// code-write Job：写入类任务与 code-patch 共用同样的前置约束。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-job-'));
  const store = new OwnerStore(path.join(root, 'owner.sqlite'));
  const projectRoot = path.join(root, 'proj');
  fs.mkdirSync(projectRoot, { recursive: true });
  store.registerProject({ id: 'p1', name: 'P1', root: projectRoot, primaryDomain: 'software-engineering' });
  const task = store.createTask({ projectId: 'p1', title: 'Write docs' });
  return { root, store, task };
};

const baseSha = 'a'.repeat(40);

test('code-write job 被接受并进入待批准', () => {
  const { store, task } = setup();
  try {
    const job = store.createJob({
      projectId: 'p1',
      jobType: 'code-write',
      title: 'Write docs',
      ownerTaskId: task.id,
      idempotencyKey: 'write-1',
      payload: { baseSha, allowedPaths: 'docs/' }
    });
    assert.equal(job.job_type, 'code-write');
    assert.equal(job.status, 'pending_approval');
  } finally { store.close(); }
});

test('code-write 仍要求 owner task / baseSha / allowedPaths', () => {
  const { store, task } = setup();
  try {
    assert.throws(() => store.createJob({
      projectId: 'p1', jobType: 'code-write', title: 'x', idempotencyKey: 'write-2',
      payload: { baseSha, allowedPaths: 'docs/' }
    }), /owner task/u);
    assert.throws(() => store.createJob({
      projectId: 'p1', jobType: 'code-write', title: 'x', ownerTaskId: task.id,
      idempotencyKey: 'write-3', payload: { allowedPaths: 'docs/' }
    }), /baseSha/u);
    assert.throws(() => store.createJob({
      projectId: 'p1', jobType: 'code-write', title: 'x', ownerTaskId: task.id,
      idempotencyKey: 'write-4', payload: { baseSha }
    }), /allowedPaths/u);
  } finally { store.close(); }
});
