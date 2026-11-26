// 把 src/setup-probe.mjs 的纯函数挂到 window，供经典脚本 shell-config.cjs / shell-compose.cjs 使用。
//
// 为什么要这一层：两个经典脚本都加载不了 ESM；而「/setup 命令解析、判定文案、取消回执」
// 只允许有一份（src/setup-probe.mjs，单测也只测那一份）。与 config-box-host.mjs 同一套做法：
// 模块脚本把纯函数原样搬到 window，渲染层只做「调用 + 画 DOM」。
//
// 时序：模块脚本晚于经典脚本。输入区在发送时才读 window.OwnerSetupProbe；
// 探测结果由主进程算好（真实文件系统在主进程），这里只搬展示与取消回执要用的纯函数。
import {
  SETUP_COMMAND,
  SETUP_PATH_KEYS,
  VERDICT,
  VERDICT_LABELS,
  isSetupCommand,
  parseSetupCommand,
  setupCancelReceipt,
  summarizeProbe
} from '../src/setup-probe.mjs';

window.OwnerSetupProbe = Object.freeze({
  SETUP_COMMAND,
  SETUP_PATH_KEYS,
  VERDICT,
  VERDICT_LABELS,
  isCommand: isSetupCommand,
  parseCommand: parseSetupCommand,
  cancelReceipt: setupCancelReceipt,
  summarize: summarizeProbe
});
window.dispatchEvent(new Event('owner-setup-probe-ready'));
