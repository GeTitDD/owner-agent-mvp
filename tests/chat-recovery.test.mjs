// 恢复卡只提供有效的恢复路径；问题正文仍以原用户消息为准。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const recovery = require('../desktop/chat-recovery.cjs');
const compose = require('../desktop/shell-compose.cjs');
const blocks = require('../desktop/shell-blocks.cjs');

test('未配置、鉴权和网络失败都能直接进入设置并重试原问题', () => {
  for (const category of ['no-model', 'unknown-model', 'auth-error', 'network-error', 'timeout', 'quota-exceeded']) {
    const card = recovery.normalize({ category, sourceSeq: 3, projectId: 'alpha', skillId: 'skill-a' });
    assert.deepEqual(card.actions.map((action) => action.id), ['configure', 'retry', 'restore']);
    assert.equal(card.sourceSeq, 3);
    assert.equal(card.projectId, 'alpha');
    assert.equal(card.skillId, 'skill-a');
    assert.equal(Object.hasOwn(card, 'question'), false);
  }
});

test('失败回复持久化为错误，部分答案标明未完成；重试保留技能与关联资料', () => {
  const reply = compose.modelFailureReply({ category: 'network-error', answer: '连接失败', partial: '读到了 README' },
    { sourceSeq: 7, projectId: 'alpha', skillId: 'domain/review', skillPrefix: '/review ' });
  assert.equal(reply.status, 'error');
  assert.match(reply.text, /未完成/);
  assert.equal(reply.blocks[0].sourceSeq, 7);
  const text = '/review 检查重试\n\n## 关联项目\n- Beta（只读）';
  assert.equal(compose.modelQuestionOf(text, reply.blocks[0].skillId, reply.blocks[0].skillPrefix),
    '/skill:domain/review 检查重试\n\n## 关联项目\n- Beta（只读）');
  assert.equal(blocks.normalizeReply({ ...reply, answers: { 0: '已重试' } }).blocks[0].answered, '已重试');
});

test('缺少原消息时不能盲目重试；只读校验失败不提供继续请求的按钮', () => {
  assert.deepEqual(recovery.normalize({ category: 'no-model' }).actions.map((a) => a.id), ['configure']);
  assert.deepEqual(recovery.normalize({ category: 'readonly-violation', sourceSeq: 4, actions: [{ id: 'retry' }] }).actions, []);
  assert.deepEqual(recovery.normalize({ category: 'question-too-long', sourceSeq: 4 }).actions.map((a) => a.id), ['restore']);
});
