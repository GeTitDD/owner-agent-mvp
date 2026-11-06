// SandboxProvider implementations.
//
// The real backend is Docker CLI driven by fixed argv. It is intentionally NOT a general
// Docker wrapper: callers cannot pass network/mount/privileged/entrypoint options. The
// Fake provider mirrors the same lifecycle for deterministic, cross-platform tests.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execFileP = promisify(execFile);

export class SandboxProviderError extends Error {
  constructor(message, code = 'sandbox-provider-error') {
    super(message);
    this.name = 'SandboxProviderError';
    this.code = code;
  }
}

const check = (ok, message, code = 'sandbox-provider-error') => {
  if (!ok) throw new SandboxProviderError(message, code);
};

export class FakeSandboxProvider {
  constructor() {
    this.preflightCalls = [];
    this.createCalls = [];
    this.startCalls = [];
    this.stopCalls = [];
    this.disposeCalls = [];
    this.collectCalls = [];
    this.runs = new Map();
    this.lastHandle = null;
    this.preflightResult = { ok: true, provider: 'fake', rootless: true, cgroupVersion: 'fake' };
    this.preflightError = null;
    this.createError = null;
    this.stopConfirmed = true;
    this.inspectError = null;
    this.stopError = null;
    this.disposeError = null;
    this.missing = false;
    this._seq = 0;
  }

  async preflight(profile) {
    this.preflightCalls.push(profile);
    if (this.preflightError) throw this.preflightError;
    return { ...this.preflightResult };
  }

  async create(spec) {
    this.createCalls.push(spec);
    if (this.createError) throw this.createError;
    const id = `fake-sandbox-${++this._seq}`;
    const run = {
      id,
      spec,
      state: 'created',
      exitCode: null,
      signal: null,
      oomKilled: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0)
    };
    this.runs.set(id, run);
    const handle = { providerRunId: id, name: id };
    this.lastHandle = handle;
    return handle;
  }

  async start(handle) {
    this.startCalls.push(handle);
    const run = this.runs.get(handle.providerRunId);
    check(!!run, 'fake sandbox run is missing');
    run.state = 'running';
    return { started: true };
  }

  async inspect(handle) {
    if (this.inspectError) throw this.inspectError;
    if (this.missing) return { state: 'missing' };
    const run = this.runs.get(handle.providerRunId);
    if (!run) return { state: 'missing' };
    if (run.state === 'running') return { state: 'running' };
    return {
      state: run.state === 'created' ? 'created' : 'exited',
      exitCode: run.exitCode,
      signal: run.signal,
      oomKilled: run.oomKilled
    };
  }

  async stop(handle) {
    this.stopCalls.push(handle);
    if (this.stopError) throw this.stopError;
    const run = this.runs.get(handle.providerRunId);
    check(!!run, 'fake sandbox run is missing');
    if (!this.stopConfirmed) return { confirmed: false };
    run.state = 'exited';
    if (run.exitCode === null) run.exitCode = 137;
    run.signal = run.signal ?? 'SIGTERM';
    return { confirmed: true };
  }

  async collect(handle) {
    this.collectCalls.push(handle);
    const run = this.runs.get(handle.providerRunId);
    check(!!run, 'fake sandbox run is missing');
    return {
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      signal: run.signal,
      oomKilled: run.oomKilled
    };
  }

  async dispose(handle) {
    this.disposeCalls.push(handle);
    if (this.disposeError) throw this.disposeError;
    const run = this.runs.get(handle.providerRunId);
    if (!run) return { confirmed: true };
    if (run.state === 'running') return { confirmed: false };
    this.runs.delete(handle.providerRunId);
    return { confirmed: true };
  }

  // Deterministic test controls.
  complete(handle = this.lastHandle, { exitCode = 0, stdout = '', stderr = '', signal = null, oomKilled = false } = {}) {
    const run = this.runs.get(handle.providerRunId);
    check(!!run, 'fake sandbox run is missing');
    run.state = 'exited';
    run.exitCode = exitCode;
    run.signal = signal;
    run.oomKilled = oomKilled;
    run.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'utf8');
    run.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr), 'utf8');
  }
}

