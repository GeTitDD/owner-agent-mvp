// 已废弃（#111 撤旧壳）：「提升为知识 / 任务」按钮在旧面板灵感列表里，旧壳删除后没有入口。
//
// 原脚本验证：灵感提升为知识候选或项目队列任务。
// 替代覆盖：提升逻辑由 tests/idea-promote.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-idea-promote.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
