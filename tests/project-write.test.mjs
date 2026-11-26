// #115 项目目录同步：触发条件、清单、会话授权、回执，全部是纯函数。
//
// 只断言四件事：哪些动作才需要确认、路径逐条完整不合并、授权按会话隔离、
// 成功 / 取消 / 失败三种回执都说得清。真实落盘与「取消后目录快照不变」由
// scripts/e2e/desktop-project-write.mjs 验收；这里不启动 Electron、不碰文件系统。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  PROJECT_NOTE_DIR,
  buildProjectSyncCard,
  grantProject,
  isProjectSyncCommand,
  noteSlugOf,
  parseProjectSyncCommand,
  planProjectSync,
  projectCancelReceipt,
  sessionHasGrant,
  projectWriteDecision,
  resetProjectGrant,
  resolveUnderRoot,
  runProjectSync,
  sessionNoteDoc
} from '../src/project-write.mjs';

const require = createRequire(import.meta.url);
const riskCard = require('../desktop/risk-card.cjs');

const ROOT = 'D:\\work\\alpha';
const AT = '2026-11-26T10:00:00.000Z';
const docs = () => [
  { relativePath: 'docs/notes/retry.md', content: '# 重试\n\n上限三次。\n' },
  { relativePath: 'docs/notes/backoff.md', content: '# 退避\n\n指数退避。\n' }
];

const planOf = () => planProjectSync({
  projectId: 'alpha',
  projectName: 'Alpha Repo',
  projectRoot: ROOT,
  docs: docs()
});

test('触发条件：只有 /同步到项目 与 /sync-project 触发，普通输入不触发', () => {
  assert.deepEqual(parseProjectSyncCommand('/同步到项目'), { kind: 'project-sync', title: '' });
  assert.deepEqual(parseProjectSyncCommand('  /同步到项目  重试设计笔记  '),
    { kind: 'project-sync', title: '重试设计笔记' });
  assert.deepEqual(parseProjectSyncCommand('/sync-project'), { kind: 'project-sync', title: '' });
  // 其余输入一律不是这条命令：普通聊天、自有目录写入、确认卡样本都不受影响。
  assert.equal(parseProjectSyncCommand('同步到项目'), null);
  assert.equal(parseProjectSyncCommand('/记灵感 收件箱要有一句提示'), null);
  assert.equal(parseProjectSyncCommand('/idea x'), null);
  assert.equal(parseProjectSyncCommand('/risk high'), null);
  assert.equal(parseProjectSyncCommand('/同步到项目器 x'), null);
  assert.equal(parseProjectSyncCommand(''), null);
  assert.equal(parseProjectSyncCommand(null), null);
  assert.equal(isProjectSyncCommand('/同步到项目 x'), true);
  assert.equal(isProjectSyncCommand('/blocks'), false);
});

test('判定表：项目目录未授权 → 确认；本次会话已授权 → 放行；声明删除 → 确认', () => {
  const noGrant = projectWriteDecision({ sessionId: 's1', grants: {} });
  assert.equal(noGrant.needsConfirm, true);
  assert.equal(noGrant.allowed, false);
  assert.equal(noGrant.gate.scope, 'project');
  assert.match(noGrant.gate.reason, /未授权/u);

  const granted = projectWriteDecision({ sessionId: 's1', grants: { s1: true } });
  assert.equal(granted.allowed, true);
  assert.equal(granted.needsConfirm, false);
  assert.match(granted.gate.reason, /已授权/u);

  const deleting = projectWriteDecision({ sessionId: 's1', grants: { s1: true }, deletes: true });
  assert.equal(deleting.allowed, false, '删除永远逐次确认（#116 的范围）');
  assert.equal(deleting.needsConfirm, true);
});

test('会话授权：键是会话 id，换会话查不到；重置与不可变都成立', () => {
  const empty = {};
  const forA = grantProject({ grants: empty, sessionId: 'session-a' });
  assert.deepEqual(empty, {}, '授权不修改原对象');
  assert.equal(sessionHasGrant({ grants: forA, sessionId: 'session-a' }), true);
  assert.equal(sessionHasGrant({ grants: forA, sessionId: 'session-b' }), false, '换会话重置');
  assert.equal(sessionHasGrant({ grants: forA, sessionId: '' }), false);
  // 'true' / 1 这类「看起来像授权」不算。
  assert.equal(sessionHasGrant({ grants: { 'session-a': 'true' }, sessionId: 'session-a' }), false);

  const reset = resetProjectGrant({ grants: forA, sessionId: 'session-a' });
  assert.equal(sessionHasGrant({ grants: reset, sessionId: 'session-a' }), false);
  assert.equal(sessionHasGrant({ grants: forA, sessionId: 'session-a' }), true, '重置不修改原对象');
});

