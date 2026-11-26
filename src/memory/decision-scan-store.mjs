// #135 决策扫描的本地状态文件（userData/memory-scan.json）。
//
// 只存一份 JSON，与 #86 的会话扫描共用；多了两块：
// - pending：还没处理的决策候选（人接受 / 拒绝之前一直留着，重启也在）；
// - rejected：人拒绝过的指纹（同内容不再提）。
//
// 这里只管读写与容错，状态怎么变由 decision-scan.mjs 的纯函数决定。
// 文件坏了 / 不存在一律按空状态处理：丢的是本地未处理候选，不伪造候选，也不碰知识库。
// 本文件不联网、不写项目目录、不调模型。

import fs from 'node:fs';
import path from 'node:path';
import { normalizeDecisionScanState } from './decision-scan.mjs';

const DEFAULTS = {
  // 未处理候选与拒绝名单都要有上限，防止一份 JSON 无限长；超了丢最旧的。
  sessions: 5000,
  fingerprints: 5000,
  pending: 500,
  rejected: 2000
};

export class DecisionScanStore {
  constructor({ file = '', limits = {} } = {}) {
    this.file = String(file ?? '');
    this.limits = { ...DEFAULTS, ...limits };
  }

  /** 读状态：文件不存在、读不出来或形状不对都按空状态处理，不抛错。 */
  read() {
    if (!this.file) return normalizeDecisionScanState({});
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, '');
      return normalizeDecisionScanState(JSON.parse(raw), this.limits);
    } catch {
      return normalizeDecisionScanState({});
    }
  }

  /** 写状态：先归一（去重、截断、补缺省），再落盘；失败只抛给调用方记录。 */
  write(state) {
    const normalized = normalizeDecisionScanState(state, this.limits);
    if (!this.file) return normalized;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
  }

  /** 读 → 纯函数改 → 写；返回写入后的状态与函数结果由调用方自己组织。 */
  update(change) {
    const next = change(this.read());
    this.write(next);
    return this.read();
  }
}
