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
let observerWindow = null;
let tray = null;
let store = null;
let personalStore = null;
let broker = null;
let sidecar = null;
let workbench = null;
let mobileServer = null;
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
let knowledgeBrowseModule = null;
let skillCatalogModule = null;
let skillCatalogCache = null;
let knowledgeReviewModule = null;
let lessonRetrievalModule = null;
// #58 / #61：待提炼提议、经验列表、经验提升为候选。三个模块都按需加载。
let onDemandModule = null;
let lessonModule = null;
let promotionModule = null;
// 提炼器只用来「读队列」：它本身不落库、不调模型，构造一次复用即可。
let lessonDistiller = null;
let mascotModule = null;
let githubModule = null;
let githubPrModule = null;
let projectBriefModule = null;
let nextActionModule = null;
let knowledgeTidyModule = null;
let diagramModule = null;
let executionStatusModule = null;
let ideaCaptureModule = null;
// #96 整理要访问外网：验收机用假的抓取器，真实环境才走网络（见 ideaFetchForAcceptance）。
let ideaSortModule = null;
// #86 会话扫描：模块按需加载；扫描是显式动作，不在启动或轮询里调用。
let sessionScanModule = null;
// #87 决策确认：候选确认入库与状态流转；同样按需加载。
let decisionConfirmModule = null;
let decisionRetrievalModule = null;
let chatModule = null;
let chatService = null;
let chatSessionStore = null;
// #89：项目库视图与快照存储。视图复用 src/project-library.mjs，快照落 owner 库的同一连接。
let projectLibraryModule = null;
let snapshotModule = null;
let snapshotStore = null;
// #90：把已发布的快照导出到 <userData>/exports/<projectId>/vN/（只读快照，不重新聚合）。
let exportModule = null;
// #93：删除项目连带清理快照与导出目录；清单（plan）与执行分开，未确认不删。
let projectDeletionModule = null;
// #91：发布后发一条飞书文本卡片，投递结果记在单独的账本表上（快照本身不可变）。
let publishCardModule = null;
let publishCardStore = null;
let feishuConfigModule = null;
// #92：历史版本浏览时的相邻版本 diff（纯函数，只读两份快照内容）。
let versionDiffModule = null;
// #84：水位与「自上次看过」。
// - memoryWatermarks：每项目一个时间点，与 OwnerStore 共用同一条连接（同一份本地库）；
// - observerEventStore：只读观察员事件，独立连接（观察员可以和桌面端同时开着）；
// - 两个模块按需 import，启动时不额外加载。
let memoryWatermarks = null;
let observerEventStore = null;
let sinceLastSeenModule = null;
let observerProbeModule = null;
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
  panelPinned: false,
  // 对话的隐式技能：空数组表示用默认七个；上限 12 由 pi-chat 兜住。
  chatSkills: []
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

// #86 会话扫描的本地状态：已扫过的会话键（重复点击不重复提炼），
// 以及留给下一张票的「库里已有决策的指纹」位（现在是空数组）。
// 只存这一份 JSON，不进知识库——扫描本身不写任何数据，确认入库是下一张票。
// 上限只为防无限增长：一年也到不了 5000 条，真到了丢最旧的会话键也不会重扫出重复候选
// （重复问答还有指纹兜底）。
const sessionScanStatePath = () => path.join(app.getPath('userData'), 'memory-scan.json');
const SESSION_SCAN_STATE_LIMIT = 5000;
const loadSessionScanState = () => {
  try {
    const raw = fs.readFileSync(sessionScanStatePath(), 'utf8').replace(/^\uFEFF/u, '');
    const parsed = JSON.parse(raw);
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter((key) => typeof key === 'string') : [],
      fingerprints: Array.isArray(parsed.fingerprints) ? parsed.fingerprints.filter((key) => typeof key === 'string') : []
    };
  } catch {
    return { sessions: [], fingerprints: [] };
  }
};
const saveSessionScanState = ({ sessions = [], fingerprints = [] } = {}) => {
  try {
    const state = {
      sessions: [...new Set(sessions)].slice(-SESSION_SCAN_STATE_LIMIT),
      fingerprints: [...new Set(fingerprints)].slice(-SESSION_SCAN_STATE_LIMIT)
    };
    fs.mkdirSync(path.dirname(sessionScanStatePath()), { recursive: true });
    fs.writeFileSync(sessionScanStatePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    logError('session-scan-state', error);
  }
};

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

/**
 * 视觉验收用的假抓取：验收机不该为了截图去访问外网。
 * 只由 OWNER_COMPANION_FAKE_SORT=1 打开，页面按地址预置；守卫、限时、限大小、四段整理
 * 全走真路径，换掉的只是最外面这一层 fetch —— 与 OWNER_COMPANION_FAKE_SOURCE 同一思路。
 */
const ideaFetchForAcceptance = async () => {
  if (process.env.OWNER_COMPANION_FAKE_SORT !== '1') return { fetch: null, resolve: null };
  const mod = (ideaSortModule ??= await importEsm('../src/idea-sort.mjs'));
  const fake = mod.fakeIdeaFetch();
  return { fetch: fake.fetch, resolve: fake.resolve };
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
  // 对话会话持久化：复用同一条连接，只新增会话/消息两张表。
  try {
    const { ChatSessionStore } = await importEsm('../src/chat-sessions.mjs');
    chatSessionStore = new ChatSessionStore({ db: store.db });
  } catch (error) {
    console.error('chat session store unavailable:', error.message);
    chatSessionStore = null;
  }
  // #89：项目库快照。表建在 owner 库上，复用同一条连接；不可用只影响库的发布，
  // 不阻塞其余功能，所以失败只记日志、退回「没有草稿/版本」的空快照状态。
  try {
    snapshotModule = await importEsm('../src/project-snapshots.mjs');
    snapshotStore = new snapshotModule.ProjectSnapshotStore({ db: store.db });
  } catch (error) {
    console.error('project snapshot store unavailable:', error.message);
    snapshotModule = null;
    snapshotStore = null;
  }
  // #90：导出模块。纯渲染 + 落盘，不依赖 Electron；失败只让导出入入口报错，
  // 已发布快照与库本身不受影响。
  try {
    exportModule = await importEsm('../src/project-exports.mjs');
  } catch (error) {
    console.error('project export module unavailable:', error.message);
    exportModule = null;
  }
  // #91：发布卡片。投递账本复用同一条连接；模块不可用时只影响「发卡片」这个动作，
  // 发布 / 导出照旧，面板会显示卡片未发送。
  try {
    publishCardModule = await importEsm('../src/project-publish-card.mjs');
    publishCardStore = new publishCardModule.PublishCardStore({ db: store.db });
  } catch (error) {
    console.error('publish card module unavailable:', error.message);
    publishCardModule = null;
    publishCardStore = null;
  }
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
    // 旧的自动采集/自动提炼链随 ADR-0007 / #62 一起删除：不再有常驻 tick，也不再有
    // 「后台自己写经验」的入口。提炼改为人在知识模式里按需触发（LessonDistiller /
    // distillOnDemand），这里只保留读取用的提炼器实例（见 knowledgeDistiller）。
    console.log('knowledge store ready: manual distillation only (ADR-0007)');
  }

  // #84 水位：新表建在同一个 owner.sqlite 里（老库打开时只多一张空表）。
  // 复用 OwnerStore 的连接，避免第二条写连接与它抢锁。
  try {
    const { MemoryWatermarkStore } = await importEsm('../src/memory/watermark.mjs');
    memoryWatermarks = new MemoryWatermarkStore({ db: store.db });
  } catch (error) {
    console.error('watermark store unavailable:', error.message);
    memoryWatermarks = null;
  }
  // #84 观察员事件：观察员写的是审计库，桌面端只读同一份。
  // 路径优先级沿用 db-path.mjs（OWNER_OBSERVER_DB → OWNER_AGENT_DB → userData/owner.sqlite），
  // 所以命令行观察员与桌面端在默认布局和 e2e 的临时库下都指向同一个文件。
  try {
    const { ObserverStore } = await importEsm('../src/observer/store.mjs');
    const { resolveObserverDbPath } = await importEsm('../src/observer/db-path.mjs');
    observerEventStore = new ObserverStore(resolveObserverDbPath({ fallback: file }));
  } catch (error) {
    console.error('observer event store unavailable:', error.message);
    observerEventStore = null;
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
  const ideaFetcher = await ideaFetchForAcceptance();
  sidecar = await startSidecar({
    store,
    brokerFactory: () => broker,
    worker,
    token: readToken,
    approvalToken,
    ideaFetch: ideaFetcher.fetch,
    ideaResolve: ideaFetcher.resolve,
    personalStore,
    imageDigest: resolveDigest(),
    sandboxRoot: path.join(app.getPath('userData'), 'sandbox'),
    port: 0,
    version: COMPANION_VERSION
  });
  baseUrl = `http://127.0.0.1:${sidecar.port}`;

  // 手机桥：局域网 + 设备令牌；只开放概览、聊天（只读）与想法管理。
  try {
    const { startMobileServer } = await importEsm('../src/mobile-server.mjs');
    const preferredPort = Number(process.env.OWNER_MOBILE_PORT) || undefined;
    let attemptPort = preferredPort ?? 47831;
    for (let attempt = 0; attempt < 5 && !mobileServer; attempt += 1) {
      try {
        mobileServer = await startMobileServer({
          store,
          stateDir: app.getPath('userData'),
          version: COMPANION_VERSION,
          port: attemptPort,
          getOverview: mobileOverviewFor,
          submitChat: ({ projectId, text }) => submitCompanionTask({ text, projectId })
        });
      } catch (error) {
        if (preferredPort || attempt === 4) throw error;
        attemptPort += 1;
      }
    }
  } catch (error) {
    logError('mobile-server', error);
  }

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
    workbench = await createWorkbenchServer({
      port: 0,
      personalDbPath: knowledgeDbPath(),
      ownerDbPath: file
    });
    const address = await workbench.listen();
    workbenchUrl = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    console.error('workbench unavailable:', error.message);
  }
}

const api = async (route, { method = 'GET', body, decision = false, timeoutMs = 8000 } = {}) => {
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
    signal: AbortSignal.timeout(timeoutMs)
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

const createSandbox = async (proposalId, project = null) => {
  // 沙箱计划要按补丁所属项目算；只有调用方没给时才退回配置/第一个项目。
  let target = project;
  if (!target) {
    const projects = (await api('/owner/v1/projects')).items ?? [];
    target = projects.find((item) => item.id === config.projectId) ?? projects[0] ?? null;
  }
  const plan = await testConfigForProject(target);
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
    return { available: false, counts: {}, recentLessons: [], candidates: [], auto: {} };
  }
  knowledgeSummaryModule = knowledgeSummaryModule ?? await importEsm('../src/knowledge/summary.mjs');
  const summary = knowledgeSummaryModule.knowledgeSummaryFor({ personalStore, projectId });
  return {
    available: true,
    ...summary,
    // 自动采集/自动提炼链已删除（ADR-0007 / #62）：没有后台 tick，也就没有「最近一次」可报。
    auto: {
      retired: true
    }
  };
};

// #58：读取「待提炼队列」用的提炼器。它不联网、不调模型——只做执行记录投影与经验表反推；
// 真正提炼要显式注入 extractor（distillOnDemand），本条 IPC 只提示，不触发提炼。
const knowledgeDistiller = async () => {
  if (!store || !personalStore) return null;
  if (lessonDistiller) return lessonDistiller;
  lessonModule = lessonModule ?? await importEsm('../src/knowledge-loop/lesson.mjs');
  lessonDistiller = new lessonModule.LessonDistiller({
    ownerStore: store,
    personalStore,
    model: config.model || ''
  });
  return lessonDistiller;
};

/** 经验列表的对外形状：面板只读它需要的字段，不把整条 payload 递过去。 */
const lessonListItem = (lesson) => ({
  id: lesson.id,
  phenomenon: lesson.phenomenon ?? '',
  mechanism: lesson.mechanism ?? '',
  countermeasure: lesson.countermeasure ?? '',
  scopeLayer: lesson.scope?.layer === 'domain' ? 'domain' : 'project',
  projectId: lesson.scope?.projectId ?? lesson.projectId ?? null,
  verificationStatus: lesson.verificationStatus ?? 'inferred',
  reproduced: lesson.reproduced === true,
  supportProjects: Number(lesson.supportProjects ?? 1) || 1,
  evidenceCount: Array.isArray(lesson.evidence) ? lesson.evidence.length : (lesson.evidenceRefs?.length ?? 0),
  createdAt: lesson.createdAt ?? null
});

