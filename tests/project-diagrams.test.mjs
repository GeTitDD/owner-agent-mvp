// 项目图谱：依赖扫描、图数据校验、Mermaid 生成。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scanDependencyGraph, normalizeDiagram, toMermaid
} from '../src/project-diagrams.mjs';

test('本地依赖扫描生成 nodes/edges 与 Mermaid', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), "import { b } from './b.js';\nimport React from 'react';\n");
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'export const b = 1;\n');
    const diagram = scanDependencyGraph(root);
    assert.equal(diagram.kind, 'dependency');
    assert.ok(diagram.data.nodes.some((node) => node.id === 'src/a.js'));
    assert.ok(diagram.data.nodes.some((node) => node.id === 'src/b.js'));
    assert.ok(diagram.data.nodes.some((node) => node.type === 'external'));
    assert.ok(diagram.data.edges.some((edge) => edge.from === 'src/a.js' && edge.to === 'src/b.js'));
    assert.match(diagram.mermaid, /flowchart LR/u);
    assert.match(diagram.mermaid, /src\/a\.js/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('状态图与时序图校验并生成 Mermaid', () => {
  const state = normalizeDiagram('state', {
    summary: '任务状态',
    states: [
      { id: 'idle', label: '空闲', kind: 'start' },
      { id: 'running', label: '运行中' },
      { id: 'done', label: '完成', kind: 'end' }
    ],
    transitions: [
      { from: 'idle', to: 'running', trigger: '提交' },
      { from: 'running', to: 'done', trigger: '通过' }
    ],
    confidence: 'high'
  });
  const stateMermaid = toMermaid('state', state);
  assert.match(stateMermaid, /stateDiagram-v2/u);
  assert.match(stateMermaid, /空闲/u);
  assert.match(stateMermaid, /提交/u);

  const sequence = normalizeDiagram('sequence', {
    summary: '请求链路',
    participants: [{ id: 'ui', label: '界面' }, { id: 'api', label: 'API' }],
    messages: [{ from: 'ui', to: 'api', text: '提交任务', kind: 'sync' }]
  });
  const seqMermaid = toMermaid('sequence', sequence);
  assert.match(seqMermaid, /sequenceDiagram/u);
  assert.match(seqMermaid, /界面/u);
  assert.match(seqMermaid, /->>/u);
});

test('非法图数据被拒绝', () => {
  assert.throws(() => normalizeDiagram('state', { states: [] }), /states/u);
  assert.throws(() => normalizeDiagram('dependency', { nodes: [] }), /nodes/u);
});
