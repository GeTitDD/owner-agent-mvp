import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerSandboxProvider } from '../src/sandbox-provider.mjs';

const providerWith = (handler) => new DockerSandboxProvider({
  dockerExec: async (args) => ({
    code: 0,
    stdout: '',
    stderr: '',
    ...(await handler(args))
  })
});
const handle = { providerRunId: 'abcdef123456', name: 'owner-sandbox-test', runId: 'test', projectId: 'proj-a', attempt: 1 };
const labels = JSON.stringify({ 'owner.sandbox': '1', 'owner.run': 'test', 'owner.project': 'proj-a', 'owner.attempt': '1' });

test('[sandbox-provider#1] a verified no-such-container is missing; a daemon error is unknown', async () => {
  const missing = providerWith((args) => {
    if (args[0] === 'inspect') return { code: 1, stderr: 'Error: No such object: abcdef123456' };
    return {};
  });
  assert.deepEqual(await missing.inspect(handle), { state: 'missing' });

  const unavailable = providerWith((args) => {
    if (args[0] === 'inspect') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    return {};
  });
  await assert.rejects(() => unavailable.inspect(handle), /inspect unavailable/);
});

test('[sandbox-provider#2] stop never confirms when inspect becomes unavailable', async () => {
  const provider = providerWith((args) => {
    if (args[0] === 'inspect' && args[2] === '{{json .Config.Labels}}') return { stdout: labels };
    if (args[0] === 'stop') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    if (args[0] === 'inspect') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    return {};
  });
  await assert.rejects(() => provider.stop(handle), /inspect unavailable/);
});

test('[sandbox-provider#3] preflight rejects unknown cgroup, missing seccomp and untrusted digest', async () => {
  const profile = {
    imageDigest: `sha256:${'a'.repeat(64)}`, id: 'node-smoke', command: ['node', '--version']
  };
  const base = (args) => {
    if (args[0] === 'version') return { stdout: 'linux\n' };
    if (args[0] === 'image') return { stdout: 'img\n' };
    if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') return { stdout: '["name=seccomp,profile=builtin"]' };
    if (args[0] === 'info') return { stdout: '2\n' };
    return {};
  };
  assert.equal((await providerWith(base).preflight(profile)).ok, true);
  assert.equal((await providerWith((args) => {
    if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') return { stdout: '["name=apparmor"]' };
    return base(args);
  }).preflight(profile)).reason, 'seccomp-required');
  assert.equal((await providerWith((args) => {
    if (args[0] === 'info' && args[2] === '{{.CgroupVersion}}') return { stdout: '1\n' };
    return base(args);
  }).preflight(profile)).reason, 'cgroup-v2-required');
  assert.equal((await providerWith((args) => {
    if (args[0] === 'info') return { code: 1, stderr: 'Cannot connect' };
    return base(args);
  }).preflight(profile)).reason, 'docker-info-unavailable');
  const trusted = new DockerSandboxProvider({ trustedImageDigests: [`sha256:${'b'.repeat(64)}`], dockerExec: async (args) => ({ code: 0, stdout: '', stderr: '', ...base(args) }) });
  assert.equal((await trusted.preflight(profile)).reason, 'image-not-trusted');
});

test('[sandbox-provider#4] strict reconciliation lookup distinguishes absent, unavailable and foreign containers', async () => {
  const absent = providerWith((args) => {
    if (args[0] === 'ps') return { stdout: '' };
    return {};
  });
  assert.equal(await absent.findOwnedContainerStrict({ runId: 'test', projectId: 'proj-a', attempt: 1 }), null);

  const unavailable = providerWith((args) => {
    if (args[0] === 'ps') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    return {};
  });
  await assert.rejects(
    () => unavailable.findOwnedContainerStrict({ runId: 'test', projectId: 'proj-a', attempt: 1 }),
    /lookup unavailable/
  );

  const foreign = providerWith((args) => {
    if (args[0] === 'ps') return { stdout: 'abcdef123456\n' };
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ 'owner.sandbox': '1', 'owner.run': 'other' }) };
    return {};
  });
  await assert.rejects(
    () => foreign.findOwnedContainerStrict({ runId: 'test', projectId: 'proj-a', attempt: 1 }),
    /foreign container/
  );

  const found = providerWith((args) => {
    if (args[0] === 'ps') return { stdout: 'abcdef123456\n' };
    if (args[0] === 'inspect') return { stdout: labels };
    return {};
  });
  assert.equal((await found.findOwnedContainerStrict({ runId: 'test', projectId: 'proj-a', attempt: 1 })).providerRunId,
    'abcdef123456');
});

test('[sandbox-provider#5] create failure after a container id retains the orphan provider identity', async () => {
  const provider = providerWith((args) => {
    if (args[0] === 'create') return { stdout: 'abcdef123456\n' };
    if (args[0] === 'inspect' && args[2] === '{{json .Config.Labels}}') return { stdout: labels };
    if (args[0] === 'inspect') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
    return {};
  });
  await assert.rejects(
    () => provider.create({
      runId: 'test', projectId: 'proj-a', attempt: 1, snapshotPath: '/tmp/snapshot',
      command: ['node', '--test', 'tests/smoke.test.mjs'], imageDigest: `sha256:${'a'.repeat(64)}`,
      timeoutMs: 30000, memoryBytes: 134217728, cpus: 1, pidsLimit: 64, tmpfsBytes: 33554432
    }),
    (error) => error.providerRunId === 'abcdef123456' && error.code === 'inspect-unavailable'
  );
});
