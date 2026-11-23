import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { probeProject } from '../src/observer/probe.mjs';
import { detectStaleEvent, detectDriftEvent, detectBacklogEvent } from '../src/observer/events.mjs';
import { DEFAULT_THRESHOLDS, resolveThresholds } from '../src/observer/thresholds.mjs';
import {
  addUntrackedFiles,
  git,
  makeBehindRepo,
  makeRepo,
  makeTempDir,
  statusText,
  treeDigest
} from './helpers/observer-fixture.mjs';

const withDir = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const NOW = new Date('2026-11-24T09:00:00+08:00');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';

test('落后主干 12 个提交的项目产生一条漂移事件，且探针不修改仓库', () => withDir(async (dir) => {
  const root = makeBehindRepo({ root: path.join(dir, 'drift'), behind: 12, commitAt: FOUR_DAYS_AGO });
  const beforeTree = treeDigest(root);
  const beforeStatus = statusText(root);

  const snapshot = probeProject({ projectId: 'obs-drift', projectName: 'Drift Project', root });
  const event = detectDriftEvent(snapshot, { now: NOW, driftCommits: 10 });

  assert.equal(snapshot.branch, 'feature');
  assert.equal(snapshot.trunkRef, 'main');
  assert.equal(snapshot.behindTrunk, 12);
  assert.equal(event.type, 'drift');
  assert.equal(event.projectId, 'obs-drift');
  assert.equal(event.projectName, 'Drift Project');
  assert.equal(event.branchLabel, 'feature');
  assert.equal(event.trunkRef, 'main');
  assert.equal(event.behindTrunk, 12);
  assert.equal(event.detectedAt, '2026-11-24T01:00:00.000Z');
  assert.match(event.fingerprint, /^[0-9a-f]{64}$/);

  assert.equal(statusText(root), beforeStatus);
  assert.equal(treeDigest(root), beforeTree);
}));

test('落后提交数超过阈值才触发漂移：10 不触发，11 触发', () => withDir(async (dir) => {
  const exact = probeProject({
    projectId: 'obs-drift-exact',
    root: makeBehindRepo({ root: path.join(dir, 'exact'), behind: 10 })
  });
  const over = probeProject({
    projectId: 'obs-drift-over',
    root: makeBehindRepo({ root: path.join(dir, 'over'), behind: 11 })
  });

  assert.equal(exact.behindTrunk, 10);
  assert.equal(detectDriftEvent(exact, { now: NOW, driftCommits: 10 }), null);
  assert.equal(over.behindTrunk, 11);
  assert.equal(detectDriftEvent(over, { now: NOW, driftCommits: 10 }).type, 'drift');
}));

test('没有可比主干时（就在 main 上）不产生漂移事件', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'solo'), commitAt: FOUR_DAYS_AGO });
  const snapshot = probeProject({ projectId: 'obs-solo', root });

  assert.equal(snapshot.trunkRef, null);
  assert.equal(snapshot.behindTrunk, 0);
  assert.equal(detectDriftEvent(snapshot, { now: NOW, driftCommits: 10 }), null);
}));

test('未提交文件达到 20 个产生一条积压事件', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'backlog'), commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);

  const snapshot = probeProject({ projectId: 'obs-backlog', projectName: 'Backlog Project', root });
  const event = detectBacklogEvent(snapshot, { now: NOW, backlogFiles: 20 });

  assert.equal(snapshot.uncommittedFiles, 25);
  assert.equal(event.type, 'backlog');
  assert.equal(event.projectId, 'obs-backlog');
  assert.equal(event.projectName, 'Backlog Project');
  assert.equal(event.uncommittedFiles, 25);
  assert.equal(event.detectedAt, '2026-11-24T01:00:00.000Z');
  assert.match(event.fingerprint, /^[0-9a-f]{64}$/);
}));

