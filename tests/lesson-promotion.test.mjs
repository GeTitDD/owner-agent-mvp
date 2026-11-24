// 经验提升为知识候选（#61）：一条经验一键提交为候选，走既有审核；被拒不动经验；
// 同现象经验累积到 3 条只返回提议信号，由人决定是否提升；提升不改经验的验证状态。
// 这里用 PersonalKnowledgeStore(':memory:')，不联网、不调真实模型。
// 只断言外部行为：库里最后剩下什么候选、经验行是否原样、信号何时出现。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { CANDIDATE_CONTRACT, normalizeLesson } from '../src/knowledge-loop/contracts.mjs';
import {
  PROMOTION_THRESHOLD, lessonPromotionSignals, promoteLessonToCandidate
} from '../src/knowledge-loop/promotion.mjs';

const PHENOMENON = 'retry loop leaves the last attempt unused';
const MECHANISM = 'for 循环写成 i < attempts - 1，最后一次重试永远不会执行';
const COUNTERMEASURE = '改成 i < attempts，并用同一条断言复跑测试确认次数';

/**
 * 造一条经验：现象 / 机制 / 对策 + 它引用的执行记录。
 * 证据行按执行记录 ID 逐条写入，和提炼器落库的形状一致。
 */
const seedLesson = (personal, {
  phenomenon = PHENOMENON,
  mechanism = MECHANISM,
  countermeasure = COUNTERMEASURE,
  projectId = 'p1',
  domainIds = ['software-engineering'],
  records = ['sandbox:run1'],
  verificationStatus = 'unverified'
} = {}) => {
  const lesson = normalizeLesson({
    projectId,
    sourceRecordId: records[0] ?? 'sandbox:run0',
    phenomenon,
    mechanism,
    countermeasure,
    scope: { layer: 'project', projectId, domainIds },
    verificationStatus,
    evidenceRefs: records
  });
  return personal.addLesson(lesson, {
    evidence: records.map((ref) => ({ ref, recordId: ref, kind: 'sandbox-run', excerpt: `记录=${ref}` }))
  });
};

const pendingCandidates = (personal) =>
  personal.proposals('pending').filter((item) => item.meta?.contract === CANDIDATE_CONTRACT);

test('一条经验一键提为候选：进待审队列，payload 沿用候选契约', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lesson = seedLesson(personal, { records: ['sandbox:run1', 'sandbox:run2'] });
    const result = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });

    assert.equal(result.created, true);
    assert.equal(result.lesson.id, lesson.id);

    const pending = pendingCandidates(personal);
    assert.equal(pending.length, 1, '提升后候选必须出现在待审队列');
    const [proposal] = pending;
    assert.equal(proposal.id, result.proposal.id);
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.target_id, null, '提升是新建候选，不是改既有知识');

    // 来源记在 meta.sourceLessonIds：知识浏览靠它把候选归属回项目。
    assert.deepEqual(proposal.meta.sourceLessonIds, [lesson.id]);
    assert.deepEqual(proposal.meta.sourceExperienceIds, [], '经验不是 experience/v1，不冒充来源经验');
    assert.equal(proposal.meta.proposedLayer, 'project');
    assert.equal(proposal.meta.proposedKind, 'pattern');

    const { payload } = proposal;
    assert.equal(payload.title, PHENOMENON, '现象进标题');
    assert.match(payload.content, new RegExp(PHENOMENON, 'u'), '现象也进正文');
    assert.match(payload.content, /机制：/u, '机制进正文');
    assert.match(payload.content, /对策：/u, '对策进正文');
    assert.ok(payload.content.includes(COUNTERMEASURE));
    assert.equal(payload.kind, 'claim');
    assert.equal(payload.layer, 'project');
    assert.equal(payload.scope, 'project');
    assert.equal(payload.projectId, 'p1');
    assert.equal(payload.verificationStatus, 'unverified', '候选从不直接是 verified');
    assert.deepEqual(payload.domains, ['software-engineering']);
    assert.ok(payload.evidenceRefs.includes('sandbox:run1'));
    assert.ok(payload.evidenceRefs.includes('sandbox:run2'));
    assert.equal(payload.sourceRef, `knowledge-loop:lesson:${lesson.id}`);

    // 再点一次不产生第二条候选：一条经验对应一条待审候选。
    const again = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });
    assert.equal(again.created, false);
    assert.equal(again.proposal.id, proposal.id);
    assert.equal(pendingCandidates(personal).length, 1);
  } finally { personal.close(); }
});

test('候选走既有审核：接受后成为知识，经验仍是待验证', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lesson = seedLesson(personal);
    const { proposal } = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });

    const done = personal.reviewProposal(proposal.id, { decision: 'approved', reviewer: 'local-user' });
    assert.equal(done.status, 'approved');
    const knowledge = personal.get(done.applied_id);
    assert.equal(knowledge.title, PHENOMENON);
    assert.equal(knowledge.verificationStatus, 'unverified', '接受候选只是入场，不是已验证');
    assert.equal(knowledge.layer, 'project');
    assert.equal(personal.listLessons().length, 1, '接受候选不新增、不改经验行');
    assert.equal(personal.getLesson(lesson.id).verificationStatus, 'unverified');

    // 已接受的候选已经落成知识：同一条经验再点一次不再造第二条候选。
    const again = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });
    assert.equal(again.created, false);
    assert.equal(again.reason, 'approved');
    assert.equal(again.proposal.id, proposal.id);
    assert.equal(personal.list().length, 1);
  } finally { personal.close(); }
});

