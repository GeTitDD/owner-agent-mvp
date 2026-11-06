// WorkspaceBroker — host-side, fixed-argument Git operations for patch workspaces.
//
// NO shell and NO model access to Git. Every command runs with a fixed argument vector
// against the registered canonical root (or the isolated worktree).
//
// Worktrees live OUTSIDE the project tree: <workspacesRoot>/<projectId>/<jobId>/a<attempt>.
// The broker refuses: non-git projects, dirty working trees (excluding the v0.7 identity
// marker), base-SHA drift, pre-existing workspace paths and path escape from the
// workspaces root. It is NOT a security sandbox — only worktree/index isolation.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { sha256 } from './utils.mjs';
import {
  PATCH_LIMITS,
  canonicalProposalHash,
  inspectSafePath,
  readProposalArtifact,
  readSafeMaterial,
  validateProposal
} from './patch-protocol.mjs';
import { samePath, verifyProjectRoot } from './project-identity.mjs';

const execFileP = promisify(execFile);
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const gitFailure = (message) => new Error(message);

export class WorkspaceBroker {
  constructor(store, { workspacesRoot, gitBin = 'git' } = {}) {
    this.store = store;
    this.workspacesRoot = workspacesRoot
      || process.env.OWNER_AGENT_WORKSPACES_DIR
      || path.join(os.homedir(), '.owner-agent', 'workspaces');
    this.gitBin = gitBin;
  }

