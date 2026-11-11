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
  knowledge: []
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
      state.briefs = raw.briefs && typeof raw.briefs === 'object' ? raw.briefs : {};
      state.diagrams = raw.diagrams && typeof raw.diagrams === 'object' ? raw.diagrams : {};
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
      delete state.briefs[projectId];
      delete state.diagrams[projectId];
      persist();
      return { removed: before !== state.projects.length };
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

    listKnowledge(projectId) {
      return state.knowledge
        .filter((entry) => !projectId || entry.projectId === projectId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((entry) => ({ ...entry }));
    },
    addKnowledge({ projectId, title, body = '', tags = [], status = 'unverified', source = 'manual' }) {
      const entry = {
        id: crypto.randomUUID(),
        projectId,
        title: String(title).slice(0, 200),
        body: String(body).slice(0, 8000),
        tags: Array.isArray(tags) ? tags.slice(0, 8).map((tag) => String(tag).slice(0, 30)) : [],
        status: status === 'verified' ? 'verified' : 'unverified',
        source,
        createdAt: now()
      };
      state.knowledge.push(entry);
      persist();
      return { ...entry };
    }
  };
}
