// 已废弃（#111 撤旧壳）：会话扫描页是旧面板知识档的一部分，旧壳删除后没有入口。
//
// 原脚本验证：扫描候选入库前脱敏，原文秘密不出现。
// 替代覆盖：脱敏由 tests/redact.test.mjs 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-redaction.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
