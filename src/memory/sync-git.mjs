// 同步传输只操作自有 bare 缓存和受控文档路径，不检出远端文件，也不进入被观察仓库。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../utils.mjs';

export const SYNC_DOCUMENT_PREFIX = 'owner-memory/v1/';
export const SYNC_DOCUMENT_MAX = 10000;
export const SYNC_FILE_MAX = 1024 * 1024;
export const SYNC_TOTAL_MAX = 64 * 1024 * 1024;
const FILE_PATTERN = /^owner-memory\/v1\/(knowledge|lesson|profile|diagram|snapshot|domain)\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.md$/u;

export class SyncTransportError extends Error {
  constructor(message, code = 'sync-transport-failed') { super(message); this.name = 'SyncTransportError'; this.code = code; }
}
const fail = (message, code) => { throw new SyncTransportError(message, code); };

/** 设置里只保存无凭据的仓库标识；拒绝任意主机、命令、文件路径和带 token 的地址。 */
export function normalizeSyncTarget(repo, branch = 'main') {
  let value = String(repo ?? '').trim();
  if (value.startsWith('https://github.com/')) value = value.slice('https://github.com/'.length);
  value = value.replace(/\.git$/u, '');
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/u.exec(value);
  if (!match || ['.', '..'].includes(match[2])) fail('同步仓库请填写 GitHub 用户名/仓库名，不要包含凭据。', 'sync-target-invalid');
  const ref = String(branch ?? '').trim() || 'main';
  if (ref.length > 120 || ref === '@' || ref.startsWith('-') || ref.endsWith('.') || ref.includes('..')
    || ref.includes('@{') || /[~^:?*\[\\\x00-\x20\x7f]/u.test(ref)
    || ref.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    fail('同步分支名称无效，请填写普通分支名。', 'sync-branch-invalid');
  }
  return { repo: value, owner: match[1], name: match[2], branch: ref, url: `https://github.com/${value}.git` };
}

/** 只联系 GitHub 固定接口；验证私有、自有和写权限，不把凭据或响应正文带回界面。 */
export async function verifyPrivateGitHubRepository({ target, token, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!token) fail('未检测到 GITHUB_TOKEN 或 GH_TOKEN，请设置凭据后重新检查。', 'auth-missing');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const get = async suffix => {
    const response = await fetchImpl(`https://api.github.com/${suffix}`, { redirect: 'error', signal: requestSignal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` } });
    if (!response.ok) fail(response.status === 401 || response.status === 403
      ? '无法验证同步权限，请检查 token 的仓库访问权限。' : '无法读取同步仓库，请核对名称与网络后重试。',
    response.status === 401 || response.status === 403 ? 'auth-failed' : 'repository-unavailable');
    return response.json();
  };
  const [user, repo] = await Promise.all([get('user'), get(`repos/${target.repo}`)]);
  if (repo.private !== true) fail('同步只支持私有仓库，请先选择自己的私有仓库。', 'repository-not-private');
  if (String(repo.owner?.login ?? '').toLowerCase() !== String(user.login ?? '').toLowerCase() || !user.login) {
    fail('同步仓库须属于当前凭据对应的 GitHub 用户。', 'repository-not-owned');
  }
  if (repo.permissions?.push !== true) fail('当前凭据没有这个仓库的写权限。', 'repository-not-writable');
  return { private: true, writable: true, repo: target.repo, defaultBranch: String(repo.default_branch ?? '') };
}

const managedPath = (value) => {
  if (typeof value !== 'string' || !FILE_PATTERN.test(value)) fail('同步文档路径无效，未写入任何远端内容。', 'document-path-invalid');
  return value;
};
const safeDirectory = (dir) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) fail('同步缓存不能是符号链接。', 'cache-invalid');
};

export class GitMemoryTransport {
  constructor({ root, repo, branch = 'main', env = process.env, timeoutMs = 30000,
    verifyRepository = verifyPrivateGitHubRepository, git = 'git', testRemote = '' } = {}) {
    if (!root || !path.isAbsolute(root)) fail('同步缓存需要明确的自有绝对路径。', 'cache-invalid');
    this.target = normalizeSyncTarget(repo, branch);
    this.root = path.join(root, sha256(`${this.target.repo.toLowerCase()}#${this.target.branch}`).slice(0, 32));
    this.token = String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
    this.timeoutMs = timeoutMs; this.verifyRepository = verifyRepository; this.git = git;
    // 本地远端只能由测试调用方注入，配置输入仍一律按 GitHub 仓库校验。
    this.remote = testRemote ? path.resolve(testRemote) : this.target.url;
    this.localTest = Boolean(testRemote);
    this.env = { ...env };
    this.ready = false;
  }

  async initialize(signal) {
    if (this.ready) return;
    safeDirectory(this.root);
    safeDirectory(path.join(this.root, 'empty'));
    const emptyConfig = path.join(this.root, 'empty-config');
    fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
    const basic = this.token ? Buffer.from(`x-access-token:${this.token}`).toString('base64') : '';
    const inherited = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    this.childEnv = { ...inherited, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_COUNT: basic && !this.localTest ? '1' : '0',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: basic ? `AUTHORIZATION: basic ${basic}` : '',
      GIT_AUTHOR_NAME: 'Owner Companion', GIT_AUTHOR_EMAIL: 'owner-companion@localhost',
      GIT_COMMITTER_NAME: 'Owner Companion', GIT_COMMITTER_EMAIL: 'owner-companion@localhost',
      GIT_ALLOW_PROTOCOL: this.localTest ? 'file' : 'https', GIT_LFS_SKIP_SMUDGE: '1' };
    // 不继承任何 Git 环境覆盖项，避免外部仓库、配置、跟踪日志改变本次缓存的行为。
    this.args = ['-c', `core.hooksPath=${path.join(this.root, 'empty')}`, '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-c', 'push.gpgSign=false', '-c', 'http.followRedirects=false'];
    if (!fs.existsSync(path.join(this.root, 'objects'))) {
      await this.run(['init', '--bare', `--template=${path.join(this.root, 'empty')}`, this.root], { signal });
    }
    this.ready = true;
  }

  run(args, { input = '', signal, maxBuffer = SYNC_TOTAL_MAX + 1024 * 1024, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.git, [...this.args, ...args], { cwd: this.root, env: { ...this.childEnv, ...env },
        encoding: 'buffer', windowsHide: true, timeout: this.timeoutMs, maxBuffer, signal }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        if (error.name === 'AbortError' || signal?.aborted) { reject(new SyncTransportError('同步已取消，本机数据仍保留。', 'aborted')); return; }
        if (error.code === 'ENOENT') { reject(new SyncTransportError('没有找到 Git，请安装 Git 后重新检查同步。', 'git-unavailable')); return; }
        let detail = String(stderr || error.message || '').replace(/\x1b\[[0-9;]*m/gu, '').split(/\r?\n/u)[0].slice(0, 300);
        if (this.token) {
          for (const secret of [this.token, Buffer.from(`x-access-token:${this.token}`).toString('base64')]) detail = detail.split(secret).join('[REDACTED]');
        }
        reject(new SyncTransportError(error.killed ? '同步请求超时或内容超过限制，请稍后重试。'
          : `Git 同步未完成${detail ? `：${detail}` : '，请检查网络和权限后重试。'}`, error.killed ? 'git-timeout' : 'git-failed'));
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(input);
    });
  }

  async remoteHead(signal) {
    const result = await this.run(['ls-remote', '--refs', this.remote, `refs/heads/${this.target.branch}`], { signal });
    const rows = result.toString('utf8').trim().split('\n').filter(Boolean);
    if (!rows.length) return '';
    const [head, ref] = rows[0].split(/\s+/u);
    if (rows.length !== 1 || !/^[a-f0-9]{40}$/u.test(head) || ref !== `refs/heads/${this.target.branch}`) fail('无法识别远端分支，未进行写入。', 'remote-head-invalid');
    return head;
  }

  async read({ signal } = {}) {
    await this.initialize(signal);
    if (!this.localTest) await this.verifyRepository({ target: this.target, token: this.token, signal });
    let head = await this.remoteHead(signal);
    if (!head) return { head: '', documents: [] };
    await this.run(['fetch', '--no-tags', '--depth=1', this.remote, `refs/heads/${this.target.branch}`], { signal });
    head = (await this.run(['rev-parse', 'FETCH_HEAD'], { signal })).toString('utf8').trim();
    const tree = (await this.run(['ls-tree', '-r', '-z', head, '--', SYNC_DOCUMENT_PREFIX], { signal })).toString('utf8');
    const entries = tree.split('\0').filter(Boolean).map(line => {
      const match = /^(100644) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
      if (!match) fail('同步目录含有不支持的链接或文件类型，请先处理后重试。', 'document-mode-invalid');
      return { oid: match[2], path: managedPath(match[3]) };
    });
    if (entries.length > SYNC_DOCUMENT_MAX) fail('同步文档超过 10000 篇，本次未截断或同步部分清单。', 'document-count-limit');
    if (!entries.length) return { head, documents: [] };
    const batch = await this.run(['cat-file', '--batch'], { signal, input: entries.map(e => e.oid).join('\n') + '\n' });
    let offset = 0; let bytes = 0;
    const documents = entries.map(entry => {
      const end = batch.indexOf(10, offset);
      const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(batch.subarray(offset, end).toString('ascii'));
      if (!match || match[1] !== entry.oid) fail('远端文档读取不完整，请重新检查同步。', 'document-read-invalid');
      const size = Number(match[2]); bytes += size; offset = end + 1;
      if (size > SYNC_FILE_MAX || bytes > SYNC_TOTAL_MAX) fail('同步内容超过单篇或总量限制，本次未应用文档。', 'document-size-limit');
      const data = batch.subarray(offset, offset + size); offset += size + 1;
      if (data.length !== size || batch[offset - 1] !== 10 || data.includes(0)) fail('远端文档不是完整的文本，未应用。', 'document-read-invalid');
      const content = data.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(data)) fail('同步文档需要 UTF-8 文本。', 'document-encoding-invalid');
      return { path: entry.path, content };
    });
    return { head, documents };
  }

  async publish({ head = '', documents, signal } = {}) {
    await this.initialize(signal);
    if (!Array.isArray(documents)) fail('缺少待同步文档清单。', 'document-list-invalid');
    if (head && !/^[a-f0-9]{40}$/u.test(head)) fail('远端版本无效，请重新检查。', 'remote-head-invalid');
    let bytes = 0; const seen = new Set();
    for (const doc of documents) {
      managedPath(doc.path);
      if (seen.has(doc.path)) fail('同步清单有重复文档，未推送。', 'document-duplicate');
      seen.add(doc.path);
      if (typeof doc.content !== 'string' || doc.content.includes('\0')) fail('同步正文必须是文本。', 'document-content-invalid');
      const size = Buffer.byteLength(doc.content); bytes += size;
      if (size > SYNC_FILE_MAX || bytes > SYNC_TOTAL_MAX) fail('同步正文超过限制，未推送。', 'document-size-limit');
    }
    if (!this.localTest) await this.verifyRepository({ target: this.target, token: this.token, signal });
    if (await this.remoteHead(signal) !== head) fail('远端在预览后已变化，请重新检查，原选择尚未执行。', 'remote-changed');
    if (!documents.length) return { head, changed: false, published: [] };
    // 限制的是发布后的整棵记忆树，不能让一批合法增量把下次读取变成超限。
    const manifest = new Map(documents.map(doc => [doc.path, Buffer.byteLength(doc.content)]));
    if (head) {
      const tree = (await this.run(['ls-tree', '-r', '-l', '-z', head, '--', SYNC_DOCUMENT_PREFIX], { signal })).toString('utf8');
      for (const line of tree.split('\0').filter(Boolean)) {
        const entry = /^100644 blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u.exec(line);
        if (!entry) fail('同步目录含有不支持的文件类型，未推送。', 'document-mode-invalid');
        const file = managedPath(entry[3]);
        if (!manifest.has(file)) manifest.set(file, Number(entry[2]));
      }
    }
    if (manifest.size > SYNC_DOCUMENT_MAX) fail('同步后文档将超过 10000 篇，未推送。', 'document-count-limit');
    if ([...manifest.values()].some(size => size > SYNC_FILE_MAX) || [...manifest.values()].reduce((sum,size) => sum+size,0) > SYNC_TOTAL_MAX) {
      fail('同步后的完整内容超过限制，未推送。', 'document-size-limit');
    }
    const transaction = path.join(this.root, `transaction-${randomUUID()}`); safeDirectory(transaction);
    const env = { GIT_INDEX_FILE: path.join(transaction, 'index') };
    try {
      await this.run(head ? ['read-tree', head] : ['read-tree', '--empty'], { env, signal });
      for (const doc of documents) {
        const oid = (await this.run(['hash-object', '-w', '--stdin'], { input: doc.content, signal })).toString('ascii').trim();
        await this.run(['update-index', '--add', '--cacheinfo', '100644', oid, doc.path], { env, signal });
      }
      const tree = (await this.run(['write-tree'], { env, signal })).toString('ascii').trim();
      if (head) {
        const previous = (await this.run(['rev-parse', `${head}^{tree}`], { signal })).toString('ascii').trim();
        if (previous === tree) return { head, changed: false, published: [] };
      }
      const commit = (await this.run(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'Sync Owner Companion memory documents'], { signal })).toString('ascii').trim();
      // 不使用 force；读取之后再有其他设备推送，Git 自己会拒绝非快进更新。
      await this.run(['push', this.remote, `${commit}:refs/heads/${this.target.branch}`], { signal });
      return { head: commit, changed: true, published: documents.map(doc => doc.path) };
    } finally { fs.rmSync(transaction, { recursive: true, force: true }); }
  }
}
