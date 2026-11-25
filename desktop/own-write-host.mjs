// 把 src/own-write.mjs 的纯函数挂到 window，供经典脚本 shell.js 调用。
//
// 为什么需要这一层：shell.js / shell-thread.cjs 都是普通脚本（<script src>），
// 没法 import ESM；而「自有目录写入的判定与回执」只允许有一份（#114）。
// 与 write-gate-host.mjs / focus-ops-host.mjs 同一套做法：模块脚本把纯函数原样搬到
// window，渲染层只做「调用 + 画 DOM」。
//
// 时序：模块脚本晚于经典脚本执行，所以 shell.js 在真正发送时才读 window.OwnerOwnWrite；
// 读不到就当场给出可见提示，不留下「点了没反应」的状态。挂载完成后发一次事件，
// 需要补画的界面可以据此补一次。
import { OWN_WRITE_ACTIONS, OWN_WRITE_KINDS, OWN_WRITE_COMMAND, ownWriteAction, ownWriteDecision, ownWriteReceipt, runOwnWrite, parseOwnWriteCommand } from '../src/own-write.mjs';

window.OwnerOwnWrite = Object.freeze({
  OWN_WRITE_ACTIONS,
  OWN_WRITE_KINDS,
  OWN_WRITE_COMMAND,
  action: ownWriteAction,
  decide: ownWriteDecision,
  receipt: ownWriteReceipt,
  run: runOwnWrite,
  parseCommand: parseOwnWriteCommand
});
window.dispatchEvent(new Event('owner-own-write-ready'));
