// 把 src/write-gate.mjs 的纯函数挂到 window，供经典脚本 panel.js 调用。
//
// 为什么要这一层：panel.js 是普通脚本（<script src>），无法 import ESM；而「写到哪儿放行、
// 哪儿要确认」的规则只允许有一份（ADR-0012 的 writeGate），不能让渲染层抄第二套判定。
// 与 focus-ops-host.mjs / since-seen-host.mjs 同一套做法：模块脚本把纯函数原样搬到 window，
// 渲染层只做「调用 + 画 DOM」。这里不持有授权状态——授权按会话，留在调用方（panel.js）内存里。
//
// 时序：模块脚本晚于经典脚本执行。panel.js 第一次渲染时可能还读不到，读不到就用默认
// 「写·自有」；挂载完成后发一次事件，面板补画顶栏那一格。
import { writeGate, writeScopeLabel } from '../src/write-gate.mjs';

window.OwnerWriteGate = Object.freeze({ writeGate, writeScopeLabel });
window.dispatchEvent(new Event('owner-write-gate-ready'));
