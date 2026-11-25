// #85 决策提炼：给定一段会话片段、已有决策的指纹与一个可注入的提炼器，输出决策候选。
// 只断言「给这些输入，候选应该是什么」；不调真实模型、不读盘、不读库。
// 真实取样里的三个事实决定了这里的断言重点：助手那句才给出具体范围、理由本来就稀少、
// 会话开头常被注入环境上下文与系统历史。
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftDecisions, decisionFingerprint } from '../src/memory/decision-draft.mjs';

/** 会话片段：角色 + 文本 + 时间，与摄入层交给这里的形状一致。 */
const fragment = ({ role, text, at = '2026-11-20T10:00:00.000Z' }) => ({ role, text, at });

/** 假的提炼器：只回显传进来的两段原文，不猜任何东西。 */
const echoExtract = (pair) => ({
  phenomenon: pair.user.text,
  intent: pair.assistant ? pair.assistant.text : '',
  abandoned: '',
  reason: ''
});

test('成对取：用户原话与紧随的助手确认都进候选', () => {
  const calls = [];
  const extract = (pair) => {
    calls.push(pair);
    return {
      phenomenon: '构建慢',
      intent: '换用 esbuild 打包',
      abandoned: '保留 tsc 做完整编译',
      reason: 'tsc 增量构建太慢'
    };
  };
  const view = draftDecisions({
    projectId: 'alpha',
    sessionId: 's1',
    fragments: [
      fragment({ role: 'user', text: '构建太慢了，换掉 tsc', at: '2026-11-20T10:00:00.000Z' }),
      fragment({ role: 'assistant', text: '那就用 esbuild 打包，tsc 只留类型检查', at: '2026-11-20T10:00:05.000Z' })
    ],
    extract
  });

  assert.equal(view.candidates.length, 1);
  const [candidate] = view.candidates;
  // 两个字段都来自助手确认，正是「只取用户那句会丢掉一半信息」的那一半。
  assert.equal(candidate.phenomenon, '构建慢');
  assert.equal(candidate.intent, '换用 esbuild 打包');
  assert.equal(candidate.abandoned, '保留 tsc 做完整编译');
  assert.equal(candidate.reason, 'tsc 增量构建太慢');
  assert.equal(candidate.missingReason, false);
  // 原话与确认两句都在候选里，任何下游都能重新读上下文。
  assert.deepEqual(candidate.quote, {
    user: '构建太慢了，换掉 tsc',
    assistant: '那就用 esbuild 打包，tsc 只留类型检查'
  });
  assert.equal(candidate.partial, false);
  assert.equal(candidate.projectId, 'alpha');
  assert.equal(candidate.status, 'proposed');
  assert.deepEqual(
    candidate.evidence.map((ref) => [ref.role, ref.index, ref.sessionId, ref.at]),
    [
      ['user', 0, 's1', '2026-11-20T10:00:00.000Z'],
      ['assistant', 1, 's1', '2026-11-20T10:00:05.000Z']
    ]
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].user.text, '构建太慢了，换掉 tsc');
  assert.equal(calls[0].assistant.text, '那就用 esbuild 打包，tsc 只留类型检查');
  assert.equal(view.empty, false);
});

test('只有用户原话：仍然提议，但标成不完整且只带一条证据', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [fragment({ role: 'user', text: '日志里别打 token' })],
    extract: echoExtract
  });

  const [candidate] = view.candidates;
  assert.equal(view.candidates.length, 1);
  assert.equal(candidate.partial, true);
  assert.equal(candidate.quote.user, '日志里别打 token');
  assert.equal(candidate.quote.assistant, '');
  assert.equal(candidate.evidence.length, 1);
  assert.equal(candidate.evidence[0].role, 'user');
});

test('缺理由：留空并单独标记，不填占位词', () => {
  const extract = () => ({ phenomenon: '切到单线程', intent: '先跑通', abandoned: '', reason: '   ' });
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '这版先别并发了' }),
      fragment({ role: 'assistant', text: '好，先单线程跑通' })
    ],
    extract
  });

  const [candidate] = view.candidates;
  assert.equal(candidate.reason, '');
  assert.equal(candidate.missingReason, true);
  // 理由是空的，但意图仍完整：缺的只有理由这一项。
  assert.equal(candidate.intent, '先跑通');
});