export class DockerSandboxProvider {
  constructor({
    dockerBin = 'docker',
    stopConfirmMs = 5000,
    requireRootless = false,
    captureMaxBytes = 1024 * 1024,
    dockerExec = null,
    operationTimeoutMs = 30000,
    trustedImageDigests = null
  } = {}) {
    this.dockerBin = dockerBin;
    this.stopConfirmMs = stopConfirmMs;
    this.requireRootless = requireRootless;
    this.captureMaxBytes = captureMaxBytes;
    this.dockerExec = dockerExec;
    this.operationTimeoutMs = operationTimeoutMs;
    this.trustedImageDigests = trustedImageDigests
      ?? (process.env.OWNER_AGENT_SANDBOX_TRUSTED_DIGESTS
        ? process.env.OWNER_AGENT_SANDBOX_TRUSTED_DIGESTS.split(',').map((x) => x.trim()).filter(Boolean)
        : null);
    this.captures = new Map();
  }

  async docker(args, { allowExitCodes = [] } = {}) {
    if (this.dockerExec) {
      const result = await this.dockerExec(args);
      if (result.code === 0) return result.stdout;
      if (allowExitCodes.includes(result.code)) return result.stdout ?? '';
      const error = new SandboxProviderError('docker command failed', 'docker-command-failed');
      error.exitCode = result.code;
      error.stderr = result.stderr ?? '';
      throw error;
    }
    try {
      const result = await execFileP(this.dockerBin, args, {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout: this.operationTimeoutMs,
        env: { ...process.env, DOCKER_CLI_HINTS: 'false' }
      });
      return result.stdout;
    } catch (error) {
      if (allowExitCodes.includes(error.code)) return error.stdout ?? '';
      const timedOut = error.killed || error.signal === 'SIGTERM' || /timed out/i.test(String(error.message));
      const wrapped = new SandboxProviderError(
        timedOut ? 'docker command timed out' : 'docker command failed',
        timedOut ? 'docker-timeout' : 'docker-command-failed'
      );
      wrapped.exitCode = error.code;
      wrapped.stderr = error.stderr ?? '';
      throw wrapped;
    }
  }

  isMissingContainer(error) {
    return (error?.exitCode === 1 || error?.exitCode === 125)
      && /no such (container|object)/i.test(String(error?.stderr ?? ''));
  }

  async preflight(profile) {
    let serverOs;
    try {
      serverOs = (await this.docker(['version', '--format', '{{.Server.Os}}'])).trim();
    } catch {
      return { ok: false, reason: 'docker-not-available', provider: 'docker' };
    }
    if (serverOs !== 'linux') return { ok: false, reason: 'docker-os-unsupported', provider: 'docker' };
    if (this.trustedImageDigests && !this.trustedImageDigests.includes(profile.imageDigest)) {
      return { ok: false, reason: 'image-not-trusted', provider: 'docker' };
    }
    try {
      await this.docker(['image', 'inspect', profile.imageDigest, '--format', '{{.Id}}']);
    } catch {
      return { ok: false, reason: 'image-not-available', provider: 'docker' };
    }
    let securityOptions;
    let cgroupVersion;
    try {
      securityOptions = JSON.parse((await this.docker(['info', '--format', '{{json .SecurityOptions}}'])).trim());
      cgroupVersion = (await this.docker(['info', '--format', '{{.CgroupVersion}}'])).trim();
    } catch {
      return { ok: false, reason: 'docker-info-unavailable', provider: 'docker' };
    }
    if (cgroupVersion !== '2') {
      return { ok: false, reason: 'cgroup-v2-required', provider: 'docker', cgroupVersion };
    }
    if (!JSON.stringify(securityOptions).includes('seccomp')) {
      return { ok: false, reason: 'seccomp-required', provider: 'docker', cgroupVersion };
    }
    const rootless = JSON.stringify(securityOptions).includes('rootless');
    if (this.requireRootless && !rootless) {
      return { ok: false, reason: 'rootless-required', provider: 'docker', rootless, cgroupVersion };
    }
    return { ok: true, provider: 'docker', rootless, cgroupVersion, imageDigest: profile.imageDigest };
  }

