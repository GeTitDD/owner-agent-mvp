// #117 监控对象描述符：三类（project / session / github）各一种合法形状，
// 缺字段、未知类型、未知 focus 一律明确拒绝并给出原因，不做兜底猜测。
// 纯函数测试：不碰盘、不碰库。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWatchTarget,
  watchTargetRef,
  WatchTargetError,
  WATCH_TARGET_TYPES,
  SESSION_SOURCES,
  GITHUB_FOCUS
} from '../src/watch/target.mjs';

/** 断言「被拒绝」，并同时检查原因码与原因文案里带上了那个错的值/字段。 */
const rejects = (input, { code, message }) => {
  assert.throws(() => normalizeWatchTarget(input), (error) => {
    assert.ok(error instanceof WatchTargetError, `应当抛 WatchTargetError，实际是 ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
};

test('三类对象的固定词表只写一份', () => {
  assert.deepEqual([...WATCH_TARGET_TYPES], ['project', 'session', 'github']);
  assert.deepEqual([...SESSION_SOURCES], ['codex', 'claude']);
  assert.deepEqual([...GITHUB_FOCUS], ['commits', 'pullRequests', 'issues']);
});

test('project 对象：项目 id 是唯一必填字段，ref 由它派生', () => {
  const target = normalizeWatchTarget({ type: 'project', projectId: '  alpha  ' });
  assert.deepEqual({ ...target }, { type: 'project', ref: 'project:alpha', projectId: 'alpha' });
  // 同一个项目再归一化一次结果不变（存储层会拿归一化结果再进一遍）。
  assert.deepEqual({ ...normalizeWatchTarget(target) }, { ...target });
  assert.equal(Object.isFrozen(target), true);
});

test('project 对象：项目根只作携带，不参与 ref、不读盘', () => {
  const root = 'D:/repos/alpha';
  const target = normalizeWatchTarget({ type: 'project', projectId: 'alpha', root });
  assert.equal(target.root, root);
  assert.equal(target.ref, 'project:alpha');
});

test('session 对象：来源 + 会话 id，来源只认 codex / claude', () => {
  for (const source of SESSION_SOURCES) {
    const target = normalizeWatchTarget({ type: 'session', source, sessionId: ' 0f1e2d3c ' });
    assert.deepEqual({ ...target }, {
      type: 'session', ref: `session:${source}:0f1e2d3c`, source, sessionId: '0f1e2d3c'
    });
  }
  // 未知来源明确拒绝：不猜「也许是 opencode」，也不退回到默认来源。
  rejects({ type: 'session', source: 'opencode', sessionId: 'abc' }, {
    code: 'target-field-invalid',
    message: /未知的会话来源：opencode.*codex \/ claude/u
  });
  rejects({ type: 'session', sessionId: 'abc' }, {
    code: 'target-field-missing',
    message: /session 对象缺少 source/u
  });
  rejects({ type: 'session', source: 'codex' }, {
    code: 'target-field-missing',
    message: /session 对象缺少 sessionId/u
  });
});

test('github 对象：owner/repo + 关注面子集，focus 归一成固定顺序', () => {
  const target = normalizeWatchTarget({
    type: 'github',
    owner: ' Owner ',
    repo: 'Repo',
    focus: ['issues', 'commits', 'commits']
  });
  assert.deepEqual({ ...target }, {
    type: 'github',
    // ref 用小写：同一个仓库换了大小写不该算两个对象，水位不能被拆成两份。
    ref: 'github:owner/repo',
    owner: 'Owner',
    repo: 'Repo',
    nameWithOwner: 'Owner/Repo',
    focus: ['commits', 'issues']
  });
});

test('github 对象：关注面不影响 ref，换关注面仍共用同一份水位', () => {
  const onlyCommits = normalizeWatchTarget({ type: 'github', owner: 'o', repo: 'r', focus: ['commits'] });
  const everything = normalizeWatchTarget({
    type: 'github', owner: 'o', repo: 'r', focus: [...GITHUB_FOCUS]
  });
  assert.equal(onlyCommits.ref, everything.ref);
  assert.deepEqual(everything.focus, [...GITHUB_FOCUS]);
});

test('github 对象：缺字段、非法字符、未知 focus 都明确拒绝', () => {
  rejects({ type: 'github', repo: 'r', focus: ['commits'] }, {
    code: 'target-field-missing', message: /github 对象缺少 owner/u
  });
  rejects({ type: 'github', owner: 'o', focus: ['commits'] }, {
    code: 'target-field-missing', message: /github 对象缺少 repo/u
  });
  rejects({ type: 'github', owner: 'own er', repo: 'r', focus: ['commits'] }, {
    code: 'target-field-invalid', message: /owner 不是合法的 GitHub 账号名：own er/u
  });
  rejects({ type: 'github', owner: 'o', repo: 'r' }, {
    code: 'target-field-missing', message: /github 对象缺少 focus/u
  });
  rejects({ type: 'github', owner: 'o', repo: 'r', focus: [] }, {
    code: 'target-focus-empty', message: /focus 不能为空.*commits \/ pullRequests \/ issues/u
  });
  rejects({ type: 'github', owner: 'o', repo: 'r', focus: 'commits' }, {
    code: 'target-field-invalid', message: /focus 必须是数组/u
  });
  rejects({ type: 'github', owner: 'o', repo: 'r', focus: ['commits', 'stars'] }, {
    code: 'target-focus-unknown', message: /focus 里有未知项：stars.*commits \/ pullRequests \/ issues/u
  });
});

test('未知类型与缺类型都拒绝：原因里写出收到的类型', () => {
  rejects({ type: 'repo', projectId: 'alpha' }, {
    code: 'target-type-unknown', message: /未知的监控对象类型：repo.*project \/ session \/ github/u
  });
  // 原型链上的名字不是类型：constructor / __proto__ 都得被当成未知，而不是落进某个内建对象。
  for (const type of ['constructor', '__proto__', 'toString']) {
    rejects({ type, projectId: 'alpha' }, {
      code: 'target-type-unknown', message: /未知的监控对象类型/u
    });
  }
  rejects({ projectId: 'alpha' }, {
    code: 'target-type-missing', message: /缺少 type.*project \/ session \/ github/u
  });
  rejects({ type: '', projectId: 'alpha' }, {
    code: 'target-type-missing', message: /缺少 type/u
  });
});

test('不是对象就不是描述符：不把字符串或数组猜成一个对象', () => {
  for (const value of [null, undefined, 'project:alpha', 42, ['project']]) {
    rejects(value, { code: 'target-not-object', message: /描述符必须是对象/u });
  }
});

test('project 对象的项目 id 过脏就拒绝，不在 storage 里留下坏键', () => {
  rejects({ type: 'project' }, { code: 'target-field-missing', message: /project 对象缺少 projectId/u });
  rejects({ type: 'project', projectId: '   ' }, { code: 'target-field-missing', message: /缺少 projectId/u });
  rejects({ type: 'project', projectId: 'a'.repeat(91) }, {
    code: 'target-field-invalid', message: /projectId 过长（最多 90 字符）/u
  });
  rejects({ type: 'project', projectId: 'alpha\u0001' }, {
    code: 'target-field-invalid', message: /projectId 含控制字符/u
  });
});

test('watchTargetRef 只是 normalizeWatchTarget 的一层取值，校验行为完全一致', () => {
  assert.equal(watchTargetRef({ type: 'project', projectId: 'alpha' }), 'project:alpha');
  assert.equal(watchTargetRef({ type: 'session', source: 'claude', sessionId: 's1' }), 'session:claude:s1');
  assert.equal(watchTargetRef({ type: 'github', owner: 'o', repo: 'r', focus: ['issues'] }), 'github:o/r');
  assert.throws(() => watchTargetRef({ type: 'nope' }), WatchTargetError);
});
