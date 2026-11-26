// 已废弃（#111 撤旧壳）：决策确认面板是旧面板知识页的一部分，旧壳删除后没有入口。
//
// 原脚本验证：扫描候选确认前不写库、状态流转。
// 替代覆盖：决策由 tests/decision-confirm.test.mjs、tests/decision-draft.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-decisions.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
