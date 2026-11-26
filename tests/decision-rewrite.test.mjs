// #138 决策候选改写与 `/记决策` 手动入口。
//
// 覆盖四条验收面：
// 1. 候选改写选择 / 放弃的方案 / 理由后接受，写进库的是改后的内容，现象只读；
// 2. 取消（取消改写 / 取消记决策）一个字都不写；
// 3. `/记决策` 确认后只写一条决策，重复确认不写第二条；
// 4. 理由留空仍是显式的「缺理由」，不填占位词。
//
// 这里不读真实会话、不调模型：候选直接按 decision-scan 的形状构造，
// 入库走真实的 PersonalKnowledgeStore；表单与动作分发是纯函数，断言不必起窗口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { DecisionScanStore } from '../src/memory/decision-scan-store.mjs';
import { decisionFingerprint } from '../src/memory/decision-draft.mjs';
import { decisionViewOf } from '../src/memory/decision-status.mjs';
import {
  normalizeDecisionScanState,
  mergeCandidates,
  pendingOf,
  applyDecisionEdits,
  acceptPendingCandidate
} from '../src/memory/decision-scan.mjs';
import { confirmDecisionCandidate } from '../src/memory/decision-confirm.mjs';

const require = createRequire(import.meta.url);
const compose = require('../desktop/shell-compose.cjs');
const blocks = require('../desktop/shell-blocks.cjs');
const form = require('../desktop/decision-form.cjs');

const AT = '2026-11-26T09:00:00.000Z';
const PHENOMENON = '构建太慢，统一改成 esbuild 打包';

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decision-rewrite-'));

const makeStores = (root) => {
  const scanStore = new DecisionScanStore({ file: path.join(root, 'memory-scan.json') });
  const personal = new PersonalKnowledgeStore(path.join(root, 'knowledge.sqlite'), { logger: null });
  return { scanStore, personal };
};

const seedPending = (scanStore, overrides = {}) => {
  const candidate = {
    projectId: 'alpha',
    projectName: 'Alpha 项目',
    fingerprint: decisionFingerprint({ projectId: 'alpha', text: PHENOMENON }),
    phenomenon: PHENOMENON,
    intent: '用 esbuild 替换 tsc',
    abandoned: 'webpack',
    reason: '',
    missingReason: true,
    quote: { user: PHENOMENON, assistant: '好，换成 esbuild' },
    evidence: [{ role: 'user', index: 0, sessionId: 'alpha-s1', at: AT }],
    source: 'codex',
    sessionId: 'alpha-s1',
    sessionPath: 'C:/tmp/rollout-alpha-s1.jsonl',
    ...overrides
  };
  const merged = mergeCandidates(normalizeDecisionScanState({}), [candidate], {
    projectId: 'alpha', projectName: 'Alpha 项目', now: AT
  });
  scanStore.write(merged.state);
  return { candidate, pending: pendingOf(merged.state, 'alpha')[0] };
};

