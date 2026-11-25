// #87 决策确认与入库：确认一条候选 → 知识表里出现一条 kind=decision；
// 加上可选理由；缺理由显式标记；决策状态与验证状态分开；结束状态不再算现状。
//
// 存储用临时库：老库补列、两套状态并存、状态流转、未确认不写库都在真实 SQLite 上断言。
// 视图与状态判断用纯函数测，不启动 Electron、不调模型、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { draftDecisions } from '../src/memory/decision-draft.mjs';
import {
  confirmDecisionCandidate,
  changeDecisionStatus,
  decisionContentOf,
  decisionDraftFromCandidate
} from '../src/memory/decision-confirm.mjs';
import {
  decisionRetrievalView,
  decisionStatusChange,
  decisionStatusOf,
  isCurrentDecision
} from '../src/memory/decision-status.mjs';
import { knowledgeBrowseView } from '../src/knowledge/browse.mjs';
import { projectLibraryView } from '../src/project-library.mjs';

const AT = '2026-11-25T10:00:00.000Z';

const candidateOf = (overrides = {}) => ({
  fingerprint: 'fp-esbuild',
  projectId: 'p1',
  projectName: 'P1',
  phenomenon: '构建太慢，改成 esbuild 打包',
  intent: '用 esbuild 替换 tsc',
  abandoned: 'webpack',
  reason: '',
  missingReason: true,
  partial: false,
  quote: {
    user: '构建太慢，改成 esbuild 打包',
    assistant: '好，用 esbuild 替换 tsc，webpack 那条路不再走'
  },
  evidence: [
    { role: 'user', index: 1, sessionId: 's1', at: AT },
    { role: 'assistant', index: 2, sessionId: 's1', at: AT }
  ],
  source: 'codex',
  sessionPath: 'C:/tmp/codex-session.jsonl',
  ...overrides
});

const makeTempDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-confirm-'));
  return { dir, file: path.join(dir, 'knowledge.sqlite') };
};

/** 造一个 #87 之前的老库：personal_units 没有 decision_status 列，但已有一条普通知识。 */
const makeLegacyDb = (file) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE personal_units (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision>0),
      payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    db.prepare('INSERT INTO personal_units(id,revision,payload,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('personal.legacy', 1, JSON.stringify({
        title: '旧知识', content: '升级前就存在的条目', kind: 'note', layer: 'applied',
        scope: 'personal', projectId: null, domains: [], tags: [], evidenceRefs: [],
        verificationStatus: 'verified', relations: {}, sourceRef: null
      }), AT, AT);
  } finally {
    db.close();
  }
};

const existing = (file) => {
  const db = new DatabaseSync(file);
  try {
    return db.prepare('PRAGMA table_info(personal_units)').all().map((row) => row.name);
  } finally {
    db.close();
  }
};

