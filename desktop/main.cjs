// Owner Companion desktop host.
//
// 进程内启动 Owner sidecar + 常驻 Worker；审批令牌只留在主进程。
// 渲染进程（桌宠/面板）只能通过受控 IPC 读取视图模型与触发操作。
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog, Notification, shell } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile, execFileSync, fork } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');

const execFileAsync = promisify(execFile);

const PET_SIZE = 136;
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 640;
const COMPANION_VERSION = '1.0.0';
// 单实例：桌面快捷方式重复双击时聚焦已有窗口，而不是再起一个进程抢同一份 SQLite。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (pet) { pet.show(); positionPet(); }
  showPanel();
});
const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot-dir='));
const screenshotDir = screenshotArg ? screenshotArg.slice('--screenshot-dir='.length) : '';
// 验收/自动化实例不把桌宠和面板画到用户桌面上（否则会看到测试宠物一闪而过）。
const e2eOffscreen = process.env.OWNER_AGENT_E2E_OFFSCREEN === '1';
const selfTestArg = process.argv.find((arg) => arg.startsWith('--self-test='));
const selfTest = selfTestArg ? selfTestArg.slice('--self-test='.length) : '';
const selfTestOutArg = process.argv.find((arg) => arg.startsWith('--self-test-out='));
const selfTestOut = selfTestOutArg ? selfTestOutArg.slice('--self-test-out='.length) : '';
const userDataArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
if (userDataArg) app.setPath('userData', path.resolve(userDataArg.slice('--user-data-dir='.length)));
// 开发期用 `electron desktop/main.cjs` 启动时 Electron 会把 userData 落到 `%APPDATA%\Electron`，
// 与打包版（`owner-agent-mvp`）配置、数据库不一致。这里统一到打包版目录，未显式指定时才生效。
else app.setPath('userData', path.join(app.getPath('appData'), 'owner-agent-mvp'));

let pet = null;
let panel = null;
let fullWindow = null;
let tray = null;
let store = null;
let personalStore = null;
let knowledgeRuntime = null;
let knowledgeTimer = null;
let broker = null;
let sidecar = null;
let workbench = null;
let worker = null;
let workerTimer = null;
let baseUrl = '';
let workbenchUrl = '';
let readToken = '';
let approvalToken = '';
let quitting = false;
let dragState = null;
let dragTimer = null;
let lastNoticeKey = '';
let pendingModel = null;
let serviceCache = { at: 0, value: null };
// pstack Playbook：注册表按需加载，runner 跟随当前模型，结果留在内存便于面板复读。
let playbookRegistry = null;
let playbookRunner = null;
let triageRunner = null;
let playbookRunnerError = '';
let playbookRuns = new Map();
const activePlaybookRuns = new Map();
const lastPlaybookResults = new Map();
const playbookAborts = new Map();
const playbookChildren = new Map();
let knowledgeSummaryModule = null;
let harvestInFlight = false;
let mascotModule = null;
let githubModule = null;
let githubPrModule = null;
let projectBriefModule = null;
let nextActionModule = null;
let knowledgeTidyModule = null;
let diagramModule = null;
const githubCache = new Map();
const githubActivityCache = new Map();
const briefCache = new Map();

const configPath = () => path.join(app.getPath('userData'), 'companion.json');
const defaults = () => ({
  pet: null,
  projectId: '',
  allowedPaths: 'src/',
  includePaths: ['package.json'],
  gatewayUrl: 'http://127.0.0.1:18789',
  model: '',
  // 图谱生成专用模型：主模型不可用时的备用模型（留空则只用主模型）。
  diagramModel: '',
  mascotSkin: 'pululu',
  sandboxMode: 'auto',
  sandboxByProject: {},
  sandboxProjectDirByProject: {},
  knowledgeAutoHarvest: false,
  panelPinned: false
});
let config = defaults();

const errorLogPath = () => path.join(app.getPath('userData'), 'companion-errors.log');
const logError = (scope, error) => {
  const message = error?.stack ?? error?.message ?? String(error ?? '');
  try {
    fs.appendFileSync(errorLogPath(), `${new Date().toISOString()} [${scope}] ${message}\n`);
  } catch { /* 日志不可写时不影响主流程 */ }
};
process.on('uncaughtException', (error) => { logError('uncaught', error); console.error(error); });
process.on('unhandledRejection', (reason) => { logError('unhandledRejection', reason); });

const loadConfig = () => {
  try {
    // PowerShell 写出的 JSON 可能带 UTF-8 BOM，JSON.parse 会直接失败。
    const raw = fs.readFileSync(configPath(), 'utf8').replace(/^\uFEFF/u, '');
    config = { ...defaults(), ...JSON.parse(raw) };
    if (!Array.isArray(config.includePaths)) config.includePaths = defaults().includePaths;
  } catch {
    config = defaults();
  }
};
const saveConfig = () => {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    console.error('save config failed:', error.message);
  }
};

const importEsm = (relative) =>
  import(require('node:url').pathToFileURL(path.join(__dirname, relative)).href);

const dbPath = () =>
  process.env.OWNER_AGENT_DB || path.join(app.getPath('userData'), 'owner.sqlite');
const knowledgeDbPath = () =>
  process.env.OWNER_KNOWLEDGE_DB
  || process.env.DOMAIN_CONTEXT_DB
  || path.join(os.homedir(), '.domain-context', 'index.sqlite');

const digestCache = new Map();
const resolveDigest = (imageRef = 'node:22-alpine') => {
  const explicit = process.env.OWNER_AGENT_SANDBOX_IMAGE_DIGEST;
  if (imageRef === 'node:22-alpine' && /^sha256:[0-9a-f]{64}$/u.test(explicit ?? '')) return explicit;
  if (digestCache.has(imageRef)) return digestCache.get(imageRef);
  let digest = '';
  try {
    const ref = execFileSync('docker', [
      'image', 'inspect', imageRef, '--format', '{{index .RepoDigests 0}}'
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
    const found = ref.split('@')[1];
    if (/^sha256:[0-9a-f]{64}$/u.test(found ?? '')) digest = found;
  } catch {
    digest = '';
  }
  digestCache.set(imageRef, digest);
  return digest;
};

const fakeSourceAgent = async () => {
  if (process.env.OWNER_COMPANION_FAKE_SOURCE !== '1') return null;
  const { FakePatchProposalAgent, PatchProposalAgent } = await importEsm(
    '../src/patch-proposal-agent.mjs'
  );
  const buggy = `export function withRetry(fn, { attempts = 3 } = {}) {
  let lastError;
  // 真实 bug：off-by-one，只尝试 attempts - 1 次。
  for (let i = 0; i < attempts - 1; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;
  const fake = new FakePatchProposalAgent({
    files: [{ path: 'src/retry.js', action: 'modify', content: `${buggy}\n// touched by companion source patch\n` }]
  });
  const real = new PatchProposalAgent({ timeoutMs: 300000, model: config.model || '' });
  return {
    requiresModel: false,
    setModel(model) { real.model = model; },
    async generate(input) {
      if (String(input.repairContext ?? '').trim()) return real.generate(input);
      return fake.generate(input);
    }
  };
};

/** 把模型设置应用到现有 Worker 的提案 Agent（不重建 Worker）。 */
const applyWorkerModel = (model) => {
  const agent = worker?.patchWorker?.proposalAgent;
  if (!agent) return false;
  if (typeof agent.setModel === 'function') agent.setModel(model);
  else agent.model = model;
  return true;
};

async function startServices() {
  const { OwnerStore } = await importEsm('../src/owner-store.mjs');
  const { WorkspaceBroker } = await importEsm('../src/workspace-broker.mjs');
  const { DockerSandboxProvider } = await importEsm('../src/sandbox-provider.mjs');
  const { OwnerWorker } = await importEsm('../src/worker-agent.mjs');
  const {
    startSidecar, resolveSidecarToken, resolveApprovalToken
  } = await importEsm('../src/sidecar-server.mjs');

  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store = new OwnerStore(file);
  try {
    const { PersonalKnowledgeStore } = await importEsm('../src/personal-store.mjs');
    const knowledgeFile = knowledgeDbPath();
    fs.mkdirSync(path.dirname(knowledgeFile), { recursive: true });
    personalStore = new PersonalKnowledgeStore(knowledgeFile);
  } catch (error) {
    console.error('knowledge store unavailable:', error.message);
    personalStore = null;
  }
  if (personalStore) {
    try {
      const { KnowledgeLoopRuntime } = await importEsm('../src/knowledge-loop/runtime.mjs');
      knowledgeRuntime = new KnowledgeLoopRuntime({
        ownerStore: store,
        personalStore,
        model: config.model || '',
        // 自动提炼会调用模型；默认关闭，只自动采集经验并显示待提炼队列。
        allowHarvest: process.env.OWNER_KNOWLEDGE_AUTO_HARVEST === '1'
          || config.knowledgeAutoHarvest === true
      });
      knowledgeTimer = setInterval(() => {
        knowledgeRuntime.tick().catch((error) => {
          console.error('knowledge auto tick failed:', error.message);
        });
      }, 15000);
      knowledgeTimer.unref?.();
      setTimeout(() => {
        knowledgeRuntime.tick().catch(() => { /* first scan is best effort */ });
      }, 2500).unref?.();
    } catch (error) {
      console.error('knowledge runtime unavailable:', error.message);
      knowledgeRuntime = null;
    }
  }
  broker = new WorkspaceBroker(store, {
    workspacesRoot: path.join(app.getPath('userData'), 'workspaces')
  });
  const provider = new DockerSandboxProvider({ requireRootless: false });
  const proposalAgent = await fakeSourceAgent();
  worker = new OwnerWorker(store, {
    broker,
    provider,
    proposalAgent,
    model: config.model || '',
    timeoutMs: 300000,
    leaseMs: 180000,
    allowModel: true
  });
  readToken = resolveSidecarToken({ dbPath: file });
  approvalToken = resolveApprovalToken({ dbPath: file });
  sidecar = await startSidecar({
    store,
    brokerFactory: () => broker,
    worker,
    token: readToken,
    approvalToken,
    imageDigest: resolveDigest(),
    sandboxRoot: path.join(app.getPath('userData'), 'sandbox'),
    port: 0,
    version: COMPANION_VERSION
  });
  baseUrl = `http://127.0.0.1:${sidecar.port}`;

  // 常驻 Worker：批准后的步骤自动推进；没有批准对象时保持空闲。
  workerTimer = setInterval(() => {
    if (pendingModel !== null && worker && !worker.running) {
      if (applyWorkerModel(pendingModel)) pendingModel = null;
    }
    if (worker && !worker.running) worker.start({ wait: false });
  }, 2000);
  workerTimer.unref?.();

  try {
    const { createWorkbenchServer } = await importEsm('../src/workbench-server.mjs');
    workbench = await createWorkbenchServer({ port: 0, dbPath: file });
    const address = await workbench.listen();
    workbenchUrl = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    console.error('workbench unavailable:', error.message);
  }
}

const api = async (route, { method = 'GET', body, decision = false } = {}) => {
  const headers = { authorization: `Bearer ${readToken}` };
  if (decision) headers['x-owner-approval-token'] = approvalToken;
  if (method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-owner-origin'] = JSON.stringify({
      gatewayInstanceId: 'owner-companion',
      operatorId: 'owner',
      pluginVersion: COMPANION_VERSION
    });
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
};

const stateOf = (summary) => summary;

const projectIdOf = (item) => item?.project_id ?? item?.projectId ?? '';

/** 当前项目的沙箱预检：全局默认 + 按项目覆盖 + 生态探测。 */
let sandboxPlanModule = null;
const testConfigForProject = async (project) => {
  sandboxPlanModule = sandboxPlanModule ?? await importEsm('../src/sandbox-plan.mjs');
  const projectId = project?.id ?? '';
  const mode = sandboxPlanModule.effectiveSandboxMode({
    globalMode: config.sandboxMode,
    projectMode: (config.sandboxByProject ?? {})[projectId] ?? ''
  });
  const plan = sandboxPlanModule.resolveSandboxPlan({
    root: project?.root ?? '',
    mode,
    projectDir: (config.sandboxProjectDirByProject ?? {})[projectId] ?? '',
    includePaths: config.includePaths
  });
  return { ...plan, projectId };
};

const createSandbox = async (proposalId) => {
  const projects = (await api('/owner/v1/projects')).items ?? [];
  const project = projects.find((item) => item.id === config.projectId) ?? projects[0] ?? null;
  const plan = await testConfigForProject(project);
  const image = plan.image || 'node:22-alpine';
  const imageDigest = resolveDigest(image);
  if (!imageDigest) {
    throw new Error(`沙箱镜像未就绪：请先执行 docker pull ${image}`);
  }
  return api('/owner/v1/sandbox-runs', {
    method: 'POST',
    body: {
      proposalId,
      profile: plan.profile,
      ...(plan.projectDir ? { projectDir: plan.projectDir } : {}),
      includePaths: plan.required,
      imageDigest
    }
  });
};

