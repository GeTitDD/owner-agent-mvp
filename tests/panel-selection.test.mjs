// 审查修复：P0-1 视图项目 / 交办目标分离——选择语义用纯函数 + 渲染层源码验证。
// 不联网、不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selection = require('../desktop/panel-selection.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const projects = [
  { id: 'alpha', name: 'Alpha Repo' },
  { id: 'beta', name: 'Beta Repo' }
];

/** 取某段函数体：从 marker 到同一层级的 `};`，用来断言「这一段没碰另一个状态」。 */
const blockOf = (source, marker, end = '\n  };') => {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing block: ${marker}`);
  const stop = source.indexOf(end, start);
  assert.notEqual(stop, -1, `unterminated block: ${marker}`);
  return source.slice(start, stop);
};

test('按 id 找项目：找不到返回 null，四种用法共用一份实现', () => {
  assert.equal(selection.findProject(projects, 'beta').id, 'beta');
  assert.equal(selection.findProject(projects, 'gone'), null);
  assert.equal(selection.findProject(projects, ''), null);
  assert.equal(selection.findProject([], 'alpha'), null);
  // 视图默认第一、交办严格显式，两者都建立在同一个 findProject 上。
  assert.equal(selection.viewProject(projects, '').id, 'alpha');
  assert.equal(selection.submitProject(projects, ''), null);
});

test('视图项目没选时默认第一个，选过就跟着选择走', () => {
  assert.equal(selection.viewProject(projects, '').id, 'alpha');
  assert.equal(selection.viewProject(projects, 'beta').id, 'beta');
  // 选中的项目被删掉：视图回到第一个，不抛错。
  assert.equal(selection.viewProject(projects, 'gone').id, 'alpha');
  assert.equal(selection.viewProject([], 'alpha'), null);
});

test('交办目标必须显式选：没选或项目不存在都不放行', () => {
  assert.equal(selection.submitProject(projects, ''), null);
  assert.equal(selection.submitProject(projects, 'gone'), null);
  assert.equal(selection.submitProject(projects, 'beta').id, 'beta');
});

test('交办按钮没选时显示未选项目，选过显示项目名', () => {
  assert.equal(selection.targetLabel(null), '未选项目');
  assert.equal(selection.targetLabel(selection.submitProject(projects, '')), '未选项目');
  assert.equal(selection.targetLabel(selection.submitProject(projects, 'alpha')), 'Alpha Repo');
});

test('选择只存在内存里：主进程不再写回 config.projectId', () => {
  const main = read('desktop/main.cjs');
  assert.equal(/config\.projectId\s*=(?!=)/u.test(main), false);
  // 快照不再把配置里的旧项目当成默认；没传项目时看第一个。
  assert.match(main, /const wanted = String\(requestedProjectId \|\| ''\);/u);
  // 交办必须拿到显式项目，缺了就报错，不静默回退到第一个。
  assert.match(main, /registeredProject\(projectId, '先选择要交办的项目。'\)/u);
  assert.equal(/submitCompanionTask[\s\S]{0,200}resolveProject/u.test(main), false);
});

test('渲染层没有全局项目下拉，也不再调用 settings.set({ projectId })', () => {
  const panel = read('desktop/panel.js');
  const html = read('desktop/panel.html');
  assert.equal(panel.includes('projectSelect'), false);
  assert.equal(html.includes('id="projectSelect"'), false);
  assert.equal(/settings\.set\(\{\s*projectId/u.test(panel), false);
  // 发送前先取显式目标，取不到就地拦下。
  assert.match(panel, /const target = handoffTarget\(\);\s*\n\s*if \(!target\)/u);
});

test('P0-1 视图项目与交办目标是两个互不影响的状态', () => {
  const panel = read('desktop/panel.js');
  assert.match(panel, /let viewProjectId = '';/u);
  assert.match(panel, /let handoffProjectId = '';/u);
  assert.equal(panel.includes('selectedProjectId'), false);

  const viewBlock = blockOf(panel, 'const selectViewProject = async (projectId) => {');
  assert.match(viewBlock, /viewProjectId = id;/u);
  assert.equal(viewBlock.includes('handoffProjectId ='), false);

  const handoffBlock = blockOf(panel, 'const selectHandoffProject = (projectId) => {');
  assert.match(handoffBlock, /handoffProjectId = id;/u);
  assert.equal(handoffBlock.includes('viewProjectId ='), false);

  // 详情卡标签只切视图，绝不调用交办目标的设置函数。
  const focusBlock = blockOf(panel, 'const selectFocusProject = (projectId) => {');
  assert.match(focusBlock, /selectViewProject\(projectId\)/u);
  assert.equal(focusBlock.includes('selectHandoffProject'), false);

  // 取数只认视图项目；交办解析只认显式 id。
  assert.match(panel, /snapshot\(\{ projectId: viewProjectId \}\)/u);
  assert.match(panel, /const handoffTarget = \(projectId = handoffProjectId\)/u);
});

test('待办卡只标项目名，不再分「当前/其他」两堆', () => {
  const panel = read('desktop/panel.js');
  assert.equal(panel.includes('其他项目 ·'), false);
  assert.equal(panel.includes('所选项目 ·'), false);
  assert.match(panel, /el\('div', 'pending-project', item\.projectName\)/u);
});

test('沙箱提示不再打印 unknown 占位', () => {
  const panel = read('desktop/panel.js');
  assert.equal(panel.includes("ecosystem || 'unknown'"), false);
  assert.match(panel, /这个项目还没有可用的沙箱 profile/u);
});

test('toast 挂在模式栏下方：不盖导航、不压输入区', () => {
  const html = read('desktop/panel.html');
  const css = read('desktop/panel.css');
  assert.match(html, /<\/nav>[\s\S]{0,200}?<div class="toast-host">[\s\S]{0,40}?<div id="toast"/u);
  assert.equal(/\.toast\s*\{[^}]*top:\s*70px/u.test(css), false);
  assert.match(css, /\.toast-host\s*\{[^}]*position:\s*relative/u);
});
