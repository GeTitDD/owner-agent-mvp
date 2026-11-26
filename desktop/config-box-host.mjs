// 把 src/config-box.mjs 的分区数据与来源规则挂到 window，供经典脚本 shell-config.cjs 使用。
//
// 为什么要这一层：shell-config.cjs 是普通脚本（<script src>），无法 import ESM；
// 而「七行分区 + 来源标注」的数据只允许有一份（src/config-box.mjs，单测也只测那一份），
// 不能让渲染层再抄一套。与 card-scope-host.mjs / write-gate-host.mjs 同一套做法：
// 模块脚本把纯函数原样搬到 window，渲染层只做「调用 + 画 DOM」。
//
// 时序：模块脚本晚于经典脚本执行。配置箱是点了才开，所以渲染层在打开那一刻再读
// window.OwnerConfigBox；读不到就明说「数据模块未加载」，不画半张空箱子。
// 这里不持有状态：当前值留在主进程的 companion.json。
import {
  SECRET_LABELS, SECTIONS, SOURCE, SOURCE_LABELS,
  buildRows, displayOf, editableRows, listText, patchForSave, resolveSource, rowById, secretStateOf
} from '../src/config-box.mjs';

window.OwnerConfigBox = Object.freeze({
  SECRET_LABELS,
  SECTIONS,
  SOURCE,
  SOURCE_LABELS,
  buildRows,
  displayOf,
  editableRows,
  listText,
  patchForSave,
  resolveSource,
  rowById,
  secretStateOf
});
window.dispatchEvent(new Event('owner-config-box-ready'));
