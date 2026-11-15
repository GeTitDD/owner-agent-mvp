// 项目画像：pstack 结果 → 用户可读结构；commit 变化判定过期。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectBrief, buildLocalProjectBrief, briefIsStale, oneLinerOf } from '../src/project-brief.mjs';

test('一句话取首句并限制长度', () => {
  assert.equal(oneLinerOf('这是第一句。这是第二句。'), '这是第一句。');
  assert.equal(oneLinerOf('', 'fallback'), 'fallback');
});

test('把 findings/nextSteps 映射成项目画像', () => {
  const brief = buildProjectBrief({
    project: { id: 'demo', name: 'Demo' },
    result: {
      runId: 'pb_1', status: 'ok',
      summary: '一个零依赖 Node 项目。带一个 off-by-one bug。',
      findings: [
        { title: '入口', detail: 'src/index.js 导出 format', evidence: ['src/index.js:1'] },
        { title: '测试', detail: 'node --test', evidence: ['tests/a.test.mjs:2'] }
      ],
      risks: ['没有 CI'],
      nextSteps: ['先跑 npm test'],
      evidence: []
    },
    repoFacts: {
      scripts: ['npm test', 'npm run build'],
      testCommands: ['npm test'],
      testCriteria: ['命令退出码为 0'],
      evidence: ['package.json'],
      unknowns: []
    }
  });
  assert.equal(brief.oneLiner, '一个零依赖 Node 项目。');
  assert.equal(brief.modules.length, 2);
  assert.deepEqual(brief.howToRun, ['npm test', 'npm run build']);
  assert.deepEqual(brief.verify.commands, ['npm test']);
  assert.equal(brief.risks[0], '没有 CI');
  assert.ok(brief.evidence.includes('src/index.js:1'));
  assert.ok(brief.evidence.includes('package.json'));
  assert.equal(brief.sourceRuns[0], 'pb_1');
});

test('本地快速画像不依赖模型，使用 README/package/目录', () => {
  const brief = buildLocalProjectBrief({
    project: { id: 'demo', name: 'Demo' },
    repoFacts: {
      packageInfo: { name: 'demo', description: '一个演示项目' },
      readme: '# Demo\n\n这是 README 的说明。\n',
      scripts: ['npm test'],
      testCommands: ['npm test'],
      testCriteria: ['命令退出码为 0'],
      directories: ['src', 'tests'],
      markers: ['AGENTS.md'],
      evidence: ['README.md', 'package.json']
    }
  });
  assert.equal(brief.oneLiner, '一个演示项目');
  assert.match(brief.whatItIs, /README/u);
  assert.deepEqual(brief.howToRun, ['npm test']);
  assert.equal(brief.modules[0].name, 'src');
  assert.ok(brief.conventions[0].includes('AGENTS.md'));
  assert.equal(brief.generatedFrom, 'local-scan');
  const readmeOnly = buildLocalProjectBrief({
    project: { id: 'x', name: 'X' },
    repoFacts: { readme: '# X\n\n> 引用\n\n这是一个没有 package.json 的项目。\n' }
  });
  assert.equal(readmeOnly.oneLiner, '这是一个没有 package.json 的项目。');
});

test('commit 变化或工作区有改动时画像过期', () => {
  const brief = { basedOnCommit: 'aaa' };
  assert.equal(briefIsStale(null), true);
  assert.equal(briefIsStale(brief, { head: 'aaa' }), false);
  assert.equal(briefIsStale(brief, { head: 'bbb' }), true);
  assert.equal(briefIsStale(brief, { head: 'aaa', dirty: true }), true);
  assert.equal(briefIsStale(brief, { head: '', dirty: false }), false);
});
