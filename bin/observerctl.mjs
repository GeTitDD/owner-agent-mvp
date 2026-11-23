#!/usr/bin/env node
// 观察员命令行入口：只读探针 + 事件 + 飞书投递，不依赖 Electron。
//
// 用法：
//   node bin/observerctl.mjs stale --project <id> [--threshold-days 3]
//   node bin/observerctl.mjs check --project <id> [--drift-commits 10] [--backlog-files 20]
//     [--webhook <your-webhook>] [--config <feishu.json>] [--thresholds <thresholds.json>]
//     [--db <sqlite>] [--json]
//   node bin/observerctl.mjs digest [--quiet-start 22] [--quiet-end 8] [--now <iso>]
//     [--webhook ...] [--db <sqlite>] [--json]
//
// stale 只查停滞（保持 #27 的行为）；check 一次查停滞、漂移与积压，三者共用 thresholds.mjs。
// digest 扫描全部已登记项目，每个项目每个本地日历日最多一条聚合消息（#30）。
// webhook 读取优先级：--webhook > OWNER_OBSERVER_FEISHU_WEBHOOK > --config/默认配置文件 > 未配置（skipped）。
// 阈值读取优先级：显式命令行参数 > 环境变量 > --thresholds/默认阈值文件 > 内置默认值。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerStore } from '../src/owner-store.mjs';
import { ObserverStore } from '../src/observer/store.mjs';
import { runStaleCheck, runProjectCheck, runDigestScan } from '../src/observer/service.mjs';
import { resolveFeishuWebhook } from '../src/observer/config.mjs';
import { DEFAULT_THRESHOLDS, resolveThresholds } from '../src/observer/thresholds.mjs';
import { DEFAULT_QUIET_HOURS, normalizeQuietHours } from '../src/observer/digest.mjs';
import { defaultDbPath } from '../src/storage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Observe registered projects and notify Feishu when they go stale, adrift or backlogged.

Usage:
  node bin/observerctl.mjs stale --project <id> [options]
  node bin/observerctl.mjs check --project <id> [options]
  node bin/observerctl.mjs digest [options]

