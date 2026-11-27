// 把 src/memory/sync-status.mjs 的纯函数挂到 window，供经典脚本 shell-header.cjs 使用。
//
// 为什么要这一层：shell-header.cjs 是普通脚本（<script src>），无法 import ESM；
// 而「三态怎么判 / 哪种语气 / 未同步时能不能显示已同步」只允许有一份（syncBadge），
// 不能在渲染里抄第二套。与 card-scope-host.mjs 同一套做法：模块脚本把纯函数原样搬到 window，
// 渲染层只做「调用 + 改 DOM」，状态本身仍由主进程落盘。
//
// 时序：模块脚本晚于经典脚本执行。顶栏第一次渲染时可能还读不到，读不到就先写静态的
// 「未同步」（宁可少说也不写「已同步」）；挂载完成后发一次事件，顶栏补画这一格。
import {
  SYNC_STATES,
  SYNC_TONES,
  applySyncAttempt,
  emptySyncStatus,
  formatSyncTime,
  normalizeSyncStatus,
  syncAttemptText,
  syncBadge,
  syncErrorView,
  syncStatusLine
} from '../src/memory/sync-status.mjs';

window.OwnerSyncStatus = Object.freeze({
  SYNC_STATES,
  SYNC_TONES,
  applySyncAttempt,
  emptySyncStatus,
  formatSyncTime,
  normalizeSyncStatus,
  syncAttemptText,
  syncBadge,
  syncErrorView,
  syncStatusLine
});
window.dispatchEvent(new Event('owner-sync-status-ready'));
