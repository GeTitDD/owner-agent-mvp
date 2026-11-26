// 已废弃（#111 撤旧壳）：知识三档是旧面板的分区，新壳没有档位，旧 DOM 断言全部失效。
//
// 原脚本验证：知识摘要、四个知识请求、知识详情与复用证据。
// 替代覆盖：知识业务模块由 tests/knowledge-*.test.mjs 直接覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-knowledge.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
