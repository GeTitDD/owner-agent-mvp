// Owner Companion desktop host.
//
// 进程内启动 Owner sidecar + 常驻 Worker；审批令牌只留在主进程。
// 渲染进程（桌宠/面板）只能通过受控 IPC 读取视图模型与触发操作。
const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, dialog, Notification, shell } =
  require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const PET_SIZE = 136;
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 640;
const COMPANION_VERSION = '1.0.0';
const screenshotArg = process.argv.find((arg) => arg.startsWith('--screenshot-dir='));
const screenshotDir = screenshotArg ? screenshotArg.slice('--screenshot-dir='.length) : '';
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
let playbookRunnerError = '';
const playbookRuns = new Map();

const configPath = () => path.join(app.getPath('userData'), 'companion.json');
const defaults = () => ({
  pet: null,
  projectId: '',
  allowedPaths: 'src/',
  includePaths: ['package.json'],
  gatewayUrl: 'http://127.0.0.1:18789',
  model: '',
  knowledgeAutoHarvest: false,
  panelPinned: false
});
let config = defaults();

const loadConfig = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = { ...defaults(), ...raw };
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

const resolveDigest = () => {
  const explicit = process.env.OWNER_AGENT_SANDBOX_IMAGE_DIGEST;
  if (/^sha256:[0-9a-f]{64}$/u.test(explicit ?? '')) return explicit;
  try {
    const ref = execFileSync('docker', [
      'image', 'inspect', 'node:22-alpine', '--format', '{{index .RepoDigests 0}}'
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    const digest = ref.split('@')[1];
    return /^sha256:[0-9a-f]{64}$/u.test(digest ?? '') ? digest : '';
  } catch {
    return '';
  }
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
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
};

const stateOf = (summary) => summary;

const projectIdOf = (item) => item?.project_id ?? item?.projectId ?? '';

/** 当前项目的测试配置自检：node-smoke 固定运行 tests/sandbox-smoke.test.mjs。 */
const testConfigForProject = (project) => {
  const required = [...new Set(['tests/sandbox-smoke.test.mjs', ...config.includePaths])]
    .map((item) => String(item).replace(/\\/gu, '/').replace(/^\.\//u, ''))
    .filter(Boolean);
  if (!project?.root) {
    return { ok: false, projectId: project?.id ?? '', profile: 'node-smoke', required, missing: [] };
  }
  const missing = required.filter((rel) => {
    try {
      fs.accessSync(path.join(project.root, rel));
      return false;
    } catch {
      return true;
    }
  });
  return {
    ok: missing.length === 0,
    projectId: project.id,
    profile: 'node-smoke',
    required,
    missing
  };
};

const createSandbox = (proposalId) => api('/owner/v1/sandbox-runs', {
  method: 'POST',
  body: {
    proposalId,
    // node-smoke 固定运行该文件，自动加入快照，避免用户漏配。
    includePaths: [...new Set(['tests/sandbox-smoke.test.mjs', ...config.includePaths])]
  }
});

const toPending = ({ jobs, patches, sandboxes, repairs }, projectNames = new Map()) => {
  const pending = [];
  const tag = (item) => {
    const projectId = projectIdOf(item);
    return { projectId, projectName: projectNames.get(projectId) ?? '' };
  };
  for (const job of jobs) {
    if (job.status === 'pending_approval') {
      pending.push({
        kind: 'job', id: job.id, hash: '',
        title: job.title,
        summary: `${job.job_type} · 等待你批准后才会开始`,
        ...tag(job)
      });
    }
  }
  for (const patch of patches) {
    if (patch.status === 'proposed') {
      pending.push({
        kind: 'patch', id: patch.id, hash: patch.proposal_hash,
        title: `补丁 ${patch.id.slice(0, 8)}`,
        summary: (patch.files ?? []).map((file) => file.path).join(', ') || '等待审阅冻结 Diff',
        ...tag(patch)
      });
    } else if (patch.status === 'approved') {
      pending.push({
        kind: 'patch-apply', id: patch.id, hash: patch.proposal_hash,
        title: `已批准补丁 ${patch.id.slice(0, 8)}`,
        summary: '下一步：应用到 Worktree，然后请求沙箱测试',
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

const knowledgeSnapshot = () => {
  if (!personalStore) return { available: false, counts: {}, recentExperiences: [], candidates: [] };
  const units = personalStore.list({ limit: 2000 });
  const experiences = personalStore.listExperiences({ limit: 1000 });
  const candidates = personalStore.proposals('pending')
    .filter((item) => item.meta?.contract === 'knowledge-candidate/v1');
  const usages = personalStore.listUsages({ limit: 200 });
  const harvested = new Set(personalStore.listHarvestRuns(1000).flatMap((run) => run.experienceIds ?? []));
  const pendingHarvest = experiences.filter((item) => !harvested.has(item.id)).length;
  return {
    available: true,
    counts: {
      experiences: experiences.length,
      pendingHarvest,
      knowledge: units.length,
      verified: units.filter((item) => item.verificationStatus === 'verified').length,
      candidates: candidates.length,
      usages: usages.length,
      positiveUsages: usages.filter((item) => item.observedBenefit === 'positive').length,
      negativeUsages: usages.filter((item) => item.observedBenefit === 'negative').length
    },
    auto: {
      allowHarvest: Boolean(knowledgeRuntime?.allowHarvest),
      last: knowledgeRuntime?.last ?? null
    },
    recentExperiences: experiences.slice(0, 5).map((item) => ({
      id: item.id, projectId: item.projectId, title: item.observedProblem,
      outcome: item.observedOutcome?.status ?? 'unknown',
      testStatus: item.observedOutcome?.testStatus ?? null,
      createdAt: item.createdAt
    })),
    candidates: candidates.slice(0, 5).map((item) => ({
      id: item.id, title: item.payload?.title ?? '未命名候选',
      layer: item.payload?.layer ?? 'project',
      confidence: item.meta?.confidence ?? null
    })),
    recentKnowledge: units.filter((item) => item.verificationStatus === 'verified').slice(0, 5).map((item) => ({
      id: item.id, title: item.title, layer: item.layer, revision: item.revision,
      scope: item.scope, projectId: item.projectId
    }))
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
  let state = 'idle';
  if (pending.length > 0) state = 'waiting';
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
  }
  const finalCycle = repairsInProject.find((cycle) =>
    ['tested_pass', 'tested_fail'].includes(cycle.status)) ?? null;
  const services = await serviceStatus();
  return {
    version: COMPANION_VERSION,
    state,
    pending,
    stage: stageText(chain),
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
    projects: projectList.map((project) => ({
      id: project.id,
      name: project.name,
      baseSha: project.baseSha ?? project.base_sha ?? ''
    })),
    config: {
      projectId: activeProjectId,
      domain: activeProject?.primary_domain ?? activeProject?.primaryDomain ?? '',
      allowedPaths: config.allowedPaths,
      includePaths: config.includePaths,
      gatewayUrl: config.gatewayUrl,
      model: config.model
    },
    testConfig: testConfigForProject(activeProject),
    services,
    knowledge: knowledgeSnapshot(),
    result: finalCycle
      ? {
        cycleId: finalCycle.id,
        status: finalCycle.status,
        testStatus: finalCycle.status === 'tested_pass' ? 'pass' : 'fail',
        label: finalCycle.status === 'tested_pass'
          ? `修复 ${finalCycle.id.slice(0, 8)} 已通过复测`
          : `修复 ${finalCycle.id.slice(0, 8)} 复测未通过`
      }
      : null
  };
};

const serviceStatus = async () => {
  const now = Date.now();
  if (serviceCache.value && now - serviceCache.at < 10000) return serviceCache.value;
  let docker = false;
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8', timeout: 2500
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
  positionPet();
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
  panel.loadFile(path.join(__dirname, 'panel.html'));
  panel.on('closed', () => { panel = null; });
};

const showPanel = () => {
  if (!panel) createPanel();
  positionPanel();
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

/** 面板点“生成改动提案”时使用：只发任务，真正的写文件仍走既有审批/沙箱链路。 */
const createPatchJob = async ({ text, projectId }) => {
  const value = String(text ?? '').trim();
  if (!value) throw new Error('请先输入要交办的事情。');
  const projects = (await api('/owner/v1/projects')).items ?? [];
  const project = projects.find((item) => item.id === projectId)
    ?? projects.find((item) => item.id === config.projectId)
    ?? projects[0];
  if (!project) throw new Error('还没有项目，请先在设置里添加一个项目目录。');
  const task = await api('/owner/v1/tasks', {
    method: 'POST',
    body: { projectId: project.id, title: value.slice(0, 200) }
  });
  const baseSha = project.baseSha ?? project.base_sha ?? '';
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
    throw new Error('项目目录不是有效的 Git 仓库，无法确定 base commit。');
  }
  const job = await api('/owner/v1/jobs', {
    method: 'POST',
    body: {
      projectId: project.id,
      jobType: 'code-patch',
      title: value.slice(0, 200),
      payload: {
        baseSha,
        allowedPaths: config.allowedPaths || 'src/',
        focus: value.slice(0, 300)
      },
      idempotencyKey: `companion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerTaskId: task.id
    }
  });
  config.projectId = project.id;
  saveConfig();
  return { jobId: job.id, status: job.status, projectId: project.id };
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

  ipcMain.handle('companion:create-job', async (event, input) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    const created = await createPatchJob({
      text: String(input?.text ?? ''),
      projectId: String(input?.projectId ?? '')
    });
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === created.projectId);
    return { jobId: created.jobId, status: created.status, testConfig: project ? testConfigForProject(project) : null };
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
      const testConfig = testConfigForProject(project);
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
    return createSandbox(String(input?.proposalId ?? ''));
  });

  ipcMain.handle('companion:knowledge-summary', async (event) => {
    if (!fromCompanion(event)) throw new Error('Unauthorized');
    return knowledgeSnapshot();
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
    const project = await projectForPlaybook(String(input?.projectId ?? ''));
    const runner = await getPlaybookRunner();
    let result;
    try {
      result = await runner.run({
        playbookId: String(input?.playbookId ?? ''),
        project,
        task: String(input?.task ?? '')
      });
    } catch (error) {
      playbookRunnerError = String(error?.message ?? error);
      throw error;
    }
    persistPlaybookRun(result);
    playbookRuns.set(`${project.id}::${result.playbookId}`, result);
    // 避免内存无限增长：只保留最近 40 次结果。
    if (playbookRuns.size > 40) {
      const oldest = playbookRuns.keys().next().value;
      playbookRuns.delete(oldest);
    }
    const { text, ...summary } = result;
    return summary;
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
      projectId: String(input?.projectId ?? '')
    });
    const projects = (await api('/owner/v1/projects')).items ?? [];
    const project = projects.find((item) => item.id === created.projectId);
    return { ...created, testConfig: project ? testConfigForProject(project) : null };
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
    if (typeof input?.projectId === 'string') config.projectId = input.projectId;
    if (typeof input?.knowledgeAutoHarvest === 'boolean') {
      config.knowledgeAutoHarvest = input.knowledgeAutoHarvest;
      knowledgeRuntime?.setAutoHarvest(input.knowledgeAutoHarvest, { model: config.model });
    } else if (knowledgeRuntime && config.knowledgeAutoHarvest) {
      knowledgeRuntime.setAutoHarvest(true, { model: config.model });
    }
    saveConfig();
    serviceCache = { at: 0, value: null };
    const modelChanged = config.model !== previousModel;
    if (modelChanged) playbookRunner = null;
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
  createTray();
  registerDisplayHandlers();
  app.on('second-instance', () => {
    if (pet) { pet.show(); positionPet(); }
    showPanel();
  });

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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(boot).catch((error) => {
    console.error('Owner Companion failed:', error);
    dialog.showErrorBox('Owner Companion 启动失败', String(error?.stack ?? error));
    app.quit();
  });
}

app.on('window-all-closed', () => { /* tray keeps the app alive */ });
app.on('before-quit', () => {
  quitting = true;
  if (dragTimer) clearInterval(dragTimer);
  if (workerTimer) clearInterval(workerTimer);
  if (knowledgeTimer) clearInterval(knowledgeTimer);
  saveConfig();
});
app.on('will-quit', () => {
  try { tray?.destroy(); } catch { /* best effort */ }
  try { if (workbench) void workbench.close(); } catch { /* best effort */ }
  try { if (sidecar) void sidecar.close(); } catch { /* best effort */ }
  try { personalStore?.close(); } catch { /* best effort */ }
  try { store?.close(); } catch { /* best effort */ }
});
