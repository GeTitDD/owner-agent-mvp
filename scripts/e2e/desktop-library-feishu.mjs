// 已废弃（#111 撤旧壳）：发布卡片的投递状态与「重新发送」按钮在旧面板里。
//
// 原脚本验证：发布后发飞书文本卡片、失败可人工重发。
// 替代覆盖：卡片由 tests/project-publish-card.test.mjs 覆盖；新壳 /发布 仍走同一条投递路径。
// 旧面板 panel.html / panel.js / panel.css 已删除，指针停在旧 DOM 上不可能再通过，故整体废弃；
// 需要旧实现时从 git 历史取，不在工作区留不会执行的第二套断言。
console.log('[DEPRECATED] scripts/e2e/desktop-library-feishu.mjs：旧壳已删除（#111），跳过旧 DOM 验收。');
process.exit(0);
