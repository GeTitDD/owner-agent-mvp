// pstack Playbook 单元测试：注册表、解析、证据核验、只读执行器与失败分类。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAYBOOKS, PLAYBOOK_GROUPS, READONLY_TOOLS, getPlaybook, listPlaybooks
} from '../src/pstack/playbooks.mjs';
import { readSkillBody } from '../src/pstack/readonly-session.mjs';
import {
  PlaybookRunner, buildPlaybookPrompt, parsePlaybookOutput, verifyEvidence
} from '../src/pstack/playbook-runner.mjs';

const makeSkillsRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-fixture-'));
  fs.mkdirSync(path.join(root, 'poteto-mode'), { recursive: true });
  fs.writeFileSync(path.join(root, 'poteto-mode', 'SKILL.md'), '# poteto\n', 'utf8');
  for (const playbook of PLAYBOOKS) {
    fs.mkdirSync(path.join(root, playbook.id), { recursive: true });
    fs.writeFileSync(
      path.join(root, playbook.id, 'SKILL.md'),
      `---\nname: ${playbook.id}\ndescription: fixture\n---\n\n# ${playbook.title}\n\n唯一纪律：先看证据。\n`,
      'utf8'
    );
  }
  return root;
};

const makeProject = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-project-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'retry.js'), 'export const attempts = 7;\n', 'utf8');
  return { id: 'demo', root, domain: 'software-engineering' };
};

const fakeFactory = (output, hooks = {}) => ({
  requiresModel: true,
  async create() {
    return {
      sessionId: () => 'fake-session',
      prompt: async (prompt) => {
        hooks.onPrompt?.(prompt);
        if (hooks.hang) return new Promise(() => {});
        if (hooks.throw) throw hooks.throw;
        return undefined;
      },
      abort: () => {},
      activeTools: () => [...READONLY_TOOLS],
      getLastText: () => output,
      model: 'fake/model',
      dispose: () => { hooks.disposed?.(); }
    };
  }
});

test('Playbook 注册表：12 个、4 组、id 唯一且都能被 getPlaybook 找到', () => {
  assert.equal(PLAYBOOKS.length, 12);
  assert.equal(PLAYBOOK_GROUPS.length, 4);
  const ids = PLAYBOOKS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const listed = listPlaybooks().flatMap((group) => group.items.map((item) => item.id));
  assert.deepEqual([...listed].sort(), [...ids].sort());
  assert.equal(getPlaybook('nope'), null);
  assert.equal(getPlaybook(ids[0]).id, ids[0]);
});

test('Playbook 提示词包含项目边界、只读约束与 JSON 输出契约', () => {
  const playbook = getPlaybook('how');
  const prompt = buildPlaybookPrompt({
    playbook,
    project: { id: 'demo', root: 'D:\\demo', domain: 'software-engineering' }
  });
  assert.match(prompt, /D:\\demo/u);
  assert.match(prompt, /只读/u);
  assert.match(prompt, /"summary"/u);
  assert.match(prompt, /findings/u);
});

test('解析 JSON 输出（含代码块包裹）', () => {
  const parsed = parsePlaybookOutput([
    '```json',
    '{"summary":"默认 attempts 是 7","findings":[{"title":"常量在 src/retry.js","detail":"导出常量","evidence":["src/retry.js:1"]}],"risks":["未知运行时"],"nextSteps":["补测试"]}',
    '```'
  ].join('\n'));
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.summary, '默认 attempts 是 7');
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.findings[0].evidence, ['src/retry.js:1']);
  assert.deepEqual(parsed.risks, ['未知运行时']);
  assert.deepEqual(parsed.nextSteps, ['补测试']);
});

test('解析 Markdown 回退，并保留未知/建议小节', () => {
  const parsed = parsePlaybookOutput([
    '## 概览',
    '项目很小，只有重试模块。',
    '## 关键发现',
    '- src/retry.js 导出了 attempts 常量',
    '## 风险',
    '- 没有测试文件',
    '## 建议下一步',
    '- 补一个回归测试'
  ].join('\n'));
  assert.equal(parsed.format, 'markdown');
  assert.match(parsed.summary, /只有重试模块/u);
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.risks, ['没有测试文件']);
  assert.deepEqual(parsed.nextSteps, ['补一个回归测试']);
});

test('证据核验：存在、缺失、越界路径都不轻信', () => {
  const project = makeProject();
  const findings = verifyEvidence(project.root, [{
    title: 't', detail: '', evidence: ['src/retry.js', 'src/missing.js', '../../etc/passwd']
  }]);
  assert.deepEqual(findings[0].evidenceChecks.map((item) => item.exists), [true, false, false]);
});

test('readSkillBody 去掉 front-matter 并限制长度', () => {
  const skills = makeSkillsRoot();
  const { body } = readSkillBody(skills, 'how');
  assert.match(body, /唯一纪律/u);
  assert.ok(!body.startsWith('---'));
  const capped = readSkillBody(skills, 'how', 5);
  assert.ok(capped.body.length < 40);
});

