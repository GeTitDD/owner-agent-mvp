#!/usr/bin/env node
// 观察员命令行入口：只读探针 + 事件 + 飞书投递，不依赖 Electron。
//
// 用法：
//   node bin/observerctl.mjs stale --project <id> [--threshold-days 3]
//     [--webhook <your-webhook>] [--config <feishu.json>] [--db <sqlite>] [--json]
//
// webhook 读取优先级：--webhook > OWNER_OBSERVER_FEISHU_WEBHOOK > --config/默认配置文件 > 未配置（skipped）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerStore } from '../src/owner-store.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { runStaleCheck } from '../src/observer/service.mjs';
import { resolveFeishuWebhook } from '../src/observer/config.mjs';
import { DEFAULT_STALE_THRESHOLD_DAYS } from '../src/observer/events.mjs';
import { defaultDbPath } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Observe one registered project and notify Feishu when it goes stale.

Usage:
  node bin/observerctl.mjs stale --project <id> [options]

Options:
  --project <id>          Registered project id (required)
  --threshold-days <n>    Stale threshold in days (default ${DEFAULT_STALE_THRESHOLD_DAYS})
  --webhook <your-webhook> Feishu bot webhook; overrides environment and config file
  --config <path>         Feishu config file (default ~/.owner-agent/feishu.json)
  --db <path>             Audit database (default ${defaultDbPath()})
  --json                  Print a machine-readable summary

Exit codes: 0 = sent/skipped/no event, 1 = delivery failed or invalid input.`;

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  const value = index === -1 ? fallback : args[index + 1];
  return typeof value === 'string' ? value : String(fallback ?? '');
};
const has = (flag) => args.includes(flag);
const fail = (message) => {
  console.error(`observer: ${message}`);
  process.exit(1);
};

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (command !== 'stale') fail(`unknown command "${command}"\n\n${USAGE}`);

const projectId = read('--project', '').trim();
if (!projectId) fail('--project <id> is required');
const dbPath = read('--db', process.env.OWNER_AGENT_DB || defaultDbPath());
const thresholdDays = Number(read('--threshold-days', String(DEFAULT_STALE_THRESHOLD_DAYS)));
if (!Number.isFinite(thresholdDays) || thresholdDays < 0) fail('--threshold-days must be a non-negative number');

// 只读取登记信息；登记本身属于 Owner 侧写入，不在观察命令里发生。
const owner = new OwnerStore(dbPath);
let project;
try {
  project = owner.getProject(projectId);
} finally {
  owner.close();
}
if (!project) fail(`project not registered: ${projectId}`);

const configPath = read('--config', '');
const configured = configPath
  ? resolveFeishuWebhook({ configPath })
  : resolveFeishuWebhook();
const webhookUrl = read('--webhook', '') || configured.webhook;

const store = new ObserverStore(dbPath);
let result;
try {
  result = await runStaleCheck({ project, store, webhookUrl, thresholdDays });
} finally {
  store.close();
}

if (has('--json')) {
  console.log(JSON.stringify({
    projectId: project.id,
    event: result.event,
    delivery: result.delivery
  }, null, 2));
} else if (!result.event) {
  console.log(`${project.name}（${project.id}）未停滞：最后提交 ${result.snapshot.lastCommitAt ?? '（无提交历史）'}`);
} else {
  console.log(result.text);
  console.log(`投递：${result.delivery.status}（${result.delivery.detail}）`);
}

if (result.delivery?.status === 'failed') process.exit(1);
process.exit(0);
