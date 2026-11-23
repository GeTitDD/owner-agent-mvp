import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { probeProject } from '../src/observer/probe.mjs';
import { detectStaleEvent } from '../src/observer/events.mjs';
import { git, makeRepo, makeTempDir } from './helpers/observer-fixture.mjs';

const withDir = async (fn) => {
  const dir = makeTempDir();
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
const NOW = new Date('2026-11-24T09:00:00+08:00');
const FOUR_DAYS_AGO = '2026-11-20T09:00:00+08:00';

test('最后提交在 4 天前的项目产生一条停滞事件', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'stale'), commitAt: FOUR_DAYS_AGO });
  const snapshot = probeProject({ projectId: 'obs-stale', projectName: 'Stale Project', root });

  const event = detectStaleEvent(snapshot, { now: NOW, thresholdDays: 3 });

  assert.equal(event.type, 'stale');
  assert.equal(event.projectId, 'obs-stale');
  assert.equal(event.projectName, 'Stale Project');
  assert.equal(event.branch, 'main');
  assert.equal(event.lastCommitAt, FOUR_DAYS_AGO);
  assert.equal(event.detectedAt, '2026-11-24T01:00:00.000Z');
  assert.equal(event.daysStale, 4);
  assert.match(event.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(event.head, snapshot.head);
}));

test('未超过阈值的项目不产生事件', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'fresh'), commitAt: '2026-11-22T09:00:00+08:00' });
  const snapshot = probeProject({ projectId: 'obs-fresh', root });

  assert.equal(detectStaleEvent(snapshot, { now: NOW, thresholdDays: 3 }), null);
}));

test('无提交历史的项目不产生停滞事件', () => withDir(async (dir) => {
  const root = path.join(dir, 'empty');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  const snapshot = probeProject({ projectId: 'obs-empty', root });

  assert.equal(detectStaleEvent(snapshot, { now: NOW, thresholdDays: 3 }), null);
}));

test('指纹只由项目、分支与最后提交决定：重复检测稳定，换分支或换提交则变化', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'repo'), commitAt: FOUR_DAYS_AGO });
  const snapshot = probeProject({ projectId: 'obs-fp', projectName: 'FP', root });

  const first = detectStaleEvent(snapshot, { now: NOW, thresholdDays: 3 });
  const later = detectStaleEvent(snapshot, { now: new Date('2026-11-24T21:00:00+08:00'), thresholdDays: 3 });
  const otherProject = detectStaleEvent({ ...snapshot, projectId: 'obs-fp-2' }, { now: NOW, thresholdDays: 3 });

  assert.equal(first.fingerprint, later.fingerprint);
  assert.notEqual(first.fingerprint, otherProject.fingerprint);

  git(root, ['checkout', '-q', '-b', 'feature']);
  const onBranch = detectStaleEvent(probeProject({ projectId: 'obs-fp', root }), { now: NOW, thresholdDays: 3 });
  assert.notEqual(first.fingerprint, onBranch.fingerprint);

  git(root, ['commit', '-q', '--allow-empty', '-m', 'next'],
    { GIT_AUTHOR_DATE: '2026-11-21T08:00:00+08:00', GIT_COMMITTER_DATE: '2026-11-21T08:00:00+08:00' });
  const newHead = detectStaleEvent(probeProject({ projectId: 'obs-fp', root }), { now: NOW, thresholdDays: 3 });
  assert.notEqual(onBranch.fingerprint, newHead.fingerprint);
}));

test('detached HEAD 的停滞事件带可读的分支标签', () => withDir(async (dir) => {
  const root = makeRepo({ root: path.join(dir, 'detached'), commitAt: FOUR_DAYS_AGO });
  git(root, ['checkout', '-q', '--detach', 'HEAD']);

  const event = detectStaleEvent(probeProject({ projectId: 'obs-detached', root }), { now: NOW, thresholdDays: 3 });

  assert.equal(event.branch, null);
  assert.equal(event.branchLabel, '(detached HEAD)');
}));
