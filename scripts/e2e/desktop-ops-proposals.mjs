// 已废弃（#111 撤旧壳）：操作区（待办 / 待提炼 / 运行中）整体删除，旧 DOM 与跳转都不在了。
//
// 原脚本验证：未提炼提议提示与「去提炼」跳转。
// 替代覆盖：提议信号由 tests/knowledge-ipc.test.mjs 与 tests/on-demand.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-ops-proposals.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