// ---- 技能目录（只读） ----
// 域包、pstack、插件三处技能合并成一份列表；扫描结果缓存一分钟，
// 面板重复渲染不重复读盘，只有点「刷新」才强制重扫。
const skillCatalogPayload = async ({ refresh = false } = {}) => {
  skillCatalogModule ??= await importEsm('../src/knowledge/skills.mjs');
  if (!skillCatalogCache) {
    // pstack 目录解析与 Playbook 共用同一套规则，避免两处对「技能在哪」给出不同答案。
    const registry = await loadPlaybookRegistry();
    const { resolvePstackSkillsDir } = await importEsm('../src/pstack/readonly-session.mjs');
    skillCatalogCache = skillCatalogModule.createSkillCatalogCache({
      scan: () => skillCatalogModule.skillCatalogFor({
        domainRoot: path.join(__dirname, '..', 'domains'),
        pluginsDir: path.join(__dirname, '..', 'plugins'),
        pstackSkillsDir: resolvePstackSkillsDir(),
        mattSkillsDir: process.env.MATT_SKILLS_DIR
          || path.join(os.homedir(), '.owner-agent', 'skills', 'matt'),
        pstackSkillIds: registry.PLAYBOOKS.map((item) => ({
          id: item.id,
          playbookLabel: item.label,
          // 图谱 playbook 由面板按钮直接生成，磁盘上没有 SKILL.md 是设计如此。
          noSkillDir: Boolean(item.diagramKind)
        }))
      })
    });
  }
  return skillCatalogCache.read({ refresh: Boolean(refresh) }).then(async (view) => {
    // 顺带把「哪些技能用于对话」带出去：面板要据此勾选，默认七个由 pi-chat 定义。
    const chatMod = await importEsm('../src/pi-chat.mjs');
    const picked = Array.isArray(config.chatSkills) && config.chatSkills.length
      ? config.chatSkills
      : chatMod.DEFAULT_SKILL_IDS;
    return { ...view, implicitSkillIds: [...picked] };
  });
};

