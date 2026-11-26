// 已废弃（#111 撤旧壳）：设置向导与操作区下钻位置随旧壳删除。
//
// 原脚本验证：设置向导搬进设置面板、答案落到操作区。
// 替代覆盖：配置由 e2e:desktop:config-box 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-focus-relocate.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
