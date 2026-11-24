#!/usr/bin/env node
// 常驻知识扫描宿主（已退役）。
//
// ADR-0007 / #62：旧采集链（扫描已完成 Run → 写经验表）已停用；KnowledgeLoopRuntime 现在
// 只返回退役状态，不读旧表、不写库。保留脚本只为让既有 npm script 与调试命令仍然可用，
// 输出里的 retired=true 就是「没有采集」。新链路的提炼入口见 src/knowledge-loop/on-demand.mjs。
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../../src/personal-store.mjs';
import { KnowledgeLoopRuntime } from '../../src/knowledge-loop/runtime.mjs';

const args = process.argv.slice(2);
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const ownerDb = read('--owner-db', process.env.OWNER_AGENT_DB || path.join(os.homedir(), '.owner-agent', 'owner.sqlite'));
const knowledgeDb = read('--knowledge-db', process.env.OWNER_KNOWLEDGE_DB || process.env.DOMAIN_CONTEXT_DB || path.join(os.homedir(), '.domain-context', 'index.sqlite'));
const intervalMs = Math.max(5000, Number(read('--interval-ms', '15000')) || 15000);
const once = args.includes('--once');
const model = read('--model', process.env.OWNER_MODEL || '');
const owner = new OwnerStore(ownerDb);
const personal = new PersonalKnowledgeStore(knowledgeDb);
const runtime = new KnowledgeLoopRuntime({ ownerStore: owner, personalStore: personal, model });

const report = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
};
const tick = async () => {
  try {
    report(await runtime.tick());
  } catch (error) {
    process.stderr.write(`knowledge auto tick failed: ${error.message}\n`);
  }
};

if (once) {
  await tick();
  personal.close();
  owner.close();
} else {
  await tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  process.on('SIGINT', () => {
    clearInterval(timer);
    personal.close();
    owner.close();
    process.exit(0);
  });
  process.stdin.resume();
}
