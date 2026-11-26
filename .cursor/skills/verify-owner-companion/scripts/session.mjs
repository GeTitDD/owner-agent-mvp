// 验证会话：起一个隔离的 Owner Companion 实例（临时 userData/DB/项目），
// 供 .cursor/skills/verify-owner-companion 的功能脚本驱动。
//
// 只用于验证：不读真实库、不调真实模型（默认 fake chat）、不写项目目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);

/** 建一个最小 demo 项目：有 package.json 与一个源码文件，够读、够引用。 */
function seedProject(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'verify-demo', private: true, type: 'module'
  }, null, 2));
  fs.writeFileSync(path.join(root, 'src/retry.js'), [
    'export async function retry(task, attempts = 3) {',
    '  for (let i = 0; i < attempts; i += 1) {',
    '    const result = await task();',
    '    if (result.ok) return result;',
    '  }',
    '  return { ok: false };',
    '}',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'README.md'), '# verify-demo\n\n用于验证的最小仓库。\n');
}

/** 假 Pi 目录：模型下拉只显示 demo provider，避免泄露本机真实模型名。 */
function seedPiHome(dir) {
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent/models.json'), JSON.stringify({
    providers: { 'demo-provider': { models: [{ id: 'fast-model' }] } }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'agent/auth.json'), JSON.stringify({ 'demo-provider': {} }));
}

/**
 * 启动一个隔离实例。
 *
 * @param {object} [options]
 * @param {boolean} [options.fakeChat] 默认 true：OWNER_AGENT_CHAT_FAKE=1，不调模型
 * @param {string}  [options.name]     证据目录后缀，默认用时间戳
 * @returns {Promise<{app: object, panel: object, dirs: object, evidenceDir: string,
 *   shot: (name: string) => Promise<string>, stop: () => Promise<void>,
 *   ownerDb: () => import('node:sqlite').DatabaseSync, waitFor: Function, sleep: Function}>}
 */
export async function createSession({ fakeChat = true, name = '' } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-verify-'));
  const userData = path.join(base, 'userdata');
  const demo = path.join(base, 'demo-repo');
  fs.mkdirSync(userData, { recursive: true });
  seedProject(demo);
  seedPiHome(path.join(base, 'pi-home'));

  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    model: 'demo-provider/fast-model',
    diagramModel: '',
    gatewayUrl: 'http://127.0.0.1:18789',
    includePaths: ['package.json'],
    chatSkills: []
  }, null, 2));

  const ownerDb = path.join(base, 'owner.sqlite');
  const knowledgeDb = path.join(base, 'knowledge.sqlite');

  const { OwnerStore } = await load('src/owner-store.mjs');
  const owner = new OwnerStore(ownerDb);
  owner.registerProject({
    id: 'verify-demo', name: 'Verify Demo', root: demo,
    primaryDomain: 'software-engineering', domains: ['software-engineering']
  });
  owner.close();

  const { ChatSessionStore } = await load('src/chat-sessions.mjs');
  const db = new DatabaseSync(ownerDb);
  const sessions = new ChatSessionStore({ db });
  const session = sessions.createSession({ projectId: 'verify-demo', title: '验证会话' });
  sessions.markOpened(session.id);
  sessions.setViewProject(session.id, 'verify-demo');
  db.close();

  const evidenceDir = path.join(repoRoot, '.verify', 'evidence', `${stamp}${name ? `-${name}` : ''}`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const cdp = await load('scripts/e2e/lib/cdp.mjs');
  const env = {
    OWNER_AGENT_PI_HOME: path.join(base, 'pi-home'),
    ...(fakeChat ? { OWNER_AGENT_CHAT_FAKE: '1' } : {})
  };
  const app = await cdp.startApp({
    userData, ownerDb, knowledgeDb, env, showPanel: true, page: 'shell.html'
  });
  const { panel } = app;
  await cdp.waitFor(panel, "document.getElementById('shellHeader')", 30000);
  await cdp.sleep(1200);

  const shot = async (fileName) => {
    const target = path.join(evidenceDir, fileName.endsWith('.png') ? fileName : `${fileName}.png`);
    await cdp.capture(panel, target);
    return target;
  };

  return {
    app,
    panel,
    dirs: {
      base, userData, ownerDb, knowledgeDb, demo,
      piHome: path.join(base, 'pi-home'), evidenceDir, repoRoot
    },
    evidenceDir,
    shot,
    ownerDb: () => new DatabaseSync(ownerDb, { readOnly: true }),
    waitFor: cdp.waitFor,
    sleep: cdp.sleep,
    async stop() {
      try { await app.stop(); } catch { /* 已退出 */ }
      // 只删本次临时实例；证据目录在仓库内，不受影响。
      try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 留现场 */ }
    }
  };
}