const knowledgeAsk = ({ kind, projectId = '', domain = '', query = '' } = {}) => {
  if (!personalStore) return { answer: '知识库尚未建立；完成任务并提炼执行记录后会出现在这里。', items: [], basis: [] };
  const units = personalStore.list({ limit: 2000 });
  // 决策有自己的状态列（#87）：已结束的决策不再算现状，检索默认不返回，
  // 也不再与「待验证 / 已验证」的知识混在一句里。
  const currentUnit = (row) => row.kind !== 'decision' || row.decisionStatus === 'active';
  const decisions = units.filter((row) => row.kind === 'decision');
  // 旧 experience/v1 已退役（#62）：问答只读三层沉淀的 lesson/v1。
  const allLessons = personalStore.listLessons({ limit: 1000 });
  // 跨项目合并后的经验只挂在最早项目下，第二个项目靠来源台账反查。
  const inProject = (row) => !projectId || row.projectId === projectId
    || (row.supportedByProjects ?? []).includes(projectId);
  const lessons = kind === 'project' ? allLessons.filter(inProject) : allLessons;
  const item = (type, row, extra = {}) => ({
    type, id: row.id,
    title: type === 'lesson' ? row.phenomenon : row.title,
    // 决策读自己的状态列，不拿验证状态冒充（#87）。
    status: type === 'lesson'
      ? (row.verificationStatus ?? 'inferred')
      : (row.kind === 'decision' ? (row.decisionStatus ?? 'active') : row.verificationStatus),
    layer: type === 'lesson' ? (row.scope?.layer ?? row.layer ?? null) : (row.layer ?? null),
    revision: row.revision ?? null,
    projectId: row.projectId ?? row.project_id ?? null,
    ...extra
  });
  if (kind === 'today') {
    const recent = lessons.filter((row) => Date.now() - Date.parse(row.lastMergedAt ?? row.createdAt) < 24 * 60 * 60 * 1000);
    const fresh = units.filter((row) => Date.now() - Date.parse(row.updatedAt) < 24 * 60 * 60 * 1000);
    return {
      answer: recent.length || fresh.length
        ? `最近 24 小时沉淀了 ${recent.length} 条经验，知识库更新 ${fresh.length} 条。`
        : '最近 24 小时没有新的经验或知识更新。',
      items: [...recent.map((row) => item('lesson', row)), ...fresh.map((row) => item('knowledge', row))],
      basis: [...recent.map((row) => `lesson:${row.id}`), ...fresh.map((row) => `knowledge:${row.id}`)]
    };
  }
  if (kind === 'similar') {
    const latest = lessons[0]?.phenomenon;
    const q = query || latest || '';
    const matched = personalStore.list({ q, limit: 10 }).filter(currentUnit);
    const found = lessons.filter((row) =>
      `${row.phenomenon} ${row.mechanism} ${row.countermeasure}`.toLowerCase().includes(q.toLowerCase())
    ).slice(0, 10);
    return {
      answer: q
        ? `${query ? '' : `以最近经验“${latest}”为检索词；`}找到 ${matched.length} 条知识、${found.length} 条相似经验。`
        : '还没有可用于相似检索的历史经验。',
      items: [...matched.map((row) => item('knowledge', row)), ...found.map((row) => item('lesson', row))],
      basis: [...matched.map((row) => `knowledge:${row.id}`), ...found.map((row) => `lesson:${row.id}`)]
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
  // 决策状态与验证状态分开：已结束的决策不进「相关知识」，但要在回答里说明还有几条旧决策。
  const projectKnowledge = units.filter((row) =>
    (row.scope === 'project'
      ? row.projectId === projectId
      : Boolean(domain) && row.domains.includes(domain)) && currentUnit(row)
  );
  const endedDecisions = decisions.filter((row) => row.decisionStatus !== 'active'
    && row.scope === 'project' && row.projectId === projectId).length;
  const projectLessons = lessons.filter(inProject);
  return {
    answer: `${projectId || '当前项目'}：${projectLessons.length} 条经验，${projectKnowledge.length} 条相关知识`
      + (endedDecisions ? `；另有 ${endedDecisions} 条决策已被取代或已放弃，不再算现状。` : '。'),
    items: [...projectLessons.slice(0, 10).map((row) => item('lesson', row)),
      ...projectKnowledge.slice(0, 10).map((row) => item('knowledge', row))],
    basis: [...projectLessons.map((row) => `lesson:${row.id}`),
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
  // 旧 experience/v1 已退役（#62）：详情只认知识、经验（lesson）与候选。
  const lesson = personalStore.getLesson(id);
  if (lesson) return { kind: 'lesson', item: lesson, evidence: lesson.evidence ?? [] };
  const proposal = personalStore.proposal(id);
  if (proposal) return { kind: 'candidate', item: proposal };
  throw new Error('未找到该知识、经验或候选');
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
  // 执行状态只有一份判定（src/execution-status.mjs）：跨项目「还在场内」的列表也从这里出。
  const loadExecutionStatus = async () => (executionStatusModule ??= await importEsm('../src/execution-status.mjs'));
  const loadKnowledgeTidy = async () => (knowledgeTidyModule ??= await importEsm('../src/knowledge/tidy.mjs'));
  const loadDiagrams = async () => (diagramModule ??= await importEsm('../src/project-diagrams.mjs'));
  const projectHeadCache = new Map();
  const triageDigestCache = new Map();
  /**
   * 交办/讨论用的本地摘要：大仓库里让模型自己 grep 往往 2 分钟都跑不完。
   * 60 秒内复用同一项目的扫描结果，避免每条消息都重新读几百个文件。
   */
  const digestForTriage = async (root) => {
    if (!root) return { text: '', scanned: 0 };
    const cached = triageDigestCache.get(root);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const mod = await loadDiagrams();
    const digest = await mod.buildProjectDigest(root, 'project');
    const value = { text: digest.text, scanned: digest.scanned ?? 0 };
    triageDigestCache.set(root, { at: Date.now(), value });
    return value;
  };
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

  // ---- #89 项目库：视图复用 project-library，快照走 project-snapshots ----

  const loadProjectLibrary = async () =>
    (projectLibraryModule ??= await importEsm('../src/project-library.mjs'));

  // #92：版本 diff 是纯函数；按需加载，和库视图一样不在启动时增加加载项。
  const loadVersionDiff = async () =>
    (versionDiffModule ??= await importEsm('../src/project-version-diff.mjs'));
  /** #93 删除项目：按需加载，删除是显式动作，不在启动或轮询里调用。 */
  const loadProjectDeletion = async () =>
    (projectDeletionModule ??= await importEsm('../src/project-deletion.mjs'));

  /** 项目图谱：与 buildView 同一口径（stale 按当前 HEAD 判断），给库的图谱摘要复用。 */
  const diagramsForProject = async (project) => {
    if (!project?.id) return [];
    const head = await headForProject(project.root ?? '');
    const items = (await api(`/owner/v1/projects/${encodeURIComponent(project.id)}/diagrams`)
      .catch(() => ({ items: [] }))).items ?? [];
    return items.map((diagram) => ({
      ...diagram,
      stale: Boolean(diagram.basedOnCommit && head && diagram.basedOnCommit !== head)
    }));
  };

  /** 按项目 id 取 owner 项目行；没给 id 时退回第一个项目（与 buildView 的口径一致）。 */
  const projectRowFor = async (projectId) => {
    const items = (await api('/owner/v1/projects')).items ?? [];
    const wanted = String(projectId ?? '');
    return (wanted ? items.find((item) => item.id === wanted) : items[0]) ?? null;
  };

  /**
   * #90 导出根：<用户配置根>/exports/。userData 就是 %APPDATA%\owner-agent-mvp（打包版）
   * 或 --user-data-dir 指定的临时目录（e2e），所以路径按「项目 / 版本」可预测，
   * 便携版与测试实例也各自落在自己的根下，不会写进真实用户目录之外的地方。
   */
  const exportsRoot = () => path.join(app.getPath('userData'), 'exports');

  /** 面板要显示的最新版本导出路径：目录是确定的，是否存在单独判断，不靠缓存。 */
  const exportInfoFor = (projectId, versions, wantedVersion = 0) => {
    if (!exportModule || !projectId) return null;
    const latest = versions?.find((item) => item.version === wantedVersion) ?? versions?.[0];
    if (!latest) return null;
    const files = exportModule.exportFilesOf({
      root: exportsRoot(), projectId, version: latest.version
    });
    return {
      version: latest.version,
      label: `v${latest.version}`,
      root: exportsRoot(),
      dir: files.dir,
      snapshotPath: files.snapshotPath,
      reportPath: files.reportPath,
      // 两个文件都在才算这一版导出完整；缺一个就当没导出，让「导出」按钮可用。
      exists: fs.existsSync(files.snapshotPath) && fs.existsSync(files.reportPath)
    };
  };

  /**
   * #91 飞书 webhook：沿用观察员的同一份配置（env → ~/.owner-agent/feishu.json），
   * 不新开第二条通道，也不在界面上另存一份凭据。
   */
  const loadFeishuWebhook = async () => {
    try {
      feishuConfigModule ??= await importEsm('../src/observer/config.mjs');
      return feishuConfigModule.resolveFeishuWebhook().webhook;
    } catch (error) {
      console.error('feishu config unavailable:', error?.message ?? error);
      return '';
    }
  };

  /**
   * #91 发布卡片：只发一条文本，结果记在投递账本上。
   * 发布此时已经成功，卡片发不出去不能反过来影响快照与导出：这里不抛异常，只返回状态；
   * 也不会自动重发，重试只能由人点「重新发送」调 companion:library-resend。
   */
  const sendPublishCard = async ({ project, version, exportDir = '', exportError = '' }) => {
    if (!publishCardModule || !publishCardStore || !snapshotStore) {
      return { status: 'unsent', detail: '卡片模块尚未就绪，请重启后再试。', delivery: null };
    }
    const raw = snapshotStore.getVersionRaw(project.id, version);
    if (!raw) return { status: 'unsent', detail: '找不到这一版快照。', delivery: null };
    try {
      return await publishCardModule.deliverPublishCard({
        deliveries: publishCardStore,
        projectId: project.id,
        version,
        contentText: raw.contentText,
        exportDir,
        exportError,
        publishedAt: raw.publishedAt,
        webhookUrl: await loadFeishuWebhook()
      });
    } catch (error) {
      console.error('publish card failed:', error?.message ?? error);
      return { status: 'unsent', detail: `卡片处理失败：${error?.message ?? error}`, delivery: null };
    }
  };

  /**
   * 项目库视图 + 草稿/版本摘要。库是视图（ADR-0009）：每次按当前知识重新聚合，
   * 只有「生成草稿 / 发布」才把它固化成快照，所以这里不写库。
   * limit 只影响面板一屏显示多少条，计数仍按全量；生成快照时用大 limit 取全量。
   */
  const libraryForProject = async (project, { profile = null, diagrams = null, limit = 5, full = false } = {}) => {
    if (!project?.id) return null;
    const mod = await loadProjectLibrary();
    let lessons = [];
    let knowledge = [];
    if (personalStore) {
      try { lessons = personalStore.listLessonsForProject(project.id, { limit: 200 }); } catch { lessons = []; }
      try { knowledge = personalStore.list({ limit: 1000 }); } catch { knowledge = []; }
    }
    const profileView = profile ?? await projectBriefFor(project);
    const diagramView = diagrams ?? await diagramsForProject(project);
    const view = mod.projectLibraryView({
      project, lessons, knowledge, profile: profileView, diagrams: diagramView, limit
    });
    const draft = snapshotStore?.getDraftState(project.id) ?? null;
    const versions = snapshotStore?.listVersions(project.id) ?? [];
    // 只把「最新一版」的投递结果给面板：旧版本的发送状态不该冒充当前这版。
    const latestDelivery = publishCardStore?.getLatest(project.id) ?? null;
    const delivery = latestDelivery && latestDelivery.version === versions[0]?.version
      ? latestDelivery
      : null;
    const payload = {
      ...view,
      // 快照模块不可用时退回空摘要：库仍能看，只是不能生成/发布（按钮由 hasDraft 置灰）。
      snapshot: snapshotModule
        ? snapshotModule.snapshotStateOf({ draft, versions })
        : { hasDraft: false, draft: null, versions: [], latestVersion: 0, nextVersion: 1, nextLabel: 'v1' },
      // 导出只读快照：面板拿到的路径就是 publish / export 写出的同一个目录。
      export: exportInfoFor(project.id, versions),
      // #91 飞书卡片：最新一版的投递结果（成功 / 未发送 + 原因），重启后仍能读到；
      // 没有版本或还没有投递记录时给 null，面板据此决定是否显示「重新发送」。
      delivery
    };
    // 面板每 2 秒轮询一次快照，groups 是全量条目，只给生成快照用，不随渲染下发。
    if (!full) delete payload.groups;
    return payload;
  };


  // 手机端概览：只暴露「看清项目 + 想法 + 知识摘要」，不含审批与写入。
  const mobileOverviewFor = async ({ projectId = '' } = {}) => {
    const projects = store.listProjects().map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root
    }));
    const known = new Set(projects.map((project) => project.id));
    const activeId = known.has(projectId)
      ? projectId
      : (known.has(config.projectId) ? config.projectId : (projects[0]?.id ?? ''));
    const project = activeId ? store.getProject(activeId) : null;
    const brief = project ? await projectBriefFor(project) : null;
    const knowledge = activeId ? await knowledgeSnapshot(activeId) : null;
    const ideas = activeId
      ? store.listProjectQueue(activeId, 'idea').map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        status: item.status,
        source: item.source,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }))
      : [];
    const tasksTodo = activeId
      ? store.listProjectQueue(activeId, 'task').filter((item) => item.status === 'todo').length
      : 0;
    const { nextActionFor } = await loadNextAction();
    const nextAction = activeId
      ? nextActionFor({
        pending: 0,
        playbookRunning: false,
        brief,
        briefStale: brief?.stale === true,
        queueTodo: tasksTodo,
        knowledge: knowledge?.counts ?? {},
        result: null,
        state: 'idle',
        cycleId: ''
      })
      : null;
    const diagrams = activeId
      ? store.listProjectDiagrams(activeId).map((diagram) => ({
        kind: diagram.kind,
        title: diagram.title,
        version: diagram.version,
        confidence: diagram.confidence,
        source: diagram.source,
        updatedAt: diagram.updatedAt
      }))
      : [];
    return {
      version: COMPANION_VERSION,
      generatedAt: new Date().toISOString(),
      projects,
      activeProjectId: activeId,
      project: project ? {
        id: project.id,
        name: project.name,
        root: project.root,
        domain: project.primary_domain ?? project.primaryDomain ?? ''
      } : null,
      brief: brief ? {
        oneLiner: brief.oneLiner ?? '',
        whatItIs: brief.whatItIs ?? '',
        howToRun: brief.howToRun ?? [],
        modules: brief.modules ?? [],
        verify: brief.verify ?? { commands: [], criteria: [] },
        risks: brief.risks ?? [],
        evidence: brief.evidence ?? [],
        version: brief.version,
        generatedAt: brief.generatedAt,
        basedOnCommit: brief.basedOnCommit ?? '',
        stale: brief.stale === true
      } : null,
      nextAction: nextAction ?? null,
      knowledge: knowledge?.counts ?? {},
      ideas,
      diagrams
    };
  };

  const gitAt = async (cwd, args, timeout = 15000) => {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout,
      windowsHide: true
    });
    return stdout.trim();
  };

  // ---- #84 自上次看过 ----
  //
  // 取数只用现有来源，不重写一套 git 事实：
  // - 提交清单与未提交文件清单走 src/observer/probe.mjs（与探针同一套只读 git 调用）；
  //   probeProject 只给 HEAD / lastCommitAt / uncommittedFiles 计数，回答不了「哪几条提交、
  //   哪些文件」，所以那里补了 readCommitList / readWorkingTreeChanges 两个只读取数。
  // - 观察员事件走审计库的 ObserverStore.listEvents（同一份库，只读）。
  // - 比较与推进全部在 src/memory/since-last-seen.mjs：先算差异、再推水位。
  const loadObserverProbe = async () => (observerProbeModule ??= await importEsm('../src/observer/probe.mjs'));
  const loadSinceLastSeen = async () => (sinceLastSeenModule ??= await importEsm('../src/memory/since-last-seen.mjs'));

  // 登记时写进项目根的身份标记与夹具目录不是「项目变了」；与 repoFactsFor 的过滤口径一致。
  const isNoisePath = (file) =>
    file === '.owner-root-identity' || String(file).startsWith('.fixture-workspaces/');

  /** 读观察员事件；库或表读不到返回 null，变化窗口会据此标「未知」而不是「没有发生」。 */
  const observerEventsFor = (projectId) => {
    if (!observerEventStore) return null;
    try {
      return observerEventStore.listEvents({ projectId, limit: 50 });
    } catch (error) {
      logError('observer.events', error);
      return null;
    }
  };

  /**
   * 进入项目时调用：先算「自上次看过」的差异，算完才推进水位（顺序在
   * computeSinceLastSeen 里固定）。面板的 2 秒轮询不调用它，只刷新已算好的结果，
   * 否则每 2 秒推进一次，差异会被自己吃掉。
   * @param {string} projectId
   * @returns {Promise<object>} changeWindowView 的视图模型（带 checkedAt / previousAt）
   */
  const sinceLastSeenFor = async (projectId) => {
    const id = String(projectId ?? '').trim();
    if (!id) throw new Error('缺少项目 id');
    const items = (await api('/owner/v1/projects')).items ?? [];
    const project = findProjectById(items, id);
    if (!project) throw new Error(`项目不存在：${id}`);
    if (!memoryWatermarks) throw new Error('水位存储不可用：本地数据库打不开，请重启客户端。');
    const probe = await loadObserverProbe();
    // 读不到（不是仓库 / git 失败）就给 null：这一类会被标成 unknown，不会缩成「没有变化」。
    let commits = null;
    let dirty = null;
    if (project.root) {
      commits = probe.readCommitList({ root: project.root, limit: 50 });
      const working = probe.readWorkingTreeChanges({ root: project.root });
      dirty = working === null ? null : working.filter((item) => !isNoisePath(item.path));
    }
    const module = await loadSinceLastSeen();
    const { view } = module.computeSinceLastSeen({
      projectId: id,
      store: memoryWatermarks,
      commits,
      dirty,
      events: observerEventsFor(id)
    });
    return view;
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


const buildView = async (requestedProjectId = '') => {
  const projects = await api('/owner/v1/projects');
  const projectList = projects.items ?? [];
  // 没有全局「当前项目」：调用方指定了就按它取数，没指定就只看第一个项目。
  // 这里不读 config.projectId，选择也不会写回配置，所以重启后总是回到默认的第一个。
  const wanted = String(requestedProjectId || '');
  const activeProjectId = wanted && projectList.some((item) => item.id === wanted)
    ? wanted
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
  // 跨项目的「还在场内」执行：view.chain 只装当前项目、每类最多一条
  // （activeJob ?? jobsInProject[0]），回答不了「别的项目是不是还活着」。
  // 这里从同一批 limit=20 的四张表摊平，终态与审批态由 execution-status.mjs 滤掉；
  // 已知限制：超出最近 20 条的旧执行不会出现，只影响很忙的大项目。
  const { listInFlightExecutions, isInFlight } = await loadExecutionStatus();
  const executions = listInFlightExecutions({
    jobs: allJobs,
    patches: allPatches,
    sandboxes: allSandboxes,
    repairs: allRepairs
  }, { projectNames });
  // 任务链只关联当前选中的项目，避免把不同项目的 Job/Patch/Run/Cycle 拼成假进度。
  const inProject = (item) => projectIdOf(item) === activeProjectId;
  const jobsInProject = allJobs.filter(inProject);
  const patchesInProject = allPatches.filter(inProject);
  const sandboxesInProject = allSandboxes.filter(inProject);
  const repairsInProject = allRepairs.filter(inProject);
  // 「进行中」不再抄一份状态数组：能直接读 execution-status.mjs 就 import，
  // 与操作区、执行记录用同一套终态 / 审批态判定（见 src/execution-status.mjs）。
  const activeJob = jobsInProject.find((job) => isInFlight('job', job.status));
  const activeCycle = repairsInProject.find((cycle) => isInFlight('cycle', cycle.status));
  const activeSandbox = sandboxesInProject.find((run) => isInFlight('sandbox', run.status));
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
  // #95 灵感收件箱是全局的（条目在整理前不属于任何项目）：不跟着 activeProjectId 取数，
  // 没有项目时也要能看能记。取不到就按「读不出来」显示，不要拿空收件箱冒充。
  const ideasView = (await api('/owner/v1/ideas').catch(() => null))?.view ?? null;
  // 图谱的「有过更新」判断已经收进 diagramsForProject，这里不再自己取一次提交。
  const diagramView = await diagramsForProject(activeProject);
  const briefView = await projectBriefFor(activeProject);
  // #89：项目库是视图，不落库；草稿/版本摘要只读快照表。随快照一起给面板，
  // 面板不再自己聚合（聚合规则只保留 src/project-library.mjs 一份）。
  const libraryView = await libraryForProject(activeProject, { profile: briefView, diagrams: diagramView });
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
    queueTodo: queueView.filter((item) => item.status === 'todo' && item.kind === 'task').length,
    knowledge: knowledgeView?.counts ?? {},
    result: resultView,
    state,
    cycleId: finalCycle?.id ?? ''
  });
  return {
    version: COMPANION_VERSION,
    state,
    pending,
    // 跨项目非终态执行（操作区「运行中」块的唯一数据源）；终态与审批态已在主进程滤掉。
    executions,
    stage,
    activity,
    timeline,
    // 专注卡片的四个入口只显示计数；这里给按项目过滤后的条数
    // （受上面 limit=20 的取数窗口限制，超出部分不计入）。
    counts: {
      jobs: jobsInProject.length,
      patches: patchesInProject.length,
      tests: sandboxesInProject.length,
      cycles: repairsInProject.length
    },
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
    ideas: ideasView,
    diagrams: diagramView,
    knowledge: knowledgeView,
    // #89：项目库那一段（两节 + 计数 + 草稿/版本状态）；没有项目时为 null。
    library: libraryView,
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

/**
 * 打开 Web 观察台：复用主进程里已启动的 workbench server（只 loadURL），
 * 不新建服务、不占用新端口；窗口关掉后可从托盘再次打开。
 */
const openObserver = async () => {
  if (!workbenchUrl) throw new Error('本地 Workbench 尚未启动，观察台不可用');
  if (observerWindow && !observerWindow.isDestroyed()) {
    observerWindow.show();
    observerWindow.focus();
    return;
  }
  observerWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'Owner Companion · 观察台',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false
    }
  });
  observerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  watchWindow(observerWindow, 'observer');
  // 直连 workbench 的 /observer 路由，保证与浏览器直开的页面同源同内容。
  observerWindow.loadURL(`${workbenchUrl}/observer`);
  observerWindow.on('closed', () => { observerWindow = null; });
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
      {
        label: '观察台',
        click: () => {
          void openObserver().catch((error) => { logError('observer.open', error); showPanel(); });
        }
      },
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

/**
 * 视觉验收用的假分诊：验收环境没有真实模型，交办会停在「只读分析失败」。
 * 只由 OWNER_COMPANION_FAKE_TRIAGE=1 打开，固定回一条「需要写入」的结论，
 * 让后面的 pending_approval 写请求与待办展示可稳定复现；审批链路本身完全不变。
 */
const fakeTriageRunner = () => ({
  async run({ task }) {
    const intent = String(task ?? '').trim().slice(0, 120);
    return {
      runId: 'tr_fake_handoff',
      status: 'ok',
      format: 'json',
      summary: `验收用分诊：这条交办需要改文件（${intent}）`,
      needsWrite: true,
      writePlan: { intent, targets: ['src/retry.js'], allowedPaths: 'src/', notes: '验收假分诊' },
      findings: [],
      questions: [],
      model: 'fake-triage',
      durationMs: 0
    };
  }
});

