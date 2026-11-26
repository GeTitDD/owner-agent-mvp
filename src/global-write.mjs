// 全局模式的写入判定：全局只读，写项目目录必须先选项目。
//
// 为什么要单独一层：ADR-0012 的 writeGate 只回答「写到哪里」；#107 多了一个前置条件——
// 当前是全局模式时「正在看的项目」为空，任何落到项目目录的写入都没有落点，
// 必须先选项目。这一层不重复实现分级，只在前面加一条硬前置，然后原样交给 writeGate。
//
// 边界（照 ADR-0012，别在这里加第二种说法）：
// - destination='project' 且没有选项目 → 拒绝，理由固定为「先选项目」；
// - destination='own'（写本机自有库，例如会话消息）→ 仍按 writeGate 放行：
//   全局模式「不写入任何项目」，不等于「不能写自己的库」，否则连对话都存不下来；
// - 外发 / 删除 / 已授权项目目录 / 未知目的地 → 一律走 writeGate，行为与项目模式一致。
//
// 本文件是纯函数：不读盘、不读环境变量、不持有状态。

import { writeGate, writeScopeLabel } from './write-gate.mjs';

/** 全局模式下写项目目录的统一拒绝理由：顶栏、闸门与以后的确认卡共用这一句。 */
export const GLOBAL_WRITE_DENIED = '当前是全局模式（没有选项目）：全局只读跨项目记忆，先选一个项目，才能写入项目目录。';

/** 「正在看的项目」是否为空（空 = 全局）。 */
export const isGlobalScope = (viewProjectId) => String(viewProjectId ?? '').trim().length === 0;

/**
 * 判定一次写入。
 *
 * @param {object} [input]
 * @param {string} [input.viewProjectId] 正在看的项目；空串即全局
 * @param {'own'|'project'|'external'} [input.destination] 写到哪里
 * @param {boolean} [input.deletes] 本次动作是否包含删除
 * @param {{ project?: boolean }} [input.granted] 当前会话的项目目录授权
 * @returns {{outcome: 'allow'|'confirm'|'deny', reason: string, scope: string}}
 */
export function globalWriteOutcome({
  viewProjectId = '', destination, deletes = false, granted = {}
} = {}) {
  // 前置：没有项目就没有项目目录写入的落点。先拦这一条，避免「反正要确认」把它放过去。
  if (isGlobalScope(viewProjectId) && destination === 'project') {
    return { outcome: 'deny', reason: GLOBAL_WRITE_DENIED, scope: 'global' };
  }
  return writeGate({ destination, deletes, granted });
}

/**
 * 顶栏写范围这一格写什么。
 * 全局模式是一种独立形态（不是「写·自有」）——它读的是项目，但一个项目也不写。
 *
 * @param {object} [input]
 * @param {string} [input.viewProjectId] 正在看的项目；空串即全局
 * @param {{ project?: boolean }} [input.granted] 当前会话的项目目录授权
 * @returns {{label: string, scope: 'global'|'own'|'project', granted: boolean, hint: string}}
 */
export function writeScopeText({ viewProjectId = '', granted = {} } = {}) {
  if (isGlobalScope(viewProjectId)) {
    return {
      label: '只读·全局',
      scope: 'global',
      granted: false,
      hint: '全局模式只读项目记忆：要写项目目录先选项目；会话消息仍写在本机自有库（ADR-0012）。'
    };
  }
  const inner = writeScopeLabel({ granted });
  return {
    label: inner.label,
    scope: inner.scope,
    granted: inner.granted,
    hint: inner.hint
  };
}
