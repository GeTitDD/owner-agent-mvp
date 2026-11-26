// 已废弃（#111 撤旧壳）：导出按钮与路径提示长在旧面板项目库段里。
//
// 原脚本验证：发布后固定目录里出现 snapshot.json 与 report.html。
// 替代覆盖：导出由 tests/project-exports.test.mjs 覆盖；新壳 /发布 回执会写导出路径。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-library-export.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