test('PlaybookRunner 返回结构化结果并核验证据', async () => {
  const skills = makeSkillsRoot();
  const project = makeProject();
  let seenPrompt = '';
  const runner = new PlaybookRunner({
    skillsDir: skills,
    sessionFactoryFor: () => fakeFactory(JSON.stringify({
      summary: '常量 attempts=7 由 src/retry.js 导出',
      findings: [{ title: '默认值', detail: '模块导出常量', evidence: ['src/retry.js'] }],
      risks: [],
      nextSteps: ['补测试']
    }), { onPrompt: (prompt) => { seenPrompt = prompt; } })
  });
  const result = await runner.run({ playbookId: 'how', project });
  assert.equal(result.status, 'ok');
  assert.equal(result.projectId, 'demo');
  assert.equal(result.findings[0].evidenceChecks[0].exists, true);
  assert.match(seenPrompt, /只读分析项目 demo/u);
  assert.ok(result.promptHash.length === 64);
});

test('PlaybookRunner 在模型异常与超时时返回受控分类', async () => {
  const skills = makeSkillsRoot();
  const project = makeProject();
  const authRunner = new PlaybookRunner({
    skillsDir: skills,
    sessionFactoryFor: () => fakeFactory('', { throw: new Error('No API key found for undefined') })
  });
  const authResult = await authRunner.run({ playbookId: 'how', project });
  assert.equal(authResult.status, 'error');
  assert.equal(authResult.category, 'auth-error');

  let disposed = false;
  const timeoutRunner = new PlaybookRunner({
    skillsDir: skills,
    timeoutMs: 30,
    sessionFactoryFor: () => fakeFactory('', { hang: true, disposed: () => { disposed = true; } })
  });
  const timeoutResult = await timeoutRunner.run({ playbookId: 'how', project });
  assert.equal(timeoutResult.status, 'error');
  assert.equal(timeoutResult.category, 'timeout');
  assert.equal(disposed, true);
});

test('PlaybookRunner 拒绝未知 playbook，并正确报告 skills 可用性', async () => {
  const project = makeProject();
  const runner = new PlaybookRunner({ skillsDir: makeSkillsRoot() });
  await assert.rejects(() => runner.run({ playbookId: 'unknown', project }), /Unknown playbook/u);
  // 解析器最后会回退到本机 pstack 目录；这里只断言能力探测可用。
  assert.equal(runner.skillsAvailable, true);
});

test('PlaybookRunner 不向会话暴露写工具（工厂只接受只读白名单）', () => {
  assert.deepEqual([...READONLY_TOOLS], ['read', 'grep', 'find', 'ls']);
  assert.ok(!READONLY_TOOLS.includes('write'));
  assert.ok(!READONLY_TOOLS.includes('bash'));
});

test('PlaybookRunner 支持外部取消并真正中止会话', async () => {
  const skills = makeSkillsRoot();
  const project = makeProject();
  let aborted = false;
  const factory = {
    requiresModel: true,
    async create() {
      return {
        sessionId: () => 'hang-session',
        prompt: () => new Promise(() => {}),
        abort: () => { aborted = true; },
        activeTools: () => [...READONLY_TOOLS],
        getLastText: () => '',
        model: 'fake/model',
        dispose: () => {}
      };
    }
  };
  const runner = new PlaybookRunner({ skillsDir: skills, sessionFactoryFor: () => factory });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const result = await runner.run({ playbookId: 'how', project, signal: controller.signal });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'canceled');
  assert.equal(aborted, true);
  assert.ok(result.advice && result.advice.length > 0);
});

test('配额错误不再伪装成“没有结论”', async () => {
  const skills = makeSkillsRoot();
  const project = makeProject();
  const factory = {
    requiresModel: true,
    async create() {
      return {
        sessionId: () => 'quota-session',
        prompt: async () => {},
        abort: () => {},
        activeTools: () => [...READONLY_TOOLS],
        lastMessage: () => ({
          role: 'assistant', stopReason: 'error', hasText: false,
          errorMessage: '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将于 2026-11-09 05:02:07 重置。"}'
        }),
        getLastText: () => '',
        model: 'fake/model',
        dispose: () => {}
      };
    }
  };
  const runner = new PlaybookRunner({ skillsDir: skills, sessionFactoryFor: () => factory });
  const result = await runner.run({ playbookId: 'how', project });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'quota-exceeded');
  assert.match(result.advice, /额度/u);
  assert.match(result.detail, /2026-11-09 05:02:07/u);
});

test('模型返回空文本时标记 empty-response', async () => {
  const skills = makeSkillsRoot();
  const project = makeProject();
  const runner = new PlaybookRunner({ skillsDir: skills, sessionFactoryFor: () => fakeFactory('   ') });
  const result = await runner.run({ playbookId: 'how', project });
  assert.equal(result.status, 'error');
  assert.equal(result.category, 'empty-response');
  assert.match(result.advice, /空内容/u);
});

test('重负载 playbook 有更长预算和单会话声明', () => {
  const architect = getPlaybook('architect');
  assert.ok(architect.timeoutMs >= 300000);
  assert.match(architect.budget, /多视角/u);
  assert.ok(architect.maxFiles <= 20);
  const prompt = buildPlaybookPrompt({
    playbook: architect,
    project: { id: 'demo', root: 'D:\\demo', domain: '' }
  });
  assert.match(prompt, /最多读 14 个文件/u);
  assert.match(prompt, /不要声称做了多视角综合/u);
});

test('证据引用规范化：反引号、行号后缀与中文行号标注都能落地', () => {
  const project = makeProject();
  const findings = verifyEvidence(project.root, [{
    title: 't', detail: '',
    evidence: ['`src/retry.js`', 'src/retry.js:12', 'src/retry.js#L3', 'src/retry.js（第 12 行）']
  }]);
  assert.deepEqual(findings[0].evidenceChecks.map((item) => item.exists), [true, true, true, true]);
});
