// 同步状态的落盘（#131）：一个很小的 JSON 文件，跟着 userData 走，重启后仍在。
//
// 为什么不用 SQLite：这里只有一条记录（三态 + 两个时间 + 一个失败原因），
// 没有查询需求，也没有和别的表的关系。JSON 文件坏了/不存在就当作「从未成功同步过」，
// 不会因为读不出状态就挡住本地读写——这正是离线可用的前提。
//
// 判定全部在 sync-status.mjs：本文件只做「读出来归一化 / 写回去」，不自己算状态。
import fs from 'node:fs';
import path from 'node:path';
import { emptySyncStatus, normalizeSyncStatus } from './sync-status.mjs';

export class SyncStatusStore {
  /**
   * @param {{file?: string}} [options] 状态文件路径（桌面端指向 <userData>/sync-status.json）
   */
  constructor({ file = '' } = {}) {
    const target = typeof file === 'string' ? file.trim() : '';
    if (!target) throw new Error('缺少同步状态的存储路径');
    this.file = target;
  }

  /** 读状态；文件不存在、读不了、JSON 坏了一律按「从未成功同步过」处理。 */
  read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, '');
      return normalizeSyncStatus(JSON.parse(raw));
    } catch {
      return emptySyncStatus();
    }
  }

  /** 写状态：先写临时文件再改名，避免写一半留下坏 JSON。 */
  save(status) {
    const value = normalizeSyncStatus(status);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
    return value;
  }
}