/** 只读分诊执行器：判断一条交办是否需要写入，再决定是否发起 HITL 写请求。 */
const getTriageRunner = async () => {
  if (triageRunner) return triageRunner;
  if (process.env.OWNER_COMPANION_FAKE_TRIAGE === '1') {
    triageRunner = fakeTriageRunner();
    return triageRunner;
  }
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
  // 交办目标只用于这次任务，不写回 config.projectId（已经取消「当前项目」）。
  return { jobId: job.id, status: job.status, projectId: project.id };
};

/** 兼容旧路径：面板“生成改动提案”也走同一个受控写入链路；必须显式给项目。 */
const createPatchJob = async ({ text, projectId, jobType = 'code-write', ...rest }) => {
  // 写路径必须显式给项目：没给就报错，不保留「没指定就写进第一个项目」的通路。
  const project = await registeredProject(projectId, '生成改动提案要选择一个项目。');
  return createWriteRequest({ project, text, ...rest });
};

/**
 * Composer 交办：先只读分析（不写文件）。
 * - 只需要回答 → 直接返回结论，不创建 Job；
 * - 需要写入 → 创建 code-write 写请求（pending_approval，HITL），批准后才启动写入子 Agent。
 */
/** 对话里的改进意见自动进「想法」池：只存文本，不触发任何执行。 */
const captureIdeaFromMessage = async (text, projectId) => {
  if (!projectId) return null;
  try {
    const mod = (ideaCaptureModule ??= await importEsm('../src/idea-capture.mjs'));
    if (!mod.looksLikeIdea(text)) return null;
    return await api('/owner/v1/queue', {
      method: 'POST',
      body: {
        projectId,
        title: mod.ideaTitle(text),
        body: text,
        kind: 'idea',
        source: 'conversation'
      }
    });
  } catch {
    return null;
  }
};

const submitCompanionTask = async ({ text, projectId }) => {
  // 交办必须显式指定项目：没给就报错，不静默回退到第一个，避免写进错项目。
  const project = await registeredProject(projectId, '先选择要交办的项目。');
  const [{ submitCompanionTask: runSubmit }, triageRunner] = await Promise.all([
    loadCompanionSubmit(),
    getTriageRunner()
  ]);
  // 大仓库先给本地摘要（模型不再自己 grep，几十秒内能答）；小仓库仍走工具探查，失败再退回摘要。
  let digest = '';
  let fallbackDigest = '';
  try {
    const info = await digestForTriage(projectRootOf(project));
    // 只有中等以上仓库才值得再跑一次摘要兜底；小项目本身很快，失败多为模型问题。
    fallbackDigest = info.scanned >= 20 ? info.text : '';
    if (info.scanned > 60) digest = info.text;
  } catch { /* 摘要不可用时退回工具模式 */ }
  const result = await runSubmit({
    text,
    project: {
      id: project.id,
      root: projectRootOf(project),
      domain: project.primary_domain ?? project.primaryDomain ?? '',
      baseSha: project.baseSha ?? project.base_sha ?? ''
    },
    triageRunner,
    createWriteRequest,
    digest,
    fallbackDigest
  });
  if (result.mode === 'write-request') {
    return { ...result, testConfig: await testConfigForProject(project) };
  }
  return result;
};

/**
 * 对话模式的只读 Pi 会话：按需创建，进程内按项目连续追问。
 * 这里不做任何写操作；模型未配置时由服务返回明确的 no-model 提示。
 */
const getChatService = async () => {
  if (chatService) return chatService;
  chatModule ??= await importEsm('../src/pi-chat.mjs');
  // 隐式技能来自 companion.json；空数组表示「用默认七个」，上限由 pi-chat 再兜一层。
  chatService = new chatModule.PiChatService({
    model: config.model || '',
    implicitSkillIds: Array.isArray(config.chatSkills) && config.chatSkills.length
      ? config.chatSkills
      : null
  });
  return chatService;
};

/** 会话存储不可用时明确报错，不返回一个空列表假装「没有历史」。 */
const requireChatSessions = () => {
  if (!chatSessionStore) throw new Error('会话存储不可用：本地数据库打不开，请重启客户端。');
  return chatSessionStore;
};

/** 按 id 找已登记项目；找不到返回 null。主进程与渲染进程各留一份（不强行共用浏览器模块）。 */
const findProjectById = (projects, projectId) => {
  const id = String(projectId ?? '').trim();
  if (!id) return null;
  return (Array.isArray(projects) ? projects : []).find((item) => item?.id === id) ?? null;
};

/** 新建会话/交办只接受已登记项目，不做「找不到就退回第一个」的静默兜底。 */
const registeredProject = async (projectId, missingMessage = '新建会话要选择一个项目。') => {
  const id = String(projectId ?? '').trim();
  if (!id) throw new Error(missingMessage);
  const items = (await api('/owner/v1/projects')).items ?? [];
  const project = findProjectById(items, id);
  if (!project) throw new Error(`项目不存在：${id}`);
  return project;
};

