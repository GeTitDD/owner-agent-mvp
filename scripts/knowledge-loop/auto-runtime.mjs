#!/usr/bin/env node
// 常驻知识采集宿主：启动一次后按低频扫描已完成 Run。
//
// Companion 产品会在自己的 Runtime timer 中调用同一个 KnowledgeLoopRuntime；
// 本脚本用于无桌面环境或调试。不是第二套调度器。
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
const allowHarvest = args.includes('--allow-harvest') || process.env.OWNER_KNOWLEDGE_AUTO_HARVEST === '1';
const once = args.includes('--once');
const model = read('--model', process.env.OWNER_MODEL || '');
const owner = new OwnerStore(ownerDb);
const personal = new PersonalKnowledgeStore(knowledgeDb);
const runtime = new KnowledgeLoopRuntime({ ownerStore: owner, personalStore: personal, allowHarvest, model });

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
