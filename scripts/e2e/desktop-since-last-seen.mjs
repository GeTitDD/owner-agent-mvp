// 已废弃（#111 撤旧壳）：变化窗口是旧面板的专注页区块，旧 DOM 断言失效。
//
// 原脚本验证：首次查看、水位推进、三类变化的呈现。
// 替代覆盖：新壳用 /变化 命令（回复块在 tests/shell-modules.test.mjs 断言）；判定由 tests/since-last-seen.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-since-last-seen.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
