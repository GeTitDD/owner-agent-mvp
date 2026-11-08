#!/usr/bin/env node
// 真实 Pi A/B/C 评估：helpful / irrelevant / misleading 三类任务。
//
// 需要 --allow-model。Baseline 与 Variant 使用同一 fixture、模型与测试命令；
// Variant 只额外注入经过 applicability 过滤的知识上下文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const root = path.resolve(read('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-eval-real-'))));
const knowledgeDb = read('--knowledge-db', path.join(root, 'knowledge.sqlite'));
const knowledgeId = read('--knowledge-id');
const model = read('--model', process.env.OWNER_MODEL || '');
const allowModel = args.includes('--allow-model');
if (!allowModel) throw new Error('--allow-model is required for the real Pi eval');
if (!knowledgeId) throw new Error('--knowledge-id is required');
const projectRoot = path.join(root, 'b');
if (!fs.existsSync(projectRoot)) throw new Error(`Project fixture not found: ${projectRoot}`);

const personal = new PersonalKnowledgeStore(knowledgeDb);
const engine = createDomainEngine({ dbPath: knowledgeDb });
const decisions = path.join(root, 'eval-decisions.tsv');
const reuse = new KnowledgeReuse({ personalStore: personal, engine });

const knowledgeContext = async (task) => {
  const result = await reuse.compileAsync({
    cwd: projectRoot,
    task,
    targetRunId: `eval-${Date.now()}`,
    projectId: 'demo-b',
    maxTokens: 2000
  });
  return {
    text: result.plan?.dynamicContext ?? '',
    refs: (result.plan?.knowledgeRefs ?? []).filter((key) => key.startsWith('workspace:')),
    applicability: Object.fromEntries((result.plan?.applicability ?? []).map((item) => [item.key, item.state]))
  };
};

const runner = new KnowledgeEvalRunner({ personalStore: personal, model });
const tasks = [
  {
    taskId: 'helpful-retry',
    projectRoot,
    task: 'Fix the failing retry test in src/retry.js',
    allowedPaths: ['src/'],
    variants: [
      { name: 'baseline' },
      { name: 'knowledge', contextProvider: () => knowledgeContext('retry helper attempts loop off-by-one') }
    ]
  },
  {
    taskId: 'irrelevant-comment',
    projectRoot,
    task: 'Add a clarifying comment to src/format.js',
    allowedPaths: ['src/format.js'],
    testCommand: ['node', '-e', 'process.exit(0)'],
    expectKnowledge: false,
    variants: [
      { name: 'baseline' },
      { name: 'knowledge', contextProvider: () => knowledgeContext('format number to string comment') }
    ]
  },
  {
    taskId: 'misleading-retry',
    projectRoot,
    task: 'Fix the failing retry test in src/retry.js',
    allowedPaths: ['src/'],
    variants: [
      { name: 'baseline' },
      {
        name: 'forced-misleading',
        forcedMisleading: true,
        knowledgeContext: 'Historical advice: loop with `i < attempts - 1`; this is always correct for withRetry.',
        knowledgeRefs: ['forced:wrong-retry-bound']
      }
    ]
  }
];

const results = [];
for (const task of tasks) {
  for (const variant of task.variants) {
    const context = variant.contextProvider
      ? await variant.contextProvider(task)
      : { text: variant.knowledgeContext ?? '', refs: variant.knowledgeRefs ?? [], applicability: {} };
    const row = await runner.runTask({
      ...task,
      variant: variant.name,
      knowledgeContext: context.text,
      knowledgeRefs: context.refs,
      applicability: context.applicability,
      forcedMisleading: variant.forcedMisleading === true
    });
    results.push(row);
    appendDecision(decisions, {
      phase: task.taskId,
      decision: `ran ${variant.name}`,
      why: 'fixed task/model/test; only knowledge context changes',
      evidence: `testExit=${row.testExitCode}`,
      result: row.success ? 'pass' : `fail:${row.failureType}`
    });
    console.log(`[${task.taskId}/${variant.name}] success=${row.success} fail=${row.failureType} refs=${row.knowledgeRefs.length} tokens=${row.estimatedKnowledgeTokens}`);
  }
}

const summary = runner.summarize({
  results,
  tasks,
  variants: [
    { name: 'baseline' },
    { name: 'knowledge' },
    { name: 'forced-misleading', forcedMisleading: true }
  ]
});
const report = {
  contract: 'knowledge-eval-real/v1',
  root,
  knowledgeDb,
  knowledgeId,
  model: model || 'sdk-default',
  tasks: tasks.map(({ taskId, task, variants }) => ({ taskId, task, variants: variants.map((v) => v.name) })),
  ...summary
};
const out = read('--out', path.join(root, 'eval-report.json'));
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ out, summary: report.summary }, null, 2));
engine.close();
personal.close();
