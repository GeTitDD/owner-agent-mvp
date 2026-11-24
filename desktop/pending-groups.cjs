// 专注模式「待办」分组的纯函数：只决定分组与哪一组默认展开，不碰 DOM。
//
// 为什么单独一个文件：#39 的折叠规则以前埋在 renderPending 里，没有任何自动化测试；
// 抽出来后「首组展开」的语义可以被明确测住。
// 语义：首组 = 第一条待办所属项目，不是项目列表里的第一个项目。
// 待办顺序本身就是紧急度顺序，第一个项目可能根本没有待办，按项目顺序展开会打开空组。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerPendingGroups），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerPendingGroups = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /**
   * 按项目分组待办。
   * - 组顺序跟随待办出现顺序；
   * - 只有一个项目时不折叠（single=true），由渲染层退化成普通列表；
   * - 多组时只展开首组。
   */
  const groupPending = (pending) => {
    const list = Array.isArray(pending) ? pending : [];
    const groups = [];
    const byProject = new Map();
    for (const item of list) {
      const projectId = String(item?.projectId || '');
      let group = byProject.get(projectId);
      if (!group) {
        group = {
          projectId,
          name: item?.projectName || projectId || '未命名项目',
          items: [],
          open: false
        };
        byProject.set(projectId, group);
        groups.push(group);
      }
      group.items.push(item);
    }
    if (groups.length > 1) groups[0].open = true;
    return { single: groups.length === 1, groups };
  };

  return { groupPending };
});
