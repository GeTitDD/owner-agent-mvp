// #116 外发与删除单独一档：把一个动作拆成「几次确认」，顺序固定。
//
// 为什么单独一个文件：ADR-0012 规定「外发发出即不可逆，另行确认」「删除永远逐次确认」。
// 这两条不是新的判定规则，而是 write-gate 已有结果的两个特例；但「一个动作同时包含
// 写入、删除、外发时应该问几次、以什么顺序问」以前没有落点。如果每个入口自己拼顺序，
// 就会出现「先发后写」这种把不可逆动作放在前面的排法——写失败时东西已经发出去了。
//
// 本文件只做计划，不出卡片、不执行、不读盘：判定一律复用 src/write-gate.mjs，
// 卡片由 desktop/confirm-cards.cjs（外发 / 删除）与 #113 的 risk-card.cjs（写入）负责。
// 顺序只有一条，写在这里而不是调用方：
//
//   写入 → 删除 → 外发
//
// 理由：写入可逆、失败可以重来；删除不可逆，只能逐条确认；外发离开本机、收不回，
// 必须放在最后——前面任何一步取消或失败，都还没发出去。先删后发也说得通（避免发出
// 已删内容），但「发出去就收不回」比「发出后内容又变了」更严重，所以外发仍然压轴。
//
// 判定表（与 write-gate 一致，这里不另判）：
//   外发            → 恒 confirm（授权不解除）
//   包含删除        → 恒 confirm（自有目录 / 已授权项目目录也一样）
//   外发 + 删除     → 拆两次，先删后发，两个都不能批量放行

import { writeGate } from './write-gate.mjs';

/** 复合动作的固定顺序；调用方不得重排，测试按这个数组断言。 */
export const CONFIRM_ORDER = Object.freeze(['write', 'delete', 'external']);

/** 为什么是这个顺序：卡片上的说明与代码注释共用同一句，避免两处口径分叉。 */
export const ORDER_REASON = '顺序固定为先写后删再外发：写入可逆、失败可重来；删除不可逆，只能逐条确认；外发离开本机、发出即收不回，放在最后——前面任何一步取消或失败，都还没发出去。';

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * 把一个动作拆成需要确认的步骤。
 *
 * @param {object} [input]
 * @param {'own'|'project'|'external'} [input.destination] 写入目的地；纯外发可给 'external'
 * @param {string[]} [input.writes] 本次要写入的完整路径（逐条，不合并）
 * @param {boolean} [input.deletes] 本次动作是否包含删除（调用方声明）
 * @param {Array<{label?:string, path?:string}>} [input.deleteItems] 将删除的对象（逐条）
 * @param {Array<{label?:string, path?:string}>} [input.sends] 将要外发的内容（逐条）
 * @param {{project?: boolean}} [input.granted] 当前会话的授权
 * @returns {{
 *   confirmations: Array<{kind:'write'|'delete'|'external', outcome:'confirm', reason:string, gate:object, paths?:string[], items?:object[]}>,
 *   blocked: Array<{kind:string, outcome:'deny', reason:string, gate:object}>,
 *   skipped: Array<{kind:string, outcome:'allow', reason:string, gate:object}>,
 *   order: string[],
 *   orderReason: string
 * }}
 *   confirmations 只放真要问的步骤，顺序固定为 写入 → 删除 → 外发；
 *   blocked 非空时调用方不得继续确认任何一步（未知目的地比放行安全）；
 *   skipped 记录「本来要问、但本次会话已授权」的写入，便于回执说清为什么少了一张卡。
 */
export function planConfirmations({
  destination,
  writes = [],
  deletes = false,
  deleteItems = [],
  sends = [],
  granted = {}
} = {}) {
  const writePaths = list(writes).map((item) => String(item ?? '').trim()).filter(Boolean);
  const deleteTargets = list(deleteItems).filter((item) => item && typeof item === 'object');
  const sendTargets = list(sends).filter((item) => item && typeof item === 'object');
  const hasDeletes = deletes === true || deleteTargets.length > 0;
  // 目的地写成 external 与「给了外发清单」是同一件事的两种调用方式。
  const hasExternal = sendTargets.length > 0 || destination === 'external';
  // 外发的「目的地」不是写盘：只有真正写文件时才需要单独的写入确认。
  const hasWrites = writePaths.length > 0 && destination !== 'external';

  const write = { kind: 'write' };
  const remove = { kind: 'delete' };
  const external = { kind: 'external' };

  if (hasWrites) {
    const gate = writeGate({ destination, deletes: false, granted });
    if (gate.outcome === 'confirm') {
      write.outcome = 'confirm';
      write.reason = gate.reason;
      write.gate = gate;
      write.paths = writePaths;
    } else if (gate.outcome === 'deny') {
      write.outcome = 'deny';
      write.reason = gate.reason;
      write.gate = gate;
    } else {
      write.outcome = 'allow';
      write.reason = gate.reason;
      write.gate = gate;
    }
  }

  if (hasDeletes) {
    // 删除的判定不看会话授权：write-gate 对任何已知目的地都返回 confirm。
    const gate = writeGate({ destination, deletes: true, granted });
    remove.outcome = gate.outcome;
    remove.reason = gate.reason;
    remove.gate = gate;
    remove.items = deleteTargets;
  }

  if (hasExternal) {
    // 外发单独判定：目的地恒为 external，deletes 不参与——删除已经单独一步。
    const gate = writeGate({ destination: 'external', deletes: false, granted });
    external.outcome = gate.outcome;
    external.reason = gate.reason;
    external.gate = gate;
    external.items = sendTargets;
  }

  const all = [write, remove, external].filter((item) => item.outcome !== undefined);
  const confirmations = all.filter((item) => item.outcome === 'confirm');
  const blocked = all.filter((item) => item.outcome === 'deny');
  const skipped = all.filter((item) => item.outcome === 'allow');

  return {
    confirmations,
    blocked,
    skipped,
    order: confirmations.map((item) => item.kind),
    orderReason: ORDER_REASON
  };
}
