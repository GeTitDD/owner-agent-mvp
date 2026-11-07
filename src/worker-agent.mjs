// Owner Worker：把已批准的 Job / Sandbox Run 推进一步。
//
// 复用现有 PatchCodingWorker 与 SandboxRunner；本类只负责“先补丁、后沙箱”的顺序、
// 单次运行互斥，以及给 UI 的进度快照。它不会批准任何对象，也不会自动 apply。
import { PatchCodingWorker } from './patch-coding-worker.mjs';
import { SandboxRunner } from './sandbox-runner.mjs';

const now = () => new Date().toISOString();

export class OwnerWorker {
  constructor(store, {
    broker = null,
    provider = null,
    proposalAgent = null,
    model = '',
    timeoutMs = 180000,
    workerId = 'owner-worker',
    leaseMs = 120000,
    allowModel = true
  } = {}) {
    if (!store) throw new Error('store is required');
    this.store = store;
    this.allowModel = allowModel;
    this.running = false;
    this.current = null;
    this.last = null;
    this.patchWorker = new PatchCodingWorker(store, {
      broker,
      workerId: `${workerId}-patch`,
      proposalAgent,
      model,
      timeoutMs,
      leaseMs
    });
    this.sandboxRunner = provider
      ? new SandboxRunner(store, {
        provider,
        workerId: `${workerId}-sandbox`,
        leaseMs,
        pollMs: 250
      })
      : null;
  }

  status() {
    return {
      running: this.running,
      current: this.current,
      last: this.last
    };
  }

  /** 一次只推进一个对象：先处理已批准的 code-patch Job，再处理已批准的 Sandbox Run。 */
  async runOnce({ projectId = '' } = {}) {
    const projects = projectId
      ? [projectId]
      : this.store.listProjects().map((project) => project.id);
    for (const id of projects) {
      const result = await this.patchWorker.runOnce({ projectId: id, allowModel: this.allowModel });
      if (result?.claimed) return { kind: 'patch', ...result };
    }
    if (!this.sandboxRunner) return { kind: 'idle', claimed: false };
    for (const id of projects) {
      const result = await this.sandboxRunner.runOnce({ projectId: id });
      if (result?.claimed) return { kind: 'sandbox', ...result };
    }
    return { kind: 'idle', claimed: false };
  }

  /**
   * 触发一次推进。
   * - wait=true：等待完成（CLI / 测试）
   * - wait=false：立即返回，UI 通过 status 轮询（HTTP tick）
   */
  start({ projectId = '', wait = false } = {}) {
    if (this.running) {
      return { started: false, reason: 'busy', current: this.current };
    }
    this.running = true;
    this.current = { startedAt: now(), projectId: projectId || null, kind: 'pending' };
    const task = this.runOnce({ projectId })
      .then((result) => {
        this.last = { ...result, at: now() };
        return result;
      })
      .catch((error) => {
        this.last = {
          kind: 'error',
          error: String(error?.message ?? error),
          at: now()
        };
        throw error;
      })
      .finally(() => {
        this.running = false;
        this.current = null;
      });
    if (wait) return task;
    // HTTP 调用不等待；吞掉拒绝，状态里会保留 last.error。
    task.catch(() => {});
    return { started: true, current: this.current };
  }
}
