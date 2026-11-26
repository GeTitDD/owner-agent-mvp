// #135 `/提炼决策`：只扫当前项目的会话，产出决策候选，未处理项跨重启保留，
// 接受才写知识库，拒绝记指纹不再重复提。
//
// 这里用临时目录造 Codex 会话、临时库验收入库、临时 JSON 验持久化；
// 不联网、不调真实模型、不读真实用户的会话目录，也不写任何项目目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { scanSessions } from '../src/memory/session-scan.mjs';
import { decisionFingerprint } from '../src/memory/decision-draft.mjs';
import { DecisionScanStore } from '../src/memory/decision-scan-store.mjs';
import {
  normalizeDecisionScanState,
  pendingOf,
  pendingSummary,
  mergeCandidates,
  rejectPending,
  acceptPendingCandidate,
  runDecisionScan
} from '../src/memory/decision-scan.mjs';

const require = createRequire(import.meta.url);
const compose = require('../desktop/shell-compose.cjs');
const blocks = require('../desktop/shell-blocks.cjs');

const AT = '2026-11-25T10:00:00.000Z';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decision-scan-'));

const writeLines = (file, rows) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
};

const codex = {
  meta: (cwd, id) => ({ timestamp: AT, type: 'session_meta', payload: { id, cwd } }),
  user: (text) => ({
    timestamp: AT,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  }),
  assistant: (text) => ({
    timestamp: AT,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  })
};

/** 假的提炼器：只回显原文，不猜字段；理由一律留空。 */
const echoExtract = (pair) => ({
  phenomenon: pair.user.text,
  intent: pair.assistant ? pair.assistant.text : '',
  abandoned: '',
  reason: ''
});