test('注入的环境上下文与系统历史被跳过，不计入候选', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '<environment_context>\n<cwd>D:\\work\\alpha</cwd>\n</environment_context>' }),
      fragment({ role: 'user', text: '环境上下文：当前目录 D:\\work\\alpha，操作系统 Windows' }),
      fragment({ role: 'user', text: '# System history\n1. 之前聊过构建' }),
      fragment({ role: 'user', text: '依赖锁文件别动' }),
      fragment({ role: 'assistant', text: '<environment_context><cwd>D:\\work\\alpha</cwd></environment_context>' })
    ],
    extract: echoExtract
  });

  // 注入的三条不是用户原话，注入的助手那条也不能当成确认：剩下一对不完整候选。
  assert.equal(view.candidates.length, 1);
  assert.equal(view.candidates[0].partial, true);
  assert.equal(view.skipped.injected, 4);
  assert.equal(view.skipped.ignored, 0);
});

test('同内容只出一条：指纹按原话正文与项目，时间戳不同也算同一条', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    sessionId: 's1',
    fragments: [
      fragment({ role: 'user', text: '错误日志别写进仓库', at: '2026-11-20T10:00:00.000Z' }),
      fragment({ role: 'assistant', text: '加到 .gitignore' }),
      fragment({ role: 'user', text: '错误日志别写进仓库', at: '2026-11-21T08:00:00.000Z' }),
      fragment({ role: 'assistant', text: '加到 .gitignore' })
    ],
    extract: echoExtract
  });

  assert.equal(view.candidates.length, 1);
  assert.equal(view.skipped.duplicate, 1);
  // 指纹本身不含时间：同一句话换个时刻仍是同一条。
  assert.equal(
    view.candidates[0].fingerprint,
    decisionFingerprint({ projectId: 'alpha', text: '错误日志别写进仓库' })
  );
});

test('重复里先不完整、后成对：保留成对那条，不留下半条', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '别引入 ORM' }),
      fragment({ role: 'user', text: '别引入 ORM' }),
      fragment({ role: 'assistant', text: '好，继续用裸 SQL' })
    ],
    extract: echoExtract
  });

  assert.equal(view.candidates.length, 1);
  assert.equal(view.candidates[0].partial, false);
  assert.equal(view.candidates[0].quote.assistant, '好，继续用裸 SQL');
});

test('同一句话属于不同项目：两条候选，指纹不同', () => {
  const fragments = [
    fragment({ role: 'user', text: '别引入 ORM' }),
    fragment({ role: 'assistant', text: '好，继续用裸 SQL' })
  ];
  const alpha = draftDecisions({ projectId: 'alpha', fragments, extract: echoExtract });
  const beta = draftDecisions({ projectId: 'beta', fragments, extract: echoExtract });

  assert.equal(alpha.candidates.length, 1);
  assert.equal(beta.candidates.length, 1);
  assert.notEqual(alpha.candidates[0].fingerprint, beta.candidates[0].fingerprint);
});

test('已有决策的指纹命中：直接跳过，不调提炼器', () => {
  const calls = [];
  const extract = (pair) => {
    calls.push(pair);
    return { phenomenon: 'x', intent: '', abandoned: '', reason: '' };
  };
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '错误日志别写进仓库' }),
      fragment({ role: 'assistant', text: '加到 .gitignore' })
    ],
    fingerprints: [decisionFingerprint({ projectId: 'alpha', text: '错误日志别写进仓库' })],
    extract
  });

  assert.deepEqual(view.candidates, []);
  assert.equal(view.skipped.existing, 1);
  assert.equal(view.empty, true);
  // 已知内容不花一次提炼：库里的旧决策不该被重复审一遍。
  assert.equal(calls.length, 0);
});