const registerIpc = () => {
  const fromCompanion = (event) =>
    [pet?.webContents, panel?.webContents].filter(Boolean).includes(event.sender);

  ipcMain.handle('companion:snapshot', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const view = await buildView(input?.projectId);
    notifyIfNeeded(view);
    return view;
  });

  // #84：进入项目时算一次「自上次看过」，返回前把水位推到当前。
  // 这个通道有副作用（写水位），所以只在「进入项目」时调用；快照轮询不碰它。
  ipcMain.handle('companion:since-last-seen', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return sinceLastSeenFor(String(input?.projectId ?? ''));
  });

  ipcMain.handle('companion:submit', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const text = String(input?.text ?? '');
    const projectId = String(input?.projectId ?? '');
    // 自动采集：讨论中提到的改进意见进「想法」池（只收集，不执行）。
    const captured = input?.captureIdea === false ? null : await captureIdeaFromMessage(text, projectId);
    const result = await submitCompanionTask({ text, projectId });
    return captured ? { ...result, capturedIdea: captured } : result;
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

  // 对话会话：新建时必须绑定已登记项目，列表按项目分组由渲染层完成。
  ipcMain.handle('companion:chat-sessions', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return { items: requireChatSessions().listSessions({ projectId: String(input?.projectId ?? '') }) };
  });

  ipcMain.handle('companion:chat-session-get', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return requireChatSessions().getSession(String(input?.id ?? ''));
  });

  ipcMain.handle('companion:chat-session-create', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await registeredProject(input?.projectId);
    return requireChatSessions().createSession({
      projectId: project.id,
      title: String(input?.title ?? '')
    });
  });

  ipcMain.handle('companion:chat-session-rename', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return requireChatSessions().renameSession(
      String(input?.id ?? ''),
      String(input?.title ?? '')
    );
  });

  ipcMain.handle('companion:chat-session-delete', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return requireChatSessions().deleteSession(String(input?.id ?? ''));
  });

  ipcMain.handle('companion:chat-session-append', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return requireChatSessions().appendMessage({
      sessionId: String(input?.id ?? ''),
      role: String(input?.role ?? ''),
      text: String(input?.text ?? ''),
      status: input?.status === 'error' ? 'error' : 'ok',
      citations: Array.isArray(input?.citations) ? input.citations : []
    });
  });

  // 对话模式：只读 Pi SDK 会话（read/grep/find/ls），不能写文件。
  // 会话消息落本地库：模型失败也保留问题，重启后能接着看。
  ipcMain.handle('companion:chat-ask', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const service = await getChatService();
    const question = String(input?.question ?? '');
    const sessionId = String(input?.sessionId ?? '').trim();
    const session = sessionId ? requireChatSessions().getSession(sessionId) : null;
    // 项目只认「会话绑定」或「本次显式传入」；找不到就让服务返回 no-project，不回退第一个。
    const wantedId = String(session?.projectId || input?.projectId || '').trim();
    const items = wantedId ? ((await api('/owner/v1/projects')).items ?? []) : [];
    const project = findProjectById(items, wantedId);
    // 续聊上下文在写入本次问题之前取，避免把问句重复塞进历史。
    const history = session ? requireChatSessions().historyForPrompt(session.id) : [];
    const text = question.trim();
    const willPersist = Boolean(
      session && text && text.length <= (chatModule?.MAX_QUESTION ?? 1200)
    );
    if (willPersist) {
      requireChatSessions().appendMessage({
        sessionId: session.id,
        role: 'user',
        text
      });
    }
    const result = await service.ask({
      project: project
        ? {
          id: project.id,
          root: projectRootOf(project),
          domain: project.primary_domain ?? project.primaryDomain ?? ''
        }
        : null,
      question,
      model: config.model || '',
      sessionId: session?.id ?? '',
      history
    });
    if (willPersist) {
      requireChatSessions().appendMessage({
        sessionId: session.id,
        role: 'assistant',
        text: String(result?.answer ?? result?.advice ?? '这次没有结论。'),
        status: result?.status === 'ok' ? 'ok' : 'error',
        citations: result?.citations ?? []
      });
    }
    return {
      ...result,
      sessionId: session?.id ?? '',
      sessionTitle: session ? requireChatSessions().getSession(session.id).title : ''
    };
  });

  ipcMain.handle('companion:queue-add', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    // 写路径显式指定项目：缺了就报错，不写进第一个项目。
    const project = await registeredProject(input?.projectId, '记想法要选择一个项目。');
    return api('/owner/v1/queue', {
      method: 'POST',
      body: {
        projectId: project.id,
        title: String(input?.title ?? '').trim(),
        body: String(input?.body ?? ''),
        source: 'owner',
        kind: input?.kind === 'idea' ? 'idea' : 'task'
      }
    });
  });

  // #95 灵感收件箱：捕获只落库（来源由存储层识别），链接只存地址、不抓取。
  // 去重也在存储层：同一段正文 + 同一个来源只会有一条，重复粘贴返回 duplicate=true。
  ipcMain.handle('companion:idea-capture', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return api('/owner/v1/ideas', {
      method: 'POST',
      body: { text: String(input?.text ?? '') }
    });
  });

  // 状态机在存储层：非法流转返回 409，面板把原因告诉用户，而不是把条目硬改过去。
  ipcMain.handle('companion:idea-status', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing idea id');
    return api(`/owner/v1/ideas/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status: String(input?.status ?? '') }
    });
  });

  // #96 整理：有条目链接时抓一次公网正文，写出四段；抓不到就把原因给面板，条目不动。
  // 抓取本身限时 5 秒，加上读正文的余量，这一条的状态超时给到 20 秒。
  ipcMain.handle('companion:idea-sort', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing idea id');
    return api(`/owner/v1/ideas/${encodeURIComponent(id)}/sort`, {
      method: 'POST',
      body: {},
      timeoutMs: 20000
    });
  });

  // #97 提升：to=knowledge 落假设类候选（走既有候选审核），to=task 落目标项目队列。
  // 没选项目时服务端拒绝并把原因回给面板；灵感状态只在成功后才变 adopted。
  ipcMain.handle('companion:idea-promote', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const id = String(input?.id ?? '');
    if (!id) throw new Error('Missing idea id');
    return api(`/owner/v1/ideas/${encodeURIComponent(id)}/promote`, {
      method: 'POST',
      body: {
        to: String(input?.to ?? ''),
        projectId: String(input?.projectId ?? '')
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
    // 先用主模型；失败后回退到设置里的「图谱备用模型」。
    const models = [...new Set([config.model, config.diagramModel]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean))];
    const candidates = models.length ? models : [''];
    // 大仓库（几十万文件）让模型自己 grep 会直接超时：先用本地扫描给一段有界摘录。
    const diagramMod = await loadDiagrams();
    const digest = (await diagramMod.buildProjectDigest(project.root, scope)).text;
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
        '可在设置中填写「图谱备用模型」，主模型失败时会自动切换。'
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
      // 项目取补丁自己的 project_id，不再依赖已取消的「当前项目」配置。
      const projects = (await api('/owner/v1/projects')).items ?? [];
      const patchProjectId = projectIdOf(applied?.proposal ?? {});
      const project = projects.find((item) => item.id === patchProjectId)
        ?? projects.find((item) => item.id === config.projectId)
        ?? projects[0] ?? null;
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
        const run = await createSandbox(id, project);
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
    const proposalId = String(input?.proposalId ?? '');
    // 优先按补丁所属项目取测试计划，避免配置里没有「当前项目」时落到别的项目。
    const patch = proposalId
      ? await api(`/owner/v1/patches/${encodeURIComponent(proposalId)}`).catch(() => null)
      : null;
    const project = await registeredProject(
      projectIdOf(patch ?? {}) || String(input?.projectId ?? ''),
      '创建沙箱要指定一个项目。'
    );
    const testConfig = await testConfigForProject(project);
    if (!testConfig.enabled) {
      throw new Error('当前项目未启用沙箱测试；到设置 → 沙箱测试里调整（自动 / 关闭 / Node）。');
    }
    if (!testConfig.ok) {
      throw new Error(`测试配置缺少 ${testConfig.missing.join(', ')}，无法创建沙箱。`);
    }
    return createSandbox(proposalId, project);
  });

  ipcMain.handle('companion:knowledge-summary', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeSnapshot(String(input?.projectId ?? '') || config.projectId);
  });

  // 整理项目知识：只做重复/需复核/冲突/未验证的只读扫描，不写库。
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

  // 旧的手动提炼（experience/v1 → 候选）已随旧经验表退役（ADR-0007 / #62）：
  // 执行记录 → 经验（lesson）的提炼改由 on-demand.mjs 的 distillOnDemand 承担，
  // 面板不再暴露这个入口，这里也不再保留一条读旧表的 IPC。

  // 知识模式浏览：只读一次本地 SQLite，按项目筛选后由视图模型分组返回。
  ipcMain.handle('companion:knowledge-browse', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    knowledgeBrowseModule = knowledgeBrowseModule ?? await importEsm('../src/knowledge/browse.mjs');
    return knowledgeBrowseModule.knowledgeBrowseFor({
      personalStore,
      projectId: String(input?.projectId ?? '')
    });
  });

  // 技能目录：只读合并域包 / pstack / 插件三处技能，refresh 才重扫。
  ipcMain.handle('companion:skill-catalog', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return skillCatalogPayload({ refresh: input?.refresh === true });
  });

  // 知识模式内的候选审核：直接复用 PersonalKnowledgeStore.reviewProposal，
  // 返回结构化结果，失败时由面板提示原因且不改变当前列表。
  ipcMain.handle('companion:knowledge-review', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    knowledgeReviewModule = knowledgeReviewModule ?? await importEsm('../src/knowledge/review.mjs');
    return knowledgeReviewModule.knowledgeReviewFor({
      personalStore,
      id: String(input?.id ?? ''),
      decision: String(input?.decision ?? ''),
      reviewer: 'local-user'
    });
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

  // 对话取经验：先按当前项目取项目级经验，再补域级经验；只读一次本地 SQLite。
  // 只把取数接到 IPC 上，不改对话的提示词与渲染（那是别的票）。
  ipcMain.handle('companion:lesson-retrieve', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) throw new Error('知识库尚未建立；任务完成后会自动提炼经验。');
    lessonRetrievalModule = lessonRetrievalModule ?? await importEsm('../src/knowledge-loop/retrieval.mjs');
    return lessonRetrievalModule.retrieveLessons({
      personalStore,
      ownerStore: store,
      projectId: String(input?.projectId ?? '') || config.projectId,
      domain: String(input?.domain ?? ''),
      query: String(input?.query ?? ''),
      limit: input?.limit
    });
  });

  ipcMain.handle('companion:knowledge-detail', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeDetail({ id: String(input?.id ?? '') });
  });

  // #58 提议信号：按项目统计「还没提炼成经验的执行记录」，达到阈值才返回。
  // 只读、只提示——这里不会调用任何提炼，也不会写库。
  // #71 操作区跨项目：显式 allProjects 时统计全部项目（空 projectId 会被
  // listDistillProposals 读成「先列项目再逐个查」）；不带这个标记时沿用
  // 「传入项目 → 配置项目」的老口径，知识页的行为不变。
  ipcMain.handle('companion:knowledge-distill-proposals', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const allProjects = input?.allProjects === true;
    const projectId = allProjects ? '' : (String(input?.projectId ?? '') || config.projectId || '');
    const distiller = await knowledgeDistiller();
    if (!distiller) return { projectId, proposals: [], threshold: null };
    onDemandModule = onDemandModule ?? await importEsm('../src/knowledge-loop/on-demand.mjs');
    return {
      projectId,
      threshold: onDemandModule.DISTILL_PROPOSAL_THRESHOLD,
      proposals: onDemandModule.listDistillProposals({ distiller, projectId })
    };
  });

  // #61 经验列表（按项目）：项目级只看本项目，域级只列与项目主域相关的那些。
  ipcMain.handle('companion:lesson-list', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) return { projectId: String(input?.projectId ?? ''), lessons: [] };
    const projectId = String(input?.projectId ?? '') || config.projectId || '';
    const limit = input?.limit === undefined ? 100 : Number(input.limit);
    const lessons = projectId
      ? personalStore.listLessonsForProject(projectId, { limit })
      : personalStore.listLessons({ limit });
    return { projectId, lessons: lessons.map(lessonListItem) };
  });

  // #61 一键提交：把一条经验提为待审候选。已有待审/已接受时幂等返回，不重复造候选。
  ipcMain.handle('companion:lesson-promote', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) throw new Error('知识库未初始化，暂时不能把经验提为候选。');
    promotionModule = promotionModule ?? await importEsm('../src/knowledge-loop/promotion.mjs');
    const result = promotionModule.promoteLessonToCandidate({
      personalStore,
      lessonId: String(input?.lessonId ?? ''),
      actor: 'local-user'
    });
    return {
      ok: true,
      created: result.created,
      reason: result.reason ?? null,
      lessonId: result.lesson?.id ?? null,
      proposalId: result.proposal?.id ?? null
    };
  });

  ipcMain.handle('companion:knowledge-open', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    await openKnowledgeWorkbench();
  });

  // #86 会话扫描：读本机 Codex / Claude Code 的会话，按工作目录匹配项目后产决策候选。
  // 只读：不写知识库、不调模型、不联网；已扫过的会话键与候选指纹落在 memory-scan.json，
  // 所以再点一次不会把同一段会话重新提炼一遍。
  ipcMain.handle('companion:session-scan', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    sessionScanModule = sessionScanModule ?? await importEsm('../src/memory/session-scan.mjs');
    const projects = (store?.listProjects() ?? []).map((project) => ({
      id: project.id,
      name: project.name ?? '',
      root: project.root ?? ''
    }));
    const state = loadSessionScanState();
    // 已确认入库的决策指纹从库里读（#87）：同一句话已经被确认过，就不该再作为候选出现。
    const confirmed = (() => {
      try { return personalStore?.decisionFingerprints?.() ?? []; } catch { return []; }
    })();
    const result = await sessionScanModule.scanSessions({
      roots: sessionScanModule.sessionRootsFrom({ home: os.homedir(), env: process.env }),
      projects,
      seenSessions: state.sessions,
      fingerprints: [...state.fingerprints, ...confirmed]
    });
    saveSessionScanState({
      sessions: [...state.sessions, ...result.scannedKeys],
      // 只记「哪些会话扫过」，不把未确认候选的指纹写进去：本轮提过的候选还没入库，
      // 占住指纹会让它以后再也没机会被提出来。跨轮的同内容去重靠会话键；
      // 已确认入库的指纹由知识库提供（上面那一步），不落进这份 JSON。
      fingerprints: state.fingerprints
    });
    return result;
  });

  // #87 决策确认：候选只在人点「确认」时入库；可选补一句理由，缺理由单独标记。
  // 未确认的候选不经过这里，因此不会写任何数据。
  ipcMain.handle('companion:decision-confirm', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) return { ok: false, reason: '知识库尚未初始化，暂时不能确认决策。' };
    decisionConfirmModule = decisionConfirmModule ?? await importEsm('../src/memory/decision-confirm.mjs');
    return decisionConfirmModule.confirmDecisionCandidate({
      personalStore,
      candidate: input?.candidate && typeof input.candidate === 'object' ? input.candidate : {},
      reason: String(input?.reason ?? ''),
      actor: 'local-user'
    });
  });

  // #87 决策状态：只改 decision_status 一列（生效中 → 已被取代 / 已放弃），验证状态不动。
  ipcMain.handle('companion:decision-status', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) return { ok: false, reason: '知识库尚未初始化，暂时不能改决策状态。' };
    decisionConfirmModule = decisionConfirmModule ?? await importEsm('../src/memory/decision-confirm.mjs');
    return decisionConfirmModule.changeDecisionStatus({
      personalStore,
      id: String(input?.id ?? ''),
      status: String(input?.status ?? ''),
      note: String(input?.note ?? ''),
      actor: 'local-user'
    });
  });

  // #87 决策检索：默认只给生效中的决策；已被取代 / 已放弃的单独列出，不算现状。
  ipcMain.handle('companion:decision-retrieve', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!personalStore) return { items: [], ended: [], counts: { current: 0, ended: 0, matched: 0 }, reason: null };
    decisionRetrievalModule = decisionRetrievalModule ?? await importEsm('../src/memory/decision-status.mjs');
    const units = personalStore.list({ limit: 2000 });
    return decisionRetrievalModule.decisionRetrievalView({
      units,
      projectId: String(input?.projectId ?? '') || config.projectId || '',
      query: String(input?.query ?? ''),
      limit: input?.limit
    });
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

  // #89 项目库：生成草稿（覆盖上一份）与发布（分配 v1..vN，发布后不可改）。
  // 两个都是显式动作：只读快照不会生成草稿，改知识也不会自动发布。
  ipcMain.handle('companion:library-draft', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('还没有项目，先添加一个项目目录。');
    if (!snapshotStore || !snapshotModule) throw new Error('快照存储尚未就绪，请重启后再试。');
    // 快照用 groups 取全量，limit 只影响随后的面板渲染；这里仍走一次全量视图。
    const library = await libraryForProject(project, { full: true });
    const note = String(input?.note ?? '');
    const content = snapshotModule.snapshotContentOf(library, { note });
    snapshotStore.saveDraft({ projectId: project.id, content });
    return libraryForProject(project);
  });

  ipcMain.handle('companion:library-publish', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('还没有项目，先添加一个项目目录。');
    if (!snapshotStore) throw new Error('快照存储尚未就绪，请重启后再试。');
    const published = snapshotStore.publish({
      projectId: project.id,
      note: String(input?.note ?? '')
    });
    // #90：发布 = 生成快照 + 导出到固定目录。导出失败不回滚已发布版本（快照不可变、
    // 版本号不能回收），把原因交给面板，由人点「导出」重试；下次导出仍是同一份字节。
    let exported = null;
    let exportError = '';
    if (exportModule) {
      try {
        exported = exportModule.exportPublishedVersion({
          store: snapshotStore,
          root: exportsRoot(),
          projectId: project.id,
          version: published.version
        });
      } catch (error) {
        exportError = String(error?.message ?? error);
        console.error('project export failed:', exportError);
      }
    } else {
      exportError = '导出模块尚未就绪，请重启后再试。';
    }
    // #91：导出确定之后再发卡片（卡片里有导出路径）；发送失败不回滚发布，
    // 状态记成「未发送」由人点「重新发送」。
    const delivery = await sendPublishCard({
      project,
      version: published.version,
      exportDir: exported?.dir ?? '',
      exportError: exported ? '' : exportError
    });
    const library = await libraryForProject(project);
    return {
      ...library,
      published: {
        version: published.version,
        label: `v${published.version}`,
        publishedAt: published.publishedAt,
        export: exported,
        exportError,
        delivery
      }
    };
  });

  // #92 历史版本浏览：只读打开某一版，并给出与上一版的自动 diff。
  // 这个入口只读：不生成草稿、不写任何表，打开历史版本不会改动已发布数据。
  ipcMain.handle('companion:library-version', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!snapshotStore) throw new Error('快照存储尚未就绪，请重启后再试。');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('还没有项目，先添加一个项目目录。');
    const version = Number(input?.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('版本号无效。');
    const current = snapshotStore.getVersion(project.id, version);
    if (!current) throw new Error(`没有找到 v${version}。`);
    // 相邻两版：v1 没有上一版，明说「首版」；版本号大于 1 却读不到上一版是异常，
    // 与首版区分开，不把缺失说成「没有变化」。
    const previous = version > 1 ? snapshotStore.getVersion(project.id, version - 1) : null;
    const diffModule = await loadVersionDiff();
    const diff = diffModule.versionDiffOf(previous?.content ?? null, current.content, {
      previousLabel: previous ? `v${previous.version}` : (version > 1 ? `v${version - 1}` : ''),
      previousMissing: version > 1 && !previous
    });
    return {
      version: current.version,
      label: `v${current.version}`,
      publishedAt: current.publishedAt,
      note: current.note,
      counts: current.counts,
      content: current.content,
      diff
    };
  });

  // #90 导出：把某个已发布版本写进固定目录。默认最新一版；重复导出是幂等的。
  ipcMain.handle('companion:library-export', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!snapshotStore || !exportModule) throw new Error('快照存储尚未就绪，请重启后再试。');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('还没有项目，先添加一个项目目录。');
    const versions = snapshotStore.listVersions(project.id);
    const wanted = Number(input?.version);
    const version = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : versions[0]?.version;
    if (!version) throw new Error('还没有已发布的版本，先发布一次再导出。');
    const exported = exportModule.exportPublishedVersion({
      store: snapshotStore, root: exportsRoot(), projectId: project.id, version
    });
    const library = await libraryForProject(project);
    return { ...library, exported };
  });

  // #91「重新发送」：只有人点才会调用——没有自动重试、没有定时发送。
  // 重发只走投递，不新建版本、也不改快照；导出已存在就把路径再写进卡片。
  ipcMain.handle('companion:library-resend', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!snapshotStore || !publishCardModule) throw new Error('卡片模块尚未就绪，请重启后再试。');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('还没有项目，先添加一个项目目录。');
    const versions = snapshotStore.listVersions(project.id);
    const wanted = Number(input?.version);
    const version = Number.isSafeInteger(wanted) && wanted > 0 ? wanted : versions[0]?.version;
    if (!version) throw new Error('还没有已发布的版本，先发布一次。');
    const info = exportInfoFor(project.id, versions, version);
    const delivery = await sendPublishCard({
      project,
      version,
      exportDir: info?.exists ? info.dir : '',
      exportError: info?.exists ? '' : '还没有导出'
    });
    const library = await libraryForProject(project);
    return { ...library, resent: delivery };
  });

  // #90「打开目录」：只允许打开导出根之内的路径，路径不存在就明确报错。
  ipcMain.handle('companion:library-export-open', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const root = path.resolve(exportsRoot());
    const target = path.resolve(String(input?.path ?? ''));
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('只能打开导出目录里的路径。');
    }
    if (!fs.existsSync(target)) throw new Error('导出目录不存在；先发布或导出一次。');
    const failure = await shell.openPath(target);
    if (failure) throw new Error(`打开目录失败：${failure}`);
    return { opened: target };
  });

  // #93 删除项目：plan 只读、run 必须显式确认。
  ipcMain.handle('companion:project-delete-plan', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const mod = await loadProjectDeletion();
    if (!snapshotStore) throw new Error('快照存储尚未就绪，请重启后再试。');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('项目不存在或已被删除。');
    // 只读：列清单不删任何东西，面板据此渲染二次确认。
    return mod.projectDeletionPlan({
      project,
      versions: snapshotStore.listVersions(project.id, { limit: 200 }),
      draft: snapshotStore.getDraftState(project.id),
      root: exportsRoot()
    });
  });

  ipcMain.handle('companion:project-delete', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const mod = await loadProjectDeletion();
    // 未确认时直接拒绝：面板必须先展示 plan，再带 confirm=true 回来。
    if (input?.confirm !== true) throw new Error('删除项目需要二次确认。');
    if (!snapshotStore) throw new Error('快照存储尚未就绪，请重启后再试。');
    const project = await projectRowFor(String(input?.projectId ?? '') || config.projectId);
    if (!project) throw new Error('项目不存在或已被删除。');
    return mod.deleteProject({
      store,
      snapshotStore,
      projectId: project.id,
      root: exportsRoot(),
      confirm: true
    });
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

  ipcMain.handle('companion:mobile-info', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!mobileServer) return { enabled: false, reason: '手机桥未启动' };
    const pairing = mobileServer.pairingCode();
    return {
      enabled: true,
      port: mobileServer.port,
      urls: mobileServer.urls,
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      devices: mobileServer.devices()
    };
  });

  ipcMain.handle('companion:mobile-refresh', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    if (!mobileServer) throw new Error('手机桥未启动');
    const pairing = mobileServer.refreshCode();
    return {
      enabled: true,
      port: mobileServer.port,
      urls: mobileServer.urls,
      code: pairing.code,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
      devices: mobileServer.devices()
    };
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
    // 对话隐式技能：最多 12 个；改完立刻重建服务，下一条消息就用新配置。
    if (Array.isArray(input?.chatSkills)) {
      const unique = [...new Set(input.chatSkills.map((item) => String(item ?? '').trim()).filter(Boolean))];
      if (unique.length > 12) throw new Error('对话技能最多 12 个：再多会把提示词撑爆。');
      config.chatSkills = unique;
      try { chatService?.disposeAll?.(); } catch { /* 释放失败也不影响下次创建 */ }
      chatService = null;
    }
    // 不再接受 projectId：面板的项目选择只存在内存里，不允许通过设置写回配置。
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
      // 旧「自动提炼」设置已随旧链路退役（#62）：接受旧配置里带过来的字段但不做任何事，
      // 免得旧客户端保存设置时报错；保存后这个键也不再写回。
      delete config.knowledgeAutoHarvest;
    }
    saveConfig();
    serviceCache = { at: 0, value: null };
    const modelChanged = config.model !== previousModel;
    if (modelChanged) {
      playbookRunner = null;
      triageRunner = null;
      // 对话会话绑定模型：换模型后旧会话立即释放，下一问重建。
      chatService?.setModel(config.model || '');
    }
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
    // 新项目只是登记进库；不再把它写成「当前项目」，选择由面板显式做出。
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
          // 三种模式各截一张：直接点顶部的模式按钮，避免 reload 的竞态。
          for (const mode of ['focus', 'knowledge', 'chat']) {
            await panel.webContents.executeJavaScript(
              `document.querySelector('#modeBar button[data-mode="${mode}"]')?.click();`
            );
            await new Promise((resolve) => setTimeout(resolve, 900));
            const image = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, `panel-${mode}.png`), image.toPNG());
            // 知识审核验收：先保留接受前的 B 模式，再点第一条候选的「接受」补一张。
            if (mode === 'knowledge') {
              const reviewProbe = await panel.webContents.executeJavaScript(`(async () => {
                const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                let button = null;
                for (let i = 0; i < 30 && !button; i += 1) {
                  button = document.querySelector('#kbGroups .kb-candidates .kb-act.accept');
                  if (!button) await wait(100);
                }
                if (!button) return { reviewed: false, reason: 'no-candidate' };
                const countOf = (key) => {
                  const node = document.querySelector('#kbGroups .kb-' + key + ' .kb-group-count');
                  return node ? node.textContent : '';
                };
                const before = countOf('candidates');
                button.click();
                for (let i = 0; i < 40; i += 1) {
                  await wait(100);
                  if (countOf('candidates') !== before) break;
                }
                return {
                  reviewed: true,
                  before,
                  candidates: countOf('candidates'),
                  pending: countOf('pending'),
                  toast: document.getElementById('toast')?.textContent ?? ''
                };
              })()`);
              fs.writeFileSync(
                path.join(screenshotDir, 'knowledge-review-probe.json'),
                JSON.stringify(reviewProbe, null, 2)
              );
              const afterImage = await panel.webContents.capturePage();
              fs.writeFileSync(
                path.join(screenshotDir, 'panel-B-after-review.png'),
                afterImage.toPNG()
              );
            }
          }
          // #41 专注：取消全局「当前项目」。
          // 第一次启动：没选项目时发送被拦；显式选项目后按钮显示项目名，概览/任务链切到该项目。
          // 用同一个 --user-data-dir 再启动一次：选择不落盘，回到「未选 + 默认第一个」。
          const focusMarker = path.join(app.getPath('userData'), 'focus-selection-run.txt');
          const focusRestarted = fs.existsSync(focusMarker);
          if (!focusRestarted) fs.writeFileSync(focusMarker, new Date().toISOString(), 'utf8');
          const focusIdle = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            document.querySelector('#modeBar button[data-mode="focus"]')?.click();
            await wait(700);
            const chip = document.getElementById('handoffTarget');
            const name = document.getElementById('handoffTargetName');
            const input = document.getElementById('taskInput');
            const before = {
              projectId: chip?.dataset.projectId ?? '',
              label: name?.textContent?.trim() ?? '',
              needsPick: chip?.classList.contains('needs-pick') === true
            };
            input.value = '把首页文案改得更直接一点';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('submitTask')?.click();
            await wait(500);
            const toast = document.getElementById('toast');
            // Toast 会自动消失，必须在 await 之前读快照，否则截到的是已隐藏状态。
            const toastText = toast?.textContent ?? '';
            const toastVisible = !(toast?.hidden ?? true);
            const draftKept = input.value;
            // #73 之后选项目只剩工作区顶部一处：视图项目只从切换标签读。
            const detailTab = document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
            // toast 位置验收：不能压住模式栏，也不能压住底部输入区。
            const rectOf = (node) => {
              if (!node) return null;
              const rect = node.getBoundingClientRect();
              return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
            };
            const toastRect = rectOf(toast);
            const navRect = rectOf(document.getElementById('modeBar'));
            const composerRect = rectOf(document.getElementById('composeSection'));
            const view = await window.companion.snapshot();
            const settings = await window.companion.settings.get();
            return {
              hasProjects: (view?.projects?.length ?? 0) > 0,
              hasGlobalProjectSelect: Boolean(document.querySelector('#composeSection select#projectSelect')),
              before,
              blockedToast: toastText,
              blockedToastVisible: toastVisible,
              draftKept,
              viewProjectFromDom: detailTab,
              toastRect,
              navRect,
              composerRect,
              toastOverlapsNav: Boolean(toastRect && navRect && toastRect.top < navRect.bottom),
              toastOverlapsComposer: Boolean(toastRect && composerRect && toastRect.bottom > composerRect.top),
              settingsProjectId: settings?.projectId ?? null
            };
          })()`);
          fs.writeFileSync(
            path.join(screenshotDir, 'focus-selection-probe.json'),
            JSON.stringify(focusIdle, null, 2)
          );
          // 再点一次发送并立刻截图，把「未选项目被拦」的提示留在画面上。
          await panel.webContents.executeJavaScript(
            "document.getElementById('submitTask')?.click();"
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          let focusImage = await panel.webContents.capturePage();
          fs.writeFileSync(
            path.join(screenshotDir, focusRestarted ? 'panel-A-restart.png' : 'panel-A-no-project.png'),
            focusImage.toPNG()
          );
          // toast 三档位置验收：同一次显示内依次切模式截图（toast 2.6 秒后自动消失）。
          fs.writeFileSync(path.join(screenshotDir, 'toast-A.png'), focusImage.toPNG());
          for (const mode of ['knowledge', 'chat']) {
            await panel.webContents.executeJavaScript(
              `document.querySelector('#modeBar button[data-mode="${mode}"]')?.click();`
            );
            await new Promise((resolve) => setTimeout(resolve, 200));
            const toastImage = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, `toast-${mode}.png`), toastImage.toPNG());
          }
          // 回到专注：后面的项目选择与截图都在专注页。
          await panel.webContents.executeJavaScript(
            `document.querySelector('#modeBar button[data-mode="focus"]')?.click();`
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (focusIdle.hasProjects) {
            const focusPicked = await panel.webContents.executeJavaScript(`(async () => {
              const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
              const chip = document.getElementById('handoffTarget');
              const name = document.getElementById('handoffTargetName');
              const beforeView = (await window.companion.snapshot())?.config?.projectId ?? '';
              chip?.click();
              await wait(300);
              const options = [...document.querySelectorAll('#handoffTargetMenu .composer-project-option')];
              const target = options.find((item) => item.dataset.project !== beforeView) ?? options[0];
              target?.click();
              // 选中后等界面真正换到该项目（快照要走一遍服务探测），最多等 6 秒。
              let viewProject = '';
              for (let i = 0; i < 40; i += 1) {
                viewProject = document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
                if (viewProject && viewProject === target?.dataset.project) break;
                await wait(150);
              }
              await wait(400);
              const picked = (await window.companion.snapshot())?.projects ?? [];
              // 视图项目从界面读：快照不传项目时主进程只会默认第一个，不代表渲染层的选择。
              const detailTab = document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
              const snapOf = async (projectId) => {
                if (!projectId) return null;
                const snap = await window.companion.snapshot({ projectId });
                return {
                  project: snap?.config?.projectId ?? '',
                  stage: snap?.stage ?? '',
                  chainJob: snap?.chain?.job?.title ?? '',
                  chainPatch: snap?.chain?.patch?.id ?? '',
                  counts: snap?.counts ?? {},
                  nextAction: snap?.nextAction?.label ?? ''
                };
              };
              const settings = await window.companion.settings.get();
              // 截图前把工作区滚到眼前（详情卡已在 #72 删除），并清掉自动生成图谱的报错提示。
              document.getElementById('workZone')?.scrollIntoView({ block: 'start' });
              await wait(400);
              document.getElementById('toast').hidden = true;
              return {
                options: options.map((item) => item.dataset.project),
                viewProject,
                detailTab,
                chip: { projectId: chip?.dataset.projectId ?? '', label: name?.textContent?.trim() ?? '' },
                projectIds: picked.map((item) => item.id),
                byProject: [await snapOf(picked[0]?.id ?? ''), await snapOf(picked[1]?.id ?? '')],
                settingsProjectId: settings?.projectId ?? null
              };
            })()`);
            fs.writeFileSync(
              path.join(screenshotDir, 'focus-selection-picked.json'),
              JSON.stringify(focusPicked, null, 2)
            );
            focusImage = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, 'panel-A-picked.png'), focusImage.toPNG());
          }
          // 技能目录验收：列表（含插件组）、展开详情、缺失条目详情（#44）。
          await panel.webContents.executeJavaScript(`
            document.querySelector('#modeBar button[data-mode="knowledge"]')?.click();
            document.getElementById('skillCatalog')?.scrollIntoView({ block: 'start' });
          `);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const skillShots = [
            ['panel-B-skills.png', '#skillCatalog', ''],
            ['panel-B-skills-plugin.png', '#skillGroups > section:last-child', ''],
            ['panel-B-skill-detail.png', '#skillGroups .skill-item', '#skillGroups .skill-item'],
            ['panel-B-skill-missing.png', '#skillGroups .skill-item.is-missing', '#skillGroups .skill-item.is-missing']
          ];
          for (const [file, scrollTo, expand] of skillShots) {
            const ready = await panel.webContents.executeJavaScript(`
              (() => {
                const expandSelector = '${expand}';
                const row = expandSelector ? document.querySelector(expandSelector) : null;
                if (row) row.open = true;
                const target = document.querySelector('${scrollTo}');
                target?.scrollIntoView({ block: '${expand ? 'center' : 'start'}' });
                return Boolean(target);
              })()
            `);
            if (!ready) continue;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const image = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, file), image.toPNG());
          }
          // 技能目录的接线探针：三处来源计数、缓存复用与强制刷新各走一次 IPC。
          const skillsProbe = await panel.webContents.executeJavaScript(`
            (async () => {
              const first = await window.companion.skills.catalog({});
              const second = await window.companion.skills.catalog({});
              const forced = await window.companion.skills.catalog({ refresh: true });
              return {
                totals: first.totals,
                sources: (first.groups ?? []).map((group) => ({
                  key: group.key, label: group.label, count: group.count, missing: group.missing
                })),
                sample: (first.groups ?? []).map((group) => (group.items?.[0] ? {
                  source: group.key, name: group.items[0].name, path: group.items[0].path,
                  missing: group.items[0].missing, reason: group.items[0].reason
                } : null)),
                playbookOnly: (first.groups ?? []).flatMap((group) => group.items ?? [])
                  .filter((item) => item.playbookOnly)
                  .map((item) => ({ id: item.id, name: item.name, missing: item.missing, source: item.source })),
                cachedFlags: [first.cached, second.cached, forced.cached]
              };
            })()
          `);
          fs.writeFileSync(path.join(screenshotDir, 'skills-probe.json'), JSON.stringify(skillsProbe, null, 2));
          // 对话模式：没有模型时必须给出明确提示（不能静默失败）。
          // 这里直接走一遍 IPC，顺带验证 preload 暴露的 chat.ask 接线。
          const chatProbe = await panel.webContents.executeJavaScript(
            `window.companion.chat.ask({ question: '这个项目是什么？', projectId: '' })
               .then((r) => ({
                 status: r?.status ?? null,
                 category: r?.category ?? null,
                 advice: String(r?.advice ?? '').slice(0, 160)
               }))
               .catch((e) => ({ error: String(e) }))`
          );
          fs.writeFileSync(
            path.join(screenshotDir, 'chat-probe.json'),
            JSON.stringify(chatProbe, null, 2)
          );
          // 多会话验收：首次运行新建两个会话（分别绑定两个项目）、提一个问题并让问题落库；
          // 第二次运行同一个 user-data-dir 时，同一段脚本只读回会话与历史，证明重启后仍在。
          const chatSessionProbe = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const list = async () => (await window.companion.chat.sessions.list()).items ?? [];
              const before = await list();
              const view = await window.companion.snapshot();
              const projects = view?.projects ?? [];
              if (!before.length && projects.length) {
                await window.companion.chat.sessions.create({ projectId: projects[0].id });
                await window.companion.chat.sessions.create({
                  projectId: (projects[1] ?? projects[0]).id,
                  title: '重启后还在的会话'
                });
                document.querySelector('#modeBar button[data-mode="focus"]')?.click();
                await wait(400);
                document.querySelector('#modeBar button[data-mode="chat"]')?.click();
                await wait(900);
                const fresh = (await list()).find((s) => s.title === '新会话') ?? (await list())[0];
                document.querySelector('[data-session-id="' + fresh.id + '"] .c-session-open')?.click();
                await wait(500);
                const input = document.querySelector('#cInput');
                input.value = '这个项目为什么会卡住？';
                document.querySelector('#cSend')?.click();
                await wait(2200);
                const listNode = document.querySelector('#cSessionList');
                if (listNode) listNode.hidden = false;
                document.querySelector('#cSessionsToggle')?.setAttribute('aria-expanded', 'true');
                await wait(400);
                return {
                  hadSessions: false,
                  projects: projects.map((p) => p.id),
                  sessions: await list(),
                  activeId: localStorage.getItem('owner-chat-session')
                };
              }
              document.querySelector('#modeBar button[data-mode="chat"]')?.click();
              await wait(900);
              const sessions = await list();
              const activeId = localStorage.getItem('owner-chat-session');
              const active = sessions.find((s) => s.id === activeId) ?? sessions[0];
              const detail = active ? await window.companion.chat.sessions.get({ id: active.id }) : null;
              const listNode = document.querySelector('#cSessionList');
              if (listNode) listNode.hidden = false;
              document.querySelector('#cSessionsToggle')?.setAttribute('aria-expanded', 'true');
              await wait(400);
              return {
                hadSessions: true,
                projects: projects.map((p) => p.id),
                sessions,
                activeId,
                activeTitle: detail?.title ?? '',
                messages: (detail?.messages ?? []).map((m) => ({
                  role: m.role,
                  status: m.status,
                  text: String(m.text ?? '').slice(0, 120)
                }))
              };
            })()
          `);
          fs.writeFileSync(
            path.join(screenshotDir, 'chat-sessions-probe.json'),
            JSON.stringify(chatSessionProbe, null, 2)
          );
          const sessionShot = chatSessionProbe?.hadSessions
            ? 'panel-C-restored.png'
            : 'panel-C-sessions.png';
          let sessionImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, sessionShot), sessionImage.toPNG());

          // 重命名：只在第一次运行（还没有改过名）时做，随后重开列表截图。
          const renameProbe = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const items = (await window.companion.chat.sessions.list()).items ?? [];
              const target = items.find((s) => s.title === '重启后还在的会话');
              if (!target) return { renamed: false };
              const renamed = await window.companion.chat.sessions.rename({
                id: target.id,
                title: '重启后还在的会话（已改名）'
              });
              document.querySelector('#modeBar button[data-mode="focus"]')?.click();
              await wait(400);
              document.querySelector('#modeBar button[data-mode="chat"]')?.click();
              await wait(900);
              const listNode = document.querySelector('#cSessionList');
              if (listNode) listNode.hidden = false;
              document.querySelector('#cSessionsToggle')?.setAttribute('aria-expanded', 'true');
              await wait(500);
              return { renamed: true, id: renamed.id, title: renamed.title };
            })()
          `);
          fs.writeFileSync(
            path.join(screenshotDir, 'chat-sessions-rename.json'),
            JSON.stringify(renameProbe, null, 2)
          );
          if (renameProbe?.renamed) {
            sessionImage = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, 'panel-C-renamed.png'), sessionImage.toPNG());
            // 切换验收：点开另一个项目的会话，截图后切回有历史的会话，保证重启截图仍能看到历史。
            const activeId = String(chatSessionProbe?.activeId ?? '');
            const switched = await panel.webContents.executeJavaScript(`
              (async () => {
                const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                const row = [...document.querySelectorAll('.c-session-item')]
                  .find((item) => !item.classList.contains('on'));
                row?.querySelector('.c-session-open')?.click();
                await wait(700);
                return {
                  title: document.querySelector('#cSessionTitle')?.textContent ?? '',
                  messages: document.querySelectorAll('#cTranscript .c-msg').length
                };
              })()
            `);
            fs.writeFileSync(
              path.join(screenshotDir, 'chat-sessions-switch.json'),
              JSON.stringify(switched, null, 2)
            );
            sessionImage = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, 'panel-C-switch.png'), sessionImage.toPNG());
            if (activeId) {
              await panel.webContents.executeJavaScript(`
                (async () => {
                  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                  const row = document.querySelector('[data-session-id="${activeId}"]');
                  row?.querySelector('.c-session-open')?.click();
                  await wait(700);
                })()
              `);
            }
          }
          // #47 对话：交办开关。默认关闭；关闭时发送只回答、不建任务；
          // 打开后走既有审批链路生成待批准任务，生成后开关自动复位，任务出现在专注页待办里。
          const handoffSteps = {};
          // ⓪ 发送前：专注页待办基线（开关还没用过，这里应当 0）。
          handoffSteps.before = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="focus"]')?.click();
              await wait(1000);
              document.getElementById('needsSection')?.scrollIntoView({ block: 'start' });
              document.getElementById('toast').hidden = true;
              await wait(300);
              return {
                needsCount: document.getElementById('needsCount')?.textContent ?? '',
                pendingCount: document.getElementById('pendingCount')?.textContent ?? '',
                cards: document.querySelectorAll('#pendingList .pending-card').length
              };
            })()
          `);
          let handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-A-handoff-before.png'), handoffImage.toPNG());
          // ① 默认状态：开关可见且关闭。会话列表先收起来，别挡住输入区。
          // 特意打开一个「不是第一个项目」的会话，用来证明交办打到会话绑定的项目，而不是默认第一个。
          handoffSteps.idle = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="chat"]')?.click();
              await wait(900);
              const view = await window.companion.snapshot();
              const projects = view?.projects ?? [];
              let sessions = (await window.companion.chat.sessions.list()).items ?? [];
              // 没有会话时先建一条（绑定第一个项目），别让发送落到「新建会话」弹窗里。
              if (!sessions.length && projects.length) {
                await window.companion.chat.sessions.create({ projectId: projects[0].id });
                document.querySelector('#modeBar button[data-mode="focus"]')?.click();
                await wait(400);
                document.querySelector('#modeBar button[data-mode="chat"]')?.click();
                await wait(900);
                sessions = (await window.companion.chat.sessions.list()).items ?? [];
              }
              const pick = sessions.find((s) => s.projectId !== (projects[0]?.id ?? ''))
                ?? sessions[0];
              if (pick) {
                const row = document.querySelector('[data-session-id="' + pick.id + '"]');
                (row ?? document.querySelector('.c-session-item'))?.querySelector('.c-session-open')?.click();
                await wait(800);
              }
              if (!document.getElementById('cSessionList')?.hidden) {
                document.getElementById('cSessionsToggle')?.click();
                await wait(300);
              }
              const toggle = document.getElementById('cHandoff');
              const after = (await window.companion.chat.sessions.list()).items ?? [];
              const activeId = localStorage.getItem('owner-chat-session') ?? '';
              return {
                hasToggle: Boolean(toggle),
                ariaPressed: toggle?.getAttribute('aria-pressed') ?? '',
                sendLabel: document.getElementById('cSend')?.textContent?.trim() ?? '',
                targetHidden: document.getElementById('cHandoffTarget')?.hidden !== false,
                targetLabel: document.getElementById('cHandoffTarget')?.textContent ?? '',
                pending: (view?.pending ?? []).length,
                firstProjectId: projects[0]?.id ?? '',
                sessionProjectId: after.find((s) => s.id === activeId)?.projectId ?? '',
                projectIds: projects.map((p) => p.id)
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-C-handoff-default.png'), handoffImage.toPNG());
          // ② 关闭状态发送：只回答，待办数不变。
          handoffSteps.off = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const input = document.getElementById('cInput');
              input.value = '这个仓库为什么用 retry 封装？';
              document.getElementById('cSend')?.click();
              // 只回答走只读会话：没有模型时会尽快返回 no-model 提示，这里等到发送键恢复。
              for (let i = 0; i < 150; i += 1) {
                await wait(100);
                if (!document.getElementById('cSend')?.disabled) break;
              }
              await wait(500);
              const view = await window.companion.snapshot();
              const bots = [...document.querySelectorAll('#cTranscript .c-msg.bot')];
              return {
                pending: (view?.pending ?? []).length,
                togglePressed: document.getElementById('cHandoff')?.getAttribute('aria-pressed') ?? '',
                lastBot: bots.length ? String(bots[bots.length - 1].textContent).slice(0, 160) : ''
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-C-handoff-answer.png'), handoffImage.toPNG());
          // ②b 回到专注页：待办数必须和发送前一样（关闭时发送不建任务）。
          handoffSteps.focusAfterOff = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="focus"]')?.click();
              await wait(1000);
              document.getElementById('needsSection')?.scrollIntoView({ block: 'start' });
              document.getElementById('toast').hidden = true;
              await wait(300);
              return {
                needsCount: document.getElementById('needsCount')?.textContent ?? '',
                pendingCount: document.getElementById('pendingCount')?.textContent ?? '',
                cards: document.querySelectorAll('#pendingList .pending-card').length
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-A-handoff-after-answer.png'), handoffImage.toPNG());
          // ③ 打开开关：按钮变「交办」，并把目标项目写在输入框旁。
          handoffSteps.armed = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="chat"]')?.click();
              await wait(900);
              document.getElementById('cHandoff')?.click();
              await wait(250);
              return {
                ariaPressed: document.getElementById('cHandoff')?.getAttribute('aria-pressed') ?? '',
                sendLabel: document.getElementById('cSend')?.textContent?.trim() ?? '',
                targetHidden: document.getElementById('cHandoffTarget')?.hidden !== false,
                targetLabel: document.getElementById('cHandoffTarget')?.textContent ?? ''
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-C-handoff-armed.png'), handoffImage.toPNG());
          // ④ 打开状态发送：生成待批准任务，开关复位。
          handoffSteps.on = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              const input = document.getElementById('cInput');
              input.value = '把 retry 的循环改回 attempts 次，并补一条测试';
              document.getElementById('cSend')?.click();
              let created = null;
              for (let i = 0; i < 60; i += 1) {
                await wait(300);
                const view = await window.companion.snapshot();
                const pending = view?.pending ?? [];
                const item = pending.find((p) => String(p.title ?? '').startsWith('写请求'));
                if (item) { created = item; break; }
              }
              await wait(600);
              const view = await window.companion.snapshot();
              const bots = [...document.querySelectorAll('#cTranscript .c-msg.bot')];
              return {
                created: created
                  ? { id: created.id, title: created.title, projectId: created.projectId, kind: created.kind }
                  : null,
                pending: (view?.pending ?? []).length,
                ariaPressed: document.getElementById('cHandoff')?.getAttribute('aria-pressed') ?? '',
                sendLabel: document.getElementById('cSend')?.textContent?.trim() ?? '',
                lastBot: bots.length ? String(bots[bots.length - 1].textContent).slice(0, 220) : ''
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-C-handoff-done.png'), handoffImage.toPNG());
          // ⑤ 专注页待办里要能看到这条任务。
          handoffSteps.focus = await panel.webContents.executeJavaScript(`
            (async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="focus"]')?.click();
              await wait(1200);
              const cards = [...document.querySelectorAll('#pendingList .pending-card')];
              const target = cards.find((card) =>
                String(card.textContent ?? '').includes('写请求')) ?? cards[0] ?? null;
              // 多个项目时待办按项目分组，非首组默认折叠：把这条所在的组展开再截图。
              const group = target?.closest('details.pending-group');
              if (group) group.open = true;
              target?.scrollIntoView({ block: 'center' });
              document.getElementById('toast').hidden = true;
              await wait(500);
              return {
                needsCount: document.getElementById('needsCount')?.textContent ?? '',
                pendingCount: document.getElementById('pendingCount')?.textContent ?? '',
                cards: cards.length,
                titles: cards.map((card) => String(card.querySelector('.pending-title')?.textContent ?? card.textContent ?? '').slice(0, 80))
              };
            })()
          `);
          handoffImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-A-handoff-pending.png'), handoffImage.toPNG());
          fs.writeFileSync(
            path.join(screenshotDir, 'chat-handoff-probe.json'),
            JSON.stringify(handoffSteps, null, 2)
          );

          // ---- 审查修复验收：P0-1 视图项目 / 交办目标分离 ----
          const splitInitial = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('#modeBar button[data-mode="focus"]')?.click();
            await wait(1200);
            const projects = (await window.companion.snapshot())?.projects ?? [];
            const chip = document.getElementById('handoffTarget');
            const name = document.getElementById('handoffTargetName');
            const tabOf = () => document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
            const handoffOf = () => ({ id: chip?.dataset.projectId ?? '', label: name?.textContent?.trim() ?? '' });
            if (projects.length < 2) return { skipped: 'need-two-projects', count: projects.length };
            const initial = { view: tabOf(), handoff: handoffOf() };
            // 点工作区的项目切换标签看另一个项目：只应换视图，交办仍是「未选项目」。
            const other = projects[1];
            const tab = [...document.querySelectorAll('#fdTabs .fd-tab')]
              .find((node) => node.dataset.project === other.id);
            tab?.click();
            for (let i = 0; i < 60; i += 1) {
              await wait(150);
              if (tabOf() === other.id) break;
            }
            await wait(600);
            // 截图要同时看到工作区的项目切换（视图项目）与底部「交办到 …」（交办目标）。
            document.getElementById('workZone')?.scrollIntoView({ block: 'start' });
            await wait(500);
            document.getElementById('toast').hidden = true;
            return {
              projectIds: projects.map((item) => item.id),
              initial,
              afterTab: { view: tabOf(), handoff: handoffOf() },
              clicked: other.id
            };
          })()`);
          let splitImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-A-view-vs-handoff.png'), splitImage.toPNG());
          const splitMenu = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const projects = (await window.companion.snapshot())?.projects ?? [];
            const viewBefore = document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '';
            const target = projects.find((item) => item.id !== viewBefore) ?? projects[0];
            document.getElementById('handoffTarget')?.click();
            await wait(300);
            document.querySelector('#handoffTargetMenu .composer-project-option[data-project="' + target.id + '"]')?.click();
            await wait(500);
            return {
              viewBefore,
              target: target.id,
              viewAfter: document.querySelector('#fdTabs .fd-tab.on')?.dataset.project ?? '',
              handoff: {
                id: document.getElementById('handoffTarget')?.dataset.projectId ?? '',
                label: document.getElementById('handoffTargetName')?.textContent?.trim() ?? ''
              }
            };
          })()`);
          splitImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-A-handoff-menu-picked.png'), splitImage.toPNG());
          fs.writeFileSync(
            path.join(screenshotDir, 'view-handoff-split.json'),
            JSON.stringify({ splitInitial, splitMenu }, null, 2)
          );

          // ---- 审查修复验收：P0-2 新建会话默认空选项、未选禁用创建 ----
          const newSessionBefore = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('#modeBar button[data-mode="chat"]')?.click();
            await wait(900);
            document.getElementById('cSessionNew')?.click();
            await wait(500);
            const modal = document.getElementById('modal');
            const select = modal.querySelector('.sheet-body select');
            const create = [...modal.querySelectorAll('.sheet-foot button')]
              .find((node) => node.textContent.trim() === '新建会话');
            return {
              open: !modal.hidden,
              value: select?.value ?? '',
              options: select ? [...select.options].map((node) => ({
                value: node.value, label: node.textContent, disabled: node.disabled
              })) : [],
              createDisabled: create?.disabled === true
            };
          })()`);
          let sessionFormImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-C-new-session-empty.png'), sessionFormImage.toPNG());
          const newSessionAfter = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            const modal = document.getElementById('modal');
            const select = modal.querySelector('.sheet-body select');
            const create = [...modal.querySelectorAll('.sheet-foot button')]
              .find((node) => node.textContent.trim() === '新建会话');
            const option = [...(select?.options ?? [])].find((node) => node.value);
            if (select && option) {
              select.value = option.value;
              select.dispatchEvent(new Event('change'));
            }
            await wait(250);
            const enabled = create?.disabled === false;
            document.getElementById('closeModal')?.click();
            return { picked: option?.value ?? '', createEnabledAfterPick: enabled };
          })()`);
          fs.writeFileSync(
            path.join(screenshotDir, 'new-session-probe.json'),
            JSON.stringify({ before: newSessionBefore, after: newSessionAfter }, null, 2)
          );

          // ---- 审查修复验收：P0-5 知识档只剩两块；四个入口跳转 + 兜底 ----
          const knowledgeBlocks = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('#modeBar button[data-mode="knowledge"]')?.click();
            await wait(1400);
            document.getElementById('knowledgeBrowse')?.scrollIntoView({ block: 'start' });
            await wait(400);
            const modeB = document.getElementById('modeB');
            const modeA = document.getElementById('modeA');
            const workspace = document.getElementById('workWorkspace');
            const browse = document.getElementById('knowledgeBrowse');
            return {
              blocks: [...modeB.querySelectorAll(':scope > .scroll > section')]
                .map((node) => ({ id: node.id, className: node.className })),
              hasWorkspaceInKnowledge: modeB.contains(workspace),
              workspaceInFocus: modeA.contains(workspace),
              // 工作区从 #69 起是常驻展开的 <section>（不再是 <details>）：只看它有没有被隐藏。
              workspaceOpen: workspace?.hidden !== true,
              renderMs: browse?.dataset.renderMs ?? '',
              renderBudget: browse?.dataset.renderBudget ?? ''
            };
          })()`);
          fs.writeFileSync(
            path.join(screenshotDir, 'knowledge-mode-blocks.json'),
            JSON.stringify(knowledgeBlocks, null, 2)
          );
          let knowledgeImage = await panel.webContents.capturePage();
          fs.writeFileSync(path.join(screenshotDir, 'panel-knowledge-two-blocks.png'), knowledgeImage.toPNG());
          const jumpTargets = {
            knowledge: 'knowledgeBrowse',
            tests: 'runningSection',
            patches: 'opsZone',
            runs: 'runningSection'
          };
          const jumpResults = [];
          for (const key of Object.keys(jumpTargets)) {
            const result = await panel.webContents.executeJavaScript(`(async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms));
              document.querySelector('#modeBar button[data-mode="focus"]')?.click();
              await wait(900);
              const entry = document.querySelector('#workEntries .work-entry[data-entry="${key}"]');
              if (!entry) return { key: '${key}', error: 'entry-not-rendered' };
              entry.click();
              await wait(1200);
              const views = { focus: 'modeA', knowledge: 'modeB', chat: 'modeC' };
              const visible = Object.entries(views)
                .find(([, id]) => !document.getElementById(id).hidden)?.[0] ?? '';
              const node = document.getElementById('${jumpTargets[key]}');
              const workspace = document.getElementById('workWorkspace');
              const rect = node?.getBoundingClientRect();
              return {
                key: '${key}',
                visible,
                target: '${jumpTargets[key]}',
                inWorkspace: Boolean(workspace && node && workspace.contains(node)),
                workspaceOpen: workspace?.hidden !== true,
                top: rect ? Math.round(rect.top) : null
              };
            })()`);
            jumpResults.push(result);
            const image = await panel.webContents.capturePage();
            fs.writeFileSync(path.join(screenshotDir, `focus-jump-${key}.png`), image.toPNG());
          }
          // 目标不存在时退回该模式顶部：临时摘掉 id，确认不抛错、仍停在专注页。
          const jumpFallback = await panel.webContents.executeJavaScript(`(async () => {
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            document.querySelector('#modeBar button[data-mode="focus"]')?.click();
            await wait(700);
            const node = document.getElementById('runningSection');
            const saved = node.id;
            node.id = 'runningSection-detached';
            document.querySelector('#workEntries .work-entry[data-entry="runs"]')?.click();
            await wait(900);
            node.id = saved;
            const wrap = document.querySelector('#modeA .a-wrap');
            const rect = wrap?.getBoundingClientRect();
            return {
              stillFocus: !document.getElementById('modeA').hidden,
              wrapTop: rect ? Math.round(rect.top) : null,
              wrapScrollTop: wrap ? wrap.scrollTop : null
            };
          })()`);
          fs.writeFileSync(
            path.join(screenshotDir, 'focus-jump-probe.json'),
            JSON.stringify({ knowledgeBlocks, jumpResults, jumpFallback }, null, 2)
          );

          // 顺手记录按项目取数的结果，验证预重构没有破坏默认行为。
          const probe = [];
          for (const projectId of ['companion-demo', 'cultivation-agent']) {
            const result = await panel.webContents.executeJavaScript(
              `window.companion.snapshot({ projectId: '${projectId}' }).then((v) => ({
                 requested: '${projectId}',
                 active: v?.config?.projectId ?? null,
                 chainKeys: Object.keys(v?.chain ?? {}), chainJobTitle: v?.chain?.job?.title ?? null,
                 projectCount: v?.projects?.length ?? 0
               })).catch((e) => ({ requested: '${projectId}', error: String(e) }))`
            );
            probe.push(result);
          }
          fs.writeFileSync(path.join(screenshotDir, 'snapshot-probe.json'), JSON.stringify(probe, null, 2));
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
  saveConfig();
});
app.on('will-quit', () => {
  try { if (mobileServer) void mobileServer.close(); } catch { /* best effort */ }
  // 退出时释放只读对话会话，避免留下等待模型的进程内句柄。
  try { chatService?.disposeAll(); } catch { /* best effort */ }
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