const seedProjects = (root) => {
  const alpha = path.join(root, 'work', 'alpha');
  const beta = path.join(root, 'work', 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  return {
    alpha: { id: 'alpha', name: 'Alpha 项目', root: alpha },
    beta: { id: 'beta', name: 'Beta 项目', root: beta }
  };
};

const writeSession = (root, { cwd, id, text, reply }) => writeLines(
  path.join(root, 'sessions', '2026', '11', '25', `rollout-${id}.jsonl`),
  [codex.meta(cwd, id), codex.user(text), codex.assistant(reply)]
);

const makeScanStore = (dir) => new DecisionScanStore({
  file: path.join(dir, 'memory-scan.json')
});

const alphaDecision = '构建太慢，统一改成 esbuild 打包';

test('只扫当前项目：别的项目的会话候选不入待办，会话键也不记成已扫过', async () => {
  const root = tempRoot();
  try {
    const { alpha, beta } = seedProjects(root);
    writeSession(root, {
      cwd: alpha.root, id: 'alpha-s1', text: alphaDecision, reply: '好，换成 esbuild'
    });
    writeSession(root, {
      cwd: beta.root, id: 'beta-s1', text: '测试统一用 vitest，不再用 jest', reply: '好，换 vitest'
    });

    const result = await runDecisionScan({
      state: normalizeDecisionScanState({}),
      project: alpha,
      roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
      scan: scanSessions,
      extract: echoExtract
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'scanned');
    assert.equal(result.added.length, 1);
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].projectId, 'alpha');
    assert.equal(result.pending[0].phenomenon, alphaDecision);
    // 只记了当前项目那一段会话的键；别的项目没有被消费。
    assert.equal(result.state.sessions.length, 1);
    assert.match(result.state.sessions[0], /alpha-s1/u);
    assert.equal(result.state.sessions.some((key) => key.includes('beta-s1')), false);
    // 回执能看出「有一段不属于本项目」，但没把它当成失败或候选。
    assert.equal(result.receipt.dropped.unmatchedCwd, 1);
    assert.equal(result.receipt.added, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未处理候选跨 store 重新打开仍在：摘要按项目给计数与条目', () => {
  const root = tempRoot();
  try {
    const scanStore = makeScanStore(root);
    const candidate = {
      fingerprint: decisionFingerprint({ projectId: 'alpha', text: alphaDecision }),
      projectId: 'alpha',
      projectName: 'Alpha 项目',
      phenomenon: alphaDecision,
      intent: '换成 esbuild',
      abandoned: '',
      reason: '',
      missingReason: true,
      quote: { user: alphaDecision, assistant: '好，换成 esbuild' },
      evidence: [{ role: 'user', index: 0, sessionId: 'alpha-s1', at: AT }],
      source: 'codex',
      sessionPath: 'C:/tmp/rollout-alpha-s1.jsonl'
    };
    const merged = mergeCandidates(normalizeDecisionScanState({}), [candidate], {
      projectId: 'alpha', projectName: 'Alpha 项目', now: AT
    });
    assert.equal(merged.added.length, 1);
    scanStore.write(merged.state);

    // 重新打开：换一个实例读同一个文件，模拟重启。
    const reopened = makeScanStore(root).read();
    const pending = pendingOf(reopened, 'alpha');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].fingerprint, candidate.fingerprint);
    assert.equal(pending[0].phenomenon, alphaDecision);
    assert.equal(pending[0].sessionId, 'alpha-s1');

    const summary = pendingSummary(reopened, [
      { id: 'alpha', name: 'Alpha 项目' },
      { id: 'beta', name: 'Beta 项目' }
    ]);
    assert.equal(summary.total, 1);
    assert.equal(summary.projects[0].projectId, 'alpha');
    assert.equal(summary.projects[0].count, 1);
    assert.equal(summary.projects[0].items[0].missingReason, true);
    // 没有候选的项目也在摘要里，计数为 0（定位屏要能显示「待确认 0」）。
    assert.equal(summary.projects.find((item) => item.projectId === 'beta').count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('接受：只写一条决策，来源与会话出处可回查，待办随之移除', async () => {
  const root = tempRoot();
  try {
    const { alpha } = seedProjects(root);
    writeSession(root, {
      cwd: alpha.root, id: 'alpha-accept', text: alphaDecision, reply: '好，换成 esbuild'
    });
    const scanStore = makeScanStore(root);
    const personal = new PersonalKnowledgeStore(path.join(root, 'knowledge.sqlite'), { logger: null });
    try {
      const result = await runDecisionScan({
        state: scanStore.read(),
        project: alpha,
        roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
        scan: scanSessions,
        extract: echoExtract
      });
      scanStore.write(result.state);
      const [candidate] = result.pending;

      const accepted = acceptPendingCandidate({
        scanStore,
        personalStore: personal,
        projectId: 'alpha',
        fingerprint: candidate.fingerprint,
        reason: '反馈速度比包体积更重要',
        now: AT
      });
      assert.equal(accepted.ok, true);
      assert.equal(accepted.created, true);
      assert.equal(accepted.missingReason, false);

      const units = personal.list();
      assert.equal(units.length, 1, '接受后只写一条决策');
      const unit = personal.get(accepted.id);
      assert.equal(unit.kind, 'decision');
      assert.equal(unit.projectId, 'alpha');
      assert.equal(unit.decision.reason, '反馈速度比包体积更重要');
      assert.equal(unit.decision.source.source, 'codex');
      assert.equal(unit.decision.source.sessionId, 'alpha-accept');
      assert.match(unit.sourceRef, /session-scan:codex:alpha-accept/u);
      assert.equal(unit.evidenceRefs.length, 2, '用户原话与助手确认两处证据都要在');

      // 待办已移除，重启后不会又冒出来。
      const reopened = makeScanStore(root).read();
      assert.equal(pendingOf(reopened, 'alpha').length, 0);
      assert.equal(pendingSummary(reopened).total, 0);

      // 同一指纹再接受一次不写第二条。
      const again = acceptPendingCandidate({
        scanStore, personalStore: personal, projectId: 'alpha', fingerprint: candidate.fingerprint
      });
      assert.equal(again.ok, false);
      assert.equal(personal.list().length, 1);
    } finally {
      personal.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('拒绝：记指纹并移除候选，同样的内容在后续扫描里不再出现', async () => {
  const root = tempRoot();
  try {
    const { alpha } = seedProjects(root);
    writeSession(root, {
      cwd: alpha.root, id: 'alpha-reject-1', text: alphaDecision, reply: '好，换成 esbuild'
    });
    const scanStore = makeScanStore(root);
    const first = await runDecisionScan({
      state: scanStore.read(),
      project: alpha,
      roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
      scan: scanSessions,
      extract: echoExtract
    });
    scanStore.write(first.state);
    const [candidate] = first.pending;

    const rejected = rejectPending({
      scanStore, projectId: 'alpha', fingerprint: candidate.fingerprint, now: AT
    });
    assert.equal(rejected.ok, true);
    assert.equal(pendingOf(scanStore.read(), 'alpha').length, 0);
    assert.equal(scanStore.read().rejected.length, 1);

    // 换一段会话说同一句话：指纹相同，不该再成为候选。
    writeSession(root, {
      cwd: alpha.root, id: 'alpha-reject-2', text: alphaDecision, reply: '好，换成 esbuild'
    });
    const second = await runDecisionScan({
      state: scanStore.read(),
      project: alpha,
      roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
      scan: scanSessions,
      extract: echoExtract
    });
    scanStore.write(second.state);
    assert.equal(second.added.length, 0);
    assert.equal(second.pending.length, 0);
    assert.equal(second.scan.counts.skipped.existing, 1);
    assert.match(compose.decisionReply(second).text, /没有新的决策/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有候选时回执明确说「没有新的决策」，不是空白也不是假成功', async () => {
  const root = tempRoot();
  try {
    const { alpha } = seedProjects(root);
    const result = await runDecisionScan({
      state: normalizeDecisionScanState({}),
      project: alpha,
      // 会话根目录不存在：按 0 段处理，但回执仍要说清「扫了、没候选」。
      roots: [{ source: 'codex', dir: path.join(root, 'missing-sessions') }],
      scan: scanSessions,
      extract: echoExtract
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'scanned');
    assert.equal(result.receipt.status, 'empty');
    assert.equal(result.added.length, 0);
    assert.equal(result.pending.length, 0);
    const reply = compose.decisionReply(result);
    assert.match(reply.text, /没有新的决策/u);
    assert.deepEqual(reply.blocks, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('扫描有截断 / 读不出来时回执是 partial；扫描抛错是 failed，不伪造空成功', async () => {
  const root = tempRoot();
  try {
    const { alpha } = seedProjects(root);
    writeSession(root, { cwd: alpha.root, id: 'alpha-p1', text: `${alphaDecision}（一）`, reply: '好' });
    writeSession(root, { cwd: alpha.root, id: 'alpha-p2', text: '日志统一脱敏，不再打 token', reply: '好' });

    const partial = await runDecisionScan({
      state: normalizeDecisionScanState({}),
      project: alpha,
      roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
      scan: scanSessions,
      extract: echoExtract,
      scanOptions: { maxSessions: 1 }
    });
    assert.equal(partial.receipt.status, 'partial');
    assert.equal(partial.receipt.truncated, 1);
    assert.match(compose.decisionReply(partial).text, /部分/u);

    const failed = await runDecisionScan({
      state: normalizeDecisionScanState({}),
      project: alpha,
      roots: [],
      scan: async () => { throw new Error('会话目录读不动'); }
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.mode, 'failed');
    assert.ok(failed.pending.length === 0);
    assert.match(compose.decisionReply(failed).text, /会话目录读不动/u);
    assert.match(compose.decisionReply(failed).text, /没有写任何候选/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未选项目：命令拒绝扫描，回执说清先选项目', async () => {
  const result = await runDecisionScan({
    state: normalizeDecisionScanState({}), project: null, roots: [], scan: scanSessions
  });
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'no-project');
  assert.match(compose.decisionReply(result).text, /先选一个项目/u);
});

test('已有未处理候选：先给待办，不再扫描；回执说明还有 N 条', async () => {
  const root = tempRoot();
  try {
    const { alpha } = seedProjects(root);
    const fingerprint = decisionFingerprint({ projectId: 'alpha', text: alphaDecision });
    const merged = mergeCandidates(normalizeDecisionScanState({}), [{
      fingerprint,
      projectId: 'alpha',
      phenomenon: alphaDecision,
      intent: '换成 esbuild',
      abandoned: '',
      reason: '',
      missingReason: true,
      quote: { user: alphaDecision, assistant: '好' },
      evidence: [],
      source: 'codex',
      sessionPath: 'C:/tmp/rollout.jsonl'
    }], { projectId: 'alpha', now: AT });

    let scanned = false;
    const result = await runDecisionScan({
      state: merged.state,
      project: alpha,
      roots: [{ source: 'codex', dir: path.join(root, 'sessions') }],
      scan: async () => { scanned = true; return scanSessions({ roots: [] }); }
    });
    assert.equal(scanned, false, '有待办时不该扫描');
    assert.equal(result.mode, 'pending');
    assert.equal(result.pending.length, 1);
    const reply = compose.decisionReply(result);
    assert.match(reply.text, /还有 1 条/u);
    assert.equal(reply.blocks.length, 1);
    assert.equal(reply.blocks[0].kind, 'decision');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('候选卡：四个字段都在，缺理由显式标注，动作只有接受 / 拒绝', () => {
  const candidate = {
    fingerprint: 'fp-card',
    projectId: 'alpha',
    projectName: 'Alpha 项目',
    phenomenon: '构建太慢，统一改成 esbuild 打包',
    intent: '用 esbuild 替换 tsc',
    abandoned: 'webpack',
    reason: '',
    missingReason: true,
    source: 'codex',
    sessionId: 'alpha-s1',
    sessionPath: 'C:/tmp/rollout.jsonl',
    quote: { user: '构建太慢，统一改成 esbuild 打包', assistant: '好' },
    evidence: []
  };
  const [card] = compose.decisionCandidateBlocks([candidate]);
  assert.equal(card.type, 'review');
  assert.equal(card.kind, 'decision');
  assert.equal(card.fingerprint, 'fp-card');
  assert.equal(card.projectId, 'alpha');
  assert.equal(card.missingReason, true);
  const labels = card.rows.map((row) => row[0]);
  for (const label of ['现象', '选择', '放弃的方案', '理由']) {
    assert.ok(labels.includes(label), `缺字段：${label}`);
  }
  assert.match(card.rows.find((row) => row[0] === '理由')[1], /缺理由/u);
  assert.deepEqual(card.actions.map((action) => action.id), ['accept', 'reject']);

  // 只有缺理由时提示会追问；理由已经在的候选不再多问。
  assert.match(card.note, /可跳过/u);
  const [filled] = compose.decisionCandidateBlocks([{ ...candidate, reason: '反馈更快', missingReason: false }]);
  assert.equal(filled.note.includes('可跳过'), false);

  // 审核卡归一化要把决策候选的字段带进渲染层。
  const model = blocks.normalizeBlock(card);
  assert.equal(model.kind, 'decision');
  assert.equal(model.fingerprint, 'fp-card');
  assert.equal(model.projectId, 'alpha');
  assert.equal(model.missingReason, true);
});

test('界面接线：内置命令、预加载桥、主进程处理器与审核动作都在', () => {
  assert.ok(compose.BUILTIN_COMMANDS.some((command) => command.text === '/提炼决策'));
  assert.equal(compose.isExactBuiltinCommand('/提炼决策'), true);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const preload = read('desktop/preload.cjs');
  const main = read('desktop/main.cjs');
  const stream = read('desktop/shell-stream.cjs');

  assert.match(preload, /scanDecisions:\s*\(input\)\s*=>\s*invoke\('companion:decision-scan'/u);
  assert.match(preload, /pendingDecisions:\s*\(input\)\s*=>\s*invoke\('companion:decision-pending'/u);
  assert.match(preload, /acceptDecision:\s*\(input\)\s*=>\s*invoke\('companion:decision-accept'/u);
  assert.match(preload, /rejectDecision:\s*\(input\)\s*=>\s*invoke\('companion:decision-reject'/u);
  for (const channel of ['decision-scan', 'decision-pending', 'decision-accept', 'decision-reject']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('companion:${channel}'`, 'u'), channel);
  }
  // 显式触发：没有定时器把决策扫描挂在轮询里。
  assert.equal(/setInterval\([^)]*decisionScan/u.test(main), false);
  // 审核卡的动作落到决策接受 / 拒绝上。
  assert.match(stream, /kind === 'decision'/u);
  assert.match(stream, /acceptDecision/u);
  assert.match(stream, /rejectDecision/u);
});
