// 待审内容必须与定位屏归属一致，并在审核前给出实际正文、范围和可追的证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateReviewView, pendingCandidateView } from '../src/knowledge/candidate-view.mjs';
import { pendingCountsOf } from '../src/memory/locate-screen.mjs';

const proposal = (id, projectId = 'alpha', extra = {}) => ({
  id, status: 'pending', created_at: '2026-11-26T00:00:00Z',
  payload: { title: `候选 ${id}`, content: '现象\n机制：实际机制\n对策：实际对策', projectId, layer: 'project', evidenceRefs: ['run:1'], ...extra },
  meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['lesson-a'], applicability: ['失败重试时'], exceptions: ['不可重试的错误'] }
});
const lesson = { id: 'lesson-a', projectId: 'alpha', phenomenon: '重试失效', evidence: [{ ref: 'run:1', excerpt: '第三次请求成功，返回 200。' }] };
const store = (rows) => ({ proposals: () => rows, getLesson: (id) => id === lesson.id ? lesson : null });
const projects = [{ id: 'alpha', name: '中文项目 Alpha' }, { id: 'beta', name: 'Beta' }];

test('先按当前项目归属过滤再分页，不把别的项目、已审核和普通提案混进来', () => {
  const rows = [proposal('other', 'beta'), ...Array.from({ length: 24 }, (_, i) => proposal(`a-${i}`)),
    { ...proposal('approved'), status: 'approved' }, { ...proposal('plain'), meta: {} }];
  const view = pendingCandidateView({ personalStore: store(rows), projectId: 'alpha', projects, limit: 20 });
  assert.equal(view.total, 24);
  assert.equal(view.items.length, 20);
  assert.equal(view.items[0].id, 'a-0');
  assert.equal(view.hasMore, true);
});

test('正文使用实际 payload.content，保留多行，显示范围、条件、例外和证据摘录', () => {
  const row = proposal('one');
  const view = candidateReviewView({ proposal: row, personalStore: store([row]), projects });
  assert.equal(view.content, row.payload.content);
  assert.match(view.scopeLabel, /中文项目 Alpha/);
  assert.match(view.evidenceText, /第三次请求成功/);
  assert.match(view.evidenceText, /run:1/);
  assert.deepEqual(view.applicability, ['失败重试时']);
  assert.deepEqual(view.exceptions, ['不可重试的错误']);
  assert.equal(view.verificationLabel, '待验证');
});

test('共享候选沿来源归属，与定位屏待确认计数一致；没有归属不分给任意项目', () => {
  const rows = [proposal('domain', null, { layer: 'domain', domains: ['engineering'] }),
    { ...proposal('orphan', null), meta: { contract: 'knowledge-candidate/v1' } }];
  const counts = pendingCountsOf({ proposals: rows, lessons: [lesson] });
  const a = pendingCandidateView({ personalStore: store(rows), projectId: 'alpha', projects });
  const b = pendingCandidateView({ personalStore: store(rows), projectId: 'beta', projects });
  assert.equal(a.total, counts.byProject.alpha.knowledge);
  assert.equal(a.items[0].id, 'domain');
  assert.match(a.items[0].scopeLabel, /域级.*engineering/);
  assert.equal(b.total, 0);
  assert.equal(pendingCandidateView({ personalStore: store(rows) }).total, 2);
});

test('关键词同时过滤正文和候选；证据丢失或只有引用时如实说明，不编摘录', () => {
  const row = { ...proposal('no-source'), meta: { contract: 'knowledge-candidate/v1', sourceLessonIds: ['gone'] } };
  const view = pendingCandidateView({ personalStore: store([row]), projectId: 'alpha', keyword: '实际对策' });
  assert.equal(view.total, 1);
  assert.match(view.items[0].evidenceText, /run:1/);
  assert.match(view.items[0].evidenceText, /未保存摘录/);
  assert.match(view.items[0].sourceLabel, /不可用/);
  assert.equal(pendingCandidateView({ personalStore: store([row]), keyword: '不匹配' }).total, 0);
});
