// #114 自有目录写入的唯一入口：判定 → 执行 → 回执。
//
// ADR-0012 把写入按目的地分级：自有目录（会话、草稿、水位、队列、导出）默认放行，
// 不打扰。但「不打扰」不等于「不留痕」——每次写入成功或失败都要在对话流里留一条
// 可复制的回执：写了什么、结果是什么；失败要带原因，不能静默。
//
// 这一版只做「自有目录 + 不删除」这一段：
// - 判定复用 src/write-gate.mjs，不在这里抄第二套规则；
// - 调用方声明删除时，判定给的是 confirm——那属于 #116 的确认路径。本入口不执行、
//   不留「已写入」回执，只把判定原样交回，避免「自有目录免确认」被顺手扩大成
//   「删除也免确认」；
// - 回执用 #109 的键值块，复制沿用 #110 的既有能力，不新增渲染路径；
// - 未知动作一律不执行（看不懂的动作比放行危险），与 write-gate 对未知目的地的态度一致。
//
// 本文件是纯函数：不读盘、不联网、不读环境变量。真正写库的那一步（写 ideas 表、
// 写快照草稿……）由调用方注入的 execute 完成，所以测试不需要临时库。

import { writeGate } from './write-gate.mjs';

/**
 * 自有目录的五类写入，与 ADR-0012 的「会话、草稿、水位、队列、导出」一一对应。
 * 别处不要再起别名：注册表是判定、回执文案与测试共用的同一份事实。
 */
export const OWN_WRITE_ACTIONS = Object.freeze({
  idea: Object.freeze({ key: 'idea', label: '记灵感', needsText: true, writeTo: 'ideas 表' }),
  draft: Object.freeze({ key: 'draft', label: '生成草稿', needsText: false, writeTo: '快照草稿' }),
  watermark: Object.freeze({ key: 'watermark', label: '写水位', needsText: false, writeTo: '水位表' }),
  enqueue: Object.freeze({ key: 'enqueue', label: '入队', needsText: false, writeTo: '项目队列' }),
  export: Object.freeze({ key: 'export', label: '导出', needsText: false, writeTo: '导出目录' })
});

/** 动作清单：表驱动测试与界面提示都按它遍历，不手抄第二份。 */
export const OWN_WRITE_KINDS = Object.freeze(Object.keys(OWN_WRITE_ACTIONS));

/** 记灵感的命令前缀；/idea 是同一件事的英文别名，方便输入法外的人。 */
export const OWN_WRITE_COMMAND = '/记灵感';
const COMMAND_PATTERN = /^\/(?:记灵感|idea)(?:\s+([\s\S]*))?$/u;

const stamp = () => new Date().toISOString();

/**
 * 取一个自有目录动作；不认识就返回 null。
 * @param {unknown} kind
 * @returns {{key: string, label: string, needsText: boolean, writeTo: string} | null}
 */
export function ownWriteAction(kind) {
  return OWN_WRITE_ACTIONS[String(kind ?? '')] ?? null;
}

/**
 * 「这个动作要不要确认」——单一判定，复用 write-gate，不重复实现规则。
 *
 * @param {object} [input]
 * @param {string} [input.kind] 自有目录动作（idea / draft / watermark / enqueue / export）
 * @param {boolean} [input.deletes] 调用方声明本次是否含删除（默认不含）
 * @param {{project?: boolean}} [input.granted] 当前会话授权；自有目录不看它，原样传下去
 * @returns {{
 *   allowed: boolean, needsConfirm: boolean, denied: boolean,
 *   action: object | null,
 *   gate: {outcome: 'allow'|'confirm'|'deny', reason: string, scope: string}
 * }}
 */
export function ownWriteDecision({ kind, deletes = false, granted = {} } = {}) {
  const action = ownWriteAction(kind);
  if (!action) {
    // 未注册的动作不落到 write-gate 上：gate 只认目的地，认不出「这个动作是什么」。
    return {
      allowed: false,
      needsConfirm: false,
      denied: true,
      action: null,
      gate: {
        outcome: 'deny',
        reason: `未知的自有目录动作「${String(kind ?? '')}」，一律不执行：看不懂的动作比放行危险。`,
        scope: 'unknown'
      }
    };
  }
  const gate = writeGate({ destination: 'own', deletes, granted });
  return {
    allowed: gate.outcome === 'allow',
    needsConfirm: gate.outcome === 'confirm',
    denied: gate.outcome === 'deny',
    action,
    gate
  };
}

