// 已废弃（#111 撤旧壳）：删除项目入口在旧面板项目库段里；新壳这一版没有对应入口。
//
// 原脚本验证：删除清单、取消不删、确认删干净、跨项目隔离。
// 替代覆盖：删除逻辑由 tests/project-deletion.test.mjs 覆盖；新壳入口留给后续卡片。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-project-delete.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
