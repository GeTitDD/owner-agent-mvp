import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAppliedSandboxFixture } from './helpers/sandbox-fixture.mjs';
import { DockerSandboxProvider } from '../src/sandbox-provider.mjs';
import { SandboxRunner } from '../src/sandbox-runner.mjs';
import { createInputSnapshot, cleanupInputSnapshot } from '../src/sandbox-materializer.mjs';
import { approvalHash, resolveTestProfile } from '../src/sandbox-protocol.mjs';
import { sha256 } from '../src/utils.mjs';

const real = process.env.OWNER_AGENT_SANDBOX_REAL === '1';
const imageDigest = process.env.OWNER_AGENT_SANDBOX_IMAGE_DIGEST || '';

const smoke = `import test from 'node:test';
import assert from 'node:assert/strict';
test('real sandbox smoke', () => assert.equal(1, 1));
`;

const fail = `import test from 'node:test';
import assert from 'node:assert/strict';
test('real sandbox assertion failure', () => assert.equal(1, 2));
`;

const probe = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';

test('runs as a non-root uid', () => {
  assert.notEqual(process.getuid(), 0);
});

test('has no effective capabilities and no-new-privileges', () => {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const cap = status.match(/^CapEff:\\s*([0-9a-f]+)$/m)?.[1] ?? '';
  assert.equal(Number.parseInt(cap || '0', 16), 0);
  assert.match(status, /^NoNewPrivs:\\s*1$/m);
});

test('cannot write the read-only workspace', () => {
  assert.throws(() => fs.writeFileSync('/workspace/forbidden.txt', 'x'));
});

test('can write only the tmpfs scratch directory', () => {
  fs.writeFileSync('/tmp/sandbox-probe.txt', 'ok');
  assert.equal(fs.readFileSync('/tmp/sandbox-probe.txt', 'utf8'), 'ok');
});

test('has no Docker socket or host root access', () => {
  assert.equal(fs.existsSync('/var/run/docker.sock'), false);
  assert.throws(() => fs.readdirSync('/root'));
});

test('has no network route', async () => {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '1.1.1.1', port: 80 });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('network timeout')); });
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  }));
});

test('cgroup limits are visible when the host exposes them', () => {
  for (const file of ['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/memory.max']) {
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      assert.notEqual(value, '');
    }
  }
});
`;

test('[sandbox-real] Linux Docker smoke and isolation probes', {
  skip: !real || !imageDigest
}, async () => {
  assert.match(imageDigest, /^sha256:[0-9a-f]{64}$/, 'OWNER_AGENT_SANDBOX_IMAGE_DIGEST must be sha256:<64 hex>');
  const fixture = await makeAppliedSandboxFixture({
    key: 'sandbox-real',
    patchFiles: [
      { path: 'src/app.js', action: 'modify', content: 'export const x = 2;\n' },
      { path: 'tests/sandbox-smoke.test.mjs', action: 'add', content: smoke },
      { path: 'tests/sandbox-fail.test.mjs', action: 'add', content: fail },
      { path: 'tests/sandbox-probe.test.mjs', action: 'add', content: probe }
    ]
  });
  try {
    for (const [profileId, expectedStatus] of [['node-smoke', 'pass'], ['node-fail', 'fail'], ['node-probe', 'pass']]) {
      const profile = resolveTestProfile(profileId, { imageDigest });
      const runId = `real-${profileId}`;
      const snapshot = createInputSnapshot({
        runId,
        workspacePath: fixture.workspace.path,
        proposal: fixture.proposal,
        includePaths: [],
        sandboxRoot: fixture.sandboxRoot
      });
      const hash = approvalHash({
        projectId: fixture.projectId,
        workspaceId: fixture.workspace.id,
        proposalId: fixture.proposal.id,
        approvedHash: fixture.proposal.approved_hash,
        baseSha: fixture.proposal.base_sha,
        profile,
        snapshotHash: snapshot.snapshotHash,
        includePaths: []
      });
      fixture.store.createSandboxRun({
        id: runId,
        projectId: fixture.projectId,
        jobId: fixture.job.id,
        attempt: fixture.proposal.attempt,
        workspaceId: fixture.workspace.id,
        proposalId: fixture.proposal.id,
        approvedHash: fixture.proposal.approved_hash,
        baseSha: fixture.proposal.base_sha,
        profile,
        approvalHash: hash,
        snapshotHash: snapshot.snapshotHash,
        snapshotPath: snapshot.snapshotPath,
        includePaths: []
      });
      const manifest = JSON.stringify(snapshot.manifest);
      fixture.store.saveSandboxEvidence(runId, 'snapshot_manifest', {
        content: manifest,
        contentHash: sha256(manifest),
        bytes: Buffer.byteLength(manifest)
      });
      fixture.store.approveSandboxRun(runId, { expectedHash: hash });

      const provider = new DockerSandboxProvider({
        requireRootless: process.env.OWNER_AGENT_SANDBOX_REQUIRE_ROOTLESS === '1'
      });
      const runner = new SandboxRunner(fixture.store, {
        provider,
        workerId: `real-${profileId}`,
        pollMs: 250,
        leaseMs: 120000
      });
      const result = await runner.runOnce({ projectId: fixture.projectId });
      const saved = fixture.store.getSandboxRun(runId);
      assert.equal(result.outcome, 'completed', `profile ${profileId} outcome`);
      assert.equal(saved.execution_status, 'completed');
      assert.equal(saved.test_status, expectedStatus, `profile ${profileId} test status`);
      const stdout = fixture.store.getSandboxEvidence(runId, 'stdout');
      assert.ok(stdout && stdout.bytes > 0, `profile ${profileId} evidence`);
      if (expectedStatus === 'pass') assert.match(stdout.content, /TAP version|ok 1|# pass/i);
      else assert.match(stdout.content, /not ok|# fail/i);
      cleanupInputSnapshot({
        snapshotPath: snapshot.snapshotPath,
        runId,
        snapshotHash: snapshot.snapshotHash,
        sandboxRoot: fixture.sandboxRoot
      });
    }
  } finally {
    fixture.cleanup();
  }
});
