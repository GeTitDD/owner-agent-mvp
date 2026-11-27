import test from 'node:test';
import assert from 'node:assert/strict';
import navigation from '../src/project-navigation.cjs';

const a = { id: 'a', projectId: 'alpha', viewProjectId: 'alpha', lastOpenedAt: '2026-11-20', messageCount: 4 };
const b = { id: 'b', projectId: 'beta', viewProjectId: 'beta', lastOpenedAt: '2026-11-24', messageCount: 2 };
const g = { id: 'g', projectId: '', viewProjectId: '', messageCount: 0 };

test('项目切换恢复最近的独立会话，不以置顶或跨项目视图代替', () => {
  const sessions = [a, b, { ...b, id: 'pinned', pinned: true, lastOpenedAt: '2026-01-01' },
    { ...b, id: 'cross', projectId: 'alpha', lastOpenedAt: '2026-11-27' },
    { ...b, id: 'deleted', deletedAt: '2026-11-27', lastOpenedAt: '2026-11-27' }];
  assert.deepEqual(navigation.projectNavigationPlan({ sessions, currentSession: a, projectId: 'beta' }),
    { kind: 'resume', sessionId: 'b', projectId: 'beta' });
  assert.equal(sessions[0], a);
  assert.equal(a.viewProjectId, 'alpha');
});

test('当前已是目标项目独立会话则不操作，正在跨项目查看则回到独立会话', () => {
  assert.equal(navigation.projectNavigationPlan({ sessions: [a, b], currentSession: a, projectId: 'alpha' }).kind, 'stay');
  assert.equal(navigation.projectNavigationPlan({ sessions: [a, b], currentSession: { ...a, viewProjectId: 'beta' }, projectId: 'beta' }).sessionId, 'b');
});

test('全局也恢复自己的会话，不能把其他项目临时查看全局的会话当成全局草稿', () => {
  const cross = { ...a, viewProjectId: '' };
  assert.deepEqual(navigation.projectNavigationPlan({ sessions: [cross, g], currentSession: cross, projectId: '' }),
    { kind: 'resume', sessionId: 'g', projectId: '' });
});

test('没有目标会话时才创建，有消息或草稿的全局会话不会被复用', () => {
  assert.deepEqual(navigation.projectNavigationPlan({ sessions: [g], currentSession: g, projectId: 'beta' }),
    { kind: 'create', projectId: 'beta', reuseEmptyGlobalId: 'g' });
  for (const context of [{ currentSession: { ...g, messageCount: 1 } }, { currentSession: g, hasDraft: true }, { currentSession: a }]) {
    assert.equal(navigation.projectNavigationPlan({ sessions: [], projectId: 'beta', ...context }).reuseEmptyGlobalId, '');
  }
  assert.equal(navigation.projectNavigationPlan({ sessions: [b, g], currentSession: g, projectId: 'beta' }).kind, 'resume');
});

test('无会话和旧记录也有确定的选择，不修改输入的会话对象', () => {
  assert.equal(navigation.projectNavigationPlan({ projectId: 'alpha' }).kind, 'create');
  const legacy = { id: 'old', projectId: 'alpha' };
  assert.equal(navigation.resumeSessionOf([legacy], ' alpha '), legacy);
  assert.deepEqual(legacy, { id: 'old', projectId: 'alpha' });
  assert.equal(navigation.resumeSessionOf([null, { ...a, viewProjectId: '' }], 'alpha'), null);
});