const toPending = ({ jobs, patches, sandboxes, repairs }, projectNames = new Map()) => {
  const pending = [];
  const tag = (item) => {
    const projectId = projectIdOf(item);
    return { projectId, projectName: projectNames.get(projectId) ?? '' };
  };
  const payloadOf = (job) => {
    try { return typeof job.payload === 'string' ? JSON.parse(job.payload) : (job.payload ?? {}); }
    catch { return {}; }
  };
  for (const job of jobs) {
    if (job.status === 'pending_approval') {
      const payload = payloadOf(job);
      pending.push({
        kind: 'job', id: job.id, hash: '',
        title: job.title,
        summary: `${job.job_type} · 等待你批准后才会开始`,
        tier: 'write',
        jobType: job.job_type,
        intent: payload.intent ?? '',
        targets: payload.targets ?? '',
        allowedPaths: payload.allowedPaths ?? '',
        analysisSummary: payload.analysisSummary ?? '',
        next: '批准后：隔离 worktree 内写入 → 生成补丁 → 再审批 → 应用 → 沙箱',
        createdAt: job.created_at ?? '',
        ...tag(job)
      });
    }
  }
  for (const patch of patches) {
    const files = (patch.files ?? []).map((file) => file.path).join(', ');
    if (patch.status === 'proposed') {
      pending.push({
        kind: 'patch', id: patch.id, hash: patch.proposal_hash,
        title: `补丁 ${patch.id.slice(0, 8)}`,
        summary: files || '等待审阅冻结 Diff',
        tier: 'write',
        files,
        next: '批准后：冻结当前 hash → 等你再次确认应用',
        ...tag(patch)
      });
    } else if (patch.status === 'approved') {
      pending.push({
        kind: 'patch-apply', id: patch.id, hash: patch.proposal_hash,
        title: `已批准补丁 ${patch.id.slice(0, 8)}`,
        summary: '下一步：应用到 Worktree，然后请求沙箱测试',
        tier: 'write',
        files,
        next: '应用后：真实项目变更；随后创建沙箱测试等你批准',
        ...tag(patch)
      });
    }
  }
  const cycleSources = new Set(repairs.map((cycle) => cycle.source_sandbox_run_id));
  for (const run of sandboxes) {
    if (run.status === 'pending_approval') {
      pending.push({
        kind: 'sandbox', id: run.id, hash: run.approval_hash,
        title: `测试 ${run.id.slice(0, 8)}`,
        summary: `${run.profile?.id ?? 'node-smoke'} · 等待你批准后运行`,
        tier: 'run',
        profile: run.profile?.id ?? 'node-smoke',
        next: '批准后：Docker 沙箱内运行测试并收集证据',
        ...tag(run)
      });
    } else if (
      run.status === 'completed' && run.test_status === 'fail' && !cycleSources.has(run.id)
      && !run.repair_cycle_id
    ) {
      pending.push({
        kind: 'repair-create', id: run.id, hash: '',
        title: `测试失败 ${run.id.slice(0, 8)}`,
        summary: '可以先创建一个修复周期，再决定是否批准',
        tier: 'write',
        next: '创建后：基于失败证据生成新补丁，仍需你批准',
        ...tag(run)
      });
    }
  }
  for (const cycle of repairs) {
    if (cycle.status === 'pending_approval') {
      const scope = Array.isArray(cycle.repairScope)
        ? cycle.repairScope
        : Array.isArray(cycle.repair_scope) ? cycle.repair_scope : [];
      pending.push({
        kind: 'repair', id: cycle.id, hash: cycle.approval_hash,
        title: `修复 ${cycle.id.slice(0, 8)}`,
        summary: `范围 ${scope.join(', ') || '—'} · 等待你批准`,
        tier: 'write',
        scope: scope.join(', '),
        next: '批准后：在原 base 上生成新补丁，再审批、应用、复测',
        ...tag(cycle)
      });
    }
  }
  return pending.slice(0, 12);
};

const stageText = (chain) => {
  const { job, patch, sandbox, cycle } = chain;
  if (cycle) {
    if (cycle.status === 'pending_approval') return '有一个修复周期等你的决定';
    if (cycle.status === 'queued') return '修复任务已批准，正在生成新的补丁';
    if (cycle.status === 'proposal_ready') return '修复补丁已生成，等待你审阅';
    if (circleSafe(cycle.status, 'applied')) return '修复补丁已应用，准备复测';
    if (cycle.status === 'test_pending') return '修复补丁正在复测';
    if (cycle.status === 'tested_pass') return '修复完成，复测通过';
    if (cycle.status === 'tested_fail') return '修复后测试仍未通过';
  }
  if (sandbox) {
    if (sandbox.status === 'pending_approval') return '测试运行等你的批准';
    if (sandbox.status === 'queued') return '测试已批准，正在启动';
    if (['running', 'provisioning', 'collecting'].includes(sandbox.status)) return '测试正在运行';
    if (sandbox.status === 'completed') {
      return sandbox.test_status === 'pass' ? '测试通过' : '测试失败，可以创建修复';
    }
  }
  if (patch) {
    if (patch.status === 'proposed') return '补丁已生成，等待你审阅';
    if (patch.status === 'approved') return '补丁已批准，等待应用';
    if (patch.status === 'applied') return '补丁已应用，等待测试';
  }
  if (job) {
    if (job.status === 'pending_approval') return '任务等你的批准';
    if (['queued', 'leased', 'running'].includes(job.status)) return '正在生成补丁';
    if (job.status === 'succeeded') return '补丁提案已完成';
    if (job.status === 'failed') return '生成补丁时遇到问题';
  }
  return '暂时没有进行中的任务';
};

const circleSafe = (value, expected) => value === expected;