/**
 * 一条回执的数据形状：对话流里的一条普通回复 `{ text, blocks }`。
 *
 * 为什么用键值块而不是新块类型：写回执只回答「写了什么、结果如何」，
 * 键值块（#109）既能读也能复制，不需要为一个动作新增渲染分支。
 *
 * @param {object} input
 * @param {object} input.action 已注册的动作（OWN_WRITE_ACTIONS 里的一项）
 * @param {boolean} input.ok 是否写成
 * @param {string} [input.wrote] 写了什么（例如「ideas 表 · 1 条」）
 * @param {string} [input.result] 结果 / 版本号 / 条目 id
 * @param {string} [input.reason] 失败原因（成功时忽略）
 * @param {string} [input.at] 时间；缺省取当前时间（测试可固定）
 * @returns {{text: string, blocks: object[]}}
 */
export function ownWriteReceipt({
  action, ok, wrote = '', result = '', reason = '', at = stamp()
} = {}) {
  const label = action?.label ?? '写入';
  const target = action?.writeTo ?? '自有目录';
  const rows = [
    ['动作', label],
    // 判定写进回执：读的人不用翻规则就知道这次为什么没被拦。
    ['判定', '自有目录 · 不删除 → 直接放行'],
    ['写入', ok ? (wrote || target) : '未写入（0 处）'],
    ['结果', ok ? (result || '成功') : '失败']
  ];
  if (!ok) rows.push(['原因', String(reason ?? '').trim() || '没有给出原因']);
  rows.push(['时间', String(at)]);
  return {
    text: ok
      ? `写入回执（自有目录）：${label}已写入 ${wrote || target}${result ? `，${result}` : ''}。`
      : `写入回执（自有目录）：${label}没有写成：${String(reason ?? '').trim() || '没有给出原因'}`,
    blocks: [{
      type: 'kv',
      title: ok ? `写入回执 · ${label}` : `写入回执 · ${label}（失败）`,
      rows
    }]
  };
}

/**
 * 统一入口：判定 → 执行 → 回执。
 *
 * 三种结局，调用方据此决定画什么：
 * - 放行且写成：`ok: true`，带成功回执；
 * - 放行但写失败（含缺正文 / 没有注入写入实现）：`ok: false`，带回执，原因写在回执里；
 * - 不放行（声明删除、需要确认、未知动作）：`blocked: true`、`receipt: null`，
 *   交给 #116 的确认路径处理，不在这里执行，也不伪造一条「已写入」的回执。
 *
 * @param {object} input
 * @param {string} input.kind 动作
 * @param {string} [input.text] 需要正文的动作（记灵感）的正文
 * @param {(payload: {kind: string, text: string, action: object}) => Promise<object>} [input.execute]
 *   真正写库的一步；返回 `{ wrote, result }`，抛错即视为写失败
 * @param {boolean} [input.deletes] 调用方声明是否含删除
 * @param {{project?: boolean}} [input.granted] 当前会话授权
 * @param {string} [input.at] 时间（测试可固定）
 * @returns {Promise<{ok: boolean, blocked: boolean, needsConfirm: boolean,
 *   decision: object, receipt: {text: string, blocks: object[]} | null}>}
 */
export async function runOwnWrite({
  kind, text = '', execute, deletes = false, granted = {}, at
} = {}) {
  const decision = ownWriteDecision({ kind, deletes, granted });
  const base = {
    ok: false,
    blocked: !decision.allowed,
    needsConfirm: decision.needsConfirm,
    decision,
    receipt: null
  };
  if (!decision.allowed) return base;

  const action = decision.action;
  const payload = { kind: action.key, text: String(text ?? '').trim(), action };
  const fail = (reason) => ({
    ...base,
    receipt: ownWriteReceipt({ action, ok: false, reason, at })
  });

  // 缺正文不调用 execute：少写一次比写一条空灵感好，原因照样进回执。
  if (action.needsText && !payload.text) {
    return fail(`${action.label}需要一句正文，这次什么都没写。`);
  }
  if (typeof execute !== 'function') {
    return fail('没有可用的写入实现，这次什么都没写。');
  }

  try {
    const outcome = await execute(payload);
    return {
      ...base,
      ok: true,
      receipt: ownWriteReceipt({
        action,
        ok: true,
        wrote: String(outcome?.wrote ?? '').trim(),
        result: String(outcome?.result ?? '').trim(),
        at
      })
    };
  } catch (error) {
    // 失败必须带原因回到对话流：不吞掉异常，也不假装写成功。
    return fail(String(error?.message ?? error ?? '').trim() || '未知原因');
  }
}

/**
 * 把输入框里的一句话解析成自有目录动作。
 *
 * 语法：`/记灵感 <正文>`，别名 `/idea <正文>`。其余输入返回 null（走普通消息），
 * 所以这条命令不会误吃掉正常聊天。正文为空也返回动作——入口会给出「需要正文」的
 * 失败回执，比回一条占位回复更说得清发生了什么。
 *
 * @param {unknown} input
 * @returns {{kind: string, text: string} | null}
 */
export function parseOwnWriteCommand(input) {
  const match = COMMAND_PATTERN.exec(String(input ?? '').trim());
  if (!match) return null;
  return { kind: 'idea', text: String(match[1] ?? '').trim() };
}
