// 已废弃（#111 撤旧壳）：专注档、详情卡与工作区入口条随旧壳删除（src/focus-ops.mjs 一并删除）。
//
// 原脚本验证：四个入口计数搬进工作区、详情卡删除后的 DOM。
// 替代覆盖：执行状态判定由 tests/execution-status.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-focus-entries.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
