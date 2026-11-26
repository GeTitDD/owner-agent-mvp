// 已废弃（#111 撤旧壳）：项目库两节、草稿与发布按钮都在旧面板工作区里，旧壳删除后没有旧 DOM。
//
// 原脚本验证：项目库两节、计数、生成草稿、发布版本、空库空态。
// 替代覆盖：新壳用 /项目库 与 /发布 [确认]；业务由 tests/project-library.test.mjs、tests/project-snapshots.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-library.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
