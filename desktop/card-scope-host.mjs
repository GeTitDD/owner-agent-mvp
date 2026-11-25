// 把 src/global-write.mjs 的纯函数挂到 window，供经典脚本 shell.js 使用。
//
// 为什么要这一层：shell.js 是普通脚本（<script src>），无法 import ESM；而「全局只读、
// 写项目先选项目」的判定只允许有一份（globalWriteOutcome），不能让渲染层再抄一套。
// 与 write-gate-host.mjs / focus-ops-host.mjs 同一套做法：模块脚本把纯函数原样搬到 window，
// 渲染层只做「调用 + 画 DOM」。这里不持有状态——正在看的项目留在 shell.js 的内存/会话里。
//
// 时序：模块脚本晚于经典脚本执行。shell.js 第一次渲染时可能还读不到，读不到就先用
// 「全局 / 只读·全局」的静态文案；挂载完成后发一次事件，壳补画写范围那一格。
import { GLOBAL_WRITE_DENIED, globalWriteOutcome, writeScopeText } from '../src/global-write.mjs';

window.OwnerCardScope = Object.freeze({ GLOBAL_WRITE_DENIED, globalWriteOutcome, writeScopeText });
window.dispatchEvent(new Event('owner-card-scope-ready'));
