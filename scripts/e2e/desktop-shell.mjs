// 已废弃（#111 撤旧壳）：旧壳外壳验收（面板显隐、设置页、模型切换）指向 panel.html，旧壳已删除。
//
// 原脚本验证：桌宠定位、面板显隐、重启后任务、模型切换、添加项目。
// 替代覆盖：新壳启动与会话由 e2e:desktop:card-shell 覆盖，配置由 e2e:desktop:config-box 覆盖。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-shell.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