test('老库升级：补上 decision_status 列，已有行原样保留且该列为空', () => {
  const { dir, file } = makeTempDb();
  try {
    makeLegacyDb(file);
    assert.equal(existing(file).includes('decision_status'), false, '升级前不该有这一列');

    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      assert.equal(store.lastDecisionStatusMigration.added, true);
      assert.equal(store.lastDecisionStatusMigration.reason, 'legacy');
      assert.equal(existing(file).includes('decision_status'), true, '升级后应有这一列');
      const legacy = store.get('personal.legacy');
      assert.ok(legacy, '老数据不能因为升级消失');
      assert.equal(legacy.title, '旧知识');
      assert.equal(legacy.verificationStatus, 'verified');
      // 非决策条目的决策状态列为空：不拿验证状态冒充。
      assert.equal(legacy.decisionStatus, null);
      // 再开一次是空操作。
      const again = new PersonalKnowledgeStore(file, { logger: null });
      try {
        assert.equal(again.lastDecisionStatusMigration.added, false);
        assert.equal(again.lastDecisionStatusMigration.reason, 'current');
      } finally { again.close(); }
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('确认候选：写一条 kind=decision 的知识，带来源、时间与证据；未确认不写任何数据', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      // 先用真实提炼链路产一条候选：证明确认吃的是扫描产出的形状，而不是测试专用对象。
      const draft = draftDecisions({
        projectId: 'p1',
        sessionId: 's1',
        fragments: [
          { role: 'user', text: candidateOf().quote.user, at: AT },
          { role: 'assistant', text: candidateOf().quote.assistant, at: AT }
        ],
        extract: (pair) => ({
          phenomenon: pair.user.text,
          intent: pair.assistant?.text ?? '',
          abandoned: 'webpack',
          reason: ''
        })
      });
      assert.equal(draft.candidates.length, 1);
      const candidate = { ...draft.candidates[0], source: 'codex', sessionPath: 'C:/tmp/codex-session.jsonl', projectName: 'P1' };

      // 未确认：库里还是 0 行（提炼只产候选，不落库）。
      assert.equal(store.list().length, 0);
      assert.equal(store.listDecisions().length, 0);

      const result = confirmDecisionCandidate({ personalStore: store, candidate, reason: '反馈速度比打包体积更重要' });
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.equal(result.status, 'active');
      assert.equal(result.missingReason, false);

      const rows = store.list();
      assert.equal(rows.length, 1, '确认后只写一行');
      const unit = store.get(result.id);
      assert.equal(unit.kind, 'decision');
      assert.equal(unit.scope, 'project');
      assert.equal(unit.projectId, 'p1');
      assert.equal(unit.decisionStatus, 'active');
      assert.equal(unit.decision.reason, '反馈速度比打包体积更重要');
      assert.equal(unit.decision.reasonMissing, false);
      assert.ok(unit.decision.decidedAt, '确认时间要入库');
      assert.equal(unit.decision.source.source, 'codex');
      assert.equal(unit.decision.source.sessionId, 's1');
      assert.match(unit.sourceRef, /session-scan:codex:/u);
      assert.deepEqual(unit.evidenceRefs, ['codex:s1#user:0', 'codex:s1#assistant:1']);

      // 幂等：同一句话再确认一次不写第二条。
      const second = confirmDecisionCandidate({ personalStore: store, candidate, reason: '换个理由' });
      assert.equal(second.ok, true);
      assert.equal(second.created, false);
      assert.equal(store.list().length, 1);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('不补理由：正文不编占位词，reasonMissing 与界面「缺理由」都在', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const result = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-no-reason' }) });
      const unit = store.get(result.id);
      assert.equal(result.missingReason, true);
      assert.equal(unit.decision.reason, '');
      assert.equal(unit.decision.reasonMissing, true);
      // 正文只列真正有的字段，不用「未说明」冒充理由。
      assert.doesNotMatch(unit.content, /未说明|理由：/u);
      assert.match(unit.content, /放弃的方案：webpack/u);

      const view = knowledgeBrowseView({ projectId: 'p1', units: store.list() });
      const item = view.groups.find((group) => group.key === 'knowledge').items[0];
      assert.equal(item.badge, '生效中', '决策徽章是决策状态，不是待验证');
      assert.equal(item.reasonMissing, true);
      assert.equal(item.current, true);
      assert.match(item.detail, /决策/u);
      assert.match(item.detail, /Codex 会话/u);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('决策状态与验证状态并存：改决策状态不动 verificationStatus，反之亦然', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const { id } = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-coexist' }) });
      const before = store.get(id);
      assert.equal(before.verificationStatus, 'unverified');
      assert.equal(before.decisionStatus, 'active');

      const changed = changeDecisionStatus({ personalStore: store, id, status: 'superseded' });
      assert.equal(changed.ok, true);
      const after = store.get(id);
      assert.equal(after.verificationStatus, 'unverified', '验证状态不能被决策状态改写');
      assert.equal(after.decisionStatus, 'superseded');
      assert.equal(after.revision, before.revision + 1, '状态变更是新的一版');
      assert.deepEqual(after.decision.history.map((entry) => [entry.from, entry.to]), [['active', 'superseded']]);
      assert.ok(after.decision.supersededAt);

      // 库里的普通知识不受影响：验证状态照旧，决策状态为空。
      const note = store.create({
        title: '普通知识', content: '与决策无关', kind: 'note', layer: 'applied', scope: 'personal',
        verificationStatus: 'verified', evidenceRefs: ['sandbox:run1']
      });
      assert.equal(store.get(note.id).decisionStatus, null);
      assert.equal(store.get(note.id).verificationStatus, 'verified');
      assert.equal(decisionStatusOf(store.get(note.id)), null, '非决策条目没有决策状态');
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('状态流转：只有生效中能结束；结束状态是终态，不提供改回', () => {
  assert.deepEqual(decisionStatusChange('active', 'superseded'), { ok: true, reason: null, message: '' });
  assert.deepEqual(decisionStatusChange('active', 'abandoned'), { ok: true, reason: null, message: '' });
  for (const [from, to, reason] of [
    ['superseded', 'abandoned', 'terminal'],
    ['superseded', 'active', 'terminal'],
    ['abandoned', 'active', 'terminal'],
    ['active', 'nonsense', 'unknown-status'],
    ['active', 'active', 'unchanged']
  ]) {
    const verdict = decisionStatusChange(from, to);
    assert.equal(verdict.ok, false, `${from} → ${to} 不该被接受`);
    assert.equal(verdict.reason, reason);
  }

  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const { id } = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-flow' }) });
      assert.equal(changeDecisionStatus({ personalStore: store, id, status: 'abandoned' }).ok, true);
      // 终态：再改回或改成另一个结束状态都会被拒，库里状态不变。
      const back = changeDecisionStatus({ personalStore: store, id, status: 'active' });
      assert.equal(back.ok, false);
      assert.match(back.reason, /另记一条新决策/u);
      assert.equal(store.get(id).decisionStatus, 'abandoned');
      // 非决策条目不能带决策状态。
      const note = store.create({ title: '普通知识', content: '内容', kind: 'note', scope: 'personal' });
      const notDecision = changeDecisionStatus({ personalStore: store, id: note.id, status: 'abandoned' });
      assert.equal(notDecision.ok, false);
      assert.match(notDecision.reason, /只有决策/u);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('检索：已被取代 / 已放弃的决策不再算现状，但仍单独列得出来', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const alive = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-alive', phenomenon: '统一用 esbuild 打包', abandoned: 'rollup' }) });
      const ended = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-ended', phenomenon: '统一用 webpack 打包' }) });
      changeDecisionStatus({ personalStore: store, id: ended.id, status: 'abandoned' });

      const current = decisionRetrievalView({ units: store.list(), projectId: 'p1' });
      assert.deepEqual(current.items.map((item) => item.id), [alive.id], '检索只给生效中的');
      assert.deepEqual(current.ended.map((item) => item.id), [ended.id], '结束的单独列出');
      assert.equal(current.counts.current, 1);
      assert.equal(current.counts.ended, 1);

      // 关键词检索同样不把结束状态当现状。
      const byKeyword = decisionRetrievalView({ units: store.list(), projectId: 'p1', query: 'webpack' });
      assert.equal(byKeyword.items.length, 0);
      assert.equal(byKeyword.ended.length, 1);
      assert.equal(byKeyword.reason.code, 'all-ended');

      // 界面：结束的仍在「知识」组，但带「不算现状」的说明，且排在生效中之后。
      const view = knowledgeBrowseView({ projectId: 'p1', units: store.list() });
      const items = view.groups.find((group) => group.key === 'knowledge').items;
      assert.deepEqual(items.map((item) => item.id), [alive.id, ended.id]);
      assert.equal(items[0].current, true);
      assert.equal(items[1].current, false);
      assert.equal(items[1].badge, '已放弃');
      assert.match(items[1].detail, /不算现状/u);
      assert.equal(isCurrentDecision(store.get(ended.id)), false);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('跨项目沿用项目级 → 域级升级：升域后项目级检索仍靠 originProjectId 说清来源', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const { id } = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-domain' }) });
      const promoted = store.promoteDecisionToDomain(id, { domainIds: ['software-engineering'] });
      assert.equal(promoted.scope, 'domain');
      assert.equal(promoted.layer, 'domain');
      assert.equal(promoted.projectId, null);
      assert.deepEqual(promoted.domains, ['software-engineering']);
      assert.equal(promoted.originProjectId, 'p1');
      assert.deepEqual(promoted.promotedFrom, { scope: 'project', projectId: 'p1' });
      // 升域不是验证也不是裁决：状态与验证状态都不动。
      assert.equal(promoted.decisionStatus, 'active');
      assert.equal(promoted.verificationStatus, 'unverified');
      // 域级决策对任何项目可见；项目级检索也仍然看得到它。
      assert.equal(decisionRetrievalView({ units: store.list(), projectId: 'p2' }).items.length, 1);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('项目库视图：决策读自己的状态，不拿验证状态冒充', () => {
  const { dir, file } = makeTempDb();
  try {
    const store = new PersonalKnowledgeStore(file, { logger: null });
    try {
      const { id } = confirmDecisionCandidate({ personalStore: store, candidate: candidateOf({ fingerprint: 'fp-library' }) });
      const view = projectLibraryView({
        project: { id: 'p1', name: 'P1', domains: ['software-engineering'] },
        lessons: [],
        knowledge: store.list()
      });
      const entry = view.groups.find((group) => group.key === 'contributedKnowledge').items[0];
      assert.equal(entry.kind, 'decision');
      assert.equal(entry.status, 'active');
      assert.equal(entry.badge, '生效中');
      assert.equal(entry.current, true);
      assert.match(entry.detail, /决策 · 本项目贡献 · 生效中/u);
      // 决策不会因为「生效中」被当成已验证的知识。
      assert.equal(view.sections.find((section) => section.key === 'verified').count, 1);
      assert.equal(view.sections.find((section) => section.key === 'observing').count, 0);

      changeDecisionStatus({ personalStore: store, id, status: 'superseded' });
      const after = projectLibraryView({
        project: { id: 'p1', name: 'P1', domains: ['software-engineering'] },
        knowledge: store.list()
      });
      const endedEntry = after.groups.find((group) => group.key === 'contributedKnowledge').items[0];
      assert.equal(endedEntry.badge, '已被取代');
      assert.equal(endedEntry.current, false);
      assert.match(endedEntry.detail, /不算现状/u);
      assert.equal(after.sections.find((section) => section.key === 'verified').count, 0);
      assert.equal(after.sections.find((section) => section.key === 'observing').count, 1);
    } finally { store.close(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('正文拼装：缺哪行省哪行，理由不编造', () => {
  assert.equal(
    decisionContentOf({ phenomenon: '换 esbuild', intent: '替换 tsc', abandoned: 'webpack', reason: '' }),
    ['决策：换 esbuild', '选择：替换 tsc', '放弃的方案：webpack'].join('\n')
  );
  assert.match(decisionContentOf({ phenomenon: '换 esbuild', reason: '快' }), /理由：快/u);
  // 草稿函数本身不写库，也不读时钟：时间由调用方给。
  const { payload, fingerprint } = decisionDraftFromCandidate({ candidate: candidateOf(), now: AT });
  assert.equal(fingerprint, 'fp-esbuild');
  assert.equal(payload.decisionStatus, 'active');
  assert.equal(payload.decision.decidedAt, AT);
  assert.equal(payload.decision.reasonMissing, true);
  assert.equal(payload.verificationStatus, 'unverified');
  assert.equal('decisionStatus' in payload.decision, false);
});

// 界面接线：知识页的「确认」入口、预加载桥与主进程处理器必须对上，否则点了没反应。
test('知识页有确认入口与决策状态动作，且从面板到主进程是一条完整的线', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const html = read('desktop/panel.html');
  const panel = read('desktop/panel.js');
  const preload = read('desktop/preload.cjs');
  const main = read('desktop/main.cjs');

  const knowledge = html.slice(html.indexOf('id="modeB"'), html.indexOf('id="modeC"'));
  assert.match(knowledge, /id="kbScanCandidates"/u);
  assert.match(panel, /dataset\.role = 'decision-confirm'/u);
  assert.match(panel, /window\.companion\.memory\.confirmDecision/u);
  assert.match(panel, /window\.companion\.memory\.setDecisionStatus/u);
  assert.match(panel, /缺理由/u);
  assert.match(preload, /confirmDecision:\s*\(input\)\s*=>\s*invoke\('companion:decision-confirm'/u);
  assert.match(preload, /setDecisionStatus:\s*\(input\)\s*=>\s*invoke\('companion:decision-status'/u);
  assert.match(main, /ipcMain\.handle\('companion:decision-confirm'/u);
  assert.match(main, /ipcMain\.handle\('companion:decision-status'/u);
  // 扫描器把已确认的决策指纹当已有指纹传进去：确认过的不再反复冒出来。
  assert.match(main, /decisionFingerprints\?\.\(\)/u);
});
