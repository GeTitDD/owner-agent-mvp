#!/usr/bin/env node
// Owner Knowledge Loop 本地 CLI。
//
// 所有命令默认只读或生成 pending 候选；`approve` 是显式人工审核入口，不自动调用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OwnerStore } from '../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { createDomainEngine } from '../src/engine.mjs';
// 旧的 `collect` / `experiences` / `harvest` 子命令随 experience/v1 一并退役（ADR-0007 / #62）：
// 执行记录 → 经验（lesson）的按需提炼见 src/knowledge-loop/on-demand.mjs 与 lesson.mjs。
import { KnowledgeReuse } from '../src/knowledge-loop/reuse.mjs';
import { KnowledgeFeedback } from '../src/knowledge-loop/feedback.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const all = (flag) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
};
const defaultDb = (name) => path.join(os.homedir(), '.domain-context', name);
const ownerDb = read('--owner-db', process.env.OWNER_AGENT_DB || defaultDb('owner.sqlite'));
const knowledgeDb = read('--knowledge-db', process.env.DOMAIN_CONTEXT_DB || defaultDb('index.sqlite'));
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function open() {
  const owner = new OwnerStore(ownerDb);
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  return { owner, personal };
}

function close({ owner, personal }) {
  owner?.close();
  personal?.close();
}

async function main() {
  if (command === 'candidates') {
    const stores = open();
    try {
      json(stores.personal.proposals(read('--status', 'pending')));
    } finally { close(stores); }
    return;
  }
  if (command === 'approve') {
    const stores = open();
    try {
      const id = read('--proposal');
      if (!id) throw new Error('--proposal is required');
      json(stores.personal.reviewProposal(id, {
        decision: 'approved',
        reviewer: read('--reviewer', 'owner')
      }));
    } finally { close(stores); }
    return;
  }
  if (command === 'reject') {
    const stores = open();
    try {
      const id = read('--proposal');
      if (!id) throw new Error('--proposal is required');
      json(stores.personal.reviewProposal(id, {
        decision: 'rejected',
        reviewer: read('--reviewer', 'owner')
      }));
    } finally { close(stores); }
    return;
  }
  if (command === 'reuse') {
    const stores = open();
    const engine = createDomainEngine({ dbPath: knowledgeDb });
    try {
      const cwd = read('--cwd');
      const task = read('--task');
      const projectId = read('--project');
      if (!cwd || !task || !projectId) throw new Error('--cwd, --task and --project are required');
      const reuse = new KnowledgeReuse({ personalStore: stores.personal, engine, ownerStore: stores.owner });
      const result = await reuse.compileAsync({
        cwd,
        task,
        targetRunId: read('--target-run', `cli-${Date.now()}`),
        projectId,
        maxTokens: Number(read('--max-tokens', '2000')) || undefined
      });
      const out = read('--out');
      if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      json({
        snapshotId: result.plan?.snapshotId ?? null,
        compilationHash: result.plan?.compilationHash ?? null,
        knowledgeRefs: result.plan?.knowledgeRefs ?? [],
        usages: result.usages,
        dynamicContext: result.plan?.dynamicContext ?? ''
      });
    } finally { engine.close(); close(stores); }
    return;
  }
  if (command === 'feedback') {
    const stores = open();
    try {
      const usageId = read('--usage');
      if (!usageId) throw new Error('--usage is required');
      const feedback = new KnowledgeFeedback({ ownerStore: stores.owner, personalStore: stores.personal });
      json(feedback.record({
        usageId,
        runId: read('--run'),
        rationale: read('--rationale'),
        evidenceRefs: all('--evidence')
      }));
    } finally { close(stores); }
    return;
  }
  if (command === 'verify') {
    const stores = open();
    try {
      const knowledgeId = read('--knowledge-id');
      if (!knowledgeId) throw new Error('--knowledge-id is required');
      const unit = stores.personal.get(knowledgeId);
      if (!unit) throw new Error('Knowledge not found');
      const evidenceRefs = all('--evidence');
      if (!evidenceRefs.length) throw new Error('At least one --evidence is required');
      json(stores.personal.update(knowledgeId, {
        ...unit,
        verificationStatus: 'verified',
        evidenceRefs: [...new Set([...unit.evidenceRefs, ...evidenceRefs])]
      }, {
        expectedRevision: unit.revision,
        actor: read('--reviewer', 'owner'),
        note: read('--note', 'Verified by owner')
      }));
    } finally { close(stores); }
    return;
  }
  if (command === 'usage') {
    const stores = open();
    try {
      json(stores.personal.listUsages({
        targetRunId: read('--target-run'),
        projectId: read('--project'),
        knowledgeId: read('--knowledge'),
        limit: Number(read('--limit', '100')) || 100
      }));
    } finally { close(stores); }
    return;
  }
  throw new Error(`Unknown command: ${command ?? '(none)'}`);
}

main().catch((error) => {
  console.error(`knowledgectl: ${error.message}`);
  process.exitCode = 1;
});
