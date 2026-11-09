// Composer 交办编排：只读分诊 → 直接回答 / HITL 写请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAllowedPaths,
  submitCompanionTask
} from '../src/companion-submit.mjs';

const project = { id: 'demo', root: 'D:\\demo', domain: 'software-engineering' };

const runnerReturning = (value) => ({ async run() { return value; } });

test('只回答模式不创建写请求', async () => {
  let created = 0;
  const result = await submitCompanionTask({
    text: '这个项目是做什么的？',
    project,
    triageRunner: runnerReturning({
      status: 'ok',
      needsWrite: false,
      summary: '这是一个演示项目',
      findings: [{ title: '有 README', evidence: ['README.md'] }],
      questions: [],
      model: 'fake/model',
      durationMs: 12,
      runId: 'tr_x'
    }),
    createWriteRequest: async () => { created += 1; return { jobId: 'j', status: 'pending_approval' }; }
  });
  assert.equal(result.mode, 'answer');
  assert.equal(result.summary, '这是一个演示项目');
  assert.equal(created, 0);
});

test('需要写入时创建 HITL 写请求并带上写入计划', async () => {
  const calls = [];
  const result = await submitCompanionTask({
    text: '给 README 补一段运行说明',
    project,
    triageRunner: runnerReturning({
      status: 'ok',
      needsWrite: true,
      summary: '需要改 README',
      writePlan: {
        intent: '在 README 补运行说明',
        targets: ['README.md'],
        allowedPaths: 'README.md'
      },
      findings: [],
      questions: [],
      model: 'fake/model',
      durationMs: 20,
      runId: 'tr_y'
    }),
    createWriteRequest: async (input) => {
      calls.push(input);
      return { jobId: 'job-1', status: 'pending_approval' };
    }
  });
  assert.equal(result.mode, 'write-request');
  assert.equal(result.jobId, 'job-1');
  assert.equal(result.intent, '在 README 补运行说明');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, '写请求：在 README 补运行说明');
  assert.equal(calls[0].allowedPaths, 'README.md');
  assert.equal(calls[0].analysisRunId, 'tr_y');
});

test('分诊失败时不创建写请求', async () => {
  let created = 0;
  const result = await submitCompanionTask({
    text: '随便改一下',
    project,
    triageRunner: runnerReturning({
      status: 'error',
      category: 'auth-error',
      summary: '只读分析失败：auth-error',
      advice: '检查模型凭据',
      runId: 'tr_z',
      durationMs: 5
    }),
    createWriteRequest: async () => { created += 1; return { jobId: 'j' }; }
  });
  assert.equal(result.mode, 'triage-error');
  assert.equal(result.category, 'auth-error');
  assert.equal(created, 0);
});

test('空交办直接拒绝', async () => {
  await assert.rejects(
    () => submitCompanionTask({
      text: '   ',
      project,
      triageRunner: runnerReturning({ status: 'ok', needsWrite: false }),
      createWriteRequest: async () => ({ jobId: 'j' })
    }),
    /交办/u
  );
});

test('normalizeAllowedPaths 去掉越界项并回退', () => {
  assert.equal(normalizeAllowedPaths('src/, docs/'), 'src/,docs/');
  assert.equal(normalizeAllowedPaths('D:\\evil, ../x, src/'), 'src/');
  assert.equal(normalizeAllowedPaths(''), 'src/');
  assert.equal(normalizeAllowedPaths('a/,b/,c/,d/,e/,f/'), 'a/,b/,c/,d/,e/');
});
