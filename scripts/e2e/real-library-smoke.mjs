// 已废弃（#111 撤旧壳）：真实库冒烟靠旧面板项目库段截图，旧壳删除后无法运行。
//
// 原脚本验证：复制真实 owner 库到临时目录，只读跑项目库并截图。
// 替代覆盖：项目库业务由 tests/project-library.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/real-library-smoke.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
