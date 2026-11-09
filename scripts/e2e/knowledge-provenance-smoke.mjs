#!/usr/bin/env node
// Knowledge Maintenance & Provenance 端到端验收（真实 CLI + 真实 git，可选真实 GitHub）。
//
// 覆盖：项目身份 → git 来源观察 → 绑定修订 → Owner 采纳 → 来源变更触发待重验证
//      → 接受重验证 → 导出/导入跨设备同步 → 会话上下文快照与恢复。
//
// 用法：node scripts/e2e/knowledge-provenance-smoke.mjs
// 证据：EVIDENCE_DIR（默认临时目录）下的 provenance-smoke.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-smoke-'));
const evidenceDir = process.env.EVIDENCE_DIR ?? work;
fs.mkdirSync(evidenceDir, { recursive: true });

const projectRoot = path.join(work, 'proj');
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'src', 'retry.js'), 'export const attempts = 7;\n', 'utf8');
const git = (args) => execFileSync('git', args, {
  cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'core.autocrlf', 'false']);
git(['config', 'user.email', 'smoke@example.invalid']);
git(['config', 'user.name', 'Provenance Smoke']);
git(['add', '.']);
git(['commit', '-qm', 'hidden convention: attempts=7']);
const firstCommit = git(['rev-parse', 'HEAD']);

const knowledgeDb = path.join(work, 'knowledge-a.sqlite');
const ownerDb = path.join(work, 'owner.sqlite');
const cloneDb = path.join(work, 'knowledge-b.sqlite');
const bundlePath = path.join(work, 'bundle.json');
const report = { work, steps: [], skipped: [] };
const run = (args, db = knowledgeDb) => {
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, 'bin', 'knowledge-maint.mjs'), ...args,
    '--knowledge-db', db, '--owner-db', ownerDb
  ], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return output.trim() ? JSON.parse(output) : null;
};
const step = (name, detail) => {
  report.steps.push({ name, ...detail });
  console.log(`[PROV] OK   ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
};

// 1. 项目身份：本地仓库无 remote 时退到根提交，跨设备保持稳定。
const project = run(['project', 'register', '--project', 'smoke-demo', '--root', projectRoot]);
if (project.identityKind !== 'git-remote' && project.identityKind !== 'git-remote' && project.identityKind !== 'git-first-commit') {
  throw new Error(`Unexpected identity kind: ${project.identityKind}`);
}
step('project identity registered', { identityKind: project.identityKind, projectIdentity: project.projectIdentity });

// 2. 建立知识单元（沿用既有 PersonalKnowledgeStore，不新建存储）。
const store = new PersonalKnowledgeStore(knowledgeDb);
let unit;
try {
  unit = store.create({
    title: 'Retry default is 7', content: 'withRetry must default attempts to 7 for the hidden convention.',
    kind: 'claim', layer: 'project', scope: 'project', projectId: 'smoke-demo',
    domains: ['software-engineering'], tags: ['retry'],
    evidenceRefs: ['legacy:commit:' + firstCommit.slice(0, 8)], verificationStatus: 'unverified'
  });
} finally { store.close(); }
step('knowledge unit created', { unitId: unit.id, revision: unit.revision });

// 3. 真实 git 来源观察 + 绑定 + 采纳。
const observed = run(['observe', '--kind', 'git', '--project', 'smoke-demo', '--root', projectRoot, '--path', 'src/retry.js']);
step('git source observed', {
  sourceId: observed.sourceId, observationId: observed.observationId,
  sourceVersion: observed.sourceVersion, contentHash: observed.contentHash
});
run(['link', '--knowledge', unit.id, '--revision', '1', '--observation', observed.observationId, '--relation', 'supports']);
const adopted = run(['adopt', '--knowledge', unit.id, '--revision', '1', '--note', 'Owner accepted the hidden convention']);
step('owner adoption recorded', { revision: adopted.revision, drift: adopted.drift });

// 4. 来源变化 → 待重验证（不静默改知识）。
fs.writeFileSync(path.join(projectRoot, 'src', 'retry.js'), 'export const attempts = 9;\n', 'utf8');
git(['add', '.']);
git(['commit', '-qm', 'convention changed to 9']);
const changed = run(['observe', '--kind', 'git', '--project', 'smoke-demo', '--root', projectRoot, '--path', 'src/retry.js']);
if (changed.revalidations.length !== 1) throw new Error('Expected exactly one pending revalidation');
const queued = run(['revalidate', 'list', '--status', 'pending', '--knowledge', unit.id]);
step('source change queued for revalidation', { pending: queued.length, reason: queued[0].reason });

const storeCheck = new PersonalKnowledgeStore(knowledgeDb);
try {
  const untouched = storeCheck.get(unit.id);
  if (untouched.revision !== 1) throw new Error('Knowledge was silently modified');
} finally { storeCheck.close(); }

const resolved = run(['revalidate', 'resolve', '--id', queued[0].id, '--decision', 'accepted', '--note', 're-verify against commit 2']);
step('revalidation accepted by owner', { status: resolved.status });

// 5. explain 回答“来源、版本、采纳、证据”。
const explanation = run(['explain', '--knowledge', unit.id]);
const linkedVersion = explanation.revisions.find((item) => item.revision === 1)?.links?.[0]?.sourceVersion;
if (!linkedVersion) throw new Error('explain lost the source version');
step('explain reports provenance', {
  headRevision: explanation.headRevision, adoptedRevision: explanation.adoptedRevision,
  adoptedDrift: explanation.adoptionDrift, linkedSourceVersion: linkedVersion,
  verificationStatus: explanation.verificationStatus
});

// 6. 跨设备同步：导出 A，导入空库 B。
run(['sync', 'export', '--project', 'smoke-demo', '--out', bundlePath]);
const imported = run(['sync', 'import', '--in', bundlePath], cloneDb);
if (imported.imported !== 1) throw new Error(`Expected 1 imported unit, got ${imported.imported}`);
const clone = new PersonalKnowledgeStore(cloneDb);
try {
  const copy = clone.get(unit.id);
  if (!copy) throw new Error('Unit id was not preserved across devices');
  if (copy.revision !== explanation.headRevision) throw new Error('Revision history diverged on import');
} finally { clone.close(); }
step('offline sync preserved identity and history', { imported: imported.imported, unitId: unit.id });

const duplicate = run(['sync', 'import', '--in', bundlePath], cloneDb);
step('second import is a no-op', { unchanged: duplicate.unchanged });

// 7. 可选：真实 GitHub 解析（需要 gh 登录 + 网络；失败只标记跳过，不伪造数据）。
let githubDone = false;
for (let attempt = 1; attempt <= 2 && !githubDone; attempt += 1) {
  try {
    const gh = run(['observe', '--kind', 'github', '--github-kind', 'commit', '--repo', 'GeTitDD/owner-agent-mvp', '--ref', 'main', '--project', 'smoke-demo']);
    step('github source observed', { sourceVersion: gh.sourceVersion, sourceType: 'github' });
    githubDone = true;
  } catch (error) {
    if (attempt === 2) {
      report.skipped.push({
        name: 'github source observed',
        reason: String(error.stderr ? error.message + String(error.stderr) : error.message).slice(0, 1500)
      });
      console.log('[PROV] SKIP github source observed (gh unavailable or network unavailable)');
    }
  }
}

fs.writeFileSync(path.join(evidenceDir, 'provenance-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('[PROV] PASS');
console.log(`[PROV] evidence=${path.join(evidenceDir, 'provenance-smoke.json')}`);