Commands:
  stale                   Detect staleness only (the #27 workflow)
  check                   Detect staleness, drift and backlog in one pass
  digest                  Scan every registered project; at most one digest per project per day

Options:
  --project <id>          Registered project id (required for stale / check)
  --threshold-days <n>    Stale threshold in days (default ${DEFAULT_THRESHOLDS.staleDays})
  --drift-commits <n>     Commits behind trunk before drift (default ${DEFAULT_THRESHOLDS.driftCommits})
  --backlog-files <n>     Uncommitted files that count as backlog (default ${DEFAULT_THRESHOLDS.backlogFiles})
  --thresholds <path>     Threshold config file (default ~/.owner-agent/thresholds.json)
  --quiet-start <hour>    Quiet window start hour, inclusive (default ${DEFAULT_QUIET_HOURS.startHour})
  --quiet-end <hour>      Quiet window end hour, exclusive (default ${DEFAULT_QUIET_HOURS.endHour})
  --now <iso>             Override the scan clock (local calendar day, ISO timestamp)
  --webhook <your-webhook> Feishu bot webhook; overrides environment and config file
  --config <path>         Feishu config file (default ~/.owner-agent/feishu.json)
  --db <path>             Audit database (default ${defaultDbPath()})
  --json                  Print a machine-readable summary

Exit codes: 0 = sent/skipped/deferred/no event, 1 = delivery failed or invalid input.`;

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
if (command !== 'stale' && command !== 'check' && command !== 'digest') {
  fail(`unknown command "${command}"\n\n${USAGE}`);
}

const scan = command === 'digest';
const projectId = read('--project', '').trim();
if (!scan && !projectId) fail('--project <id> is required');
const dbPath = read('--db', process.env.OWNER_AGENT_DB || defaultDbPath());

// 阈值集中由 thresholds.mjs 解析；命令行参数只在显式给出时覆盖。
const envThresholdsPath = typeof process.env.OWNER_OBSERVER_THRESHOLDS === 'string'
  ? process.env.OWNER_OBSERVER_THRESHOLDS.trim() : '';
const thresholdsPath = read('--thresholds', '') || envThresholdsPath;
let thresholds;
try {
  thresholds = resolveThresholds(thresholdsPath ? { configPath: thresholdsPath } : {});
} catch (error) {
  fail(error.message);
}
// 覆盖阈值：停滞允许小数天，提交数与文件数必须是非负整数。
const override = (flag, field, { min = 0, integer = false } = {}) => {
  if (!has(flag)) return thresholds[field];
  const value = Number(read(flag, ''));
  const valid = Number.isFinite(value) && value >= min && (!integer || Number.isSafeInteger(value));
  if (!valid) fail(`${flag} must be ${integer ? 'an integer' : 'a number'} >= ${min}`);
  return value;
};
thresholds.staleDays = override('--threshold-days', 'staleDays');
thresholds.driftCommits = override('--drift-commits', 'driftCommits', { integer: true });
thresholds.backlogFiles = override('--backlog-files', 'backlogFiles', { min: 1, integer: true });

const configPath = read('--config', '');
const configured = configPath
  ? resolveFeishuWebhook({ configPath })
  : resolveFeishuWebhook();
const webhookUrl = read('--webhook', '') || configured.webhook;

// 多项目每日聚合：不需要 --project，一次扫描全部已登记项目。
if (scan) {
  const nowArg = read('--now', '').trim();
  const now = nowArg ? new Date(nowArg) : new Date();
  if (!Number.isFinite(now.getTime())) fail('--now must be a valid ISO timestamp');

  let quietHours;
  try {
    quietHours = normalizeQuietHours({
      startHour: Number(read('--quiet-start', String(DEFAULT_QUIET_HOURS.startHour))),
      endHour: Number(read('--quiet-end', String(DEFAULT_QUIET_HOURS.endHour)))
    });
  } catch (error) {
    fail(error.message);
  }

  const owner = new OwnerStore(dbPath);
  let projects;
  try {
    projects = owner.listProjects();
  } finally {
    owner.close();
  }

  const store = new ObserverStore(dbPath);
  let result;
  try {
    result = await runDigestScan({ projects, store, webhookUrl, now, thresholds, quietHours });
  } finally {
    store.close();
  }

  const failed = result.deliveries.some((delivery) => delivery.status === 'failed');
  if (has('--json')) {
    console.log(JSON.stringify({
      day: result.day,
      targetDay: result.targetDay,
      quiet: result.quiet,
      quietHours: result.quietHours,
      projects: result.projects.map((item) => ({
        projectId: item.projectId,
        projectName: item.projectName,
        events: item.events.map((event) => event.type),
        digestId: item.digestId,
        skipped: item.skipped,
        error: item.error ?? null
      })),
      rolled: result.rolled,
      deliveries: result.deliveries.map((delivery) => ({
        digestId: delivery.digestId,
        projectId: delivery.projectId,
        day: delivery.day,
        status: delivery.status,
        detail: delivery.detail,
        attempts: delivery.attempts.map((attempt) => ({ status: attempt.status, detail: attempt.detail }))
      }))
    }, null, 2));
  } else {
    if (result.quiet) {
      console.log(`夜间静默 ${result.quietHours.startHour}:00–${result.quietHours.endHour}:00：`
        + `本次不投递，顺延到 ${result.targetDay} 合并。`);
    }
    for (const item of result.projects) {
      if (item.error) {
        console.error(`${item.projectName || item.projectId}（${item.projectId}）：扫描失败（${item.error}）`);
        continue;
      }
      const counts = item.events.reduce((acc, event) => {
        acc[event.type] = (acc[event.type] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`${item.projectName || item.projectId}（${item.projectId}）：停滞 ${counts.stale ?? 0}`
        + ` · 漂移 ${counts.drift ?? 0} · 积压 ${counts.backlog ?? 0}`);
    }
    for (const delivery of result.deliveries) {
      console.log(`${delivery.projectId} ${delivery.day} 投递：${delivery.status}（${delivery.detail}）`);
    }
    if (!result.projects.some((item) => item.events.length)) console.log('本轮没有新的观察事件。');
  }
  if (failed) process.exit(1);
  process.exit(0);
}

// 只读取登记信息；登记本身属于 Owner 侧写入，不在观察命令里发生。
const owner = new OwnerStore(dbPath);
let project;
try {
  project = owner.getProject(projectId);
} finally {
  owner.close();
}
if (!project) fail(`project not registered: ${projectId}`);

const store = new ObserverStore(dbPath);
let result;
try {
  result = command === 'stale'
    ? await runStaleCheck({ project, store, webhookUrl, thresholdDays: thresholds.staleDays })
    : await runProjectCheck({ project, store, webhookUrl, thresholds });
} finally {
  store.close();
}

if (has('--json')) {
  console.log(JSON.stringify(command === 'stale'
    ? { projectId: project.id, event: result.event, delivery: result.delivery }
    : { projectId: project.id, events: result.events, deliveries: result.deliveries }, null, 2));
} else if (command === 'stale') {
  if (!result.event) {
    console.log(`${project.name}（${project.id}）未停滞：最后提交 ${result.snapshot.lastCommitAt ?? '（无提交历史）'}`);
  } else {
    console.log(result.text);
    console.log(`投递：${result.delivery.status}（${result.delivery.detail}）`);
  }
} else if (result.events.length === 0) {
  console.log(`${project.name}（${project.id}）未发现停滞、漂移或积压`);
} else {
  for (const item of result.results) {
    console.log(item.text);
    console.log(`投递：${item.delivery.status}（${item.delivery.detail}）`);
  }
}

const failed = command === 'stale'
  ? result.delivery?.status === 'failed'
  : result.deliveries.some((delivery) => delivery.status === 'failed');
if (failed) process.exit(1);
process.exit(0);
