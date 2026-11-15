// 插件依赖图模块：本地扫描 nodes/edges、折叠与 Mermaid 生成。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanDependencyGraph } from '../plugins/owner-companion/node/lib/diagrams.mjs';

test('依赖扫描产出 nodes/edges 与 flowchart LR', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-diagram-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'a.js'),
      "import { b } from './b.js';\nimport React from 'react';\n"
    );
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'export const b = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'c.js'), 'export const c = 3;\n');

    const diagram = await scanDependencyGraph(root);
    const ids = diagram.data.nodes.map((node) => node.id);

    assert.equal(diagram.kind, 'dependency');
    assert.equal(diagram.title, '项目依赖图');
    assert.ok(ids.includes('src/a.js'));
    assert.ok(ids.includes('src/b.js'));
    assert.ok(ids.includes('外部:react'));

    const react = diagram.data.nodes.find((node) => node.id === '外部:react');
    assert.equal(react.type, 'external');
    assert.equal(react.label, 'react'); // label 去掉「外部:」前缀

    assert.ok(diagram.data.edges.some(
      (edge) => edge.from === 'src/a.js' && edge.to === 'src/b.js' && edge.label === 'imports'
    ));
    assert.ok(diagram.data.edges.some(
      (edge) => edge.from === 'src/a.js' && edge.to === '外部:react'
    ));

    assert.ok(diagram.mermaid.startsWith('flowchart LR'));
    assert.match(diagram.mermaid, /\|"imports"\|/u);
    assert.match(diagram.mermaid, /n0\["/u); // 节点 id 用 n0/n1…
    assert.ok(!diagram.mermaid.includes('外部:'), '节点标签不保留外部前缀');

    assert.equal(diagram.stats.files, 3);
    assert.equal(diagram.stats.edges, diagram.data.edges.length);
    assert.equal(diagram.summary, `3 个源文件、${diagram.data.edges.length} 条依赖关系`);
    assert.deepEqual(diagram.data.unknowns, []);
    assert.equal(diagram.data.confidence, 'high');
    assert.ok(diagram.data.nodes.every((node) => node.evidence.length <= 6));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('节点超过 30 个时按顶层目录折叠，外部节点保留', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-diagram-fold-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // 40 个文件：每个都引用下一个本地文件，并引用同一个外部包
    for (let index = 0; index < 40; index += 1) {
      const next = (index + 1) % 40;
      fs.writeFileSync(
        path.join(root, 'src', `f${index}.js`),
        `import './f${next}.js';\nimport lodash from 'lodash';\n`
      );
    }

    const diagram = await scanDependencyGraph(root);
    const ids = diagram.data.nodes.map((node) => node.id);

    assert.ok(ids.length <= 31, `折叠后节点应不超过 31 个，实际 ${ids.length}`);
    assert.ok(ids.includes('src'), 'src 目录被折叠成一个节点');
    assert.ok(ids.includes('外部:lodash'), '外部节点不参与折叠');
    assert.equal(diagram.data.nodes.find((node) => node.id === 'src').type, 'module');
    // 折叠后 src 内部的边消失，只剩 src → 外部:lodash
    assert.deepEqual(diagram.data.edges.map((edge) => `${edge.from}->${edge.to}`), ['src->外部:lodash']);
    assert.equal(diagram.stats.files, 40);
    assert.equal(diagram.stats.edges, 1);
    assert.match(diagram.mermaid, /flowchart LR/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