test('未提交文件未达阈值不触发积压：19 不触发，20 触发', () => withDir(async (dir) => {
  const under = makeRepo({ root: path.join(dir, 'under'), commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(under, 19);
  const at = makeRepo({ root: path.join(dir, 'at'), commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(at, 20);

  const underSnapshot = probeProject({ projectId: 'obs-under', root: under });
  const atSnapshot = probeProject({ projectId: 'obs-at', root: at });

  assert.equal(underSnapshot.uncommittedFiles, 19);
  assert.equal(detectBacklogEvent(underSnapshot, { now: NOW, backlogFiles: 20 }), null);
  assert.equal(atSnapshot.uncommittedFiles, 20);
  assert.equal(detectBacklogEvent(atSnapshot, { now: NOW, backlogFiles: 20 }).type, 'backlog');
}));

test('三类事件的指纹互不冲突', () => withDir(async (dir) => {
  const root = makeBehindRepo({ root: path.join(dir, 'all'), behind: 12, commitAt: FOUR_DAYS_AGO });
  addUntrackedFiles(root, 25);
  const snapshot = probeProject({ projectId: 'obs-all', projectName: 'All', root });

  const stale = detectStaleEvent(snapshot, { now: NOW, thresholdDays: 3 });
  const drift = detectDriftEvent(snapshot, { now: NOW, driftCommits: 10 });
  const backlog = detectBacklogEvent(snapshot, { now: NOW, backlogFiles: 20 });

  assert.equal(stale.type, 'stale');
  assert.equal(drift.type, 'drift');
  assert.equal(backlog.type, 'backlog');
  const fingerprints = new Set([stale.fingerprint, drift.fingerprint, backlog.fingerprint]);
  assert.equal(fingerprints.size, 3);
}));

test('漂移指纹只由仓库与分支决定：落后更多也不换指纹，只更新证据字段', () => withDir(async (dir) => {
  const root = makeBehindRepo({ root: path.join(dir, 'stable'), behind: 12, commitAt: FOUR_DAYS_AGO });
  const projectId = 'obs-stable-fp';

  const first = detectDriftEvent(probeProject({ projectId, root }), { now: NOW, driftCommits: 10 });
  const again = detectDriftEvent(probeProject({ projectId, root }), {
    now: new Date('2026-11-24T21:00:00+08:00'),
    driftCommits: 10
  });
  assert.equal(first.fingerprint, again.fingerprint);

  git(root, ['checkout', '-q', 'main']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'more trunk']);
  git(root, ['checkout', '-q', 'feature']);
  const deeper = detectDriftEvent(probeProject({ projectId, root }), { now: NOW, driftCommits: 10 });
  // 落后加深不换指纹：#28 的 24 小时冷却必须覆盖「同一分支漂移更深」这一情况。
  assert.equal(deeper.behindTrunk, 13);
  assert.equal(first.fingerprint, deeper.fingerprint);
}));

test('三类事件的阈值集中在一处配置：文件覆盖默认值，环境变量覆盖文件', () => withDir(async (dir) => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { staleDays: 3, driftCommits: 10, backlogFiles: 20 });

  const root = makeBehindRepo({ root: path.join(dir, 'configured'), behind: 12, commitAt: FOUR_DAYS_AGO });
  const snapshot = probeProject({ projectId: 'obs-config', root });

  const configPath = path.join(dir, 'thresholds.json');
  fs.writeFileSync(configPath, JSON.stringify({ driftCommits: 12, backlogFiles: 25 }));

  const fromFile = resolveThresholds({ env: {}, configPath });
  assert.deepEqual(fromFile, { staleDays: 3, driftCommits: 12, backlogFiles: 25 });
  // 阈值改为 12 后，落后 12 个提交不再「超过」阈值。
  assert.equal(detectDriftEvent(snapshot, { now: NOW, driftCommits: fromFile.driftCommits }), null);
  assert.equal(detectDriftEvent(snapshot, { now: NOW, driftCommits: DEFAULT_THRESHOLDS.driftCommits }).type, 'drift');

  const fromEnv = resolveThresholds({
    env: { OWNER_OBSERVER_DRIFT_COMMITS: '5', OWNER_OBSERVER_BACKLOG_FILES: '30' },
    configPath
  });
  assert.deepEqual(fromEnv, { staleDays: 3, driftCommits: 5, backlogFiles: 30 });
}));

test('缺失的配置文件按默认阈值处理，非法阈值在配置边界报错', () => withDir(async (dir) => {
  const missing = resolveThresholds({ env: {}, configPath: path.join(dir, 'nope.json') });
  assert.deepEqual(missing, DEFAULT_THRESHOLDS);

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ driftCommits: -1 }));
  assert.throws(() => resolveThresholds({ env: {}, configPath: bad }), /Invalid drift threshold/);
}));
