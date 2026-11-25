// #112 验收：顶栏写范围可读、随会话授权切换。
//
// 面板层没有单元测试，判定本身由 tests/write-gate.test.mjs 表驱动覆盖；这里只验三件事：
//   ① 顶栏默认读出「写·自有」（不是空壳、也不是面板自造的第三种说法）；
//   ② 面板确实能从 window 上取到 src/write-gate.mjs 的 writeGate，
//      并且「项目目录未授权」当场得到 confirm（顶栏与判定读的是同一份规则）；
//   ③ 收到本次会话的授权事件后顶栏变成「项目目录已授权」，取消授权后回到「写·自有」。
// 全程用本 worktree 专属临时 userData + 临时 owner / 知识库，不碰真实 %APPDATA%。
import fs from 'node:fs';
import path from 'node:path';
import {
  capture, consoleErrors, createChecker, startApp, waitFor
} from './lib/cdp.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const shotsDir = process.env.SHOTS_DIR ?? path.resolve(repoRoot, '..', '..', 'mm-notes', 'shots-112');
const tempBase = process.env.TMP_112 ?? path.resolve(shotsDir, '..', 'tmp-112');
const { check, failures } = createChecker('[WRITE-SCOPE-#112]');

const readScope = (panel) => panel.evaluate(`(() => {
  const node = document.getElementById('writeScope');
  return node ? {
    text: node.textContent.trim(),
    scope: node.dataset.scope ?? '',
    title: node.title ?? '',
    granted: node.classList.contains('granted')
  } : null;
})()`);

const grant = (panel, project) => panel.evaluate(
  `document.dispatchEvent(new CustomEvent('owner-write-grant', { detail: { granted: { project: ${project} } } }))`
);

const run = async () => {
  fs.mkdirSync(tempBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempBase, 'write-scope-112-'));
  const userData = path.join(root, 'userdata');
  const ownerDb = path.join(root, 'owner.sqlite');
  const knowledgeDb = path.join(root, 'knowledge.sqlite');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'companion.json'), JSON.stringify({
    projectId: '', gatewayUrl: 'http://127.0.0.1:18789', model: '', includePaths: ['package.json']
  }, null, 2));

  const app = await startApp({ userData, ownerDb, knowledgeDb, showPanel: true });
  const { panel } = app;
  try {
    check('顶栏渲染出写范围这一格', await waitFor(panel, "Boolean(document.getElementById('writeScope'))"));
    // 模块脚本晚于 panel.js：等 host 把纯函数挂上窗口再读默认文案。
    check('判定模块对面板可读', await waitFor(panel, "Boolean(window.OwnerWriteGate?.writeGate)"));
    check('顶栏默认读出「写·自有」', await waitFor(panel,
      "document.getElementById('writeScope').textContent.trim() === '写·自有'"));

    const initial = await readScope(panel);
    check('默认范围是自有目录', initial?.scope === 'own' && initial?.granted === false, JSON.stringify(initial));

    // 同一份规则：面板取到的 writeGate 对「项目目录、未授权」必须给 confirm。
    const gate = await panel.evaluate(`(() => {
      const api = window.OwnerWriteGate;
      const project = api.writeGate({ destination: 'project', deletes: false, granted: { project: false } });
      const granted = api.writeGate({ destination: 'project', deletes: false, granted: { project: true } });
      const deleting = api.writeGate({ destination: 'own', deletes: true, granted: { project: true } });
      const unknown = api.writeGate({ destination: 'nowhere' });
      return { project, granted, deleting, unknown };
    })()`);
    check('面板读到「项目目录未授权 → 需确认」', gate?.project?.outcome === 'confirm', gate?.project?.reason);
    check('面板读到「项目目录已授权 → 放行」', gate?.granted?.outcome === 'allow', gate?.granted?.reason);
    check('面板读到「删除即使已授权也需确认」', gate?.deleting?.outcome === 'confirm', gate?.deleting?.reason);
    check('面板读到「未知目的地 → 拒绝」', gate?.unknown?.outcome === 'deny', gate?.unknown?.reason);

    // 授权按会话：事件进来才变，退出即回默认。
    await grant(panel, true);
    check('授权后顶栏变成「项目目录已授权」', await waitFor(panel,
      "document.getElementById('writeScope').textContent.trim() === '项目目录已授权'"));
    const grantedScope = await readScope(panel);
    check('授权后范围标为项目目录', grantedScope?.scope === 'project' && grantedScope?.granted === true,
      JSON.stringify(grantedScope));
    check('授权后提示仍写明删除与外发要逐次确认', /删除/u.test(grantedScope?.title ?? ''), grantedScope?.title);
    await capture(panel, path.join(shotsDir, 'write-scope-granted.png'));

    await grant(panel, false);
    check('取消授权后回到「写·自有」', await waitFor(panel,
      "document.getElementById('writeScope').textContent.trim() === '写·自有'"));
    const resetScope = await readScope(panel);
    check('取消授权后范围回到自有目录', resetScope?.scope === 'own' && resetScope?.granted === false,
      JSON.stringify(resetScope));
    await capture(panel, path.join(shotsDir, 'write-scope-own.png'));

    const errors = consoleErrors(panel);
    check('控制台无报错', errors.length === 0, errors.join(' | ').slice(0, 400));

    if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed`);
    console.log(`[WRITE-SCOPE-#112] PASS; shots → ${shotsDir}`);
  } finally {
    await app.stop();
    if (failures.length > 0) {
      console.error(`[WRITE-SCOPE-#112] kept state: ${root}`);
    } else {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ }
    }
  }
};

run().catch((error) => {
  console.error(`[WRITE-SCOPE-#112] FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
