// 本地项目扫描与快速画像：用临时 Node 项目验证关键字段与兜底行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../plugins/owner-companion/node/lib/scan.mjs';
import { buildQuickBrief } from '../plugins/owner-companion/node/lib/brief.mjs';

/** 建一个最小可扫描项目：package.json + README + 一个源码文件 + 一个测试文件 + 一处 TODO。 */
async function makeFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'owner-scan-'));
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.mkdir(path.join(root, 'tests'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      scripts: { dev: 'node src/a.js', test: 'node --test tests' }
    }, null, 2)
  );
  await fsp.writeFile(
    path.join(root, 'README.md'),
    '# Fixture App\n\n一个用于扫描测试的示例项目。\n\n## 运行\n\n```bash\nnpm run dev\n```\n'
  );
  await fsp.writeFile(path.join(root, 'src', 'a.js'), '// TODO: 补一个示例\nexport const a = 1;\n');
  await fsp.writeFile(path.join(root, 'tests', 'a.test.js'), '// 占位测试\n');
  return root;
}

/** 清理临时目录，失败也不影响测试结论。 */
async function removeFixture(root) {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

test('scanProject 收集 Node 项目的关键事实', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanProject(root);

    assert.equal(scan.name, path.basename(root));
    assert.equal(scan.root, path.resolve(root));
    assert.equal(scan.ecosystem, 'node');

    assert.ok(scan.readme, '应该识别到 README.md');
    assert.equal(scan.readme.path, 'README.md');
    assert.match(scan.readme.summary, /示例项目/u);
    assert.ok(!scan.readme.summary.includes('```'), '摘要应该是纯文本');

    assert.ok(scan.packageJson, '应该解析 package.json');
    assert.equal(scan.packageJson.name, 'fixture-app');
    assert.deepEqual(scan.packageJson.scripts, [
      'npm run dev: node src/a.js',
      'npm run test: node --test tests'
    ]);

    assert.equal(scan.sourceCount, 2, 'src/a.js 与 tests/a.test.js 都算源码');
    assert.deepEqual(scan.testFiles, ['tests/a.test.js']);
    assert.equal(scan.todoCount, 1);
    assert.ok(scan.topLevel.includes('src'));
    assert.ok(scan.topLevel.includes('tests'));
    assert.ok(scan.topLevel.includes('package.json'));
  } finally {
    await removeFixture(root);
  }
});

test('buildQuickBrief 由扫描结果生成画像', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanProject(root);
    const brief = buildQuickBrief(scan);

    assert.equal(brief.source, 'local-scan');
    assert.match(brief.oneLiner, /Fixture App/u);
    assert.match(brief.whatItIs, /示例项目/u);

    assert.equal(brief.howToRun[0], 'npm run dev: node src/a.js');
    assert.equal(brief.howToRun.length, 2);

    assert.ok(brief.modules.some((item) => item.path === 'src'), 'modules 应包含顶层目录');
    assert.deepEqual(brief.verify.commands, ['npm test']);
    assert.ok(brief.verify.criteria.length > 0);

    assert.ok(brief.risks.some((risk) => risk.includes('TODO/FIXME')));
    assert.ok(brief.risks.every((risk) => typeof risk === 'string' && risk.length > 0));

    assert.ok(brief.evidence.includes('README.md'));
    assert.ok(brief.evidence.includes('package.json'));
    assert.ok(brief.evidence.length <= 12);

    assert.equal(brief.basedOnCommit, scan.git?.head ?? '');
    assert.ok(!Number.isNaN(Date.parse(brief.generatedAt)), 'generatedAt 应是可解析的时间');
  } finally {
    await removeFixture(root);
  }
});

test('信息缺失时给出兜底运行命令与风险提示', () => {
  const brief = buildQuickBrief({ name: 'demo', ecosystem: 'python' });

  assert.equal(brief.oneLiner, 'demo：python 项目');
  assert.equal(brief.source, 'local-scan');
  assert.ok(brief.howToRun.some((line) => line.includes('pytest')));
  assert.equal(brief.basedOnCommit, '');
  assert.ok(brief.risks.includes('README 缺失'));
  assert.ok(brief.risks.includes('没有检测到测试文件'));
  assert.deepEqual(brief.modules, []);
  assert.deepEqual(brief.evidence, []);
});

test('时间预算用尽时返回已收集到的部分结果', async () => {
  const root = await makeFixture();
  try {
    const scan = await scanProject(root, { timeoutMs: 1 });
    assert.equal(typeof scan.name, 'string');
    assert.equal(scan.name, path.basename(root));
    assert.ok(Array.isArray(scan.topLevel));
    assert.ok(Array.isArray(scan.testFiles));
    assert.equal(typeof scan.todoCount, 'number');
  } finally {
    await removeFixture(root);
  }
});