  // Empty, owner-private hooks directory: project hooks must never run as a side effect
  // of worktree creation. (Git filters configured in .gitattributes are a documented
  // residual risk; this is a worktree boundary, not an OS sandbox.)
  noHooksDir() {
    const dir = path.join(this.rootReal(), '.no-hooks');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async git(cwd, args, { allowDiffExit = false } = {}) {
    const hooksPath = this.noHooksDir();
    const hardenedArgs = [
      '-c', `core.hooksPath=${hooksPath}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.noprefix=false',
      '-c', 'diff.mnemonicPrefix=false',
      ...args
    ];
    try {
      const result = await execFileP(this.gitBin, hardenedArgs, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
      });
      return result.stdout;
    } catch (error) {
      // `git diff --no-index` uses exit code 1 to mean "there are differences".
      if (allowDiffExit && (error.code === 1 || error.code === '1') && typeof error.stdout === 'string') {
        return error.stdout;
      }
      // Never pass raw stderr into durable audit records; local CLI callers still get a
      // useful, bounded diagnostic.
      const detail = String(error.stderr || error.message || '').trim().slice(0, 300);
      throw gitFailure(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
    }
  }

  // Git filters run arbitrary local commands during checkout/add/diff. P0 promises not to
  // execute project code. Scanning only tracked files is insufficient: a tracked
  // `.gitattributes` with `*.txt filter=evil` can match a NEW proposal file that is not
  // tracked yet. We therefore reject any `filter` assignment in every attributes source
  // (tracked/untracked `.gitattributes`, `$GIT_DIR/info/attributes`, core.attributesFile
  // and the XDG default), regardless of which files currently exist.
  async attributeFiles(cwd) {
    const files = new Set();
    const listed = await this.git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    for (const rel of listed.split('\u0000').filter(Boolean)) {
      if (rel === '.gitattributes' || rel.endsWith('/.gitattributes')) {
        files.add(path.resolve(cwd, rel));
      }
    }
    try {
      const info = (await this.git(cwd, ['rev-parse', '--git-path', 'info/attributes'])).trim();
      if (info) files.add(path.isAbsolute(info) ? info : path.resolve(cwd, info));
    } catch {
      // Missing info/attributes is normal.
    }
    try {
      const configured = (await this.git(cwd, ['config', '--path', '--get', 'core.attributesFile'])).trim();
      if (configured) files.add(path.isAbsolute(configured) ? configured : path.resolve(cwd, configured));
    } catch {
      // No core.attributesFile.
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    files.add(path.join(xdg, 'git', 'attributes'));
    return [...files];
  }

  async assertNoExecutableFilters(cwd) {
    for (const file of await this.attributeFiles(cwd)) {
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        throw new Error('Git attributes path is a symbolic link; refusing worktree operation');
      }
      if (!stat.isFile()) continue;
      if (stat.size > 1_048_576) {
        throw new Error('Git attributes file is too large; refusing worktree operation');
      }
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/#.*$/, '').trim();
        if (!clean) continue;
        // The first token is a pattern (or `[attr]macro`); any later token that assigns
        // `filter` can invoke a smudge/clean/process command on matching paths.
        for (const token of clean.split(/\s+/).slice(1)) {
          if (token.startsWith('-') || token.startsWith('!')) continue;
          if (token === 'filter' || token.startsWith('filter=')) {
            throw new Error('repository assigns Git filter attributes; refusing worktree operation');
          }
        }
      }
    }

    // Defense in depth: resolve attributes for every currently tracked path too, so a
    // macro/global source we failed to parse still cannot slip through for existing files.
    const files = await this.git(cwd, ['ls-files', '-z']);
    if (!files) return;
    const hooksPath = this.noHooksDir();
    const args = [
      '-c', `core.hooksPath=${hooksPath}`,
      '-c', 'core.fsmonitor=false',
      'check-attr', '-z', '--stdin', 'filter'
    ];
    let output;
    try {
      output = execFileSync(this.gitBin, args, {
        cwd,
        input: files,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }
      });
    } catch {
      throw new Error('unable to verify Git filter safety; refusing worktree operation');
    }
    const parts = output.split('\u0000');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const value = parts[i + 2];
      if (value && value !== 'unspecified' && value !== 'unset') {
        throw new Error('repository assigns executable Git filters; refusing worktree operation');
      }
    }
  }

  static sanitizeIds({ projectId, jobId, attempt }) {
    const idRe = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,88}$/;
    check(idRe.test(projectId) && !projectId.includes('..'), 'invalid project id');
    check(idRe.test(jobId) && !jobId.includes('..'), 'invalid job id');
    check(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 1_000_000, 'invalid attempt');
  }

  rootReal() {
    if (fs.existsSync(this.workspacesRoot)) {
      const stat = fs.lstatSync(this.workspacesRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('workspaces root must be a real directory, not a link');
      }
    } else {
      fs.mkdirSync(this.workspacesRoot, { recursive: true, mode: 0o700 });
    }
    return fs.realpathSync(this.workspacesRoot);
  }

  // Reject an existing symlink/junction anywhere below the workspaces root before any
  // directory creation or Git operation can follow it.
  assertNoSymlinkComponents(target) {
    const root = this.rootReal();
    const relative = path.relative(root, target);
    check(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative),
      'workspace path escapes the workspaces root');
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch {
        break; // The remaining components do not exist yet.
      }
      if (stat.isSymbolicLink()) {
        throw new Error('workspace path contains a symbolic link/junction');
      }
      if (current !== target && !stat.isDirectory()) {
        throw new Error('workspace parent path is not a real directory');
      }
      const real = fs.realpathSync(current);
      check(samePath(real, current), 'workspace path aliases another location');
    }
  }

  ensureWorkspaceParent(projectId, jobId) {
    const root = this.rootReal();
    let current = root;
    for (const segment of [projectId, jobId]) {
      const next = path.join(current, segment);
      if (!fs.existsSync(next)) {
        try {
          fs.mkdirSync(next, { mode: 0o700 });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('workspace parent path is not a real directory');
      }
      const real = fs.realpathSync(next);
      check(samePath(real, next), 'workspace parent path aliases another location');
      current = next;
    }
    return current;
  }

  workspacePath(projectId, jobId, attempt) {
    WorkspaceBroker.sanitizeIds({ projectId, jobId, attempt });
    const root = this.rootReal();
    const expected = path.join(root, projectId, jobId, `a${attempt}`);
    const resolved = path.resolve(expected);
    const prefix = path.resolve(root) + path.sep;
    const within = process.platform === 'win32'
      ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
      : resolved.startsWith(prefix);
    check(within, 'workspace path escapes the workspaces root');
    this.assertNoSymlinkComponents(resolved);
    return resolved;
  }

  assertRecordPath(record) {
    const expected = this.workspacePath(record.project_id, record.job_id, record.attempt);
    check(samePath(record.path, expected), 'workspace record path does not match its ids');
    // The branch is also re-derived; a tampered DB row must never delete `main` or an
    // unrelated branch during cleanup.
    const expectedBranch = `owner/job-${record.job_id}-a${record.attempt}`;
    check(record.branch === expectedBranch, 'workspace record branch does not match its ids');
    return expected;
  }

  async branchExists(root, branch) {
    try {
      await this.git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async isRegisteredWorktree(root, worktreePath, branch) {
    const output = await this.git(root, ['worktree', 'list', '--porcelain']);
    const expectedRef = `refs/heads/${branch}`;
    for (const block of output.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/).filter(Boolean);
      const pathLine = lines.find((line) => line.startsWith('worktree '));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      if (!pathLine || !branchLine) continue;
      const registeredPath = pathLine.slice('worktree '.length);
      if (samePath(registeredPath, worktreePath) && branchLine.slice('branch '.length) === expectedRef) {
        return true;
      }
    }
    return false;
  }

  // Prove the physical directory is still the linked worktree Git registered for this
  // project: its `.git` file points into the common git dir's worktrees area, and that
  // gitdir's reverse `gitdir` file points back to the same `.git` file. A replaced
  // ordinary directory cannot satisfy both sides of the link.
  async assertWorktreeIdentity(root, worktreePath) {
    const dotGit = path.join(worktreePath, '.git');
    let stat;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      throw new Error('workspace path is not a linked git worktree; refusing to remove it');
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) {
      throw new Error('workspace path has an unexpected .git file; refusing to remove it');
    }
    const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!match) throw new Error('workspace path has no gitdir link; refusing to remove it');
    const gitdir = path.resolve(worktreePath, match[1].trim());
    const commonRaw = (await this.git(root, ['rev-parse', '--git-common-dir'])).trim();
    const commonDir = path.resolve(root, commonRaw);
    const worktreesRoot = path.join(commonDir, 'worktrees');
    const gitdirReal = fs.realpathSync(gitdir);
    const worktreesReal = fs.realpathSync(worktreesRoot);
    const prefix = worktreesReal + path.sep;
    const inside = process.platform === 'win32'
      ? gitdirReal.toLowerCase().startsWith(prefix.toLowerCase())
      : gitdirReal.startsWith(prefix);
    if (!inside) throw new Error('workspace gitdir is outside the project worktrees area');
    const reverseFile = path.join(gitdir, 'gitdir');
    if (!fs.existsSync(reverseFile)) throw new Error('workspace gitdir has no reverse link');
    const reverseRaw = fs.readFileSync(reverseFile, 'utf8').trim();
    const reverseTarget = path.isAbsolute(reverseRaw) ? reverseRaw : path.resolve(gitdir, reverseRaw);
    if (!samePath(reverseTarget, dotGit)) {
      throw new Error('workspace gitdir reverse link does not point back to the workspace');
    }
  }

  // Remove only a worktree that Git still registers for this controlled branch. If the
  // recorded path was manually removed and replaced by an unrelated ordinary directory,
  // refuse and leave it untouched (the DB row stays active/quarantined for inspection).
  async removeWorktree(root, worktreePath, branch) {
    const registered = await this.isRegisteredWorktree(root, worktreePath, branch);
    const exists = fs.existsSync(worktreePath);
    if (!registered && exists) {
      throw new Error('workspace path is not a registered git worktree; refusing to remove it');
    }
    if (registered && exists) {
      await this.assertWorktreeIdentity(root, worktreePath);
      await this.git(root, ['worktree', 'remove', '--force', worktreePath]);
      if (fs.existsSync(worktreePath)) {
        throw new Error('git worktree remove did not remove the workspace path');
      }
    }
    try {
      await this.git(root, ['worktree', 'prune']);
    } catch {
      // Best effort; stale metadata never authorizes a recursive filesystem delete.
    }
    if (await this.branchExists(root, branch)) {
      await this.git(root, ['branch', '-D', branch]);
    }
  }

  // Create one worktree per attempt from an owner-pinned base commit. Any refusal happens
  // before the worktree is created; any later failure removes the partial worktree/branch.
  async createWorkspace({ projectId, jobId, attempt, baseSha } = {}) {
    WorkspaceBroker.sanitizeIds({ projectId, jobId, attempt });
    check(typeof baseSha === 'string' && /^[0-9a-f]{40}$/.test(baseSha),
      'baseSha must be an explicit 40-hex commit SHA');

    const project = this.store.getProject(projectId);
    check(!!project, 'Unknown project');
    const rootCheck = verifyProjectRoot(project);
    check(rootCheck.ok, `project root is unavailable (${rootCheck.reason})`);
    const root = rootCheck.root;

    let toplevel;
    try {
      toplevel = (await this.git(root, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw gitFailure('project root is not a git repository');
    }
    let toplevelReal;
    try {
      toplevelReal = fs.realpathSync(toplevel);
    } catch {
      throw gitFailure('git toplevel is missing');
    }
    check(samePath(toplevelReal, root), 'git toplevel does not match the registered project root');

    // Filter safety must be verified BEFORE `git status`, because status can itself run a
    // configured clean filter. `ls-files`/`check-attr` are metadata-only and do not.
    await this.assertNoExecutableFilters(root);

    // Clean snapshot: untracked/modified files are refused. The identity marker written
    // by v0.7 registration is the one documented exception.
    const status = (await this.git(root, [
      'status', '--porcelain', '--', '.', ':(exclude).owner-root-identity'
    ])).trim();
    check(status === '', 'project working tree is dirty; commit or stash before requesting a patch workspace');

    const head = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
    check(head === baseSha, 'base SHA drifted from the approved HEAD');

    const wtPath = this.workspacePath(projectId, jobId, attempt);
    check(!fs.existsSync(wtPath), 'workspace path already exists');
    const branch = `owner/job-${jobId}-a${attempt}`;
    check(await this.branchExists(root, branch) === false, 'controlled branch already exists; clean or reconcile it first');

    // Create only the two parent levels, one at a time, re-checking real directory identity
    // after each mkdir. The worktree target itself is created exclusively by git.
    const parent = this.ensureWorkspaceParent(projectId, jobId);
    check(samePath(parent, path.dirname(wtPath)), 'workspace parent path changed unexpectedly');
    let created = false;
    try {
      await this.git(root, ['worktree', 'add', '-b', branch, wtPath, baseSha]);
      created = true;
      const wtReal = fs.realpathSync(wtPath);
      const wsRoot = this.rootReal();
      const prefix = wsRoot + path.sep;
      const within = process.platform === 'win32'
        ? wtReal.toLowerCase().startsWith(prefix.toLowerCase())
        : wtReal.startsWith(prefix);
      check(within, 'workspace path escapes the workspaces root');
      const record = this.store.createWorkspaceRecord({
        projectId, jobId, attempt, baseSha, branch, path: wtReal
      });
      return { record, path: wtReal, branch, baseSha };
    } catch (error) {
      if (created) {
        try {
          await this.removeWorktree(root, wtPath, branch);
        } catch {
          // Preserve the original create failure; the partial path is never recursively
          // deleted without proof that Git still registers it.
        }
      }
      throw error;
    }
  }

  async inspect(recordOrId) {
    const record = typeof recordOrId === 'string' ? this.store.getWorkspace(recordOrId) : recordOrId;
    check(!!record, 'Unknown workspace');
    this.assertRecordPath(record);
    let head = null;
    let status = null;
    let alive = false;
    try {
      head = (await this.git(record.path, ['rev-parse', 'HEAD'])).trim();
      status = (await this.git(record.path, ['status', '--porcelain', '-z'])).trim();
      alive = true;
    } catch {
      // The worktree may be gone (cleaned or manually removed).
    }
    return { ...record, head, dirty: !!status, alive };
  }

  // Trusted host-side read broker for prompt material. Every path reuses the patch
  // validator's parent-chain/link/case checks: an approved path whose intermediate
  // directory is a symlink/junction is a hard failure, not a silent empty read. Directory
  // walks skip unsafe children (they are not explicitly approved material).
  readMaterial(record, entries) {
    const out = [];
    let total = 0;
    const seen = new Set();
    const worktreeRoot = record.path;

    const addInspected = (inspected, { failClosed = false } = {}) => {
      if (out.length >= PATCH_LIMITS.maxMaterialFiles) return;
      if (seen.has(inspected.path)) return;
      if (inspected.kind !== 'file') return;
      if (inspected.stat.size > PATCH_LIMITS.maxFileBytes) {
        if (failClosed) throw new Error('approved material exceeds the per-file size limit');
        return;
      }
      if (total + inspected.stat.size > PATCH_LIMITS.maxMaterialBytes) {
        if (failClosed) throw new Error('approved material exceeds the total size limit');
        return;
      }
      let material;
      try {
        material = readSafeMaterial(inspected);
      } catch (error) {
        if (failClosed) throw error;
        return;
      }
      seen.add(inspected.path);
      out.push({ path: material.path, content: material.content });
      total += material.bytes;
    };

    const walk = (prefix, depth) => {
      if (depth > 4 || out.length >= PATCH_LIMITS.maxMaterialFiles) return;
      let directory;
      try {
        directory = inspectSafePath({ worktreeRoot, relPath: prefix });
      } catch {
        return;
      }
      if (directory.kind !== 'directory') return;
      let names;
      try {
        names = fs.readdirSync(directory.full, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const dirent of names) {
        if (out.length >= PATCH_LIMITS.maxMaterialFiles) return;
        if (dirent.name.startsWith('.')) continue;
        const rel = `${prefix}/${dirent.name}`;
        let inspected;
        try {
          inspected = inspectSafePath({ worktreeRoot, relPath: rel });
        } catch {
          continue; // symlink/hardlink/case-alias/binary child: never material
        }
        if (inspected.kind === 'directory') walk(rel, depth + 1);
        else if (inspected.kind === 'file') addInspected(inspected, { failClosed: false });
      }
    };

    for (const entry of entries) {
      // Explicit approved paths are fail-closed: unsafe parents, links or invalid UTF-8
      // abort the attempt instead of silently dropping material.
      const inspected = inspectSafePath({ worktreeRoot, relPath: entry.norm });
      if (inspected.kind === 'file') addInspected(inspected, { failClosed: true });
      else if (inspected.kind === 'directory') walk(entry.norm, 0);
    }
    return out;
  }

  // Generate a reviewable unified diff without touching the worktree. `git diff --no-index`
  // gives us the real diff algorithm; headers are rewritten to repo-relative paths.
  async buildProposalDiff(worktreeRoot, files) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-patch-diff-'));
    const chunks = [];
    try {
      for (const file of files) {
        const oldPath = path.join(tmp, 'old');
        const newPath = path.join(tmp, 'new');
        let oldText = '';
        if (file.action === 'modify') {
          oldText = fs.readFileSync(path.join(worktreeRoot, file.path), 'utf8');
        }
        fs.writeFileSync(oldPath, oldText, 'utf8');
        fs.writeFileSync(newPath, file.content, 'utf8');
        const raw = await this.git(tmp, [
          '-c', 'core.autocrlf=false',
          'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
          '--unified=3', '--', 'old', 'new'
        ], { allowDiffExit: true });
        const header = `diff --git a/${file.path} b/${file.path}`;
        if (!raw.trim()) {
          chunks.push(`${header}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${file.path}\n`);
          continue;
        }
        const lines = raw.replace(/\r\n/g, '\n').split('\n');
        const rewritten = lines.map((line) => {
          if (line === 'diff --git a/old b/new') return header;
          if (line === '--- a/old') return file.action === 'add' ? '--- /dev/null' : `--- a/${file.path}`;
          if (line === '+++ b/new') return `+++ b/${file.path}`;
          return line;
        });
        if (file.action === 'add') {
          const at = rewritten.indexOf(header);
          if (at !== -1 && rewritten[at + 1] !== 'new file mode 100644') {
            rewritten.splice(at + 1, 0, 'new file mode 100644');
          }
          for (let i = 0; i < rewritten.length; i++) {
            if (rewritten[i].startsWith('index e69de29..')) {
              rewritten[i] = `index 0000000..${rewritten[i].slice('index e69de29..'.length)}`;
            }
          }
        }
        chunks.push(rewritten.join('\n').replace(/\n+$/, '\n'));
      }
      return chunks.join('\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // Stage intent-to-add so new files appear in `git diff`, then return both the diff and the
  // exact changed-path set for independent comparison with the proposal.
  async buildAppliedDiff(worktreePath) {
    await this.git(worktreePath, ['add', '--intent-to-add', '.']);
    const namesRaw = await this.git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z']);
    const paths = namesRaw.split('\u0000').filter(Boolean).sort();
    const diff = await this.git(worktreePath, ['diff', '--no-ext-diff', '--no-textconv']);
    return { diff, paths };
  }

  // Fail-closed apply: re-validate everything, persist `applying`, write files with per-file
  // oplog, independently verify the worktree, then commit `applied`. Any post-`applying`
  // error becomes needs_reconciliation and quarantines the workspace as evidence.
  async applyProposal(record, proposal, { now = new Date().toISOString() } = {}) {
    check(!!record && !!proposal, 'workspace and proposal are required');
    check(record.id === proposal.workspace_id, 'proposal does not belong to this workspace');
    check(record.project_id === proposal.project_id, 'proposal does not belong to this project');
    check(record.job_id === proposal.job_id && record.attempt === proposal.attempt,
      'proposal does not belong to this workspace attempt');
    check(record.status === 'active', 'workspace is not active');
    this.assertRecordPath(record);

    const project = this.store.getProject(record.project_id);
    check(!!project, 'Unknown project');
    const rootCheck = verifyProjectRoot(project);
    check(rootCheck.ok, `project root is unavailable (${rootCheck.reason})`);

    if (proposal.status !== 'approved') throw new Error(`proposal in status ${proposal.status} cannot be applied`);
    check(proposal.approved_hash === proposal.proposal_hash, 'approval is not bound to the current proposal hash');
    const proposalAllowed = Array.isArray(proposal.allowedPaths)
      ? proposal.allowedPaths
      : JSON.parse(proposal.allowed_paths);

    // Any precheck failure after approval is fail-closed too: no file is written, the
    // proposal becomes apply_failed, and the workspace is quarantined for inspection.
    let artifact;
    try {
      await this.assertNoExecutableFilters(rootCheck.root);
      await this.assertNoExecutableFilters(record.path);
      const artifactRow = this.store.getPatchArtifact(proposal.id, 'proposal');
      check(!!artifactRow, 'stored proposal artifact is missing');
      check(sha256(artifactRow.content) === artifactRow.content_hash, 'stored proposal artifact hash mismatch');
      artifact = readProposalArtifact(artifactRow.content);
      check(artifact.base_sha === proposal.base_sha, 'proposal artifact base SHA mismatch');
      const artifactAllowed = Array.isArray(artifact.allowed_paths) ? artifact.allowed_paths : null;
      check(artifactAllowed && JSON.stringify(artifactAllowed) === JSON.stringify(proposalAllowed),
        'proposal artifact allowed scope mismatch');
      check(Array.isArray(artifact.files) && artifact.files.length === proposal.files.length,
        'proposal artifact file count mismatch');
      for (let i = 0; i < artifact.files.length; i++) {
        const a = artifact.files[i];
        const m = proposal.files[i];
        check(a.path === m.path && a.action === m.action && a.old_sha === (m.old_sha ?? null) && a.new_sha === m.new_sha,
          'proposal artifact metadata mismatch');
      }
      const recomputed = canonicalProposalHash(artifact.files);
      check(recomputed === proposal.proposal_hash, 'proposal hash no longer matches its content');
      check(recomputed === proposal.approved_hash, 'approval hash does not match the proposal content');

      // Re-check base, scope, links, case aliases and old hashes immediately before apply.
      const head = (await this.git(record.path, ['rev-parse', 'HEAD'])).trim();
      check(head === proposal.base_sha, 'worktree HEAD drifted from the approved base');
      const revalidated = validateProposal({
        worktreeRoot: record.path,
        allowedPaths: proposalAllowed,
        rawFiles: artifact.files.map((f) => ({ path: f.path, action: f.action, content: f.content }))
      });
      check(revalidated.proposalHash === proposal.proposal_hash,
        'worktree content no longer matches the approved proposal');
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 200);
      try {
        this.store.failPatchPrecheck(proposal.id, { reason, now });
        this.store.quarantineWorkspace(record.id, { reason: 'apply precheck failed', now });
      } catch {
        // Keep the original protocol error as the actionable surface.
      }
      return { outcome: 'apply_failed', error: reason };
    }

    this.store.beginPatchApply(proposal.id, { now });
    try {
      for (const file of artifact.files) {
        const full = path.join(record.path, file.path);
        if (file.action === 'modify') {
          const current = fs.readFileSync(full, 'utf8');
          check(sha256(current) === file.old_sha, `old content changed before write: ${file.path}`);
        } else {
          check(!fs.existsSync(full), `add target appeared before write: ${file.path}`);
        }
        fs.writeFileSync(full, file.content, {
          encoding: 'utf8',
          flag: file.action === 'add' ? 'wx' : 'w'
        });
        this.store.logPatchOp(proposal.id, 'file_written', 'host',
          `${file.action}:${file.path}`, now);
      }

      const { diff, paths } = await this.buildAppliedDiff(record.path);
      const expected = proposal.files.map((f) => f.path).sort();
      check(JSON.stringify(paths) === JSON.stringify(expected),
        'worktree change set does not match the proposal');
      check(diff.trim().length > 0, 'applied diff is empty');
      for (const file of artifact.files) {
        const current = fs.readFileSync(path.join(record.path, file.path), 'utf8');
        check(sha256(current) === file.new_sha, `new content hash mismatch: ${file.path}`);
      }
      const stored = this.store.completePatchApply(proposal.id, { diffContent: diff, now });
      return {
        outcome: 'applied',
        proposal: stored,
        diffChars: diff.length,
        diffHash: sha256(diff)
      };
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 200);
      let marked = true;
      try {
        this.store.markPatchNeedsReconciliation(proposal.id, { reason, now });
      } catch {
        marked = false;
      }
      try {
        this.store.quarantineWorkspace(record.id, { reason: 'apply failed; evidence retained', now });
      } catch {
        // Already quarantined or terminal.
      }
      return { outcome: 'needs_reconciliation', error: reason, marked };
    }
  }

  // Independent post-apply verification used by Owner reconcile `confirm-applied`.
  async verifyApplied(record, proposal) {
    try {
      check(!!record && !!proposal, 'workspace and proposal are required');
      this.assertRecordPath(record);
      const project = this.store.getProject(record.project_id);
      check(!!project, 'Unknown project');
      const rootCheck = verifyProjectRoot(project);
      check(rootCheck.ok, `project root is unavailable (${rootCheck.reason})`);
      await this.assertNoExecutableFilters(rootCheck.root);
      await this.assertNoExecutableFilters(record.path);
      const head = (await this.git(record.path, ['rev-parse', 'HEAD'])).trim();
      check(head === proposal.base_sha, 'worktree HEAD drifted from the approved base');
      const artifactRow = this.store.getPatchArtifact(proposal.id, 'proposal');
      check(!!artifactRow, 'stored proposal artifact is missing');
      check(sha256(artifactRow.content) === artifactRow.content_hash, 'stored proposal artifact hash mismatch');
      const artifact = readProposalArtifact(artifactRow.content);
      check(canonicalProposalHash(artifact.files) === proposal.proposal_hash,
        'proposal hash no longer matches its content');
      for (const file of artifact.files) {
        const inspected = inspectSafePath({ worktreeRoot: record.path, relPath: file.path });
        if (inspected.kind !== 'file') return { ok: false, reason: `not a regular file: ${file.path}` };
        const current = readSafeMaterial(inspected).content;
        if (sha256(current) !== file.new_sha) return { ok: false, reason: `content hash mismatch: ${file.path}` };
      }
      const { diff, paths } = await this.buildAppliedDiff(record.path);
      const expected = proposal.files.map((f) => f.path).sort();
      if (JSON.stringify(paths) !== JSON.stringify(expected)) {
        return { ok: false, reason: 'worktree change set does not match the proposal' };
      }
      return { ok: true, diff, diffHash: sha256(diff) };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error).slice(0, 160) };
    }
  }

  quarantine(id, { reason = '', now = new Date().toISOString() } = {}) {
    return this.store.quarantineWorkspace(id, { reason, now });
  }

  // Owner-explicit cleanup. The path must equal the path re-derived from the record ids;
  // only that worktree and its controlled branch are removed.
  async cleanup(id, { confirm = false, now = new Date().toISOString() } = {}) {
    check(confirm === true, 'workspace cleanup requires explicit owner confirmation');
    const record = this.store.getWorkspace(id);
    check(!!record, 'Unknown workspace');
    const expected = this.assertRecordPath(record);
    const proposal = this.store.getPatchProposalForWorkspace(record.id);
    if (proposal) {
      check(['applied', 'rejected', 'apply_failed'].includes(proposal.status),
        `proposal in status ${proposal.status} must be reconciled before cleanup`);
    }
    const root = this.rootReal();
    check(fs.existsSync(expected) ? samePath(fs.realpathSync(expected), expected) : true,
      'workspace path was replaced by a link');
    const project = this.store.getProject(record.project_id);
    check(!!project, 'Unknown project');
    const rootCheck = verifyProjectRoot(project);
    check(rootCheck.ok, `project root is unavailable (${rootCheck.reason})`);
    await this.assertNoExecutableFilters(rootCheck.root);
    if (fs.existsSync(expected) || await this.branchExists(rootCheck.root, record.branch)) {
      await this.removeWorktree(rootCheck.root, expected, record.branch);
    }
    check(!samePath(expected, project.root), 'refusing to remove the project root');
    check(!samePath(expected, root), 'refusing to remove the workspaces root');
    return this.store.cleanupWorkspace(id, { now });
  }
}