test('候选被拒：经验状态、内容、证据、争议裁决都不动', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const first = seedLesson(personal);
    // 同一现象、不同对策 → #57 的争议组；裁决结果不能被一次失败提升碰到。
    const second = seedLesson(personal, {
      countermeasure: '把重试次数写成常量 3，不再读配置', records: ['sandbox:run2']
    });
    personal.markLessonsDisputed([first.id, second.id]);
    const beforeFirst = personal.getLesson(first.id);
    const beforeSecond = personal.getLesson(second.id);

    const { proposal } = promoteLessonToCandidate({ personalStore: personal, lessonId: first.id });
    const done = personal.reviewProposal(proposal.id, { decision: 'rejected' });

    assert.equal(done.status, 'rejected');
    assert.deepEqual(personal.getLesson(first.id), beforeFirst, '被拒后经验必须原样');
    assert.deepEqual(personal.getLesson(second.id), beforeSecond, '同组另一条经验也不能被碰');
    assert.equal(personal.lessonStatus(first.id), 'disputed', '争议裁决不因候选被拒而改变');
    assert.equal(personal.list().length, 0, '被拒不落知识');

    // 被拒不拦后续重提：经验本身仍是原样，人改完可以再提一条新候选。
    const again = promoteLessonToCandidate({ personalStore: personal, lessonId: first.id });
    assert.equal(again.created, true);
    assert.notEqual(again.proposal.id, proposal.id);
    assert.deepEqual(personal.getLesson(first.id), beforeFirst);
  } finally { personal.close(); }
});

test('同现象经验累积到 3 条才提议：2 条只在队列里，3 条返回信号且不自动提升', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lesson = seedLesson(personal, { records: ['sandbox:run1', 'sandbox:run2'] });
    assert.deepEqual(lessonPromotionSignals({ personalStore: personal }).signals, [], '2 条还不提议');

    // 第三条执行记录支持同一现象：同一条经验，证据累加。
    personal.appendLessonEvidence(lesson.id, { sourceRecordId: 'sandbox:run3' }, [
      { ref: 'sandbox:run3', recordId: 'sandbox:run3', kind: 'sandbox-run', excerpt: '记录=sandbox:run3' }
    ]);

    const { threshold, signals } = lessonPromotionSignals({ personalStore: personal });
    assert.equal(threshold, PROMOTION_THRESHOLD);
    assert.equal(signals.length, 1);
    const [signal] = signals;
    assert.equal(signal.phenomenon, PHENOMENON);
    assert.deepEqual(signal.lessonIds, [lesson.id]);
    assert.equal(signal.occurrences, 3, '三条执行记录支持同一现象才算 3 条');
    assert.equal(signal.recordCount, 3);
    assert.equal(signal.pendingProposalId, null);

    // 提议只是信号：不建候选、不改经验。
    assert.equal(personal.proposals('pending').length, 0, '提议不自动提升');
    assert.equal(personal.getLesson(lesson.id).verificationStatus, 'unverified');
  } finally { personal.close(); }
});

test('三条同现象经验（不同对策）也触发提议，且不自动合并或提升', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lessons = ['对策甲', '对策乙', '对策丙'].map((countermeasure, index) => seedLesson(personal, {
      countermeasure, records: [`sandbox:run${index + 1}`]
    }));
    assert.equal(personal.listLessons().length, 3, '不同对策各自成行，不能被信号偷偷合并');

    const { signals } = lessonPromotionSignals({ personalStore: personal });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].occurrences, 3);
    assert.equal(signals[0].lessonCount, 3);
    assert.deepEqual([...signals[0].lessonIds].sort(), lessons.map((lesson) => lesson.id).sort());
    for (const lesson of lessons) {
      assert.equal(personal.getLesson(lesson.id).verificationStatus, 'unverified');
    }
    assert.equal(personal.proposals('pending').length, 0);
  } finally { personal.close(); }
});

test('提升不把经验升为已验证：推断仍是推断，候选只是待审', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    // 追不到证据的经验只能算推断，落库时就是这样。
    const lesson = seedLesson(personal, { verificationStatus: 'inferred', records: [] });
    const before = personal.getLesson(lesson.id);
    assert.equal(before.verificationStatus, 'inferred');

    const { proposal } = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });

    assert.equal(personal.getLesson(lesson.id).verificationStatus, 'inferred', '提升不改经验验证状态');
    assert.deepEqual(personal.getLesson(lesson.id), before, '提升后经验行逐字段不变');
    assert.equal(proposal.payload.verificationStatus, 'unverified', '候选侧只有待验证，没有已验证');
    assert.deepEqual(proposal.payload.evidenceRefs, [], '没有可追证据就不编证据');
  } finally { personal.close(); }
});

test('已提交待审的候选会出现在提议信号里，避免同一条经验被反复提交', () => {
  const personal = new PersonalKnowledgeStore(':memory:');
  try {
    const lesson = seedLesson(personal, { records: ['sandbox:run1', 'sandbox:run2', 'sandbox:run3'] });
    const { proposal } = promoteLessonToCandidate({ personalStore: personal, lessonId: lesson.id });

    const { signals } = lessonPromotionSignals({ personalStore: personal });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].pendingProposalId, proposal.id, '信号要指出已有待审候选，而不是再提一条');
    assert.equal(signals[0].promotedProposalId, null);

    // 接受之后信号仍会列出这一组经验，但标记出已落成知识的候选，不再提示提交。
    personal.reviewProposal(proposal.id, { decision: 'approved' });
    const after = lessonPromotionSignals({ personalStore: personal }).signals[0];
    assert.equal(after.pendingProposalId, null);
    assert.equal(after.promotedProposalId, proposal.id);
  } finally { personal.close(); }
});
