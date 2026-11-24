// #71 接线检查：待提炼提议必须来自既有 IPC、只提示、跳转复用模式切换。
// 只读源码，不起 Electron；行为由 scripts/e2e/desktop-ops-proposals.mjs 验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('#71 操作区有独立的待提炼块，默认隐藏', () => {
  const html = read('desktop/panel.html');
  const ops = html.slice(html.indexOf('id="opsZone"'), html.indexOf('id="workZone"'));
  assert.match(ops, /<section id="proposeSection"[^>]*hidden/u);
  assert.match(ops, /id="proposeList"/u);
  // 顺序：待办在前、待提炼在后（与 focusOpsView 的三段顺序一致）。
  const needsAt = ops.indexOf('id="needsSection"');
  const proposeAt = ops.indexOf('id="proposeSection"');
  assert.ok(needsAt !== -1 && proposeAt !== -1 && needsAt < proposeAt);
  assert.match(ops, /id="opsPendingTitle"/u);
});

test('#71 提议数据走既有 IPC，且要全部项目', () => {
  const panel = read('desktop/panel.js');
  const main = read('desktop/main.cjs');
  // 面板只读 IPC，不自己算阈值、不调提炼。
  assert.match(panel, /window\.companion\.knowledge\.distillProposals\(\{ allProjects: true \}\)/u);
  assert.equal(/DISTILL_PROPOSAL_THRESHOLD/u.test(panel), false);
  assert.equal(/distillOnDemand|knowledge\.distill\(/u.test(panel), false);
  // 提议进视图模型，渲染层不再另算一份。
  assert.match(panel, /proposals: opsProposals/u);
  // 主进程显式区分「全部项目」与「当前项目」，阈值仍在 on-demand.mjs。
  assert.match(main, /input\?\.allProjects === true/u);
  assert.match(main, /listDistillProposals\(\{ distiller, projectId \}\)/u);
});

test('#71 去提炼复用模式切换与知识页刷新，不另写导航', () => {
  const panel = read('desktop/panel.js');
  const jump = panel.match(/const jumpToKnowledgeProposals = \(projectId\) => \{([\s\S]*?)\n  \};/u)?.[1] ?? '';
  assert.notEqual(jump, '');
  assert.match(jump, /knowledgeBrowseProject = id/u);
  assert.match(jump, /setMode\('knowledge'\)/u);
  // 没有重写隐藏模式 / 手动改 hidden 的第二套导航。
  assert.equal(/\.hidden = /u.test(jump), false);
  // 空项目也要能定位：知识浏览的筛选不因「还没有条目」被退回「全部」。
  assert.match(panel, /view\?\.projects \?\? \[\]\)\.some\(\(item\) => item\.id === knowledgeBrowseProject\)/u);
});