test('改写后接受：写入改后的选择 / 放弃 / 理由，现象与指纹不变，仍只有一条决策', () => {
  const root = tempRoot();
  try {
    const { scanStore, personal } = makeStores(root);
    try {
      const { candidate } = seedPending(scanStore);

      const accepted = acceptPendingCandidate({
        scanStore,
        personalStore: personal,
        projectId: 'alpha',
        fingerprint: candidate.fingerprint,
        edits: {
          intent: '用 esbuild 替换 tsc，保留类型检查脚本',
          abandoned: 'webpack 与 babel',
          reason: '反馈速度比打包体积更重要'
        },
        now: AT
      });
      assert.equal(accepted.ok, true);
      assert.equal(accepted.created, true);
      assert.equal(accepted.missingReason, false);

      assert.equal(personal.list().length, 1, '改写后接受只写一条决策');
      const unit = personal.get(accepted.id);
      assert.equal(unit.decision.intent, '用 esbuild 替换 tsc，保留类型检查脚本');
      assert.equal(unit.decision.abandoned, 'webpack 与 babel');
      assert.equal(unit.decision.reason, '反馈速度比打包体积更重要');
      assert.equal(unit.decision.reasonMissing, false);
      // 现象是只读的：改写字段不能连它一起换掉，指纹也不变。
      assert.equal(unit.title, PHENOMENON);
      assert.equal(unit.decision.fingerprint, candidate.fingerprint);
      assert.match(unit.content, /选择：用 esbuild 替换 tsc，保留类型检查脚本/u);
      assert.doesNotMatch(unit.content, /webpack$/mu);
      assert.equal(pendingOf(scanStore.read(), 'alpha').length, 0, '接受后待办移除');

      // 同一指纹再接受一次：已经不在待办里，也不会写第二条。
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

test('改写只动三个可编辑字段：现象改了也无效，理由清空仍是显式缺理由', () => {
  const candidate = {
    projectId: 'alpha',
    fingerprint: 'fp-edit',
    phenomenon: PHENOMENON,
    intent: '旧选择',
    abandoned: '旧放弃',
    reason: '旧理由',
    missingReason: false
  };
  const edited = applyDecisionEdits(candidate, {
    phenomenon: '伪造的新现象',
    intent: '新选择',
    abandoned: '新放弃',
    reason: '   '
  });
  assert.equal(edited.phenomenon, PHENOMENON, '现象只读，不接受改写');
  assert.equal(edited.fingerprint, 'fp-edit');
  assert.equal(edited.intent, '新选择');
  assert.equal(edited.abandoned, '新放弃');
  assert.equal(edited.reason, '');
  assert.equal(edited.missingReason, true, '理由被清空就显式回到缺理由');

  // 没有改写时原样返回，调用方不必分支。
  assert.equal(applyDecisionEdits(candidate, null), candidate);
});

test('取消不写：取消改写与取消记决策都只收起表单，知识库与待办都不动', () => {
  const root = tempRoot();
  try {
    const { scanStore, personal } = makeStores(root);
    try {
      const { candidate } = seedPending(scanStore);
      const beforePending = scanStore.read();

      // 候选卡：点「取消改写」只是收起，不回答、不写库。
      const collapse = form.reviewIntent({
        mode: 'candidate',
        action: 'cancel-edit',
        card: { missingReason: true, values: { reason: '' } }
      });
      assert.equal(collapse.type, 'collapse');
      assert.equal(collapse.answered, undefined);
      assert.equal(collapse.edits, undefined);
      assert.equal(personal.list().length, 0, '取消改写不写知识库');
      assert.deepEqual(scanStore.read().pending, beforePending.pending, '取消改写不动待办');

      // 记决策卡：点「取消」只记一条回执，不写任何决策。
      const cancel = form.reviewIntent({
        mode: 'compose',
        action: 'cancel',
        fields: { phenomenon: '一条没写完的决策', intent: '选择', abandoned: '放弃', reason: '' }
      });
      assert.equal(cancel.type, 'cancel');
      assert.equal(cancel.edits, undefined);
      assert.equal(personal.list().length, 0, '取消记决策不写知识库');

      // 待办里的候选原样还在，之后再接受仍能走原内容。
      assert.equal(pendingOf(scanStore.read(), 'alpha')[0].fingerprint, candidate.fingerprint);
    } finally {
      personal.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/记决策 确认只写一条决策；理由留空显式缺理由，来源标手动填写，不伪造会话出处', () => {
  const root = tempRoot();
  try {
    const { personal } = makeStores(root);
    try {
      const reply = compose.decisionComposeReply({ projectId: 'alpha', projectName: 'Alpha 项目' });
      assert.match(reply.text, /确认后写入/u);
      assert.equal(reply.blocks.length, 1);
      const [card] = reply.blocks;
      assert.equal(card.type, 'review');
      assert.equal(card.kind, 'decision');
      assert.equal(card.mode, 'compose');
      assert.equal(card.editable, true);
      assert.equal(card.projectId, 'alpha');
      assert.deepEqual(card.actions.map((action) => action.id), ['confirm', 'cancel']);

      const candidate = form.composeCandidate({
        projectId: 'alpha',
        projectName: 'Alpha 项目',
        fields: { phenomenon: '发布拆成草稿与确认两步', intent: '先草稿，再输入确认', abandoned: '一键发布', reason: '' }
      });
      const result = confirmDecisionCandidate({ personalStore: personal, candidate, reason: '' });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.equal(result.missingReason, true);

      assert.equal(personal.list().length, 1, '/记决策 确认后只有一条决策');
      const unit = personal.get(result.id);
      assert.equal(unit.title, '发布拆成草稿与确认两步');
      assert.equal(unit.decision.intent, '先草稿，再输入确认');
      assert.equal(unit.decision.abandoned, '一键发布');
      assert.equal(unit.decision.reason, '');
      assert.equal(unit.decision.reasonMissing, true);
      assert.doesNotMatch(unit.content, /未说明|理由：/u, '缺理由不填占位词');
      // 手动入口不冒充会话扫描：来源是 manual，且没有会话 id / 路径。
      assert.equal(unit.decision.source.kind, 'manual');
      assert.equal(unit.decision.source.source, 'manual');
      assert.equal(unit.decision.source.sessionId, '');
      assert.equal(unit.sourceRef, null);
      assert.deepEqual(unit.evidenceRefs, []);
      assert.equal(decisionViewOf(unit).sourceLabel, '手动填写');

      // 同一现象 + 同一项目再确认：走幂等路径，不写第二条。
      const again = confirmDecisionCandidate({ personalStore: personal, candidate, reason: '换个理由' });
      assert.equal(again.created, false);
      assert.equal(personal.list().length, 1);
      // 第二次补的理由不会覆盖已入库的那条（仍是缺理由）。
      assert.equal(personal.get(result.id).decision.reasonMissing, true);
    } finally {
      personal.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('候选卡与记决策卡共用同一张表单：现象在改写时只读，可编辑字段都是三项', () => {
  const { candidate } = { candidate: {
    projectId: 'alpha',
    fingerprint: 'fp-card',
    phenomenon: PHENOMENON,
    intent: '用 esbuild 替换 tsc',
    abandoned: 'webpack',
    reason: '',
    missingReason: true,
    source: 'codex',
    sessionId: 'alpha-s1'
  } };
  const [card] = compose.decisionCandidateBlocks([candidate]);
  assert.equal(card.editable, true);
  assert.equal(card.mode, 'candidate');
  assert.equal(card.phenomenon, PHENOMENON);
  assert.deepEqual(card.values, {
    phenomenon: PHENOMENON, intent: '用 esbuild 替换 tsc', abandoned: 'webpack', reason: ''
  });
  assert.deepEqual(card.actions.map((action) => action.id), ['accept', 'rewrite', 'reject']);
  assert.deepEqual(card.formActions.map((action) => action.id), ['save-accept', 'cancel-edit']);

  // 归一化后渲染层拿到的还是同一张表单，不被拆成第二套。
  const model = blocks.normalizeBlock(card);
  assert.equal(model.kind, 'decision');
  assert.equal(model.mode, 'candidate');
  assert.equal(model.editable, true);
  assert.equal(model.phenomenon, PHENOMENON);
  assert.equal(model.values.reason, '');
  assert.deepEqual(model.formActions.map((action) => action.id), ['save-accept', 'cancel-edit']);

  // 记决策同一张卡：空白值、确认 / 取消，没有第二套表单。
  const composeCard = compose.decisionComposeReply({ projectId: 'alpha', projectName: 'Alpha 项目' }).blocks[0];
  const composeModel = blocks.normalizeBlock(composeCard);
  assert.equal(composeModel.mode, 'compose');
  assert.equal(composeModel.editable, true);
  assert.deepEqual(composeModel.values, { phenomenon: '', intent: '', abandoned: '', reason: '' });
  assert.equal(composeModel.formActions.length, 0, '记决策的动作在卡片底部，不另起一套表单动作');

  // #135 存下来的旧卡没有 values：改写时按行反推初值，理由那行的「缺理由」提示不冒充理由。
  const legacy = blocks.normalizeBlock({
    type: 'review',
    kind: 'decision',
    projectId: 'alpha',
    fingerprint: 'fp-legacy',
    missingReason: true,
    rows: [
      ['现象', '旧现象'],
      ['选择', '旧选择'],
      ['放弃的方案', '旧放弃'],
      ['理由', '缺理由（接受时可补一句）']
    ]
  });
  assert.equal(legacy.values.phenomenon, '旧现象');
  assert.equal(legacy.values.intent, '旧选择');
  assert.equal(legacy.values.abandoned, '旧放弃');
  assert.equal(legacy.values.reason, '');
});

test('动作分发：缺理由的接受先追问，保存并接受带改写，记决策空现象拒绝写入', () => {
  // 缺理由的普通接受：先问一句（#135 原有行为）。
  assert.equal(form.reviewIntent({
    mode: 'candidate', action: 'accept', card: { missingReason: true, values: { reason: '' } }
  }).type, 'ask-reason');

  // 理由已在：直接接受，不带改写。
  const filled = form.reviewIntent({
    mode: 'candidate', action: 'accept', card: { missingReason: false, values: { reason: '反馈更快' } }
  });
  assert.equal(filled.type, 'accept');
  assert.equal(filled.edits, null);
  assert.equal(filled.reason, '反馈更快');

  // 保存并接受：把三个可编辑字段作为 edits 带下去；现象不在里面。
  const saved = form.reviewIntent({
    mode: 'candidate',
    action: 'save-accept',
    fields: { phenomenon: '伪造现象', intent: '新选择', abandoned: '新放弃', reason: '新理由' }
  });
  assert.equal(saved.type, 'accept');
  assert.deepEqual(saved.edits, { intent: '新选择', abandoned: '新放弃', reason: '新理由' });
  assert.equal(saved.reason, '新理由');

  // 改写按钮只展开，不改任何东西；拒绝直接拒绝。
  assert.equal(form.reviewIntent({ mode: 'candidate', action: 'rewrite' }).type, 'expand');
  assert.equal(form.reviewIntent({ mode: 'candidate', action: 'reject' }).type, 'reject');

  // 记决策：现象空着不许写，填好才是确认。
  const invalid = form.reviewIntent({
    mode: 'compose', action: 'confirm', fields: { phenomenon: '   ', intent: '选择' }
  });
  assert.equal(invalid.type, 'invalid');
  assert.match(invalid.message, /现象不能为空/u);

  const confirmed = form.reviewIntent({
    mode: 'compose', action: 'confirm', fields: { phenomenon: '现象', intent: '选择', abandoned: '', reason: '' }
  });
  assert.equal(confirmed.type, 'confirm');
  assert.equal(confirmed.fields.phenomenon, '现象');
  assert.equal(confirmed.fields.intent, '选择');
});

test('未改写的 #135 候选路径仍然可用：补理由接受写一条，缺理由保持标记', () => {
  const root = tempRoot();
  try {
    const { scanStore, personal } = makeStores(root);
    try {
      const { candidate } = seedPending(scanStore);
      const result = acceptPendingCandidate({
        scanStore, personalStore: personal, projectId: 'alpha', fingerprint: candidate.fingerprint, reason: '补一句理由'
      });
      assert.equal(result.ok, true);
      assert.equal(result.missingReason, false);
      assert.equal(personal.get(result.id).decision.reason, '补一句理由');
    } finally {
      personal.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // `/提炼决策` 的待办卡还是 kind=decision，并多出「改写」这一个动作。
  const pending = [{ ...seedPendingCard() }];
  const card = compose.decisionReply({ mode: 'pending', pending }).blocks[0];
  assert.equal(card.kind, 'decision');
  assert.deepEqual(card.actions.map((action) => action.id), ['accept', 'rewrite', 'reject']);
});

const seedPendingCard = () => ({
  projectId: 'alpha',
  fingerprint: 'fp-pending',
  phenomenon: PHENOMENON,
  intent: '用 esbuild 替换 tsc',
  abandoned: 'webpack',
  reason: '',
  missingReason: true,
  source: 'codex',
  sessionId: 'alpha-s1'
});

test('界面接线：同一张表单、两个动作落点、主进程只增一个 edits 入参', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

  assert.ok(compose.BUILTIN_COMMANDS.some((command) => command.text === '/记决策'));
  assert.equal(compose.isExactBuiltinCommand('/记决策'), true);

  const html = read('desktop/shell.html');
  assert.match(html, /<script src="\.\/decision-form\.cjs"><\/script>/u);

  const view = read('desktop/shell-blocks-view.js');
  assert.match(view, /review-form/u);
  assert.match(view, /data-decision-field|decisionField/u);

  const stream = read('desktop/shell-stream.cjs');
  for (const token of ['data-decision-field', 'save-accept', 'cancel-edit', 'confirmDecision', 'acceptDecision']) {
    assert.ok(stream.includes(token), `shell-stream 缺少 ${token}`);
  }
  assert.match(stream, /reviewIntent/u);

  const preload = read('desktop/preload.cjs');
  assert.match(preload, /confirmDecision:\s*\(input\)\s*=>\s*invoke\('companion:decision-confirm'/u);
  const main = read('desktop/main.cjs');
  assert.match(main, /edits:\s*input\?\.edits/u, '接受接口要把改写字段交给 acceptPendingCandidate');
  assert.match(main, /acceptPendingCandidate/u);
});
