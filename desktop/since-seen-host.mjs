// 把 src/memory/since-last-seen.mjs 的纯函数挂到 window，供经典脚本 panel.js 调用。
//
// 为什么要这一层：panel.js 是普通脚本（<script src>），无法 import ESM；而「首次查看」
// 「三类全空压成一行」这类判定只允许有一份（sinceSeenSection），不能在渲染里抄第二套。
// 与 focus-ops-host.mjs 同一套做法：模块脚本把纯函数原样搬到 window，渲染层只画 DOM。
//
// 时序：模块脚本晚于经典脚本执行。panel.js 第一次渲染时可能还读不到，读不到就跳过这一帧；
// 挂载完成后发一次事件，面板若正停在专注页会补画。
import { sinceSeenSection } from '../src/memory/since-last-seen.mjs';

window.OwnerSinceSeen = Object.freeze({ sinceSeenSection });
window.dispatchEvent(new Event('owner-since-seen-ready'));
