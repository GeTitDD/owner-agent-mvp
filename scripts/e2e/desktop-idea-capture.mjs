// 已废弃（#111 撤旧壳）：灵感收件箱 UI 长在旧面板，旧壳删除后旧 DOM 断言失效。
//
// 原脚本验证：灵感收件箱的捕获入口、来源与时间。
// 替代覆盖：新壳用 /记灵感（e2e:desktop:own-write 覆盖）；状态机由 tests/idea-*.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-idea-capture.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