// pstack（只读 playbook）运行时的桌宠/面板状态。
// 运行中的 playbook 由主进程记录；完成结果保留 3 分钟，用于“完成/失败”提示。
const activePlaybookFor = (projectId) => {
  const items = [...activePlaybookRuns.values()]
    .filter((run) => run.projectId === projectId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return items[0] ?? null;
};

const recentPlaybookFor = (projectId, windowMs = 3 * 60 * 1000) => {
  const now = Date.now();
  let best = null;
  for (const run of lastPlaybookResults.values()) {
    if (run.projectId !== projectId) continue;
    const finished = Date.parse(String(run.finishedAt ?? ''));
    if (!Number.isFinite(finished) || now - finished > windowMs) continue;
    if (!best || finished > Date.parse(String(best.finishedAt))) best = run;
  }
  return best;
};

// ---- 桌宠皮肤（mascot / Codex 阶段） ----

const mascotDirs = () => ({
  builtinDir: path.join(__dirname, 'assets', 'mascots'),
  userDir: path.join(app.getPath('userData'), 'mascots')
});

const loadMascots = async () => (mascotModule ??= await importEsm('../src/mascots.mjs'));

const mascotView = async () => {
  const mod = await loadMascots();
  const resolved = mod.resolveMascot({ ...mascotDirs(), skin: config.mascotSkin });
  return {
    skin: resolved.skin,
    label: resolved.label,
    kind: resolved.kind,
    fallback: resolved.fallback,
    url: resolved.file ? pathToFileURL(resolved.file).href : '',
    sprite: resolved.sprite ? {
      ...resolved.sprite,
      url: pathToFileURL(resolved.file).href
    } : null
  };
};

const mascotCatalog = async () => {
  const mod = await loadMascots();
  const resolved = mod.resolveMascot({ ...mascotDirs(), skin: config.mascotSkin });
  return {
    current: resolved.skin,
    fallback: resolved.fallback,
    userDir: mascotDirs().userDir,
    skins: resolved.skins.map((item) => ({
      id: item.id, label: item.label, builtin: item.builtin, kind: item.kind ?? 'static',
      url: pathToFileURL(item.file).href,
      thumb: item.dir && fs.existsSync(path.join(item.dir, 'thumb.png'))
        ? pathToFileURL(path.join(item.dir, 'thumb.png')).href
        : '',
      sprite: item.sprite ? { ...item.sprite, url: pathToFileURL(item.file).href } : null
    }))
  };
};

/** 诊断快照：一次返回环境、沙箱计划、服务、最近任务/测试/Playbook 运行。 */
const diagnosticsSnapshot = async () => {
  const projects = (await api('/owner/v1/projects')).items ?? [];
  const active = projects.find((item) => item.id === config.projectId) ?? projects[0] ?? null;
  const [jobs, patches, runs, services, testConfig, knowledge] = await Promise.all([
    api('/owner/v1/jobs?limit=20'),
    api('/owner/v1/patches?limit=20'),
    api('/owner/v1/sandbox-runs?limit=20'),
    serviceStatus(),
    testConfigForProject(active),
    knowledgeSnapshot(active?.id ?? '')
  ]);
  const playbooks = [];
  try {
    const files = fs.readdirSync(playbookReportDir()).filter((name) => name.endsWith('.json')).sort().slice(-15);
    for (const name of files) {
      const data = JSON.parse(fs.readFileSync(path.join(playbookReportDir(), name), 'utf8'));
      playbooks.push({
        runId: data.runId,
        playbookId: data.playbookId,
        status: data.status,
        category: data.category ?? '',
        durationMs: data.durationMs,
        startedAt: data.startedAt,
        model: data.model,
        summary: String(data.summary ?? '').slice(0, 160)
      });
    }
  } catch { /* 没有 playbook 报告不视为错误 */ }
  return {
    generatedAt: new Date().toISOString(),
    version: COMPANION_VERSION,
    userData: app.getPath('userData'),
    model: config.model,
    projectId: config.projectId,
    project: active ? { id: active.id, root: active.root, domain: active.primary_domain } : null,
    sandbox: testConfig,
    services,
    knowledge: knowledge?.counts ?? null,
    jobs: (jobs.items ?? []).map((job) => ({
      id: job.id, status: job.status, title: job.title, updatedAt: job.updated_at
    })),
    patches: (patches.items ?? []).map((patch) => ({
      id: patch.id, status: patch.status,
      paths: (patch.files ?? []).map((file) => file.path),
      updatedAt: patch.updated_at
    })),
    sandboxRuns: (runs.items ?? []).map((run) => ({
      id: run.id, status: run.status, testStatus: run.test_status,
      exitCode: run.exit_code, profile: run.profile?.id ?? '', updatedAt: run.updated_at
    })),
    playbooks
  };
};

const knowledgeSnapshot = async (projectId = config.projectId) => {
  if (!personalStore) {
    return { available: false, counts: {}, recentExperiences: [], pendingExperiences: [], candidates: [], auto: {} };
  }
  knowledgeSummaryModule = knowledgeSummaryModule ?? await importEsm('../src/knowledge/summary.mjs');
  const summary = knowledgeSummaryModule.knowledgeSummaryFor({ personalStore, projectId });
  return {
    available: true,
    ...summary,
    auto: {
      allowHarvest: Boolean(knowledgeRuntime?.allowHarvest),
      last: knowledgeRuntime?.last ?? null
    }
  };
};

const knowledgeAsk = ({ kind, projectId = '', domain = '', query = '' } = {}) => {
  if (!personalStore) return { answer: '知识库尚未建立；任务完成后会自动采集经验。', items: [], basis: [] };
  const units = personalStore.list({ limit: 2000 });
  const allExperiences = personalStore.listExperiences({ limit: 1000 });
  const experiences = kind === 'project'
    ? allExperiences.filter((row) => !projectId || row.projectId === projectId)
    : allExperiences;
  const item = (type, row, extra = {}) => ({
    type, id: row.id,
    title: type === 'experience' ? row.observedProblem : row.title,
    status: type === 'experience' ? row.observedOutcome?.status : row.verificationStatus,
    layer: row.layer ?? null, revision: row.revision ?? null,
    projectId: row.projectId ?? row.project_id ?? null,
    ...extra
  });
  if (kind === 'today') {
    const recent = experiences.filter((row) => Date.now() - Date.parse(row.createdAt) < 24 * 60 * 60 * 1000);
    const fresh = units.filter((row) => Date.now() - Date.parse(row.updatedAt) < 24 * 60 * 60 * 1000);
    return {
      answer: recent.length || fresh.length
        ? `最近 24 小时采集了 ${recent.length} 条经验，知识库更新 ${fresh.length} 条。`
        : '最近 24 小时没有新的经验或知识更新。',
      items: [...recent.map((row) => item('experience', row)), ...fresh.map((row) => item('knowledge', row))],
      basis: [...recent.map((row) => `experience:${row.id}`), ...fresh.map((row) => `knowledge:${row.id}`)]
    };
  }
  if (kind === 'similar') {
    const latest = experiences[0]?.observedProblem;
    const q = query || latest || '';
    const matched = personalStore.list({ q, limit: 10 });
    const exp = experiences.filter((row) =>
      `${row.observedProblem} ${row.actionSummary}`.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 10);
    return {
      answer: q
        ? `${query ? '' : `以最近经验“${latest}”为检索词；`}找到 ${matched.length} 条知识、${exp.length} 条相似经验。`
        : '还没有可用于相似检索的历史问题。',
      items: [...matched.map((row) => item('knowledge', row)), ...exp.map((row) => item('experience', row))],
      basis: [...matched.map((row) => `knowledge:${row.id}`), ...exp.map((row) => `experience:${row.id}`)]
    };
  }
  if (kind === 'verified') {
    const verified = units.filter((row) => row.verificationStatus === 'verified');
    const rows = verified.map((row) => {
      const usages = personalStore.listUsages({ knowledgeId: row.id, limit: 200 });
      const projects = [...new Set(usages.map((usage) => usage.projectId))];
      const positive = usages.filter((usage) => usage.observedBenefit === 'positive').length;
      const negative = usages.filter((usage) => usage.observedBenefit === 'negative').length;
      return item('knowledge', row, {
        usageProjects: projects, positiveUsages: positive, negativeUsages: negative,
        detail: `被 ${projects.length} 个项目复用；正反馈 ${positive}，负反馈 ${negative}`
      });
    });
    return {
      answer: verified.length
        ? `${verified.length} 条已验证知识；${rows.filter((row) => row.usageProjects.length > 0).length} 条有复用记录。`
        : '还没有已验证知识。',
      items: rows, basis: verified.map((row) => `knowledge:${row.id}`)
    };
  }
  // project
  const projectKnowledge = units.filter((row) =>
    row.scope === 'project'
      ? row.projectId === projectId
      : Boolean(domain) && row.domains.includes(domain)
  );
  const projectExperiences = experiences.filter((row) => !projectId || row.projectId === projectId);
  return {
    answer: `${projectId || '当前项目'}：${projectExperiences.length} 条经验，${projectKnowledge.length} 条相关知识。`,
    items: [...projectExperiences.slice(0, 10).map((row) => item('experience', row)),
      ...projectKnowledge.slice(0, 10).map((row) => item('knowledge', row))],
    basis: [...projectExperiences.map((row) => `experience:${row.id}`),
      ...projectKnowledge.map((row) => `knowledge:${row.id}`)]
  };
};

const knowledgeDetail = ({ id } = {}) => {
  if (!personalStore) throw new Error('知识库尚未建立');
  const unit = personalStore.get(id);
  if (unit) {
    const revisions = personalStore.revisions(id);
    const usages = personalStore.listUsages({ knowledgeId: id, limit: 200 });
    const feedback = usages.map((usage) => personalStore.feedbackForUsage(usage.id)).filter(Boolean);
    return { kind: 'knowledge', item: unit, revisions, usages, feedback };
  }
  const experience = personalStore.getExperience(id);
  if (experience) {
    const linked = experience.evidenceRefs
      .filter((ref) => ref.startsWith('experience:'))
      .map((ref) => personalStore.getExperience(ref.slice('experience:'.length)))
      .filter(Boolean);
    return { kind: 'experience', item: experience, linkedExperiences: linked };
  }
  const proposal = personalStore.proposal(id);
  if (proposal) return { kind: 'candidate', item: proposal };
  throw new Error('未找到该知识或经验');
};

  const loadGithub = async () => (githubModule ??= await importEsm('../src/github.mjs'));

  const gitRemoteOf = async (root) => {
    try {
      const { stdout } = await execFileAsync(
        'git', ['-C', root, 'config', '--get', 'remote.origin.url'],
        { timeout: 3000, windowsHide: true }
      );
      return stdout.trim();
    } catch {
      return '';
    }
  };

  const ghErrorText = (error) => {
    const stderr = String(error?.stderr ?? '').trim();
    if (error?.code === 'ENOENT') return '未安装 gh CLI';
    if (/auth|login|authentication/iu.test(stderr)) return '需要 gh auth login';
    if (/not found|could not resolve|HTTP 404/iu.test(stderr)) return '仓库不存在或无权访问';
    return (stderr.split('\n')[0] || String(error?.message ?? error)).slice(0, 120);
  };

  /** 关联项目根目录的 GitHub 仓库，并用 gh 读取只读状态；缓存 5 分钟。 */
  const githubForProject = async (root) => {
    if (!root) return null;
    const cached = githubCache.get(root);
    if (cached && Date.now() - cached.at < (cached.value ? 5 * 60 * 1000 : 60 * 1000)) {
      return cached.value;
    }
    let value = null;
    try {
      const remote = await gitRemoteOf(root);
      const { parseGitHubRemote } = await loadGithub();
      const parsed = parseGitHubRemote(remote);
      if (parsed) {
        value = {
          ...parsed,
          available: false,
          error: '',
          private: null,
          defaultBranch: '',
          stars: null,
          description: '',
          lastCommit: ''
        };
        try {
          const { stdout } = await execFileAsync('gh', [
            'repo', 'view', parsed.nameWithOwner,
            '--json', 'nameWithOwner,url,description,isPrivate,stargazerCount,defaultBranchRef'
          ], { timeout: 3500, windowsHide: true });
          const data = JSON.parse(stdout);
          value.available = true;
          value.url = data.url || value.url;
          value.private = data.isPrivate === true;
          value.description = data.description ?? '';
          value.stars = Number(data.stargazerCount) || 0;
          value.defaultBranch = data.defaultBranchRef?.name ?? '';
        } catch (error) {
          value.error = ghErrorText(error);
        }
        try {
          const { stdout } = await execFileAsync(
            'git', ['-C', root, 'log', '-1', '--format=%h %s'],
            { timeout: 3000, windowsHide: true }
          );
          value.lastCommit = stdout.trim().slice(0, 160);
        } catch { /* 没有提交也允许只显示仓库链接 */ }
      }
    } catch {
      value = null;
    }
    githubCache.set(root, { at: Date.now(), value });
    return value;
  };

  /** 读取仓库打开的 Issues / PR（只读，缓存 2 分钟）。 */
  const githubActivityFor = async (root) => {
    const repo = await githubForProject(root);
    if (!repo) {
      return { linked: false, repo: null, issues: [], prs: [], issueCount: 0, prCount: 0, error: '' };
    }
    const cached = githubActivityCache.get(repo.nameWithOwner);
    if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.value;
    const value = {
      linked: true,
      repo: {
        nameWithOwner: repo.nameWithOwner,
        url: repo.url,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        available: repo.available
      },
      issues: [],
      prs: [],
      issueCount: 0,
      prCount: 0,
      error: ''
    };
    if (!repo.available) {
      value.error = repo.error || 'gh 无法读取仓库状态';
      githubActivityCache.set(repo.nameWithOwner, { at: Date.now(), value });
      return value;
    }
    const list = async (kind) => {
      const common = ['--repo', repo.nameWithOwner, '--state', 'open', '--limit', '20'];
      if (kind === 'issue') {
        const { stdout } = await execFileAsync('gh', [
          'issue', 'list', ...common, '--json', 'number,title,author,updatedAt,url'
        ], { timeout: 5000, windowsHide: true });
        return JSON.parse(stdout);
      }
      const { stdout } = await execFileAsync('gh', [
        'pr', 'list', ...common, '--json', 'number,title,author,isDraft,updatedAt,url'
      ], { timeout: 5000, windowsHide: true });
      return JSON.parse(stdout);
    };
    const [issues, prs] = await Promise.allSettled([list('issue'), list('pr')]);
    if (issues.status === 'fulfilled') {
      value.issueCount = issues.value.length;
      value.issues = issues.value.slice(0, 5).map((item) => ({
        number: item.number,
        title: item.title,
        author: item.author?.login ?? '',
        updatedAt: item.updatedAt ?? '',
        url: item.url ?? ''
      }));
    } else {
      value.error = ghErrorText(issues.reason);
    }
    if (prs.status === 'fulfilled') {
      value.prCount = prs.value.length;
      value.prs = prs.value.slice(0, 5).map((item) => ({
        number: item.number,
        title: item.title,
        author: item.author?.login ?? '',
        draft: item.isDraft === true,
        updatedAt: item.updatedAt ?? '',
        url: item.url ?? ''
      }));
    } else if (!value.error) {
      value.error = ghErrorText(prs.reason);
    }
    githubActivityCache.set(repo.nameWithOwner, { at: Date.now(), value });
    return value;
  };

  const loadGithubPr = async () => (githubPrModule ??= await importEsm('../src/github-pr.mjs'));
  const loadProjectBrief = async () => (projectBriefModule ??= await importEsm('../src/project-brief.mjs'));
  const loadNextAction = async () => (nextActionModule ??= await importEsm('../src/next-action.mjs'));
  const loadKnowledgeTidy = async () => (knowledgeTidyModule ??= await importEsm('../src/knowledge/tidy.mjs'));
  const loadDiagrams = async () => (diagramModule ??= await importEsm('../src/project-diagrams.mjs'));
  const projectHeadCache = new Map();
  const headForProject = async (root) => {
    if (!root) return '';
    const cached = projectHeadCache.get(root);
    if (cached && Date.now() - cached.at < 20000) return cached.value;
    const value = await gitAt(root, ['rev-parse', 'HEAD']).catch(() => '');
    projectHeadCache.set(root, { at: Date.now(), value });
    return value;
  };

  /** 读取项目画像所需的仓库事实：HEAD、脏状态、npm scripts、测试命令、证据文件。 */
  const repoFactsFor = async (project, { includeDirty = false } = {}) => {
    const head = await gitAt(project.root, ['rev-parse', 'HEAD']).catch(() => '');
    const status = includeDirty
      ? await execFileAsync('git', ['-C', project.root, 'status', '--porcelain'], {
        timeout: 10000, windowsHide: true
      }).then((result) => result.stdout).catch(() => '')
      : '';
    const scripts = [];
    const evidence = [];
    let testCommands = [];
    let packageInfo = {};
    const dirtyLines = String(status).split('\n').filter(Boolean).filter((line) => {
      const file = line.slice(3).trim();
      return file !== '.owner-root-identity' && !file.startsWith('.fixture-workspaces/');
    });
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(project.root, 'package.json'), 'utf8'));
      evidence.push('package.json');
      packageInfo = {
        name: String(pkg.name ?? ''),
        description: String(pkg.description ?? '')
      };
      for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        scripts.push(name === 'test' ? `npm test` : `npm run ${name}`);
        if (name === 'test') testCommands = ['npm test'];
        if (scripts.length >= 8) break;
        void command;
      }
    } catch { /* 非 Node 项目允许没有 package.json */ }
    let readme = '';
    for (const name of ['README.md', 'README.zh-CN.md', 'README.txt']) {
      const file = path.join(project.root, name);
      if (!fs.existsSync(file)) continue;
      evidence.push(name);
      try { readme = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { /* 读取失败忽略 */ }
      break;
    }
    const directories = [];
    try {
      for (const entry of fs.readdirSync(project.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'coverage'].includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        directories.push(entry.name);
        if (directories.length >= 10) break;
      }
    } catch { /* 根目录不可读时只用已知信息 */ }
    const markers = ['AGENTS.md', 'CONTRIBUTING.md', 'docs']
      .filter((name) => fs.existsSync(path.join(project.root, name)));
    const runHints = [];
    if (fs.existsSync(path.join(project.root, 'play.ps1'))) runHints.push('powershell -File play.ps1');
    if (fs.existsSync(path.join(project.root, 'manage.py'))) runHints.push('python manage.py runserver');
    if (fs.existsSync(path.join(project.root, 'project.godot'))) runHints.push('用 Godot 打开项目');
    if (fs.existsSync(path.join(project.root, 'package.json'))) runHints.push('npm install');
    if (fs.existsSync(path.join(project.root, 'docker-compose.yml'))) runHints.push('docker compose up -d');
    for (const name of ['pyproject.toml', 'go.mod', 'Cargo.toml']) {
      if (fs.existsSync(path.join(project.root, name))) evidence.push(name);
    }
    if (!testCommands.length) {
      if (fs.existsSync(path.join(project.root, 'pytest.ini'))) testCommands = ['python -m pytest'];
      else if (fs.existsSync(path.join(project.root, 'pyproject.toml'))) testCommands = ['python -m pytest'];
    }
    return {
      head,
      dirty: dirtyLines.length > 0,
      scripts,
      testCommands,
      testCriteria: testCommands.length ? ['命令退出码为 0'] : [],
      evidence,
      packageInfo,
      readme,
      directories,
      markers,
      runHints,
      unknowns: dirtyLines.length > 0 ? ['工作区有未提交改动，画像可能不完整'] : []
    };
  };

  const projectBriefFor = async (project) => {
    if (!project) return null;
    const cached = briefCache.get(project.id);
    if (cached && Date.now() - cached.at < 20000) return cached.value;
    const stored = await api(`/owner/v1/projects/${encodeURIComponent(project.id)}/brief`)
      .catch(() => null);
    if (!stored) {
      briefCache.set(project.id, { at: Date.now(), value: null });
      return null;
    }
    const facts = await repoFactsFor(project);
    const mod = await loadProjectBrief();
    const value = {
      ...stored.payload,
      version: stored.version,
      generatedAt: stored.generatedAt,
      basedOnCommit: stored.basedOnCommit,
      sourceRunId: stored.sourceRunId,
      stale: mod.briefIsStale(stored, { head: facts.head, dirty: facts.dirty }),
      head: facts.head
    };
    briefCache.set(project.id, { at: Date.now(), value });
    return value;
  };

  const saveProjectBrief = async (project, payload, { basedOnCommit = '', sourceRunId = '' } = {}) => {
    const saved = await api(`/owner/v1/projects/${encodeURIComponent(project.id)}/brief`, {
      method: 'PUT',
      body: { payload, basedOnCommit, sourceRunId }
    });
    briefCache.delete(project.id);
    return {
      ...saved.payload,
      version: saved.version,
      generatedAt: saved.generatedAt,
      basedOnCommit: saved.basedOnCommit,
      sourceRunId: saved.sourceRunId
    };
  };


  const gitAt = async (cwd, args, timeout = 15000) => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      windowsHide: true
    });
    return stdout.trim();
  };

  /**
   * 准备 PR 预览：只认可“复测通过 + 已应用补丁 + 活跃 worktree + GitHub 仓库可用”。
   * 返回内容会参与 previewHash；真正创建时必须重算并比对。
   */
  const preparePr = async (cycleId) => {
    const id = String(cycleId ?? '');
    if (!id) throw new Error('缺少修复周期。');
    const cycle = await api(`/owner/v1/repair-cycles/${encodeURIComponent(id)}`);
    if (!cycle) throw new Error('找不到修复周期。');
    if (cycle.status !== 'tested_pass') throw new Error('只有复测通过的修复才能创建 PR。');
    const proposal = cycle.proposal;
    if (!proposal || proposal.status !== 'applied') {
      throw new Error('修复补丁还没有应用，不能创建 PR。');
    }
    const project = ((await api('/owner/v1/projects')).items ?? [])
      .find((item) => item.id === cycle.project_id);
    if (!project) throw new Error('项目不存在。');
    const github = await githubForProject(project.root);
    if (!github) throw new Error('项目没有关联 GitHub 仓库。');
    if (!github.available) throw new Error(`GitHub 仓库不可用：${github.error || 'gh 无法读取'}`);
    const workspaces = (await api(
      `/owner/v1/workspaces?projectId=${encodeURIComponent(project.id)}&limit=100`
    )).items ?? [];
    const workspace = workspaces.find((item) => item.id === proposal.workspace_id);
    if (!workspace || workspace.status === 'cleaned') {
      throw new Error('找不到补丁对应的 worktree。');
    }
    if (!workspace.path || !fs.existsSync(workspace.path)) throw new Error('worktree 目录不存在。');
    const pr = await loadGithubPr();
    if (!pr.isSafeHeadBranch(workspace.branch)) {
      throw new Error(`分支 ${workspace.branch} 不在允许推送的 owner/ 范围内。`);
    }
    const base = String(github.defaultBranch || 'main');
    if (!/^[A-Za-z0-9._/-]+$/u.test(base)) throw new Error('默认分支名不合法。');
    const files = (proposal.files ?? []).map((file) => file.path).filter(Boolean);
    if (!files.length) throw new Error('补丁没有变更文件。');
    const status = await execFileAsync('git', ['-C', workspace.path, 'status', '--porcelain'], {
      timeout: 15000, windowsHide: true
    }).then((result) => result.stdout.replace(/\r/gu, '').replace(/\n+$/u, ''))
      .catch(() => '');
    const changed = status.split('\n').filter(Boolean).map((line) => {
      const rest = line.slice(3).trim();
      return rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
    });
    const outside = changed.filter((file) => !files.includes(file));
    if (outside.length) {
      throw new Error(`worktree 存在未批准的改动：${outside.slice(0, 3).join(', ')}`);
    }
    const ahead = Number(await gitAt(workspace.path, ['rev-list', '--count', `${proposal.base_sha}..HEAD`])
      .catch(() => '0')) || 0;
    if (!status && ahead === 0) throw new Error('没有可提交的改动。');
    const stat = await gitAt(workspace.path, ['diff', '--stat', proposal.base_sha]).catch(() => '');
    const tasks = (await api(`/owner/v1/tasks?projectId=${encodeURIComponent(project.id)}`)).items ?? [];
    const task = tasks.find((item) => item.id === cycle.owner_task_id) ?? null;
    const draft = pr.buildPrDraft({
      taskTitle: task?.title || cycle.job?.title || project.name,
      projectName: project.name,
      cycleId: cycle.id,
      proposalId: proposal.id,
      runId: cycle.repair_sandbox_run_id ?? '',
      files,
      base,
      head: workspace.branch
    });
    const previewHash = pr.prPreviewHash({
      repo: github.nameWithOwner,
      base,
      head: workspace.branch,
      files,
      proposalHash: proposal.proposal_hash,
      commitMessage: draft.commitMessage,
      cycleId: cycle.id
    });
    return {
      cycle,
      project,
      github,
      workspace,
      proposal,
      files,
      ahead,
      preview: {
        previewHash,
        cycleId: cycle.id,
        repo: github.nameWithOwner,
        repoUrl: github.url,
        private: github.private,
        base,
        head: workspace.branch,
        files,
        stat,
        ahead,
        draft
      }
    };
  };

  const prPreviewFor = async (cycleId) => (await preparePr(cycleId)).preview;

  const prCreateFor = async ({ cycleId, previewHash, confirm }) => {
    if (confirm !== true) throw new Error('需要显式确认才能推送分支并创建 PR。');
    const prepared = await preparePr(cycleId);
    if (String(previewHash ?? '') !== prepared.preview.previewHash) {
      throw new Error('预览已过期或内容发生变化，请重新预览后再确认。');
    }
    const { workspace, files, preview, github } = prepared;
    // 只暂存批准过的文件，绝不使用 git add -A。
    await gitAt(workspace.path, ['add', '--', ...files]);
    const staged = await gitAt(workspace.path, ['diff', '--cached', '--name-only']);
    let commit = await gitAt(workspace.path, ['rev-parse', '--short', 'HEAD']).catch(() => '');
    if (staged) {
      await gitAt(workspace.path, [
        '-c', 'user.name=Owner Companion',
        '-c', 'user.email=owner-companion@users.noreply.github.com',
        'commit', '-m', preview.draft.commitMessage
      ]);
      commit = await gitAt(workspace.path, ['rev-parse', '--short', 'HEAD']);
    } else if (prepared.ahead === 0) {
      throw new Error('没有可提交的改动。');
    }
    const exists = await gitAt(workspace.path, [
      'ls-remote', '--heads', 'origin', `refs/heads/${preview.head}`
    ]);
    if (exists) throw new Error(`远端已存在分支 ${preview.head}，请先清理。`);
    await gitAt(workspace.path, [
      'push', 'origin', `HEAD:refs/heads/${preview.head}`
    ], 60000);
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'create',
        '--repo', github.nameWithOwner,
        '--base', preview.base,
        '--head', preview.head,
        '--title', preview.draft.title,
        '--body', preview.draft.body,
        '--draft'
      ], { timeout: 60000, windowsHide: true });
      const url = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
      return { pushed: true, url, branch: preview.head, base: preview.base, commit };
    } catch (error) {
      return {
        pushed: true,
        url: '',
        branch: preview.head,
        base: preview.base,
        commit,
        error: ghErrorText(error)
      };
    }
  };