  assertRunSpec(spec) {
    check(spec && typeof spec === 'object', 'run spec is required');
    check(typeof spec.runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,88}$/.test(spec.runId), 'invalid run id');
    check(typeof spec.projectId === 'string' && spec.projectId.length <= 90, 'invalid project id');
    check(Number.isSafeInteger(spec.attempt) && spec.attempt >= 1, 'invalid attempt');
    check(typeof spec.snapshotPath === 'string' && spec.snapshotPath.length > 0 && !spec.snapshotPath.includes(','),
      'invalid snapshot path');
    check(Array.isArray(spec.command) && spec.command.length >= 1 && spec.command[0] === 'node', 'invalid sandbox command');
    check(/^sha256:[0-9a-f]{64}$/.test(spec.imageDigest), 'invalid image digest');
    check(Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs >= 1000 && spec.timeoutMs <= 300000, 'invalid timeout');
    check(Number.isSafeInteger(spec.memoryBytes) && spec.memoryBytes >= 16 * 1024 * 1024, 'invalid memory');
    check(typeof spec.cpus === 'number' && spec.cpus >= 0.1 && spec.cpus <= 4, 'invalid cpus');
    check(Number.isSafeInteger(spec.pidsLimit) && spec.pidsLimit >= 8 && spec.pidsLimit <= 512, 'invalid pids limit');
    check(Number.isSafeInteger(spec.tmpfsBytes) && spec.tmpfsBytes >= 1024 * 1024, 'invalid tmpfs');
  }

  async create(spec) {
    this.assertRunSpec(spec);
    const name = `owner-sandbox-${spec.runId}`;
    const args = [
      'create', '--pull=never', '--name', name,
      '--label', 'owner.sandbox=1',
      '--label', `owner.run=${spec.runId}`,
      '--label', `owner.project=${spec.projectId}`,
      '--label', `owner.attempt=${spec.attempt}`,
      '--network', 'none',
      '--read-only',
      '--user', '65534:65534',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--pids-limit', String(spec.pidsLimit),
      '--memory', String(spec.memoryBytes),
      '--memory-swap', String(spec.memoryBytes),
      '--cpus', String(spec.cpus),
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${spec.tmpfsBytes}`,
      '--mount', `type=bind,src=${spec.snapshotPath},dst=/workspace,readonly`,
      '--workdir', '/workspace',
      '--env', 'HOME=/tmp',
      '--env', 'NO_COLOR=1',
      '--env', 'TZ=UTC',
      '--init',
      '--stop-timeout', '1',
      '--ulimit', 'nofile=256:256',
      '--entrypoint', spec.command[0],
      spec.imageDigest,
      ...spec.command.slice(1)
    ];
    let providerRunId = null;
    try {
      providerRunId = (await this.docker(args)).trim();
      check(/^[0-9a-f]{12,64}$/.test(providerRunId), 'docker create returned an invalid id');
      const handle = { providerRunId, name, runId: spec.runId, projectId: spec.projectId, attempt: spec.attempt };
      await this.assertOwnership(handle);
      await this.assertEffectiveConfig(handle, spec);
      return handle;
    } catch (error) {
      if (providerRunId) {
        error.providerRunId = providerRunId;
        error.name = name;
      }
      throw error;
    }
  }

  async assertEffectiveConfig(handle, spec) {
    let info;
    try {
      info = JSON.parse((await this.docker(['inspect', '--format', '{{json .}}', handle.providerRunId])).trim());
    } catch (error) {
      if (this.isMissingContainer(error)) {
        throw new SandboxProviderError('sandbox container disappeared during configuration verification', 'container-missing');
      }
      throw new SandboxProviderError('sandbox effective configuration cannot be verified', 'inspect-unavailable');
    }
    const hc = info.HostConfig ?? {};
    const fail = (reason) => {
      throw new SandboxProviderError(`sandbox effective configuration mismatch: ${reason}`, 'provider-config-mismatch');
    };
    if (hc.NetworkMode !== 'none') fail('network');
    if (hc.ReadonlyRootfs !== true) fail('readonly-rootfs');
    if (hc.Privileged === true) fail('privileged');
    if (hc.PidMode === 'host' || hc.IpcMode === 'host') fail('host-namespace');
    if (!Array.isArray(hc.CapDrop) || !hc.CapDrop.map((x) => x.toUpperCase()).includes('ALL')) fail('cap-drop');
    if (!Array.isArray(hc.SecurityOpt)
      || !hc.SecurityOpt.some((x) => /no-new-privileges/.test(String(x)))) fail('no-new-privileges');
    if (hc.PidsLimit !== spec.pidsLimit) fail('pids-limit');
    if (hc.Memory !== spec.memoryBytes) fail('memory');
    if (hc.MemorySwap !== spec.memoryBytes) fail('memory-swap');
    if (hc.NanoCpus !== Math.round(spec.cpus * 1_000_000_000)) fail('cpus');
    if ((info.Config?.User ?? '') !== '65534:65534') fail('user');
    const workspaceMount = (info.Mounts ?? []).find((mount) => mount.Destination === '/workspace');
    if (!workspaceMount || workspaceMount.RW !== false || workspaceMount.Type !== 'bind') fail('workspace-mount');
    let sourceReal;
    let expectedReal;
    try {
      sourceReal = fs.realpathSync(workspaceMount.Source);
      expectedReal = fs.realpathSync(spec.snapshotPath);
    } catch {
      fail('workspace-mount-source');
    }
    if (sourceReal !== expectedReal) fail('workspace-mount-source');
    const tmpfs = hc.Tmpfs?.['/tmp'] ?? '';
    if (!String(tmpfs).includes(`size=${spec.tmpfsBytes}`)) fail('tmpfs');
    return true;
  }

  async findOwnedContainer({ runId, projectId, attempt } = {}) {
    try {
      const ids = (await this.docker([
        'ps', '-a', '--filter', `label=owner.run=${runId}`, '--format', '{{.ID}}'
      ])).trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const handle = { providerRunId: id, name: `owner-sandbox-${runId}`, runId, projectId, attempt };
        try {
          await this.assertOwnership(handle);
          return handle;
        } catch {
          // Keep searching; a same-label foreign container is not ours.
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async assertOwnership(handle) {
    let labels;
    try {
      labels = JSON.parse((await this.docker(['inspect', '--format', '{{json .Config.Labels}}', handle.providerRunId])).trim());
    } catch {
      throw new SandboxProviderError('sandbox container ownership cannot be verified', 'ownership-unverified');
    }
    check(labels && labels['owner.sandbox'] === '1', 'sandbox container is not owned by owner-agent', 'ownership-mismatch');
    check(labels['owner.run'] === handle.runId, 'sandbox container run label mismatch', 'ownership-mismatch');
    check(labels['owner.project'] === handle.projectId, 'sandbox container project label mismatch', 'ownership-mismatch');
    check(labels['owner.attempt'] === String(handle.attempt), 'sandbox container attempt label mismatch', 'ownership-mismatch');
    return true;
  }

  async start(handle) {
    const child = spawn(this.dockerBin, ['start', '-a', handle.providerRunId], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, DOCKER_CLI_HINTS: 'false' }
    });
    const capture = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, truncated: false };
    const append = (target, chunk) => {
      const current = target === 'stdout' ? capture.stdoutBytes : capture.stderrBytes;
      const remaining = this.captureMaxBytes - current;
      if (remaining <= 0) {
        capture.truncated = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (slice.length < chunk.length) capture.truncated = true;
      (target === 'stdout' ? capture.stdout : capture.stderr).push(slice);
      if (target === 'stdout') capture.stdoutBytes += slice.length;
      else capture.stderrBytes += slice.length;
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    capture.exit = new Promise((resolve) => {
      child.on('error', () => resolve({ code: null, signal: null, error: true }));
      child.on('close', (code, signal) => resolve({ code, signal, error: false }));
    });
    capture.child = child;
    this.captures.set(handle.providerRunId, capture);
    return { started: true };
  }

  async inspect(handle) {
    let state;
    try {
      state = JSON.parse((await this.docker(['inspect', '--format', '{{json .State}}', handle.providerRunId])).trim());
    } catch (error) {
      if (this.isMissingContainer(error)) return { state: 'missing' };
      // Daemon/socket/permission/timeout failures are UNKNOWN, never "missing".
      throw new SandboxProviderError('sandbox inspect unavailable', 'inspect-unavailable');
    }
    if (state.Running) return { state: 'running', oomKilled: !!state.OOMKilled };
    return {
      state: state.Status === 'created' ? 'created' : 'exited',
      exitCode: state.ExitCode,
      signal: state.Signal || null,
      oomKilled: !!state.OOMKilled
    };
  }

  async stop(handle) {
    let ownershipError = null;
    try {
      await this.assertOwnership(handle);
    } catch (error) {
      ownershipError = error;
    }
    if (ownershipError) {
      // A verified 404 is safe (nothing is running). Any other ownership/inspect failure
      // is unknown and must never become "stopped".
      const info = await this.inspect(handle);
      if (info.state === 'missing') return { confirmed: true };
      throw ownershipError;
    }
    try {
      await this.docker(['stop', '--time', '1', handle.providerRunId], { allowExitCodes: [1] });
    } catch {
      // inspect below decides whether it is really stopped; an inspect outage is unknown.
    }
    const deadline = Date.now() + this.stopConfirmMs;
    while (Date.now() <= deadline) {
      const info = await this.inspect(handle);
      if (info.state === 'exited' || info.state === 'missing') return { confirmed: true };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { confirmed: false };
  }

  async collect(handle) {
    const capture = this.captures.get(handle.providerRunId);
    if (capture) {
      const exit = await Promise.race([
        capture.exit,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: null, error: true }), 5000))
      ]);
      const info = await this.inspect(handle);
      this.captures.delete(handle.providerRunId);
      return {
        stdout: Buffer.concat(capture.stdout),
        stderr: Buffer.concat(capture.stderr),
        exitCode: info.exitCode ?? exit.code,
        signal: info.signal ?? exit.signal,
        oomKilled: !!info.oomKilled
      };
    }
    // Recovery path after a provider-process restart: Docker logs are merged, so treat them
    // as stdout and leave stderr empty rather than inventing a split.
    let stdout = Buffer.alloc(0);
    try {
      const raw = await this.docker(['logs', handle.providerRunId]);
      stdout = Buffer.from(raw, 'utf8');
    } catch {
      // Missing logs are not a test result; the caller records a bounded empty artifact.
    }
    const info = await this.inspect(handle);
    return { stdout, stderr: Buffer.alloc(0), exitCode: info.exitCode, signal: info.signal, oomKilled: !!info.oomKilled };
  }

  async dispose(handle) {
    const info = await this.inspect(handle);
    if (info.state === 'running') return { confirmed: false };
    if (info.state === 'missing') return { confirmed: true };
    await this.assertOwnership(handle);
    try {
      await this.docker(['rm', '-f', handle.providerRunId], { allowExitCodes: [1] });
    } catch {
      return { confirmed: false };
    }
    const after = await this.inspect(handle);
    return { confirmed: after.state === 'missing' };
  }
}
