// 已废弃（#111 撤旧壳）：旧工作区入口条 #workProjectBar 已随旧面板删除。
//
// 原脚本验证：工作区顶部项目切换、四个入口计数、交办菜单。
// 替代覆盖：新壳项目胶囊与切换确认由 e2e:desktop:card-projects 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-projects.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
