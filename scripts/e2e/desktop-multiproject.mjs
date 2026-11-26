// 已废弃（#111 撤旧壳）：多项目待办 / 阶段 / 结果挤在旧面板的操作区，操作区随旧壳删除。
//
// 原脚本验证：多项目 pending / stage / 结果只显示当前项目。
// 替代覆盖：项目切换由 e2e:desktop:card-projects 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-multiproject.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
