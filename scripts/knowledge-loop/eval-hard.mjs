#!/usr/bin/env node
// 困难任务 A/B：知识包含一个不可从源码推断的项目约定（默认重试次数=7）。
// Baseline 只有源码；Variant 额外获得经过验证的领域知识。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { createDomainEngine } from '../../src/engine.mjs';
import { KnowledgeReuse } from '../../src/knowledge-loop/reuse.mjs';
import { KnowledgeEvalRunner } from '../../src/knowledge-loop/eval.mjs';
import { appendDecision } from '../../src/knowledge-loop/decision-log.mjs';

const args = process.argv.slice(2);
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
if (!args.includes('--allow-model')) throw new Error('--allow-model is required');
const root = path.resolve(read('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-hard-'))));
const knowledgeDb = read('--knowledge-db', path.join(root, 'knowledge.sqlite'));
const model = read('--model', process.env.OWNER_MODEL || '');
const projectRoot = path.join(root, 'hard-b');
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'tests'), { recursive: true });
const retry = `export function withRetry(fn, { attempts = 1 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try { return fn(); } catch (error) { lastError = error; }
  }
  throw lastError;
}
`;
const test = `import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/retry.js';
test('withRetry uses all attempts', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    if (calls < 7) throw new Error('flaky');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 7);
});
`;
fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"hard-b","private":true,"type":"module"}\n', 'utf8');
fs.writeFileSync(path.join(projectRoot, 'src', 'retry.js'), retry, 'utf8');
fs.writeFileSync(path.join(projectRoot, 'tests', 'sandbox-smoke.test.mjs'), test, 'utf8');
const git = (cwd, cmd) => execFileSync('git', cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(projectRoot, ['init', '-q', '-b', 'main']);
git(projectRoot, ['config', 'core.autocrlf', 'false']);
git(projectRoot, ['config', 'user.email', 'hard@example.invalid']);
git(projectRoot, ['config', 'user.name', 'Hard Fixture']);
git(projectRoot, ['add', '.']);
git(projectRoot, ['commit', '-qm', 'hard base: wrong default attempts']);

fs.writeFileSync(path.join(projectRoot, 'domain-context.json'), `${JSON.stringify({
  project: { id: 'hard-b', primaryDomain: 'software-engineering' },
  domainRoot: path.resolve(process.cwd(), 'domains'),
  domains: [{ id: 'software-engineering', version: '1.0.0' }],
  context: { maxTokens: 2000 },
  workspace: { enabled: true, importDomainIds: ['software-engineering'], includeProject: true }
}, null, 2)}\n`, 'utf8');

const personal = new PersonalKnowledgeStore(knowledgeDb);
const engine = createDomainEngine({ dbPath: knowledgeDb });
const unit = (() => {
  const existing = personal.list({ q: 'default attempts seven', limit: 20 })
    .find((item) => /default attempt count is 7/iu.test(item.content));
  if (existing) return existing;
  return personal.create({
    title: 'Retry fixture default attempt count',
    content: 'In this retry fixture family, the default attempt count is 7. When attempts is omitted, default to 7 and loop with i < attempts; the smoke test asserts exactly 7 calls.',
    kind: 'claim', layer: 'applied', scope: 'domain',
    domains: ['software-engineering'], tags: ['retry', 'attempts', 'default', 'seven'],
    evidenceRefs: ['fixture:hard-source'], verificationStatus: 'verified', sourceRef: 'eval-hard'
  });
})();
const reuse = new KnowledgeReuse({ personalStore: personal, engine });
const contextProvider = async () => {
  const result = await reuse.compileAsync({
    cwd: projectRoot,
    task: 'retry attempts default loop',
    targetRunId: `hard-eval-${Date.now()}`,
    projectId: 'hard-b',
    maxTokens: 2000
  });
  return {
    text: result.plan?.dynamicContext ?? '',
    refs: (result.plan?.knowledgeRefs ?? []).filter((key) => key.startsWith('workspace:')),
    applicability: {}
  };
};
const runner = new KnowledgeEvalRunner({ personalStore: personal, model });
const results = [];
for (const variant of [
  { name: 'baseline' },
  { name: 'knowledge', contextProvider }
]) {
  const context = variant.contextProvider ? await variant.contextProvider() : { text: '', refs: [] };
  const row = await runner.runTask({
    taskId: 'hard-default-attempts',
    projectRoot,
    task: 'Fix the failing retry test in src/retry.js',
    allowedPaths: ['src/'],
    variant: variant.name,
    knowledgeContext: context.text,
    knowledgeRefs: context.refs
  });
  results.push(row);
  appendDecision(path.join(root, 'eval-hard-decisions.tsv'), {
    phase: 'hard-default-attempts', decision: `ran ${variant.name}`,
    why: 'the default attempt count cannot be inferred from source alone',
    evidence: `testExit=${row.testExitCode}`, result: row.success ? 'pass' : `fail:${row.failureType}`
  });
  console.log(`[hard/${variant.name}] success=${row.success} refs=${row.knowledgeRefs.length} tokens=${row.estimatedKnowledgeTokens}`);
}
const report = {
  contract: 'knowledge-eval-hard/v1',
  oracleControl: true,
  note: 'Oracle control: the answer knowledge is injected directly, not learned from project A. Use eval-ab-learning.mjs for the A→B learning chain.',
  root, knowledgeDb, unitId: unit.id, model: model || 'sdk-default',
  fixedTask: 'Fix the failing retry test in src/retry.js',
  results,
  baselineSuccess: results.find((row) => row.variant === 'baseline')?.success ?? false,
  knowledgeSuccess: results.find((row) => row.variant === 'knowledge')?.success ?? false,
  knowledgeRefs: results.find((row) => row.variant === 'knowledge')?.knowledgeRefs ?? []
};
const out = read('--out', path.join(root, 'eval-hard-report.json'));
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out, baselineSuccess: report.baselineSuccess, knowledgeSuccess: report.knowledgeSuccess }, null, 2));
engine.close();
personal.close();
