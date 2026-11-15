// 插件自己的本地数据：项目、想法、画像、图谱、知识笔记。
//
// 数据落在 ~/.owner-companion/owner.json（可用 OWNER_COMPANION_DIR 覆盖），
// 写入采用「临时文件 + rename」保证原子性，并保留一份 .bak 备份。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;

export const dataDir = () => (process.env.OWNER_COMPANION_DIR
  ? path.resolve(process.env.OWNER_COMPANION_DIR)
  : path.join(os.homedir(), '.owner-companion'));

const emptyState = () => ({
  version: SCHEMA_VERSION,
  projects: [],
  ideas: [],
  briefs: {},
  diagrams: {},
  knowledge: [],
  experiences: [],
  patches: [],
  tests: [],
  github: {},
  // 任务页签上次停留的项目：key 是 Cindy 任务 id，'' 为无任务时的默认值。
  focus: {}
});

const slug = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
  .replace(/^-+|-+$/gu, '')
  .slice(0, 24) || 'project';

/** 打开（或创建）JSON 数据文件。 */
export function openStore(dir = dataDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'owner.json');
  let state = emptyState();

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      state = { ...emptyState(), ...raw };
      state.projects = Array.isArray(raw.projects) ? raw.projects : [];
      state.ideas = Array.isArray(raw.ideas) ? raw.ideas : [];
      state.knowledge = Array.isArray(raw.knowledge) ? raw.knowledge : [];
      state.experiences = Array.isArray(raw.experiences) ? raw.experiences : [];
      state.patches = Array.isArray(raw.patches) ? raw.patches : [];
      state.tests = Array.isArray(raw.tests) ? raw.tests : [];
      state.github = raw.github && typeof raw.github === 'object' ? raw.github : {};
      state.briefs = raw.briefs && typeof raw.briefs === 'object' ? raw.briefs : {};
      state.diagrams = raw.diagrams && typeof raw.diagrams === 'object' ? raw.diagrams : {};
      state.focus = raw.focus && typeof raw.focus === 'object' ? raw.focus : {};
    }
  } catch { /* 首次运行或文件损坏时从空状态开始 */ }

  const persist = () => {
    const tmp = `${file}.tmp`;
    const text = JSON.stringify(state, null, 2);
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 首次没有旧文件 */ }
    fs.renameSync(tmp, file);
  };

  const now = () => new Date().toISOString();

  return {
    dir,
    file,
    snapshot: () => state,
    save: persist,

    listProjects: () => state.projects.map((project) => ({ ...project })),
    getProject(projectId) {
      return state.projects.find((project) => project.id === projectId) ?? null;
    },
    addProject({ root, name = '' }) {
      const resolved = path.resolve(String(root || ''));
      const existing = state.projects.find((project) => project.root === resolved);
      if (existing) return { project: { ...existing }, created: false };
      const base = path.basename(resolved) || 'project';
      let id = slug(base);
      let suffix = 1;
      while (state.projects.some((project) => project.id === id)) {
        suffix += 1;
        id = `${slug(base)}-${suffix}`;
      }
      const project = {
        id,
        name: String(name || base).slice(0, 120),
        root: resolved,
        createdAt: now(),
        updatedAt: now()
      };
      state.projects.push(project);
      persist();
      return { project: { ...project }, created: true };
    },
    removeProject(projectId) {
      const before = state.projects.length;
      state.projects = state.projects.filter((project) => project.id !== projectId);
      state.ideas = state.ideas.filter((idea) => idea.projectId !== projectId);
      state.knowledge = state.knowledge.filter((entry) => entry.projectId !== projectId);
      state.experiences = state.experiences.filter((entry) => entry.projectId !== projectId);
      state.patches = state.patches.filter((entry) => entry.projectId !== projectId);
      state.tests = state.tests.filter((entry) => entry.projectId !== projectId);
      delete state.briefs[projectId];
      delete state.diagrams[projectId];
      delete state.github[projectId];
      for (const [key, value] of Object.entries(state.focus)) {
        if (value === projectId) delete state.focus[key];
      }
      persist();
      return { removed: before !== state.projects.length };
    },

    /** 读取某个任务上次停留的项目；没有记录时回落到默认项目。 */
    getFocusedProject(sessionId = '') {
      const exists = (id) => state.projects.some((project) => project.id === id);
      const own = state.focus[String(sessionId || '')];
      if (own && exists(own)) return own;
      const fallback = state.focus[''];
      return fallback && exists(fallback) ? fallback : '';
    },

    /** 记住某个任务停留的项目；只保留最近 50 个任务，避免数据无限增长。 */
    setFocusedProject(sessionId = '', projectId = '') {
      const id = String(projectId || '');
      if (!state.projects.some((project) => project.id === id)) return { ok: false, projectId: '' };
      const key = String(sessionId || '');
      // 先删后写，让这个 key 排在最后（对象保留插入顺序）。
      delete state.focus[key];
      state.focus[key] = id;
      const keys = Object.keys(state.focus);
      for (const stale of keys.slice(0, Math.max(0, keys.length - 50))) {
        if (stale !== '') delete state.focus[stale];
      }
      persist();
      return { ok: true, projectId: id };
    },

    listIdeas(projectId, status = '') {
      return state.ideas
        .filter((idea) => (!projectId || idea.projectId === projectId) && (!status || idea.status === status))
        .map((idea) => ({ ...idea }));
    },
    addIdea({ projectId, title, body = '', source = 'manual' }) {
      const existing = state.ideas.find((idea) => idea.projectId === projectId && idea.title === title);
      if (existing) return { ...existing };
      const idea = {
        id: crypto.randomUUID(),
        projectId,
        title: String(title).slice(0, 300),
        body: String(body).slice(0, 4000),
        status: 'todo',
        source,
        createdAt: now(),
        updatedAt: now()
      };
      state.ideas.push(idea);
      persist();
      return { ...idea };
    },
    updateIdea(id, { status, title } = {}) {
      const idea = state.ideas.find((item) => item.id === id);
      if (!idea) throw Object.assign(new Error('想法不存在'), { status: 404 });
      if (status !== undefined) {
        if (!['todo', 'doing', 'blocked', 'done', 'failed'].includes(status)) {
          throw Object.assign(new Error('无效的想法状态'), { status: 400 });
        }
        idea.status = status;
      }
      if (title !== undefined) idea.title = String(title).slice(0, 300);
      idea.updatedAt = now();
      persist();
      return { ...idea };
    },
    removeIdea(id) {
      const before = state.ideas.length;
      state.ideas = state.ideas.filter((idea) => idea.id !== id);
      persist();
      return { removed: before !== state.ideas.length };
    },

    getBrief(projectId) {
      return state.briefs[projectId] ? { ...state.briefs[projectId] } : null;
    },
    saveBrief(projectId, brief) {
      state.briefs[projectId] = { ...brief };
      persist();
      return { ...brief };
    },

    getDiagram(projectId, kind) {
      const entry = state.diagrams[projectId]?.[kind];
      return entry ? { ...entry } : null;
    },
    listDiagrams(projectId) {
      const bucket = state.diagrams[projectId] ?? {};
      return Object.values(bucket).map((entry) => ({
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        version: entry.version,
        updatedAt: entry.updatedAt
      }));
    },
    saveDiagram(projectId, diagram) {
      const bucket = state.diagrams[projectId] ?? {};
      const previous = bucket[diagram.kind];
      bucket[diagram.kind] = {
        ...diagram,
        version: (previous?.version ?? 0) + 1,
        updatedAt: now()
      };
      state.diagrams[projectId] = bucket;
      persist();
      return { ...bucket[diagram.kind] };
    },

    listKnowledge(projectId, status = '') {
      return state.knowledge
        .filter((entry) => (!projectId || entry.projectId === projectId)
          && (!status || entry.status === status))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((entry) => ({ ...entry }));
    },
    getKnowledge(id) {
      const entry = state.knowledge.find((item) => item.id === id);
      return entry ? { ...entry } : null;
    },
    addKnowledge({ projectId, title, body = '', tags = [], evidence = [], status = 'unverified', source = 'manual' }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        title: String(title).slice(0, 200),
        body: String(body).slice(0, 12000),
        tags: Array.isArray(tags) ? tags.slice(0, 8).map((tag) => String(tag).slice(0, 30)) : [],
        evidence: Array.isArray(evidence) ? evidence.slice(0, 8).map((ref) => String(ref).slice(0, 200)) : [],
        status: status === 'verified' ? 'verified' : 'unverified',
        source,
        createdAt: now(),
        updatedAt: now(),
        revisions: []
      };
      state.knowledge.push(entry);
      persist();
      return { ...entry };
    },
    proposeKnowledge({ projectId, title, body = '', tags = [], evidence = [], source = 'cindy' }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        title: String(title).slice(0, 200),
        body: String(body).slice(0, 12000),
        tags: Array.isArray(tags) ? tags.slice(0, 8).map((tag) => String(tag).slice(0, 30)) : [],
        evidence: Array.isArray(evidence) ? evidence.slice(0, 8).map((ref) => String(ref).slice(0, 200)) : [],
        status: 'proposed',
        source,
        createdAt: now(),
        updatedAt: now(),
        revisions: []
      };
      state.knowledge.push(entry);
      persist();
      return { ...entry };
    },
    reviewKnowledge(id, decision, reviewer = 'local-user') {
      const entry = state.knowledge.find((item) => item.id === id);
      if (!entry) throw Object.assign(new Error('知识不存在'), { status: 404 });
      if (entry.status !== 'proposed') throw Object.assign(new Error('这条候选已经审核过'), { status: 409 });
      entry.status = decision === 'accept' ? 'unverified' : 'rejected';
      entry.reviewedAt = now();
      entry.reviewer = reviewer;
      entry.updatedAt = now();
      persist();
      return { ...entry };
    },
    verifyKnowledge(id) {
      const entry = state.knowledge.find((item) => item.id === id);
      if (!entry) throw Object.assign(new Error('知识不存在'), { status: 404 });
      entry.status = 'verified';
      entry.verifiedAt = now();
      entry.updatedAt = now();
      persist();
      return { ...entry };
    },
    updateKnowledge(id, { title, body, tags } = {}) {
      const entry = state.knowledge.find((item) => item.id === id);
      if (!entry) throw Object.assign(new Error('知识不存在'), { status: 404 });
      entry.revisions.push({
        at: entry.updatedAt || entry.createdAt,
        title: entry.title,
        body: entry.body,
        tags: [...(entry.tags ?? [])]
      });
      if (title !== undefined) entry.title = String(title).slice(0, 200);
      if (body !== undefined) entry.body = String(body).slice(0, 12000);
      if (tags !== undefined) {
        entry.tags = Array.isArray(tags) ? tags.slice(0, 8).map((tag) => String(tag).slice(0, 30)) : [];
      }
      entry.updatedAt = now();
      // 修改后需要重新验证。
      if (entry.status === 'verified') entry.status = 'unverified';
      persist();
      return { ...entry };
    },
    tidyKnowledge(projectId) {
      const entries = state.knowledge.filter((entry) => !projectId || entry.projectId === projectId);
      const byTitle = new Map();
      for (const entry of entries) {
        const key = entry.title.toLowerCase().replace(/\s+/gu, '');
        byTitle.set(key, [...(byTitle.get(key) ?? []), entry.id]);
      }
      return {
        duplicates: [...byTitle.entries()].filter(([, ids]) => ids.length > 1)
          .map(([title, ids]) => ({ title, ids })),
        short: entries.filter((entry) => String(entry.body ?? '').length < 40)
          .map((entry) => ({ id: entry.id, title: entry.title })),
        unverified: entries.filter((entry) => entry.status === 'unverified')
          .map((entry) => ({ id: entry.id, title: entry.title })),
        proposed: entries.filter((entry) => entry.status === 'proposed')
          .map((entry) => ({ id: entry.id, title: entry.title }))
      };
    },
    searchKnowledge(query, projectId = '') {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return [];
      return state.knowledge
        .filter((entry) => (!projectId || entry.projectId === projectId)
          && (`${entry.title} ${entry.body} ${(entry.tags ?? []).join(' ')}`.toLowerCase().includes(needle)))
        .map((entry) => ({ ...entry }))
        .slice(0, 20);
    },

    listExperiences(projectId, { distilled } = {}) {
      return state.experiences
        .filter((entry) => (!projectId || entry.projectId === projectId)
          && (distilled === undefined || entry.distilled === distilled))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((entry) => ({ ...entry }));
    },
    addExperience({ projectId, text, outcome = 'unknown', source = 'cindy' }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        text: String(text).slice(0, 8000),
        outcome: ['success', 'failure', 'unknown'].includes(outcome) ? outcome : 'unknown',
        source,
        distilled: false,
        createdAt: now()
      };
      state.experiences.push(entry);
      persist();
      return { ...entry };
    },
    markExperienceDistilled(id) {
      const entry = state.experiences.find((item) => item.id === id);
      if (!entry) throw Object.assign(new Error('经验不存在'), { status: 404 });
      entry.distilled = true;
      persist();
      return { ...entry };
    },

    listPatches(projectId, status = '') {
      return state.patches
        .filter((entry) => (!projectId || entry.projectId === projectId)
          && (!status || entry.status === status))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((entry) => ({ ...entry }));
    },
    getPatch(id) {
      const entry = state.patches.find((item) => item.id === id);
      return entry ? { ...entry } : null;
    },
    addPatch({ projectId, title, diff, baseCommit = '', source = 'cindy' }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        title: String(title).slice(0, 200),
        diff: String(diff),
        baseCommit: String(baseCommit || ''),
        status: 'pending',
        source,
        createdAt: now(),
        updatedAt: now()
      };
      state.patches.push(entry);
      persist();
      return { ...entry };
    },
    updatePatch(id, { status, note = '' } = {}) {
      const entry = state.patches.find((item) => item.id === id);
      if (!entry) throw Object.assign(new Error('补丁提案不存在'), { status: 404 });
      if (status !== undefined) {
        if (!['pending', 'applied', 'rejected'].includes(status)) {
          throw Object.assign(new Error('无效的补丁状态'), { status: 400 });
        }
        entry.status = status;
      }
      entry.note = String(note || entry.note || '').slice(0, 1000);
      entry.updatedAt = now();
      persist();
      return { ...entry };
    },

    listTestRuns(projectId) {
      return state.tests
        .filter((entry) => entry.projectId === projectId)
        .slice(-5)
        .reverse()
        .map((entry) => ({ ...entry }));
    },
    addTestRun({ projectId, command, ok, durationMs, output = '', code = 0 }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        command: String(command).slice(0, 200),
        ok: ok === true,
        code: Number(code) || 0,
        durationMs: Number(durationMs) || 0,
        output: String(output).slice(-8000),
        createdAt: now()
      };
      state.tests.push(entry);
      if (state.tests.length > 200) state.tests = state.tests.slice(-200);
      persist();
      return { ...entry };
    },

    getGithub(projectId) {
      return state.github[projectId] ? { ...state.github[projectId] } : null;
    },
    setGithub(projectId, data) {
      state.github[projectId] = { ...data, updatedAt: now() };
      persist();
      return { ...state.github[projectId] };
    }
  };
}