const buildView = async () => {
  const projects = await api('/owner/v1/projects');
  const projectList = projects.items ?? [];
  const activeProjectId = config.projectId && projectList.some((item) => item.id === config.projectId)
    ? config.projectId
    : projectList[0]?.id ?? '';
  const activeProject = projectList.find((item) => item.id === activeProjectId) ?? null;
  const [summary, workerState, jobs, patches, sandboxes, repairs] = await Promise.all([
    api('/owner/v1/summary'),
    api('/owner/v1/worker/status'),
    api('/owner/v1/jobs?limit=20'),
    api('/owner/v1/patches?limit=20'),
    api('/owner/v1/sandbox-runs?limit=20'),
    api('/owner/v1/repair-cycles?limit=20')
  ]);
  const allJobs = jobs.items ?? [];
  const allPatches = patches.items ?? [];
  const allSandboxes = sandboxes.items ?? [];
  const allRepairs = repairs.items ?? [];
  const projectNames = new Map(projectList.map((project) => [project.id, project.name]));
  const pending = toPending({
    jobs: allJobs,
    patches: allPatches,
    sandboxes: allSandboxes,
    repairs: allRepairs
  }, projectNames);
  // 任务链只关联当前选中的项目，避免把不同项目的 Job/Patch/Run/Cycle 拼成假进度。
  const inProject = (item) => projectIdOf(item) === activeProjectId;
  const jobsInProject = allJobs.filter(inProject);
  const patchesInProject = allPatches.filter(inProject);
  const sandboxesInProject = allSandboxes.filter(inProject);
  const repairsInProject = allRepairs.filter(inProject);
  const activeJob = jobsInProject.find((job) =>
    ['pending_approval', 'queued', 'leased', 'running', 'cancel_requested'].includes(job.status)
  );
  const activeCycle = repairsInProject.find((cycle) =>
    ['pending_approval', 'queued', 'proposal_ready', 'applied', 'test_pending'].includes(cycle.status)
  );
  const activeSandbox = sandboxesInProject.find((run) =>
    ['pending_approval', 'queued', 'provisioning', 'running', 'collecting'].includes(run.status)
  );
  const latestPatch = patchesInProject[0] ?? null;
  const chain = {
    job: activeJob ?? jobsInProject[0] ?? null,
    patch: latestPatch,
    sandbox: activeSandbox ?? sandboxesInProject[0] ?? null,
    cycle: activeCycle ?? repairsInProject[0] ?? null
  };
  // 活动流与会话时间线：给面板的 Cindy 式 activity / message 卡片用。
  const jobLabel = (status) => ({
    pending_approval: '等你批准', approved: '已批准', queued: '排队中', leased: '已领取',
    running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
    rejected: '已拒绝', needs_reconciliation: '需要核对'
  }[status] ?? status);
  const runLabel = (run) => {
    const test = run.test_status ?? 'unknown';
    const exit = Number.isInteger(run.exit_code) ? ` · exit ${run.exit_code}` : '';
    return `${run.status} · 测试 ${test}${exit}`;
  };
  const cycleLabel = (status) => ({
    pending_approval: '等你批准', queued: '排队中', proposal_ready: '补丁就绪',
    applied: '已应用', test_pending: '等待测试', tested_pass: '复测通过',
    tested_fail: '复测未通过', failed: '失败', cancelled: '已取消'
  }[status] ?? status);

  // 每个项目最近一次进展：从任务 / 补丁 / 沙箱 / 修复里取时间最新的一条，
  // 供面板顶部的项目列表显示「最近更新」。
  const projectSource = await importEsm('../src/project-source.mjs');
  const localHost = projectSource.localHostName();

  const projectDigest = (projectId) => {
    const items = [];
    for (const job of allJobs) {
      if (projectIdOf(job) !== projectId) continue;
      items.push({
        at: job.updated_at ?? job.created_at ?? '',
        text: `任务：${job.title || '未命名'} · ${jobLabel(job.status)}`,
        tone: job.status === 'failed' ? 'error'
          : job.status === 'succeeded' ? 'ok'
            : ['running', 'leased', 'queued'].includes(job.status) ? 'active' : 'muted'
      });
    }
    for (const patch of allPatches) {
      if (projectIdOf(patch) !== projectId) continue;
      const files = (patch.files ?? []).map((file) => file.path).join(', ');
      items.push({
        at: patch.updated_at ?? patch.created_at ?? '',
        text: `补丁：${files || patch.id.slice(0, 8)} · ${patch.status}`,
        tone: patch.status === 'applied' ? 'ok' : 'muted'
      });
    }
    for (const run of allSandboxes) {
      if (projectIdOf(run) !== projectId) continue;
      items.push({
        at: run.updated_at ?? run.created_at ?? '',
        text: `沙箱测试：${run.test_status === 'pass' ? '通过' : run.test_status === 'fail' ? '未通过' : run.status}`,
        tone: run.test_status === 'pass' ? 'ok' : run.test_status === 'fail' ? 'error' : 'muted'
      });
    }
    for (const cycle of allRepairs) {
      if (projectIdOf(cycle) !== projectId) continue;
      items.push({
        at: cycle.updated_at ?? cycle.created_at ?? '',
        text: `修复：${cycleLabel(cycle.status)}`,
        tone: cycle.status === 'tested_pass' ? 'ok'
          : ['tested_fail', 'failed'].includes(cycle.status) ? 'error' : 'muted'
      });
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return items[0] ?? null;
  };

  const activity = [];
  if (chain.job) activity.push({ kind: 'status', text: `任务：${chain.job.title}（${jobLabel(chain.job.status)}）` });
  if (chain.patch) {
    activity.push({
      kind: 'tool',
      text: `补丁：${(chain.patch.files ?? []).map((file) => file.path).join(', ') || chain.patch.id.slice(0, 8)} · ${chain.patch.status}`
    });
  }
  if (chain.sandbox) activity.push({ kind: 'tool', text: `沙箱：${runLabel(chain.sandbox)}` });
  if (chain.cycle) activity.push({ kind: 'status', text: `修复：${chain.cycle.status}` });
  if (activity.length === 0) activity.push({ kind: 'status', text: '暂时没有进行中的任务' });

  const timeline = [];
  for (const job of jobsInProject.slice(0, 6)) {
    timeline.push({
      id: `job:${job.id}`, kind: 'user', tool: 'job',
      title: job.title || '未命名任务',
      detail: `任务 · ${jobLabel(job.status)}`,
      at: job.updated_at ?? job.created_at ?? '',
      ref: { type: 'job', id: job.id }
    });
  }
  for (const patch of patchesInProject.slice(0, 6)) {
    timeline.push({
      id: `patch:${patch.id}`, kind: 'tool', tool: 'patch',
      title: '补丁提案',
      detail: `${(patch.files ?? []).map((file) => file.path).join(', ') || patch.id.slice(0, 8)} · ${patch.status}`,
      at: patch.updated_at ?? patch.created_at ?? '',
      ref: { type: 'patch', id: patch.id, status: patch.status }
    });
  }
  for (const run of sandboxesInProject.slice(0, 6)) {
    timeline.push({
      id: `sandbox:${run.id}`, kind: 'tool', tool: 'test',
      title: '沙箱测试',
      detail: runLabel(run),
      tone: run.test_status === 'pass' ? 'ok' : run.test_status === 'fail' ? 'error' : 'muted',
      at: run.updated_at ?? run.created_at ?? '',
      ref: { type: 'sandbox', id: run.id }
    });
  }
  for (const cycle of repairsInProject.slice(0, 4)) {
    timeline.push({
      id: `repair:${cycle.id}`, kind: 'tool', tool: 'repair',
      title: '修复循环',
      detail: cycle.status,
      tone: cycle.status === 'tested_pass' ? 'ok' : cycle.status === 'tested_fail' ? 'error' : 'muted',
      at: cycle.updated_at ?? cycle.created_at ?? '',
      ref: { type: 'repair', id: cycle.id }
    });
  }
  timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // 状态只反映“最近一次结果”，避免很久以前的失败/成功让桌宠永久变色。
  const nowMs = Date.now();
  const recent = (value, windowMs = 30 * 60 * 1000) => {
    const at = Date.parse(String(value ?? ''));
    return Number.isFinite(at) && nowMs - at < windowMs;
  };
  const latestCycle = repairsInProject[0] ?? null;
  const latestJob = jobsInProject[0] ?? null;
  const workerOnProject = workerState.running
    && (!workerState.current?.projectId || workerState.current.projectId === activeProjectId);
  const activePlaybook = activePlaybookFor(activeProjectId);
  const recentPlaybook = activePlaybook ? null : recentPlaybookFor(activeProjectId);
  let state = 'idle';
  if (pending.length > 0) state = 'waiting';
  else if (activePlaybook) state = 'working';
  else if (workerOnProject || activeJob || activeSandbox || activeCycle
    || sandboxesInProject.some((run) => ['queued', 'running'].includes(run.status))) {
    state = 'working';
  } else if (latestCycle && ['tested_fail', 'failed'].includes(latestCycle.status)
    && recent(latestCycle.updated_at ?? latestCycle.created_at)) {
    state = 'error';
  } else if (latestJob && ['failed', 'needs_reconciliation'].includes(latestJob.status)
    && recent(latestJob.updated_at ?? latestJob.created_at)) {
    state = 'error';
  } else if (latestCycle && latestCycle.status === 'tested_pass'
    && recent(latestCycle.updated_at ?? latestCycle.created_at)) {
    state = 'done';
  } else if (recentPlaybook) {
    // pstack 只读分析完成后短暂显示结果，再回到 idle。
    state = recentPlaybook.status === 'error' ? 'error' : 'done';
  }
  const finalCycle = repairsInProject.find((cycle) =>
    ['tested_pass', 'tested_fail'].includes(cycle.status)) ?? null;
  const chainView = {
    job: chain.job ? {
      id: chain.job.id, title: chain.job.title, status: chain.job.status,
      jobType: chain.job.job_type, createdAt: chain.job.created_at, updatedAt: chain.job.updated_at
    } : null,
    patch: chain.patch ? {
      id: chain.patch.id, status: chain.patch.status,
      files: (chain.patch.files ?? []).map((file) => file.path),
      createdAt: chain.patch.created_at, updatedAt: chain.patch.updated_at
    } : null,
    sandbox: chain.sandbox ? {
      id: chain.sandbox.id, status: chain.sandbox.status,
      testStatus: chain.sandbox.test_status, profile: chain.sandbox.profile?.id ?? '',
      exitCode: chain.sandbox.exit_code, createdAt: chain.sandbox.created_at, updatedAt: chain.sandbox.updated_at
    } : null,
    cycle: chain.cycle ? {
      id: chain.cycle.id, status: chain.cycle.status,
      scope: Array.isArray(chain.cycle.repairScope) ? chain.cycle.repairScope
        : Array.isArray(chain.cycle.repair_scope) ? chain.cycle.repair_scope : [],
      createdAt: chain.cycle.created_at, updatedAt: chain.cycle.updated_at
    } : null
  };
  const services = await serviceStatus();
  const projectGithubs = await Promise.all(
    projectList.map((project) => githubForProject(project.root))
  );
  let stage = stageText(chain);
  if (activePlaybook) stage = `pstack 正在分析：${activePlaybook.title}`;
  else if (stage === '暂时没有进行中的任务' && recentPlaybook) {
    stage = `pstack ${recentPlaybook.status === 'error' ? '失败' : '完成'}：${recentPlaybook.title}`;
  }
  if (activePlaybook) {
    const idleLine = activity.findIndex((line) => line.text === '暂时没有进行中的任务');
    if (idleLine >= 0) activity.splice(idleLine, 1);
    activity.unshift({ kind: 'status', text: `pstack：${activePlaybook.title} · 分析中` });
  }
  const knowledgeView = await knowledgeSnapshot(activeProjectId);
  const queueView = (await api(
    `/owner/v1/queue?projectId=${encodeURIComponent(activeProjectId)}`
  )).items ?? [];
  const projectHead = await headForProject(activeProject?.root ?? '');
  const diagramView = ((await api(
    `/owner/v1/projects/${encodeURIComponent(activeProjectId)}/diagrams`
  ).catch(() => ({ items: [] }))).items ?? []).map((diagram) => ({
    ...diagram,
    stale: Boolean(diagram.basedOnCommit && projectHead && diagram.basedOnCommit !== projectHead)
  }));
  const briefView = await projectBriefFor(activeProject);
  const resultView = finalCycle
    ? {
      cycleId: finalCycle.id,
      status: finalCycle.status,
      testStatus: finalCycle.status === 'tested_pass' ? 'pass' : 'fail',
      label: finalCycle.status === 'tested_pass'
        ? `修复 ${finalCycle.id.slice(0, 8)} 已通过复测`
        : `修复 ${finalCycle.id.slice(0, 8)} 复测未通过`
    }
    : null;
  const { nextActionFor } = await loadNextAction();
  const nextAction = nextActionFor({
    pending: pending.length,
    playbookRunning: Boolean(activePlaybook),
    brief: briefView,
    briefStale: briefView?.stale === true,
    queueTodo: queueView.filter((item) => item.status === 'todo').length,
    knowledge: knowledgeView?.counts ?? {},
    result: resultView,
    state,
    cycleId: finalCycle?.id ?? ''
  });
  return {
    version: COMPANION_VERSION,
    state,
    pending,
    stage,
    activity,
    timeline,
    chain: chainView,
    playbook: activePlaybook
      ? {
        running: true,
        playbookId: activePlaybook.playbookId,
        title: activePlaybook.title,
        startedAt: activePlaybook.startedAt
      }
      : recentPlaybook
        ? {
          running: false,
          playbookId: recentPlaybook.playbookId,
          title: recentPlaybook.title,
          status: recentPlaybook.status,
          summary: String(recentPlaybook.summary ?? '').slice(0, 160),
          finishedAt: recentPlaybook.finishedAt
        }
        : null,
    worker: {
      running: Boolean(workerState.running),
      onProject: Boolean(workerOnProject),
      label: workerState.running
        ? `工作中${workerState.current?.kind ? ` · ${workerState.current.kind}` : ''}`
        : workerState.last
          ? `上次 ${({ idle: '空闲', patch: '生成补丁', sandbox: '运行测试', error: '异常' })[workerState.last.kind] ?? workerState.last.kind}`
          : '空闲'
    },
    summary,
    projects: projectList.map((project, index) => {
      const digest = projectDigest(project.id);
      const lastAt = digest?.at || project.last_event_at || project.updated_at
        || project.created_at || '';
      const host = projectSource.hostOfRoot(project.root, localHost);
      return {
        id: project.id,
        name: project.name,
        root: project.root ?? '',
        goal: project.goal ?? '',
        status: project.status ?? '',
        baseSha: project.baseSha ?? project.base_sha ?? '',
        host,
        hostLabel: projectSource.hostLabelOf(host, localHost),
        hostLocal: host === localHost,
        github: projectGithubs[index] ?? null,
        lastEventAt: lastAt,
        progress: digest?.text
          ?? (project.goal ? `目标：${project.goal}` : '还没有任务记录'),
        progressTone: digest?.tone ?? 'muted',
        pending: pending.filter((item) => item.projectId === project.id).length
      };
    }),
    config: {
      projectId: activeProjectId,
      domain: activeProject?.primary_domain ?? activeProject?.primaryDomain ?? '',
      allowedPaths: config.allowedPaths,
      includePaths: config.includePaths,
      gatewayUrl: config.gatewayUrl,
      model: config.model,
      sandboxMode: config.sandboxMode ?? 'auto',
      sandboxProjectMode: (config.sandboxByProject ?? {})[activeProjectId] ?? ''
    },
    testConfig: await testConfigForProject(activeProject),
    services,
    mascot: await mascotView(),
    brief: briefView,
    nextAction,
    queue: queueView,
    diagrams: diagramView,
    knowledge: knowledgeView,
    result: resultView
  };
};

const serviceStatus = async () => {
  const now = Date.now();
  if (serviceCache.value && now - serviceCache.at < 10000) return serviceCache.value;
  let docker = false;
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 2500,
      windowsHide: true
    });
    docker = true;
  } catch { docker = false; }
  let gateway = false;
  try {
    const response = await fetch(config.gatewayUrl, {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual'
    });
    gateway = response.status > 0;
  } catch { gateway = false; }
  let pi = false;
  try {
    fs.accessSync(path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.pi', 'agent'));
    pi = true;
  } catch { pi = false; }
  const value = { docker, gateway, pi, model: config.model || 'Pi 默认模型' };
  serviceCache = { at: now, value };
  return value;
};

