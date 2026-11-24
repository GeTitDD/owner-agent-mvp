// 审查修复：P0-4 写路径显式项目、P0-5 知识档只读两块、P1-4 模式命名。
// 只读源码与 HTML，不联网、不起 Electron。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('P0-5 知识模式只剩「知识浏览 + 技能目录」两块', () => {
  const html = read('desktop/panel.html');
  const knowledge = html.slice(html.indexOf('id="modeB"'), html.indexOf('id="modeC"'));
  const blocks = [...knowledge.matchAll(/<section id="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(blocks, ['knowledgeBrowse', 'skillCatalog']);
  // 工作区搬去专注，且默认折叠（<details> 上没有 open）。
  assert.equal(knowledge.includes('workspaceToggle'), false);
  const focus = html.slice(html.indexOf('id="modeA"'), html.indexOf('id="modeB"'));
  assert.match(focus, /<details class="workspace" id="workspaceToggle">/u);
  assert.equal(/<details[^>]*id="workspaceToggle"[^>]*\bopen\b/u.test(focus), false);
});

test('P0-5 四个入口指向真实位置，找不到时退回模式顶部', () => {
  const html = read('desktop/panel.html');
  const panel = read('desktop/panel.js');
  const jump = panel.match(/const FOCUS_JUMP = \{([\s\S]*?)\n  \};/u)?.[1] ?? '';
  assert.notEqual(jump, '');
  const expected = [
    ['knowledge', 'knowledge', 'knowledgeBrowse'],
    ['tests', 'focus', 'runningSection'],
    ['patches', 'focus', 'needsSection'],
    ['runs', 'focus', 'runningSection']
  ];
  for (const [key, mode, sectionId] of expected) {
    assert.match(jump, new RegExp(`${key}: \\['${mode}', '${sectionId}'\\]`, 'u'));
    assert.match(html, new RegExp(`id="${sectionId}"`, 'u'));
  }
  // 测试 / 运行在折叠工作区里：跳转前展开。
  assert.match(panel, /workspace\.contains\(node\)\) workspace\.open = true/u);
  // 目标被移走时退回该模式顶部，不留死跳转。
  assert.match(panel, /const node = \$\(sectionId\) \?\? \$\(MODE_VIEW\[mode\]\)/u);
});

test('P0-4 写路径不再静默回退第一个项目', () => {
  const main = read('desktop/main.cjs');
  // 两套语义只留一套：resolveProject 已删除。
  assert.equal(main.includes('resolveProject'), false);
  const between = (startMarker, endMarker) => {
    const start = main.indexOf(startMarker);
    assert.notEqual(start, -1, startMarker);
    const stop = main.indexOf(endMarker, start);
    assert.notEqual(stop, -1, endMarker);
    return main.slice(start, stop);
  };
  const patch = between('const createPatchJob = async', 'const submitCompanionTask =');
  assert.match(patch, /registeredProject\(projectId, '生成改动提案要选择一个项目。'\)/u);
  const queue = between("ipcMain.handle('companion:queue-add'", "ipcMain.handle('companion:queue-update'");
  assert.match(queue, /registeredProject\(input\?\.projectId, '记想法要选择一个项目。'\)/u);
  const chatAsk = between("ipcMain.handle('companion:chat-ask'", "ipcMain.handle('companion:queue-add'");
  // 对话取项目：只认会话绑定或本次显式传入；找不到就让服务返回 no-project。
  assert.match(chatAsk, /findProjectById\(items, wantedId\)/u);
  assert.equal(/config\.projectId/u.test(chatAsk), false);
  assert.equal(/projects\[0\]/u.test(chatAsk), false);
  // 主进程一份「按 id 找项目」，被 registeredProject 与 chat-ask 共用。
  assert.match(main, /const findProjectById = \(projects, projectId\) =>/u);
  assert.match(main, /const project = findProjectById\(items, id\);/u);
});

test('P1-4 模式用语义名，不再靠 A/B/C 猜', () => {
  const html = read('desktop/panel.html');
  const panel = read('desktop/panel.js');
  const modes = [...html.matchAll(/data-mode="([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(modes, ['focus', 'knowledge', 'chat']);
  assert.match(panel, /const MODE_VIEW = \{ focus: 'modeA', knowledge: 'modeB', chat: 'modeC' \};/u);
  assert.equal(panel.includes('renderModeA'), false);
  assert.equal(panel.includes('MODE_IDS'), false);
  assert.match(panel, /const renderFocusMode = \(\) =>/u);
});
