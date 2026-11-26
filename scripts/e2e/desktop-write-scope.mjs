// 已废弃（#111 撤旧壳）：写范围状态位在旧面板顶栏，旧壳删除后断言的是另一个 DOM。
//
// 原脚本验证：顶栏默认「写·自有」、随会话授权切换。
// 替代覆盖：新壳写范围由 e2e:desktop:card-projects 与 tests/write-gate.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-write-scope.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