test('提炼器说不像决策：跳过并计数，不影响其他片段', () => {
  const extract = (pair) => (pair.user.text.includes('颜色') ? null : {
    phenomenon: '锁文件被改',
    intent: '还原锁文件',
    abandoned: '',
    reason: ''
  });
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '这个颜色好看吗' }),
      fragment({ role: 'assistant', text: '还行' }),
      fragment({ role: 'user', text: '锁文件被顺手改了' }),
      fragment({ role: 'assistant', text: '还原它，别提交' })
    ],
    extract
  });

  assert.equal(view.candidates.length, 1);
  assert.equal(view.skipped.rejected, 1);
  assert.equal(view.candidates[0].phenomenon, '锁文件被改');
});

test('提炼器抛错：这一对跳过并计数，批处理不中断', () => {
  const extract = (pair) => {
    if (pair.user.text.includes('炸')) throw new Error('model unavailable');
    return { phenomenon: '改端口', intent: '换 8080', abandoned: '', reason: '' };
  };
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '这条炸一下' }),
      fragment({ role: 'assistant', text: '好' }),
      fragment({ role: 'user', text: '端口改成 8080' }),
      fragment({ role: 'assistant', text: '好，改配置里的默认值' })
    ],
    extract
  });

  assert.equal(view.candidates.length, 1);
  assert.equal(view.skipped.failed, 1);
});

test('工具输出与系统消息不参与配对，也不打断紧随关系', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '把重试次数降到 2' }),
      fragment({ role: 'tool', text: 'patched config.mjs' }),
      fragment({ role: 'system', text: '系统提示：保持简洁' }),
      fragment({ role: 'assistant', text: '已把默认重试次数改为 2' })
    ],
    extract: echoExtract
  });

  const [candidate] = view.candidates;
  assert.equal(view.candidates.length, 1);
  assert.equal(candidate.partial, false);
  assert.equal(candidate.quote.assistant, '已把默认重试次数改为 2');
  assert.equal(candidate.evidence[1].index, 3);
  assert.equal(view.skipped.ignored, 2);
});

test('只有助手片段：不凭自说自话造候选', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [fragment({ role: 'assistant', text: '我建议改成单线程' })],
    extract: echoExtract
  });

  assert.deepEqual(view.candidates, []);
  assert.equal(view.skipped.orphanAssistant, 1);
});

test('连续两条用户原话：先那条不完整，后那条与紧随的助手成对', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '顺序别乱' }),
      fragment({ role: 'user', text: '顺序别乱，按时间排' }),
      fragment({ role: 'assistant', text: '按时间升序' })
    ],
    extract: echoExtract
  });

  assert.equal(view.candidates.length, 2);
  assert.equal(view.candidates[0].partial, true);
  assert.equal(view.candidates[1].partial, false);
});

test('不给提炼器也能跑：只填原话，理由照样空着', () => {
  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [
      fragment({ role: 'user', text: '错误日志别写进仓库' }),
      fragment({ role: 'assistant', text: '加到 .gitignore' })
    ]
  });

  const [candidate] = view.candidates;
  assert.equal(candidate.phenomenon, '错误日志别写进仓库');
  assert.equal(candidate.intent, '');
  assert.equal(candidate.reason, '');
  assert.equal(candidate.missingReason, true);
  assert.equal(candidate.partial, false);
});

test('空输入与异常形状：给空候选，不抛栈', () => {
  assert.deepEqual(draftDecisions().candidates, []);
  assert.equal(draftDecisions().empty, true);

  const view = draftDecisions({
    projectId: 'alpha',
    fragments: [{ role: 'user', text: '' }, null, 'not a fragment', { role: 'user' }],
    extract: echoExtract
  });
  assert.deepEqual(view.candidates, []);
  assert.equal(view.empty, true);
  assert.equal(view.skipped.ignored, 4);
});

test('指纹只认正文与项目：空白差异归一，项目不同则不同', () => {
  const sparse = decisionFingerprint({ projectId: 'alpha', text: '  错误日志\n别写进仓库  ' });
  const normal = decisionFingerprint({ projectId: 'alpha', text: '错误日志 别写进仓库' });
  assert.equal(sparse, normal);
  assert.notEqual(normal, decisionFingerprint({ projectId: 'beta', text: '错误日志 别写进仓库' }));
});