const notifyIfNeeded = (view) => {
  if (process.env.OWNER_AGENT_NOTIFICATIONS === '0') return;
  if (!view.pending.length) { lastNoticeKey = ''; return; }
  const key = view.pending.map((item) => `${item.kind}:${item.id}`).join('|');
  if (key === lastNoticeKey) return;
  lastNoticeKey = key;
  if (!Notification.isSupported()) return;
  const first = view.pending[0];
  new Notification({
    title: 'Owner Companion',
    body: view.pending.length === 1 ? first.title : `${view.pending.length} 项需要你决定`
  }).show();
};

const clampToWorkArea = (x, y, width, height) => {
  const point = { x: x + width / 2, y: y + height / 2 };
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  return {
    x: Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - height))
  };
};

const positionPet = () => {
  if (!pet) return;
  const display = screen.getPrimaryDisplay();
  const fallback = {
    x: display.workArea.x + display.workArea.width - PET_SIZE - 24,
    y: display.workArea.y + display.workArea.height - PET_SIZE - 40
  };
  const target = config.pet ?? fallback;
  const { x, y } = clampToWorkArea(target.x, target.y, PET_SIZE, PET_SIZE);
  pet.setBounds({ x: Math.round(x), y: Math.round(y), width: PET_SIZE, height: PET_SIZE });
};

const positionPanel = () => {
  if (!panel || !pet) return;
  const petBounds = pet.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: petBounds.x + petBounds.width / 2,
    y: petBounds.y + petBounds.height / 2
  });
  const area = display.workArea;
  let x = petBounds.x - PANEL_WIDTH - 10;
  if (x < area.x) x = petBounds.x + petBounds.width + 10;
  if (x + PANEL_WIDTH > area.x + area.width) {
    x = area.x + area.width - PANEL_WIDTH - 10;
  }
  let y = petBounds.y + petBounds.height - PANEL_HEIGHT;
  if (y < area.y) y = area.y + 10;
  if (y + PANEL_HEIGHT > area.y + area.height) {
    y = area.y + area.height - PANEL_HEIGHT - 10;
  }
  panel.setBounds({
    x: Math.round(Math.max(area.x, x)),
    y: Math.round(Math.max(area.y, y)),
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT
  });
};

const safeWindow = (window) => {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
};

/** 渲染进程卡死时记录并尝试自动恢复，避免用户只能杀进程。 */
const watchWindow = (window, label) => {
  window.webContents.on('unresponsive', () => {
    logError(`${label}.unresponsive`, new Error('renderer stopped responding'));
    setTimeout(() => {
      if (!window.isDestroyed()) {
        try { window.webContents.reload(); } catch (error) { logError(`${label}.reload`, error); }
      }
    }, 3000);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logError(`${label}.gone`, new Error(JSON.stringify(details)));
  });
};

const createPet = () => {
  pet = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  safeWindow(pet);
  watchWindow(pet, 'pet');
  positionPet();
  if (e2eOffscreen) {
    pet.setOpacity(0);
    pet.setIgnoreMouseEvents(true);
  }
  pet.setAlwaysOnTop(true, 'floating');
  pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  pet.loadFile(path.join(__dirname, 'pet.html'));
  pet.on('closed', () => { pet = null; });
};

const createPanel = () => {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  safeWindow(panel);
  watchWindow(panel, 'panel');
  if (e2eOffscreen) {
    panel.setOpacity(0);
    panel.setIgnoreMouseEvents(true);
  }
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('closed', () => { panel = null; });
};

const showPanel = () => {
  if (!panel) createPanel();
  positionPanel();
  if (e2eOffscreen) {
    // 自动化实例只渲染不抢焦点，也不出现在任务栏。
    panel.showInactive();
    return;
  }
  panel.show();
  panel.focus();
};

const hidePanel = () => {
  if (panel && !panel.isDestroyed()) panel.hide();
};

const openFull = async () => {
  if (fullWindow && !fullWindow.isDestroyed()) {
    fullWindow.show();
    fullWindow.focus();
    return;
  }
  let target = '';
  try {
    const response = await fetch(config.gatewayUrl, { signal: AbortSignal.timeout(1500) });
    if (response.status > 0) target = config.gatewayUrl;
  } catch { target = ''; }
  if (!target && workbenchUrl) target = workbenchUrl;
  if (!target) {
    throw new Error('OpenClaw Gateway 和 Workbench 都不可用，请先在设置里配置 Gateway 地址。');
  }
  fullWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'Owner Companion · 完整工作台',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  fullWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchWindow(fullWindow, 'full');
  fullWindow.loadURL(target);
  fullWindow.on('closed', () => { fullWindow = null; });
};

const openKnowledgeWorkbench = async () => {
  if (!workbenchUrl) throw new Error('本地知识工作台尚未启动');
  if (fullWindow && !fullWindow.isDestroyed()) {
    fullWindow.show();
    fullWindow.focus();
    return;
  }
  fullWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'Owner Companion · 知识工作台',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  fullWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchWindow(fullWindow, 'knowledge');
  fullWindow.loadURL(workbenchUrl);
  fullWindow.on('closed', () => { fullWindow = null; });
};

