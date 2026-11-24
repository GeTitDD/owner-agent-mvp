// #41 专注：取消「当前项目」——选择语义用纯函数验证，不联网、不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const selection = require('../desktop/panel-selection.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const projects = [
  { id: 'alpha', name: 'Alpha Repo' },
  { id: 'beta', name: 'Beta Repo' }
];

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
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  assert.equal(/config\.projectId\s*=(?!=)/u.test(main), false);
  // 快照不再把配置里的旧项目当成默认；没传项目时看第一个。
  assert.match(main, /const wanted = String\(requestedProjectId \|\| ''\);/u);
  // 交办必须拿到显式项目，缺了就报错，不静默回退到第一个。
  assert.match(main, /registeredProject\(projectId, '先选择要交办的项目。'\)/u);
  assert.equal(/submitCompanionTask[\s\S]{0,200}resolveProject/u.test(main), false);
});

test('渲染层没有全局项目下拉，也不再调用 settings.set({ projectId })', () => {
  const panel = fs.readFileSync(path.join(root, 'desktop/panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'desktop/panel.html'), 'utf8');
  assert.equal(panel.includes('projectSelect'), false);
  assert.equal(html.includes('id="projectSelect"'), false);
  assert.equal(/settings\.set\(\{\s*projectId/u.test(panel), false);
  // 发送前先取显式目标，取不到就地拦下。
  assert.match(panel, /const target = submitTarget\(\);\s*\n\s*if \(!target\)/u);
});
