// 已废弃（#111 撤旧壳）：沙箱配置弹窗属于旧面板设置页，旧壳删除后不再存在。
//
// 原脚本验证：缺快照配置 → 创建测试失败 → 补齐后重试。
// 替代覆盖：沙箱判定由 tests/sandbox-*.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-sandbox-config.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
