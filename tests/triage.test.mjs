// 只读分诊：提示词契约、JSON 解析与失败分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TriageRunner,
  buildTriagePrompt,
  parseTriageOutput
} from '../src/pstack/triage.mjs';

test('分诊提示词声明只读、JSON 契约与写前批准', () => {
  const prompt = buildTriagePrompt({
    task: '把 README 的命令补全',
    project: { id: 'demo', root: 'D:\\demo', domain: 'software-engineering' }
  });
  assert.match(prompt, /只读/u);
  assert.match(prompt, /把 README 的命令补全/u);
  assert.match(prompt, /needsWrite/u);
  assert.match(prompt, /writePlan/u);
  assert.match(prompt, /批准/u);
  assert.doesNotMatch(prompt, /own_python/u);
});

test('启用 Python 时提示词声明只读挂载', () => {
  const prompt = buildTriagePrompt({
    task: '统计文件数',
    project: { id: 'demo', root: 'D:\\demo' },
    python: true
  });
  assert.match(prompt, /own_python/u);
  assert.match(prompt, /\/workspace/u);
  assert.match(prompt, /只读/u);
});

test('解析需要写入的分诊输出', () => {
  const parsed = parseTriageOutput(JSON.stringify({
    summary: '需要补一个说明文件',
    needsWrite: true,
    writePlan: {
      intent: '新增 docs/hello-owner.md',
      targets: ['docs/hello-owner.md'],
      allowedPaths: 'docs/',
      notes: '只新增，不改现有文件'
    },
    findings: [{ title: 'docs 目录已存在', detail: '可新增', evidence: ['README.md'] }],
    questions: []
  }));
  assert.equal(parsed.needsWrite, true);
  assert.equal(parsed.writePlan.intent, '新增 docs/hello-owner.md');
  assert.deepEqual(parsed.writePlan.targets, ['docs/hello-owner.md']);
  assert.equal(parsed.writePlan.allowedPaths, 'docs/');
  assert.equal(parsed.findings[0].title, 'docs 目录已存在');
});

test('只回答时不会产生写入计划', () => {
  const parsed = parseTriageOutput([
    '```json',
    '{"summary":"这是一个 Node 项目","needsWrite":false,',
    ' "writePlan":{"intent":"不应保留"},"findings":[],"questions":[]}',
    '```'
  ].join('\n'));
  assert.equal(parsed.needsWrite, false);
  assert.equal(parsed.writePlan, null);
});

test('坏 JSON 视为无法判断，不产生写请求', () => {
  const parsed = parseTriageOutput('我觉得需要改一下，但这里没有 JSON。');
  assert.equal(parsed.needsWrite, false);
  assert.equal(parsed.writePlan, null);
  assert.equal(parsed.questions.length, 1);
});

const fakeFactory = (session) => ({
  async create() { return session; }
});

test('TriageRunner 返回结论并校验证据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  const session = {
    model: 'fake/model',
    async prompt() {},
    getLastText: () => JSON.stringify({
      summary: '只回答：这是 demo 项目',
      needsWrite: false,
      findings: [{ title: '有 README', detail: '', evidence: ['README.md', 'missing.js'] }],
      questions: []
    }),
    lastMessage: () => ({ stopReason: 'end' }),
    dispose() {}
  };
  const runner = new TriageRunner({ sessionFactoryFor: () => fakeFactory(session) });
  const result = await runner.run({ task: '这是什么项目', project: { id: 'demo', root: dir } });
  assert.equal(result.status, 'ok');
  assert.equal(result.needsWrite, false);
  assert.equal(result.findings[0].evidenceChecks[0].exists, true);
  assert.equal(result.findings[0].evidenceChecks[1].exists, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TriageRunner 把空响应归为 empty-response', async () => {
  const session = {
    model: 'fake/model',
    async prompt() {},
    getLastText: () => '   ',
    lastMessage: () => ({ stopReason: 'end' }),
    dispose() {}
  };
  const runner = new TriageRunner({ sessionFactoryFor: () => fakeFactory(session) });
  const result = await runner.run({ task: '分析一下', project: { id: 'demo', root: os.tmpdir() } });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'empty-response');
  assert.equal(result.needsWrite, false);
});

test('TriageRunner 把上游错误归为 quota-exceeded', async () => {
  const session = {
    model: 'fake/model',
    async prompt() {},
    getLastText: () => '',
    lastMessage: () => ({ stopReason: 'error', errorMessage: '429 quota exceeded' }),
    dispose() {}
  };
  const runner = new TriageRunner({ sessionFactoryFor: () => fakeFactory(session) });
  const result = await runner.run({ task: '分析一下', project: { id: 'demo', root: os.tmpdir() } });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'quota-exceeded');
});