test('清单：逐条完整路径、顺序不变、字节数按 UTF-8 算', () => {
  const plan = planOf();
  assert.equal(plan.projectId, 'alpha');
  assert.equal(plan.projectName, 'Alpha Repo');
  assert.equal(plan.root, ROOT);
  assert.deepEqual(plan.paths, [
    `${ROOT}\\docs\\notes\\retry.md`,
    `${ROOT}\\docs\\notes\\backoff.md`
  ]);
  assert.deepEqual(plan.files.map((file) => file.relativePath),
    ['docs/notes/retry.md', 'docs/notes/backoff.md']);
  const first = plan.files[0];
  assert.equal(first.bytes, Buffer.byteLength(first.content, 'utf8'));
  assert.equal(plan.totalBytes, plan.files.reduce((sum, file) => sum + file.bytes, 0));
  // 不合并：两份文档就是两条路径，哪怕文件名相邻。
  assert.equal(new Set(plan.paths).size, 2);
});

test('清单拒绝越界：绝对路径、盘符、..、重复目标、空清单', () => {
  assert.equal(resolveUnderRoot(ROOT, 'docs\\notes\\a.md'), `${ROOT}\\docs\\notes\\a.md`);
  assert.equal(resolveUnderRoot('/home/alpha', 'docs/a.md'), '/home/alpha/docs/a.md');
  assert.throws(() => resolveUnderRoot(ROOT, '../etc/passwd'), /跳出项目目录/u);
  assert.throws(() => resolveUnderRoot(ROOT, 'docs/../../x.md'), /跳出项目目录/u);
  assert.throws(() => resolveUnderRoot(ROOT, 'D:/outside/x.md'), /相对路径/u);
  assert.throws(() => resolveUnderRoot(ROOT, '/etc/passwd'), /相对路径/u);
  assert.throws(() => resolveUnderRoot('', 'a.md'), /项目根目录为空/u);
  assert.throws(() => resolveUnderRoot(ROOT, ''), /没有目标路径/u);

  assert.throws(() => planProjectSync({
    projectRoot: ROOT,
    docs: [docs()[0], docs()[0]]
  }), /目标路径重复/u);
  assert.throws(() => planProjectSync({ projectRoot: ROOT, docs: [] }), /没有要写入的文档/u);
  assert.throws(() => planProjectSync({ docs: docs() }), /项目根目录为空/u);
});

test('未授权：不执行写入、不给回执，交给确认卡', async () => {
  let called = 0;
  const result = await runProjectSync({
    sessionId: 'session-a',
    grants: {},
    plan: planOf(),
    at: AT,
    write: async () => { called += 1; return { files: [], git: null }; }
  });
  assert.equal(called, 0, '未授权不能写');
  assert.equal(result.blocked, true);
  assert.equal(result.needsConfirm, true);
  assert.equal(result.receipt, null, '确认卡之前不伪造回执');
  assert.equal(result.decision.granted, false);
});