const createTray = () => {
  const image = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('Owner Companion');
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示桌宠', click: () => { if (pet) { pet.show(); positionPet(); } } },
      { label: '打开面板', click: showPanel },
      { label: '完整工作台', click: () => { void openFull().catch(() => showPanel()); } },
      { type: 'separator' },
      { label: '设置', click: () => { showPanel(); panel?.webContents.send('companion:open-settings'); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
  };
  rebuild();
  tray.on('double-click', () => { if (pet) { pet.show(); positionPet(); } });
  tray.on('click', showPanel);
};

// ---- pstack Playbook ----

const playbookReportDir = () => path.join(app.getPath('userData'), 'playbooks');

const loadPlaybookRegistry = async () => {
  if (playbookRegistry) return playbookRegistry;
  const registry = await importEsm('../src/pstack/playbooks.mjs');
  playbookRegistry = registry;
  return registry;
};

const getPlaybookRunner = async () => {
  if (playbookRunner) return playbookRunner;
  const { PlaybookRunner } = await importEsm('../src/pstack/playbook-runner.mjs');
  playbookRunner = new PlaybookRunner({ model: config.model || '' });
  playbookRunnerError = '';
  return playbookRunner;
};

/**
 * 在独立 Node 子进程里跑 playbook，避免 Pi SDK / 模型调用阻塞 Electron 主进程。
 * 取消时直接 kill 子进程，并返回一个受控的“取消”结果。
 */
const runPlaybookInChild = ({ playbookId, playbook, project, task = '', model = '', digest = '' }) => new Promise((resolve, reject) => {
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const child = fork(path.join(__dirname, 'playbook-child.mjs'), [], {
    cwd: path.join(__dirname, '..'),
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  playbookChildren.set(playbookId, child);
  let settled = false;
  let canceled = false;
  let stderr = '';
  const finish = (fn, value) => {
    if (settled) return;
    settled = true;
    playbookChildren.delete(playbookId);
    clearTimeout(timer);
    try { child.kill(); } catch { /* already gone */ }
    fn(value);
  };
  const timer = setTimeout(() => {
    finish(reject, new Error('playbook 执行超时，请稍后重试'));
  }, 600000);
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.on('message', (message) => {
    if (message?.type === 'ready') {
      child.send({
        type: 'run',
        playbookId,
        project,
        task,
        digest,
        model: model || config.model || '',
        timeoutMs: 240000
      });
      return;
    }
    if (message?.type === 'result') finish(resolve, message.result);
    else if (message?.type === 'error') finish(reject, new Error(message.error));
  });
  child.on('exit', (code) => {
    if (settled) return;
    if (canceled) {
      finish(resolve, {
        runId: `pb_${Date.now().toString(36)}`,
        playbookId,
        playbookLabel: playbook?.label ?? playbookId,
        status: 'error',
        category: 'canceled',
        summary: '执行失败：canceled',
        findings: [],
        risks: [],
        nextSteps: [],
        durationMs: Date.now() - began,
        startedAt,
        model: config.model || '',
        text: ''
      });
      return;
    }
    finish(reject, new Error(`playbook 子进程退出（${code}）${stderr.slice(0, 300)}`));
  });
  child.__cancel = () => {
    canceled = true;
    try { child.kill(); } catch { /* already gone */ }
  };
});

/** 只读分诊执行器：判断一条交办是否需要写入，再决定是否发起 HITL 写请求。 */
const getTriageRunner = async () => {
  if (triageRunner) return triageRunner;
  const { TriageRunner } = await importEsm('../src/pstack/triage.mjs');
  triageRunner = new TriageRunner({ model: config.model || '' });
  return triageRunner;
};

/** 权限校验：只接受当前 Owner 已注册的项目，根目录必须与登记一致。 */
const projectForPlaybook = async (projectId) => {
  const items = (await api('/owner/v1/projects')).items ?? [];
  const project = items.find((item) => item.id === (projectId || config.projectId)) ?? items[0];
  if (!project) throw new Error('还没有项目，请先在设置里添加一个项目目录。');
  return {
    id: project.id,
    root: project.root,
    domain: project.primary_domain ?? project.primaryDomain ?? ''
  };
};

const persistPlaybookRun = (result) => {
  const dir = playbookReportDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.runId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return file;
};

/**
 * 把一次 pstack 只读分析沉淀成项目知识候选（pending，不自动验证、不写文件）。
 * 供“手动沉淀”和“复盘并沉淀”一键流共用。
 */
const distillPlaybookRun = ({
  project, playbook, runId = '', summary = '',
  findings = [], risks = [], nextSteps = []
}) => {
  if (!personalStore) throw new Error('知识库尚未初始化。');
  const text = String(summary ?? '').trim().slice(0, 2000);
  if (!text) throw new Error('这次结果没有可沉淀的结论。');
  const id = String(runId ?? '');
  const existing = personalStore.proposals('pending').find((proposal) =>
    proposal.meta?.contract === 'knowledge-candidate/v1'
    && proposal.meta?.runId === id
    && proposal.meta?.playbookId === playbook.id);
  if (existing) {
    return { duplicate: true, candidateId: existing.id, title: existing.payload?.title ?? '' };
  }
  const safeFindings = Array.isArray(findings) ? findings.slice(0, 8) : [];
  const safeRisks = Array.isArray(risks) ? risks.slice(0, 6) : [];
  const safeNext = Array.isArray(nextSteps) ? nextSteps.slice(0, 6) : [];
  const evidence = [];
  for (const finding of safeFindings) {
    for (const ref of (finding?.evidence ?? [])) {
      if (typeof ref === 'string' && ref && !evidence.includes(ref)) evidence.push(ref);
    }
  }
  const lines = ['## 结论', text];
  if (safeFindings.length) {
    lines.push('', '## 关键发现');
    for (const finding of safeFindings) {
      const title = String(finding?.title ?? '').slice(0, 160);
      const detail = String(finding?.detail ?? '').slice(0, 600);
      if (title || detail) lines.push(`- ${title}${detail ? `：${detail}` : ''}`);
    }
  }
  if (safeRisks.length) {
    lines.push('', '## 风险与未知');
    for (const risk of safeRisks) lines.push(`- ${String(risk).slice(0, 300)}`);
  }
  if (safeNext.length) {
    lines.push('', '## 下一步');
    for (const step of safeNext) lines.push(`- ${String(step).slice(0, 300)}`);
  }
  const title = `${playbook.label}：${text.replace(/\s+/gu, ' ').slice(0, 50)}`;
  const proposal = personalStore.submitProposal({
    targetId: null,
    payload: {
      title,
      content: lines.join('\n').slice(0, 6000),
      kind: playbook.group === 'distill' ? 'procedure' : 'note',
      layer: 'project',
      scope: 'project',
      projectId: project.id,
      domains: project.domain ? [project.domain] : [],
      tags: [playbook.id, 'pstack'],
      evidenceRefs: [...new Set([`pstack:${id}`, ...evidence])].slice(0, 10),
      verificationStatus: 'unverified',
      relations: {},
      sourceRef: `pstack:${id}`
    },
    meta: {
      contract: 'knowledge-candidate/v1',
      sourceExperienceIds: [],
      confidence: 0.5,
      source: 'pstack',
      playbookId: playbook.id,
      runId: id
    }
  });
  return { duplicate: false, candidateId: proposal.id, title };
};

/** 面板列表：playbook 元数据 + 可用性 + 当前项目的最近一次结果。 */
const playbookListPayload = async (projectId) => {
  const registry = await loadPlaybookRegistry();
  const { resolvePstackSkillsDir } = await importEsm('../src/pstack/readonly-session.mjs');
  const skillsDir = resolvePstackSkillsDir();
  const activeProject = config.projectId || '';
  const lastRuns = {};
  for (const [key, value] of playbookRuns.entries()) {
    const [runProjectId, runPlaybookId] = key.split('::');
    if (runProjectId !== (projectId || activeProject)) continue;
    lastRuns[runPlaybookId] = {
      runId: value.runId,
      status: value.status,
      summary: value.summary,
      durationMs: value.durationMs,
      startedAt: value.startedAt
    };
  }
  return {
    skillsAvailable: Boolean(skillsDir),
    skillsDir: skillsDir ?? '',
    groups: registry.listPlaybooks(),
    lastRuns,
    error: playbookRunnerError
  };
};

/** 解析项目：只接受已登记项目；缺省用当前项目，再退到第一个。 */
const resolveProject = async (projectId = '') => {
  const projects = (await api('/owner/v1/projects')).items ?? [];
  const project = projects.find((item) => item.id === projectId)
    ?? projects.find((item) => item.id === config.projectId)
    ?? projects[0];
  if (!project) throw new Error('还没有项目，请先在设置里添加一个项目目录。');
  return project;
};

let companionSubmitModule = null;
const loadCompanionSubmit = async () => {
  companionSubmitModule ??= await importEsm('../src/companion-submit.mjs');
  return companionSubmitModule;
};

const projectRootOf = (project) => project.root ?? project.root_path ?? project.rootPath ?? '';

/**
 * 创建一条 HITL 写请求：Job 仍是 pending_approval，Owner 批准后 Worker 才会启动写入子 Agent。
 * 真正的文件写入依然发生在隔离 worktree，并继续走补丁审批与沙箱链路。
 */
const createWriteRequest = async ({
  project,
  text,
  title = '',
  intent = '',
  targets = [],
  allowedPaths = '',
  analysisRunId = '',
  analysisSummary = ''
}) => {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('请先输入要交办的事情。');
  const { normalizeAllowedPaths } = await loadCompanionSubmit();
  const baseSha = project.baseSha ?? project.base_sha ?? '';
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    throw new Error(`项目目录不是有效的 Git 仓库（${projectRootOf(project)}），无法确定 base commit。`);
  }
  const jobTitle = String(title || `写请求：${intent || value}`).slice(0, 200);
  const task = await api('/owner/v1/tasks', {
    method: 'POST',
    body: { projectId: project.id, title: jobTitle }
  });
  const job = await api('/owner/v1/jobs', {
    method: 'POST',
    body: {
      projectId: project.id,
      jobType: 'code-write',
      title: jobTitle,
      payload: {
        baseSha,
        allowedPaths: normalizeAllowedPaths(allowedPaths, config.allowedPaths || 'src/'),
        focus: value.slice(0, 300),
        intent: String(intent || value).slice(0, 300),
        targets: (Array.isArray(targets) ? targets.join(',') : String(targets || '')).slice(0, 300),
        analysisRunId: String(analysisRunId || '').slice(0, 300),
        analysisSummary: String(analysisSummary || '').slice(0, 300)
      },
      idempotencyKey: `companion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerTaskId: task.id
    }
  });
  config.projectId = project.id;
  saveConfig();
  return { jobId: job.id, status: job.status, projectId: project.id };
};

/** 兼容旧路径：面板“生成改动提案”也走同一个受控写入链路。 */
const createPatchJob = async ({ text, projectId, jobType = 'code-write', ...rest }) => {
  const project = await resolveProject(projectId);
  return createWriteRequest({ project, text, ...rest });
};

/**
 * Composer 交办：先只读分析（不写文件）。
 * - 只需要回答 → 直接返回结论，不创建 Job；
 * - 需要写入 → 创建 code-write 写请求（pending_approval，HITL），批准后才启动写入子 Agent。
 */
const submitCompanionTask = async ({ text, projectId }) => {
  const project = await resolveProject(projectId);
  const [{ submitCompanionTask: runSubmit }, triageRunner] = await Promise.all([
    loadCompanionSubmit(),
    getTriageRunner()
  ]);
  const result = await runSubmit({
    text,
    project: {
      id: project.id,
      root: projectRootOf(project),
      domain: project.primary_domain ?? project.primaryDomain ?? '',
      baseSha: project.baseSha ?? project.base_sha ?? ''
    },
    triageRunner,
    createWriteRequest
  });
  if (result.mode === 'write-request') {
    return { ...result, testConfig: await testConfigForProject(project) };
  }
  return result;
};

const registerIpc = () => {
  const fromCompanion = (event) =>
    [pet?.webContents, panel?.webContents].filter(Boolean).includes(event.sender);

  ipcMain.handle('companion:snapshot', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const view = await buildView();
    notifyIfNeeded(view);
    return view;
  });

  ipcMain.handle('companion:submit', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return submitCompanionTask({
      text: String(input?.text ?? ''),
      projectId: String(input?.projectId ?? '')
    });
  });

  // 兼容旧渲染进程：同样走“只读分析 → HITL 写请求”，不再接受 mode 开关。
  // 兼容旧入口：同样走只读分诊，只有需要写入时才创建 HITL 写请求。
  ipcMain.handle('companion:create-job', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return submitCompanionTask({
      text: String(input?.text ?? ''),
      projectId: String(input?.projectId ?? '')
    });
  });

  ipcMain.handle('companion:queue-add', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await resolveProject(String(input?.projectId ?? ''));
    return api('/owner/v1/queue', {
      method: 'POST',
      body: {
        projectId: project.id,
        title: String(input?.title ?? '').trim(),
        body: String(input?.body ?? ''),
        source: 'owner'
      }
    });
  });

  ipcMain.handle('companion:queue-update', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing queue id');
    return api(`/owner/v1/queue/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        title: input?.title,
        body: input?.body,
        status: input?.status,
        linkedJobId: input?.linkedJobId
      }
    });
  });

  ipcMain.handle('companion:queue-remove', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing queue id');
    return api(`/owner/v1/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
  });

  ipcMain.handle('companion:queue-move', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    const direction = String(input?.direction ?? '');
    if (!id) throw new Error('Missing queue id');
    return api(`/owner/v1/queue/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: { direction }
    });
  });

  // 把一条待办交给当前项目的只读分诊/写入流程；结果写回队列状态。
  ipcMain.handle('companion:queue-dispatch', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing queue id');
    const item = await api(`/owner/v1/queue/${encodeURIComponent(id)}`);
    if (!item) throw new Error('待办不存在。');
    const text = [item.title, item.body].filter(Boolean).join('\n\n');
    const result = await submitCompanionTask({ text, projectId: item.projectId });
    const status = result.mode === 'write-request' ? 'blocked'
      : result.mode === 'answer' ? 'done'
        : result.mode === 'triage-error' ? 'failed' : 'doing';
    const updated = await api(`/owner/v1/queue/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status, linkedJobId: result.jobId ?? '' }
    });
    return { ...result, item: updated };
  });

  ipcMain.handle('companion:diagram-dependency', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const mod = await loadDiagrams();
    const diagram = mod.scanDependencyGraph(project.root);
    const head = await headForProject(project.root);
    const saved = await api(`/owner/v1/projects/${encodeURIComponent(project.id)}/diagrams/dependency`, {
      method: 'PUT',
      body: {
        scope: 'project',
        title: diagram.title,
        summary: diagram.data.summary,
        mermaid: diagram.mermaid,
        data: diagram.data,
        unknowns: diagram.data.unknowns,
        confidence: diagram.data.confidence,
        source: 'local-scan',
        runId: '',
        basedOnCommit: head
      }
    });
    projectHeadCache.delete(project.root);
    return { ...saved, stale: false };
  });

  ipcMain.handle('companion:diagram-generate', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const kind = String(input?.kind ?? '');
    const scope = String(input?.scope ?? '').trim() || 'project';
    if (!['control', 'dataflow', 'state', 'sequence'].includes(kind)) {
      throw new Error('未知的图谱类型。');
    }
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const registry = await loadPlaybookRegistry();
    const playbook = registry.listPlaybooks().flatMap((group) => group.items)
      .find((item) => item.diagramKind === kind);
    if (!playbook) throw new Error('没有对应的图谱 playbook。');
    // 图谱优先用 diagramModel（设置里可单独指定），失败后回退到主模型。
    const models = [...new Set([config.diagramModel, config.model]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean))];
    const candidates = models.length ? models : [''];
    // 大仓库（几十万文件）让模型自己 grep 会直接超时：先用本地扫描给一段有界摘录。
    const diagramMod = await loadDiagrams();
    const digest = diagramMod.buildProjectDigest(project.root, scope).text;
    const runOnce = (hint, model) => runPlaybookInChild({
      playbookId: playbook.id,
      playbook: registry.getPlaybook(playbook.id),
      project,
      task: hint,
      model,
      digest
    });
    let result = null;
    let usedModel = '';
    const attempts = [];
    for (const model of candidates) {
      usedModel = model;
      try {
        result = await runOnce(`scope: ${scope}`, model);
        // 模型偶尔只返回 summary；同一模型再补一次更明确的指令。
        if (result.status === 'ok' && !result.diagram) {
          result = await runOnce(
            `scope: ${scope}\n请务必返回 diagram 对象（包含 kind 与 nodes/states/participants）。`,
            model
          );
        }
      } catch (error) {
        // 子进程异常退出等硬失败也要继续尝试下一个模型，而不是直接放弃。
        result = { status: 'error', category: 'child-exit', summary: String(error?.message ?? error) };
      }
      if (result.status === 'ok' && result.diagram) break;
      attempts.push(`${model || '默认模型'}：${result.category || result.summary || '未返回 diagram'}`);
    }
    if (result?.status !== 'ok') {
      const advice = result?.advice ? ` ${result.advice}` : '';
      throw new Error([
        `${result?.summary || '图谱生成失败。'}${advice}`,
        attempts.length > 1 ? `已尝试：${attempts.join('；')}。` : '',
        '可在设置中填写「图谱模型」换一个更快的模型。'
      ].filter(Boolean).join(' '));
    }
    if (!result.diagram) {
      const sample = String(result.text ?? result.summary ?? '').slice(0, 200);
      throw new Error(`模型没有返回 diagram 数据：${sample}`);
    }
    const data = diagramMod.normalizeDiagram(kind, result.diagram);
    const mermaid = diagramMod.toMermaid(kind, data);
    const head = await headForProject(project.root);
    const saved = await api(`/owner/v1/projects/${encodeURIComponent(project.id)}/diagrams/${kind}`, {
      method: 'PUT',
      body: {
        scope,
        title: String(result.diagram.title ?? diagramMod.DIAGRAM_LABELS[kind]).slice(0, 200),
        summary: data.summary,
        mermaid,
        data,
        unknowns: data.unknowns,
        confidence: data.confidence,
        source: `pstack:${playbook.id}`,
        runId: result.runId ?? '',
        basedOnCommit: head
      }
    });
    projectHeadCache.delete(project.root);
    return { ...saved, stale: false, usedModel };
  });

  ipcMain.handle('companion:decide', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const kind = String(input?.kind ?? '');
    const id = String(input?.id ?? '');
    const action = String(input?.action ?? 'approve');
    const hash = String(input?.hash ?? '');
    if (!id) throw new Error('Missing id');
    if (kind === 'job') {
      if (action === 'reject') {
        return api(`/owner/v1/jobs/${encodeURIComponent(id)}/reject`, {
          method: 'POST', body: { reason: String(input?.reason ?? '') }, decision: true
        });
      }
      return api(`/owner/v1/jobs/${encodeURIComponent(id)}/approve`, {
        method: 'POST', body: {}, decision: true
      });
    }
    if (kind === 'patch' || kind === 'patch-apply') {
      if (action === 'reject') {
        return api(`/owner/v1/patches/${encodeURIComponent(id)}/reject`, {
          method: 'POST', body: { reason: String(input?.reason ?? '') }, decision: true
        });
      }
      if (kind === 'patch') {
        return api(`/owner/v1/patches/${encodeURIComponent(id)}/approve`, {
          method: 'POST', body: { hash }, decision: true
        });
      }
      const applied = await api(`/owner/v1/patches/${encodeURIComponent(id)}/apply`, {
        method: 'POST', body: { hash }, decision: true
      });
      // 应用后自动创建待批准的沙箱运行；失败必须如实回传，不能假装测试已开始。
      const projects = (await api('/owner/v1/projects')).items ?? [];
      const project = projects.find((item) => item.id === config.projectId) ?? projects[0] ?? null;
      const testConfig = await testConfigForProject(project);
      // 明确关闭 / 非 Node 生态：补丁照常应用，但按设置跳过测试，不弹失败弹窗。
      if (!testConfig.enabled) {
        return { ...applied, testRequested: false, testSkipped: true, testConfig };
      }
      if (!testConfig.ok) {
        return {
          ...applied,
          testRequested: false,
          sandboxError: testConfig.missing.length
            ? `测试配置缺少文件：${testConfig.missing.join(', ')}`
            : '还没有可用的项目测试配置。',
          testConfig
        };
      }
      try {
        const run = await createSandbox(id);
        return {
          ...applied,
          testRequested: true,
          sandboxRunId: run.id,
          sandboxStatus: run.status,
          testConfig
        };
      } catch (error) {
        console.error('auto sandbox request failed:', error.message);
        return {
          ...applied,
          testRequested: false,
          sandboxError: String(error?.message ?? error),
          testConfig
        };
      }
    }
    if (kind === 'sandbox') {
      return api(`/owner/v1/sandbox-runs/${encodeURIComponent(id)}/approve`, {
        method: 'POST', body: { hash }, decision: true
      });
    }
    if (kind === 'repair') {
      return api(`/owner/v1/repair-cycles/${encodeURIComponent(id)}/approve`, {
        method: 'POST', body: { hash }, decision: true
      });
    }
    if (kind === 'repair-create') {
      return api('/owner/v1/repair-cycles', {
        method: 'POST',
        body: { sandboxRunId: id, idempotencyKey: `companion-${id}` }
      });
    }
    throw new Error(`Unknown decision kind: ${kind}`);
  });

  ipcMain.handle('companion:patch-detail', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return api(`/owner/v1/patches/${encodeURIComponent(String(input?.id ?? ''))}?content=1`);
  });

  ipcMain.handle('companion:result', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const cycleId = String(input?.cycleId ?? '');
    const cycle = await api(`/owner/v1/repair-cycles/${encodeURIComponent(cycleId)}`);
    const runs = await api(`/owner/v1/sandbox-runs?projectId=${encodeURIComponent(cycle.project_id)}&limit=200`);
    const runList = runs.items ?? [];
    const source = runList.find((run) => run.id === cycle.source_sandbox_run_id);
    const repairRun = runList.find((run) => run.repair_cycle_id === cycle.id);
    const evidence = async (run) => {
      if (!run) return null;
      const data = await api(`/owner/v1/sandbox-runs/${encodeURIComponent(run.id)}?logs=1`);
      return {
        id: run.id,
        status: run.status,
        execution: run.execution_status,
        test: run.test_status,
        stdout: String(data.stdout ?? '').slice(0, 12000),
        stderr: String(data.stderr ?? '').slice(0, 12000),
        result: String(data.result ?? '').slice(0, 4000)
      };
    };
    const proposal = async (run) => {
      if (!run) return null;
      const patch = await api(`/owner/v1/patches/${encodeURIComponent(run.proposal_id)}?content=1`);
      return {
        id: patch.id,
        status: patch.status,
        hash: patch.proposal_hash,
        paths: (patch.files ?? []).map((file) => file.path),
        diff: String(patch.proposal_diff ?? '').slice(0, 30000)
      };
    };
    return {
      cycle: {
        id: cycle.id,
        status: cycle.status,
        scope: Array.isArray(cycle.repairScope)
          ? cycle.repairScope
          : Array.isArray(cycle.repair_scope) ? cycle.repair_scope : [],
        approvalHash: cycle.approval_hash
      },
      sourceRun: await evidence(source),
      repairRun: await evidence(repairRun),
      sourcePatch: await proposal(source),
      repairPatch: await proposal(repairRun)
    };
  });

  ipcMain.handle('companion:create-sandbox', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === config.projectId) ?? projects[0] ?? null;
    const testConfig = await testConfigForProject(project);
    if (!testConfig.enabled) {
      throw new Error('当前项目未启用沙箱测试；到设置 → 沙箱测试里调整（自动 / 关闭 / Node）。');
    }
    if (!testConfig.ok) {
      throw new Error(`测试配置缺少 ${testConfig.missing.join(', ')}，无法创建沙箱。`);
    }
    return createSandbox(String(input?.proposalId ?? ''));
  });

  ipcMain.handle('companion:knowledge-summary', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeSnapshot(String(input?.projectId ?? '') || config.projectId);
  });

  // 显式人工动作：只对当前项目的待提炼经验调用 Harvest，产出 pending 候选。
  ipcMain.handle('companion:knowledge-tidy', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const projectId = String(input?.projectId ?? '') || config.projectId;
    if (!personalStore) {
      return {
        projectId,
        counts: { total: 0, duplicates: 0, stale: 0, conflicts: 0, unverified: 0 },
        duplicates: [], stale: [], conflicts: [], unverified: []
      };
    }
    const mod = await loadKnowledgeTidy();
    return mod.knowledgeTidyFor({ personalStore, projectId });
  });

  ipcMain.handle('companion:knowledge-harvest', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) throw new Error('知识库尚未初始化。');
    if (harvestInFlight) throw new Error('正在提炼，请稍候。');
    const projectId = String(input?.projectId ?? '') || config.projectId;
    if (!projectId) throw new Error('先选择一个项目。');
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === projectId);
    const domainId = project?.primary_domain ?? project?.primaryDomain ?? 'software-engineering';
    harvestInFlight = true;
    try {
      knowledgeSummaryModule = knowledgeSummaryModule ?? await importEsm('../src/knowledge/summary.mjs');
      return await knowledgeSummaryModule.harvestProjectNow({
        personalStore,
        ownerStore: store,
        model: config.model || '',
        projectId,
        domainId
      });
    } finally {
      harvestInFlight = false;
    }
  });

  ipcMain.handle('companion:knowledge-ask', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeAsk({
      kind: String(input?.kind ?? 'project'),
      projectId: String(input?.projectId ?? config.projectId ?? ''),
      domain: String(input?.domain ?? ''),
      query: String(input?.query ?? '').slice(0, 500)
    });
  });

  ipcMain.handle('companion:knowledge-detail', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeDetail({ id: String(input?.id ?? '') });
  });

  ipcMain.handle('companion:knowledge-open', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    await openKnowledgeWorkbench();
  });

  // 只读 playbook：列表、执行、报告、转提案。
  ipcMain.handle('companion:playbooks', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return playbookListPayload(String(input?.projectId ?? ''));
  });

  ipcMain.handle('companion:playbook-run', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const playbookId = String(input?.playbookId ?? '');
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const registry = await loadPlaybookRegistry();
    const playbook = registry.getPlaybook(playbookId);
    const title = playbook?.title ?? playbookId;
    const runKey = `${project.id}::${playbookId}`;
    // 运行期间让桌宠/面板知道“正在跑 pstack”，而不是显示空闲。
    activePlaybookRuns.set(runKey, {
      playbookId,
      title,
      projectId: project.id,
      projectName: project.name,
      startedAt: new Date().toISOString()
    });
    let result;
    try {
      result = await runPlaybookInChild({
        playbookId,
        playbook,
        project,
        task: String(input?.task ?? '')
      });
    } catch (error) {
      playbookRunnerError = String(error?.message ?? error);
      lastPlaybookResults.set(runKey, {
        playbookId,
        title,
        projectId: project.id,
        status: 'error',
        summary: playbookRunnerError,
        finishedAt: new Date().toISOString()
      });
      throw error;
    } finally {
      activePlaybookRuns.delete(runKey);
    }
    persistPlaybookRun({
      ...result,
      projectId: project.id,
      projectName: project.name,
      playbookTitle: title
    });
    playbookRuns.set(runKey, result);
    lastPlaybookResults.set(runKey, {
      playbookId: result.playbookId,
      title,
      projectId: project.id,
      status: result.status,
      summary: result.summary,
      finishedAt: new Date().toISOString()
    });
    if (lastPlaybookResults.size > 40) {
      const oldest = lastPlaybookResults.keys().next().value;
      lastPlaybookResults.delete(oldest);
    }
    // 避免内存无限增长：只保留最近 40 次结果。
    if (playbookRuns.size > 40) {
      const oldest = playbookRuns.keys().next().value;
      playbookRuns.delete(oldest);
    }
    // 一键“复盘并沉淀”：成功结果自动写入项目知识候选；失败不影响分析结果。
    let distill = null;
    if (input?.distill === true && result.status === 'ok') {
      try {
        distill = distillPlaybookRun({
          project,
          playbook,
          runId: result.runId,
          summary: result.summary,
          findings: result.findings,
          risks: result.risks,
          nextSteps: result.nextSteps
        });
      } catch (error) {
        distill = { error: String(error?.message ?? error) };
      }
    }
    // 一键“理解项目”：成功结果保存为项目画像（带 commit 基线）。
    let brief = null;
    if (input?.brief === true && result.status === 'ok') {
      try {
        const facts = await repoFactsFor(project, { includeDirty: true });
        const briefModule = await loadProjectBrief();
        const payload = briefModule.buildProjectBrief({ project, result, repoFacts: facts });
        brief = await saveProjectBrief(project, payload, {
          basedOnCommit: facts.head,
          sourceRunId: result.runId
        });
      } catch (error) {
        brief = { error: String(error?.message ?? error) };
      }
    }
    const { text, ...summary } = result;
    return { ...summary, distill, brief };
  });

  // 把 pstack 只读分析的结论沉淀成项目知识候选（pending，不自动验证）。
  ipcMain.handle('companion:playbook-distill', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const playbookId = String(input?.playbookId ?? '');
    const registry = await loadPlaybookRegistry();
    const playbook = registry.getPlaybook(playbookId);
    if (!playbook) throw new Error('未知的 playbook');
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    return distillPlaybookRun({
      project,
      playbook,
      runId: input?.runId,
      summary: input?.summary,
      findings: input?.findings,
      risks: input?.risks,
      nextSteps: input?.nextSteps
    });
  });

  ipcMain.handle('companion:playbook-cancel', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const playbookId = String(input?.playbookId ?? '');
    const child = playbookChildren.get(playbookId);
    if (child?.__cancel) {
      child.__cancel();
      return { canceled: true };
    }
    const controller = playbookAborts.get(playbookId);
    if (!controller) return { canceled: false };
    controller.abort();
    return { canceled: true };
  });

  ipcMain.handle('companion:playbook-report', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const runId = String(input?.runId ?? '');
    if (!/^pb_[a-z0-9]{1,40}$/u.test(runId)) throw new Error('Invalid run id');
    const file = path.join(playbookReportDir(), `${runId}.json`);
    if (!fs.existsSync(file)) throw new Error('报告不存在或已被清理。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  });

  ipcMain.handle('companion:playbook-propose', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const playbookId = String(input?.playbookId ?? '');
    const registry = await loadPlaybookRegistry();
    const playbook = registry.getPlaybook(playbookId);
    if (!playbook) throw new Error('未知的 playbook');
    const summary = String(input?.summary ?? '').trim();
    if (!summary) throw new Error('没有可用的诊断结论，无法生成提案。');
    const text = registry.buildProposalText(playbook, summary);
    if (!text) throw new Error('没有可用的诊断结论，无法生成提案。');
    const created = await createPatchJob({
      text,
      projectId: String(input?.projectId ?? ''),
      intent: summary.slice(0, 300),
      title: `写请求 [playbook:${playbookId}]：${summary.slice(0, 110)}`,
      analysisSummary: summary
    });
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === created.projectId);
    return { ...created, testConfig: project ? await testConfigForProject(project) : null };
  });

  ipcMain.handle('companion:project-brief-local', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const facts = await repoFactsFor(project, { includeDirty: true });
    const mod = await loadProjectBrief();
    const payload = mod.buildLocalProjectBrief({ project, repoFacts: facts });
    return saveProjectBrief(project, payload, { basedOnCommit: facts.head });
  });

  ipcMain.handle('companion:github-pr-preview', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return prPreviewFor(String(input?.cycleId ?? ''));
  });

  ipcMain.handle('companion:github-pr-create', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return prCreateFor({
      cycleId: String(input?.cycleId ?? ''),
      previewHash: String(input?.previewHash ?? ''),
      confirm: input?.confirm === true
    });
  });

  ipcMain.handle('companion:github-activity', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const projectId = String(input?.projectId ?? '');
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === projectId)
      ?? projects.find((item) => item.id === config.projectId)
      ?? null;
    if (!project) return { linked: false, repo: null, issues: [], prs: [], issueCount: 0, prCount: 0, error: '' };
    return githubActivityFor(project.root);
  });

  // 只允许打开 GitHub 仓库链接，避免渲染进程打开任意网址。
  ipcMain.handle('companion:open-external', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const url = String(input?.url ?? '');
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/(?:issues|pull)\/\d+)?\/?$/u.test(url)) {
      throw new Error('只允许打开 GitHub 仓库链接。');
    }
    await shell.openExternal(url);
    return { opened: true };
  });

  ipcMain.handle('companion:mascots:list', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return mascotCatalog();
  });

  ipcMain.handle('companion:mascots:set', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const mod = await loadMascots();
    const skin = String(input?.skin ?? '');
    if (!mod.isValidMascotSelection({ ...mascotDirs(), skin })) throw new Error('未知的宠物皮肤');
    config.mascotSkin = skin;
    saveConfig();
    return mascotCatalog();
  });

  ipcMain.handle('companion:mascots:import', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const mod = await loadMascots();
    const result = await dialog.showOpenDialog(panel ?? pet, {
      title: '导入 Codex 宠物（选择 pet.json 或所在文件夹）',
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Codex Pet manifest', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const imported = mod.importMascot({
      sourcePath: result.filePaths[0],
      userDir: mascotDirs().userDir
    });
    config.mascotSkin = imported.skin;
    saveConfig();
    return { canceled: false, ...imported, catalog: await mascotCatalog() };
  });

  ipcMain.on('companion:open-skin-picker', () => {
    showPanel();
    try { panel?.webContents.send('companion:open-settings'); } catch { /* best effort */ }
  });

  ipcMain.handle('companion:diagnostics', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return diagnosticsSnapshot();
  });

  // Agent 只给建议；采用动作仍由面板里的 Owner 点击触发。
  ipcMain.handle('companion:sandbox-detect', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const { suggestSandboxPlan } = await importEsm('../src/sandbox-detect.mjs');
    const suggestion = await suggestSandboxPlan({
      projectRoot: project.root,
      model: config.model || ''
    });
    return { ...suggestion, projectId: project.id };
  });

  ipcMain.handle('companion:settings:get', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    // 设置页每次打开都重新探测，提供“重新检测”入口。
    serviceCache = { at: 0, value: null };
    return { ...config, services: await serviceStatus() };
  });

  ipcMain.handle('companion:settings:set', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const previousModel = config.model;
    if (typeof input?.allowedPaths === 'string') config.allowedPaths = input.allowedPaths.trim() || 'src/';
    if (Array.isArray(input?.includePaths)) {
      config.includePaths = input.includePaths.map((item) => String(item).trim()).filter(Boolean);
    } else if (typeof input?.includePaths === 'string') {
      config.includePaths = input.includePaths.split(',').map((item) => item.trim()).filter(Boolean);
    }
    if (typeof input?.gatewayUrl === 'string') config.gatewayUrl = input.gatewayUrl.trim();
    if (typeof input?.model === 'string') config.model = input.model.trim();
    if (typeof input?.diagramModel === 'string') config.diagramModel = input.diagramModel.trim();
    if (typeof input?.projectId === 'string') config.projectId = input.projectId;
    if (typeof input?.sandboxMode === 'string') {
      const mod = sandboxPlanModule ?? await importEsm('../src/sandbox-plan.mjs');
      config.sandboxMode = mod.normalizeSandboxMode(input.sandboxMode, config.sandboxMode ?? 'auto');
    }
    if (input?.sandboxProjectMode && typeof input.sandboxProjectMode === 'object') {
      const mod = sandboxPlanModule ?? await importEsm('../src/sandbox-plan.mjs');
      const projectId = String(input.sandboxProjectMode.projectId ?? '');
      const mode = String(input.sandboxProjectMode.mode ?? '');
      if (projectId) {
        config.sandboxByProject = { ...(config.sandboxByProject ?? {}) };
        if (!mode || mode === 'auto') delete config.sandboxByProject[projectId];
        else config.sandboxByProject[projectId] = mod.normalizeSandboxMode(mode, 'auto');
      }
    }
    if (input?.sandboxProjectDir && typeof input.sandboxProjectDir === 'object') {
      const projectId = String(input.sandboxProjectDir.projectId ?? '');
      const dir = String(input.sandboxProjectDir.dir ?? '').replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+$/u, '');
      if (projectId) {
        config.sandboxProjectDirByProject = { ...(config.sandboxProjectDirByProject ?? {}) };
        if (!dir) delete config.sandboxProjectDirByProject[projectId];
        else config.sandboxProjectDirByProject[projectId] = dir.slice(0, 120);
      }
    }
    if (typeof input?.knowledgeAutoHarvest === 'boolean') {
      config.knowledgeAutoHarvest = input.knowledgeAutoHarvest;
      knowledgeRuntime?.setAutoHarvest(input.knowledgeAutoHarvest, { model: config.model });
    } else if (knowledgeRuntime && config.knowledgeAutoHarvest) {
      knowledgeRuntime.setAutoHarvest(true, { model: config.model });
    }
    saveConfig();
    serviceCache = { at: 0, value: null };
    const modelChanged = config.model !== previousModel;
    if (modelChanged) { playbookRunner = null; triageRunner = null; }
    let modelApplied = true;
    let modelPending = false;
    if (modelChanged && worker) {
      if (worker.running) {
        // 不打断当前任务；空闲时由 workerTimer 应用。
        pendingModel = config.model;
        modelApplied = false;
        modelPending = true;
      } else {
        modelApplied = applyWorkerModel(config.model);
        if (modelApplied) pendingModel = null;
      }
    }
    return { ...config, services: await serviceStatus(), modelChanged, modelApplied, modelPending };
  });

  ipcMain.handle('companion:add-project', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!store) throw new Error('本地 Owner Runtime 尚未就绪，请稍后重试。');
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    // 同一个目录重复添加时直接复用已有项目，避免 UNIQUE 冲突。
    let project = store.getProjectByRoot(root);
    if (!project) {
      const name = path.basename(root) || 'project';
      const baseId = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40)
        || 'project';
      const id = store.getProject(baseId)
        ? `${baseId.slice(0, 32)}-${Date.now().toString(36).slice(-5)}`
        : baseId;
      project = store.registerProject({
        id,
        name,
        root,
        primaryDomain: 'software-engineering'
      });
    }
    config.projectId = project.id;
    saveConfig();
    return project;
  });

  ipcMain.handle('companion:open-full', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    await openFull();
  });

  ipcMain.on('companion:show-panel', (event) => { if (fromCompanion(event)) showPanel(); });
  ipcMain.on('companion:hide-panel', (event) => { if (fromCompanion(event)) hidePanel(); });
  ipcMain.on('companion:hide-pet', (event) => { if (fromCompanion(event)) pet?.hide(); });
  ipcMain.on('companion:show-pet', (event) => {
    if (fromCompanion(event) && pet) { pet.show(); positionPet(); }
  });
  ipcMain.on('companion:quit', (event) => {
    if (fromCompanion(event)) { quitting = true; app.quit(); }
  });
  ipcMain.on('companion:drag-start', (event, input) => {
    if (!fromCompanion(event) || !pet) return;
    const offsetX = Math.max(0, Math.min(PET_SIZE, Number(input?.offsetX ?? PET_SIZE / 2)));
    const offsetY = Math.max(0, Math.min(PET_SIZE, Number(input?.offsetY ?? PET_SIZE / 2)));
    dragState = { offsetX, offsetY };
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!dragState || !pet) return;
      const point = screen.getCursorScreenPoint();
      const { x, y } = clampToWorkArea(
        point.x - dragState.offsetX,
        point.y - dragState.offsetY,
        PET_SIZE,
        PET_SIZE
      );
      pet.setPosition(Math.round(x), Math.round(y));
    }, 16);
  });
  ipcMain.on('companion:drag-end', (event) => {
    if (!fromCompanion(event)) return;
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    dragState = null;
    if (pet) {
      const bounds = pet.getBounds();
      config.pet = { x: bounds.x, y: bounds.y };
      saveConfig();
      if (panel && panel.isVisible()) positionPanel();
    }
  });
};

const registerDisplayHandlers = () => {
  const clampAll = () => {
    if (pet) {
      const bounds = pet.getBounds();
      const { x, y } = clampToWorkArea(bounds.x, bounds.y, PET_SIZE, PET_SIZE);
      pet.setPosition(Math.round(x), Math.round(y));
    }
    if (panel && panel.isVisible()) positionPanel();
  };
  screen.on('display-added', clampAll);
  screen.on('display-removed', clampAll);
  screen.on('display-metrics-changed', clampAll);
};

async function boot() {
  loadConfig();
  registerIpc();
  await startServices();
  createPet();
  createPanel();
  if (!e2eOffscreen) createTray();
  registerDisplayHandlers();

  // 自动化视觉验收：启动后截图并退出。
  if (screenshotDir) {
    setTimeout(async () => {
      try {
        fs.mkdirSync(screenshotDir, { recursive: true });
        showPanel();
        await new Promise((resolve) => setTimeout(resolve, 1800));
        if (pet) {
          const image = await pet.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'pet.png'), image.toPNG());
        }
        if (panel) {
          const image = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel.png'), image.toPNG());
        }
        console.log(`screenshots written to ${screenshotDir}`);
      } catch (error) {
        console.error('screenshot failed:', error);
      }
      setTimeout(() => { quitting = true; app.quit(); }, 600);
    }, 6000);
  }
}

/** 打包后自检：验证 asarUnpack 后的 Monty 原生包与 worker 能否运行。 */
const runSelfTest = async () => {
  const target = selfTestOut || path.join(os.tmpdir(), 'owner-companion-selftest.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-selftest-'));
  let runner = null;
  const payload = {
    test: selfTest,
    ok: false,
    version: COMPANION_VERSION,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    at: new Date().toISOString()
  };
  try {
    if (selfTest !== 'monty') throw new Error(`unknown self-test: ${selfTest}`);
    const { createMontyRunner } = await importEsm('../src/monty-runner.mjs');
    runner = await createMontyRunner({ cwd: dir, mode: 'read-only' });
    const { result } = await runner.run('sum(range(101))');
    payload.result = result;
    payload.ok = result === '5050';
  } catch (error) {
    payload.error = String(error?.message ?? error);
  } finally {
    try { await runner?.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('self-test result write failed:', error.message);
  }
  console.log('SELF_TEST', JSON.stringify(payload));
  return payload;
};

app.whenReady().then(async () => {
  if (selfTest) {
    const result = await runSelfTest();
    app.exit(result.ok ? 0 : 1);
    return;
  }
  await boot();
}).catch((error) => {
  console.error('Owner Companion failed:', error);
  dialog.showErrorBox('Owner Companion 启动失败', String(error?.stack ?? error));
  app.quit();
});

app.on('window-all-closed', () => { /* tray keeps the app alive */ });
app.on('before-quit', () => {
  quitting = true;
  if (dragTimer) clearInterval(dragTimer);
  if (workerTimer) clearInterval(workerTimer);
  if (knowledgeTimer) clearInterval(knowledgeTimer);
  saveConfig();
});
app.on('will-quit', () => {
  // 退出时先结束仍在跑的 playbook 子进程，避免留下孤儿 node 进程继续调用模型。
  for (const child of playbookChildren.values()) {
    try { child.__cancel?.(); } catch { /* best effort */ }
    try { child.kill(); } catch { /* best effort */ }
  }
  playbookChildren.clear();
  try { tray?.destroy(); } catch { /* best effort */ }
  try { if (workbench) void workbench.close(); } catch { /* best effort */ }
  try { if (sidecar) void sidecar.close(); } catch { /* best effort */ }
  try { personalStore?.close(); } catch { /* best effort */ }
  try { store?.close(); } catch { /* best effort */ }
});
