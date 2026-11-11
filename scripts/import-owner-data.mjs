// 旧桌面端数据 → Cindy 插件数据（一次性迁移）。
//
// 从 Owner Companion 的 owner.sqlite 读取项目、想法、画像、图谱，
// 合并写入 ~/.owner-companion/owner.json（默认路径，可用 --out 覆盖）。
//
// 用法：
//   node scripts/import-owner-data.mjs
//   node scripts/import-owner-data.mjs --db "D:\path\owner.sqlite" --out "D:\data"
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const dbPath = path.resolve(arg('db', path.join(process.env.APPDATA ?? '', 'owner-agent-mvp', 'owner.sqlite')));
const outDir = path.resolve(arg('out', path.join(os.homedir(), '.owner-companion')));
const outFile = path.join(outDir, 'owner.json');

if (!fs.existsSync(dbPath)) {
  console.error(`找不到旧数据库：${dbPath}`);
  process.exit(1);
}

const slug = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
  .replace(/^-+|-+$/gu, '')
  .slice(0, 24) || 'project';

const parse = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

const db = new DatabaseSync(dbPath);
const projects = db.prepare('SELECT * FROM owner_projects').all();
const queue = db.prepare('SELECT * FROM owner_project_queue').all();
let briefs = [];
let diagrams = [];
try { briefs = db.prepare('SELECT * FROM owner_project_briefs').all(); } catch { /* 旧库可能没有 */ }
try { diagrams = db.prepare('SELECT * FROM owner_project_diagrams').all(); } catch { /* 旧库可能没有 */ }
db.close();

let existing = { version: 1, projects: [], ideas: [], briefs: {}, diagrams: {}, knowledge: [] };
try {
  existing = { ...existing, ...JSON.parse(fs.readFileSync(outFile, 'utf8')) };
} catch { /* 首次迁移 */ }

const projectById = new Map(existing.projects.map((project) => [project.id, project]));
let addedProjects = 0;
for (const project of projects) {
  if ([...projectById.values()].some((item) => item.root === project.root)) continue;
  let id = slug(project.id || project.name);
  let suffix = 1;
  while (projectById.has(id)) {
    suffix += 1;
    id = `${slug(project.id || project.name)}-${suffix}`;
  }
  projectById.set(id, {
    id,
    name: project.name || path.basename(project.root),
    root: project.root,
    createdAt: project.created_at || new Date().toISOString(),
    updatedAt: project.updated_at || new Date().toISOString()
  });
  addedProjects += 1;
}

const rootToId = new Map([...projectById.values()].map((project) => [project.root, project.id]));
const oldIdToNew = new Map(projects.map((project) => [project.id, rootToId.get(project.root)]));

const existingIdeaKeys = new Set(existing.ideas.map((idea) => `${idea.projectId}|${idea.title}`));
let addedIdeas = 0;
for (const item of queue) {
  if (item.kind && item.kind !== 'idea') continue;
  const projectId = oldIdToNew.get(item.project_id);
  if (!projectId) continue;
  const key = `${projectId}|${item.title}`;
  if (existingIdeaKeys.has(key)) continue;
  existing.ideas.push({
    id: item.id,
    projectId,
    title: item.title,
    body: item.body || '',
    status: item.status || 'todo',
    source: item.source === 'conversation' ? 'conversation' : 'manual',
    createdAt: item.created_at || new Date().toISOString(),
    updatedAt: item.updated_at || item.created_at || new Date().toISOString()
  });
  existingIdeaKeys.add(key);
  addedIdeas += 1;
}

let addedBriefs = 0;
for (const row of briefs) {
  const projectId = oldIdToNew.get(row.project_id);
  if (!projectId || existing.briefs[projectId]) continue;
  const payload = parse(row.payload, null);
  if (!payload) continue;
  existing.briefs[projectId] = {
    ...payload,
    generatedAt: row.generated_at || new Date().toISOString(),
    basedOnCommit: row.based_on_commit || '',
    source: 'legacy-import'
  };
  addedBriefs += 1;
}

let addedDiagrams = 0;
for (const row of diagrams) {
  const projectId = oldIdToNew.get(row.project_id);
  if (!projectId) continue;
  const bucket = existing.diagrams[projectId] ?? {};
  if (bucket[row.kind]) continue;
  bucket[row.kind] = {
    kind: row.kind,
    title: row.title,
    summary: row.summary || '',
    mermaid: row.mermaid,
    data: parse(row.data_json, {}),
    unknowns: parse(row.unknowns_json, []),
    confidence: row.confidence || 'medium',
    source: row.source || 'legacy-import',
    basedOnCommit: row.based_on_commit || '',
    version: row.version || 1,
    updatedAt: row.updated_at || new Date().toISOString()
  };
  existing.diagrams[projectId] = bucket;
  addedDiagrams += 1;
}

existing.projects = [...projectById.values()];
existing.version = 1;
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(existing, null, 2), { mode: 0o600 });
console.log(JSON.stringify({
  db: dbPath,
  out: outFile,
  projects: `${addedProjects} 新增 / ${existing.projects.length} 合计`,
  ideas: `${addedIdeas} 新增 / ${existing.ideas.length} 合计`,
  briefs: `${addedBriefs} 新增`,
  diagrams: `${addedDiagrams} 新增`
}, null, 2));