test('允许后：执行一次，回执逐条给路径 + 字节数 + 是否进 git 工作区', async () => {
  const plan = planOf();
  const seen = [];
  const result = await runProjectSync({
    sessionId: 'session-a',
    grants: { 'session-a': true },
    plan,
    at: AT,
    write: async (payload) => {
      seen.push(payload);
      return {
        files: payload.files.map((file) => ({
          relativePath: file.relativePath, fullPath: file.fullPath, bytes: file.bytes
        })),
        git: { repo: true, files: ['docs/notes/retry.md', 'docs/notes/backoff.md'] }
      };
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].projectId, 'alpha');
  assert.equal(seen[0].projectRoot, ROOT);
  assert.equal(seen[0].files.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.blocked, false);

  const receipt = result.receipt;
  assert.match(receipt.text, /写入回执（项目目录）：已写入 2 个文件/u);
  assert.match(receipt.text, /2 个文件出现在 git status/u);
  const block = receipt.blocks[0];
  assert.equal(block.type, 'kv');
  assert.equal(block.title, '写入回执 · 同步到项目目录');
  const rows = block.rows;
  assert.deepEqual(rows[0], ['目的地', '项目目录 · Alpha Repo']);
  assert.deepEqual(rows[1], ['判定', '项目目录 · 本次会话已授权 → 放行']);
  assert.match(rows[2][1], /^2 个文件 · \d+ 字节$/u);
  assert.deepEqual(rows[3], ['路径 1', `${plan.paths[0]}（${plan.files[0].bytes} 字节）`]);
  assert.deepEqual(rows[4], ['路径 2', `${plan.paths[1]}（${plan.files[1].bytes} 字节）`]);
  assert.deepEqual(rows[5], ['git 工作区', '是（2 个文件出现在 git status）']);
  assert.deepEqual(rows[6], ['结果', '成功']);
  assert.deepEqual(rows[7], ['时间', AT]);
});

test('失败：回执带原因，也列出本来要写的路径', async () => {
  const plan = planOf();
  const result = await runProjectSync({
    sessionId: 'session-a',
    grants: { 'session-a': true },
    plan,
    at: AT,
    write: async () => { throw new Error('磁盘写满'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, false, '已经授权过，失败不是「要确认」');
  const block = result.receipt.blocks[0];
  assert.equal(block.title, '写入回执 · 同步到项目目录（失败）');
  const rows = block.rows;
  assert.deepEqual(rows[2], ['写入', '未写入（0 处）']);
  assert.deepEqual(rows[3], ['路径 1', plan.paths[0]]);
  assert.deepEqual(rows[4], ['路径 2', plan.paths[1]]);
  assert.deepEqual(rows[5], ['结果', '失败']);
  assert.deepEqual(rows[6], ['原因', '磁盘写满']);
  assert.match(result.receipt.text, /没有写成：磁盘写满/u);
});

test('取消回执：未写入 0 处，逐条列出没写的路径；git 不装作检查过', () => {
  const plan = planOf();
  const receipt = projectCancelReceipt({ plan, at: AT });
  assert.match(receipt.text, /已取消：2 个目标路径一个都没写/u);
  const block = receipt.blocks[0];
  assert.equal(block.title, '未写入 · 同步到项目目录');
  const rows = block.rows;
  assert.deepEqual(rows[0], ['目的地', '项目目录 · Alpha Repo']);
  assert.deepEqual(rows[1], ['写入', '未写入（0 处）']);
  assert.deepEqual(rows[2], ['路径 1', plan.paths[0]]);
  assert.deepEqual(rows[3], ['路径 2', plan.paths[1]]);
  assert.deepEqual(rows[4], ['结果', '已取消 · 文件系统没有变化']);
  assert.ok(rows.every((row) => row.length === 2));
  // 卡片已经不在内存里时，取消仍按卡上的路径说清楚。
  const fallback = projectCancelReceipt({ paths: plan.paths, at: AT });
  assert.deepEqual(fallback.blocks[0].rows[2], ['路径 1', plan.paths[0]]);
});

test('确认卡：复用 #113 的卡，逐条完整路径 + 三轴 + 四个动作', () => {
  const plan = planOf();
  const risk = riskCard.normalizeRisk(riskCard.ruleRiskEvaluator({
    destination: 'project', deletes: false, paths: plan.paths
  }));
  assert.equal(risk.level, 'medium');
  const card = buildProjectSyncCard({ plan, risk, riskCard, id: 'project-sync-1' });

  assert.equal(card.type, 'risk');
  assert.equal(card.id, 'project-sync-1');
  assert.equal(card.destination, 'project');
  assert.deepEqual(card.paths, plan.paths, '逐条完整路径，不合并、不省略');
  assert.deepEqual(card.axes.map((axis) => axis.valueLabel), ['项目级', '需重建', '否']);
  assert.deepEqual(card.actions.map((action) => action.label),
    ['允许这一次', '低风险免问', '我的判断不同', '取消']);
  assert.equal(card.actions.find((action) => action.id === 'defer-low')?.enabled, false,
    '中风险不放开「低风险免问」');
  assert.ok(card.basis.length >= 4);
  assert.ok(card.basis.some((line) => line.includes('项目目录')));
  assert.ok(card.basis.some((line) => line.includes('为什么不是别的等级')));
  assert.match(card.title, /同步文档到项目目录/u);
  assert.match(card.conclusion, /2 份文档/u);
});

test('笔记文档：标题进文件名与一级标题，正文原样带上；没有标题退回会话 id', () => {
  const doc = sessionNoteDoc({
    sessionId: 'session-42',
    title: '重试设计笔记',
    markdown: '正文一句。',
    at: AT
  });
  assert.equal(doc.relativePath, `${PROJECT_NOTE_DIR}/重试设计笔记.md`);
  assert.match(doc.content, /^# 重试设计笔记\n\n> 同步自会话 session-42 · 2026-11-26T10:00:00.000Z\n\n正文一句。\n$/u);

  const fallback = sessionNoteDoc({ sessionId: 'abcd1234efgh', markdown: '' });
  assert.equal(fallback.relativePath, `${PROJECT_NOTE_DIR}/abcd1234efgh.md`);
  // 路径分隔符与不合法的文件名字符不能进文件名。
  assert.equal(noteSlugOf({ title: 'a/b:c*d?' }), 'a-b-c-d');
  assert.equal(noteSlugOf({}), 'note');
});
