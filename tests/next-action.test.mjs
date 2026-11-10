// 下一步建议：优先级与用户语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextActionFor } from '../src/next-action.mjs';

const brief = { oneLiner: 'x', basedOnCommit: 'a' };

test('待审批优先级最高', () => {
  assert.equal(nextActionFor({ pending: 2, playbookRunning: true }).command, 'decide');
});

test('运行中优先于理解项目', () => {
  assert.equal(nextActionFor({ playbookRunning: true, brief: null }).command, 'wait');
});

test('没有画像或画像过期时先理解项目', () => {
  assert.equal(nextActionFor({ brief: null }).command, 'understand');
  assert.equal(nextActionFor({ brief, briefStale: true }).command, 'understand');
  assert.match(nextActionFor({ brief: null }).label, /理解/u);
});

test('有待提炼或候选时建议整理知识', () => {
  const action = nextActionFor({ brief, knowledge: { pendingHarvest: 3, candidates: 1 } });
  assert.equal(action.command, 'tidy');
  assert.match(action.label, /4/u);
});

test('测试通过后建议交付；失败后建议查看', () => {
  assert.equal(nextActionFor({ brief, result: { testStatus: 'pass', cycleId: 'c1' } }).command, 'deliver');
  assert.equal(nextActionFor({ brief, state: 'error' }).command, 'inspect');
  assert.equal(nextActionFor({ brief }).command, 'compose');
});
