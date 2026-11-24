// 专注/对话模式的项目选择：纯函数，不读配置、不碰 DOM、不发请求。
//
// 为什么单独一个文件：取消「当前项目」之后，有两个容易混淆的概念要能脱离界面验证——
// 「视图项目」（没选时默认第一个，只用于展示）和「交办目标」（必须显式选，没选就不许发）。
// 两者互不影响：看 A 项目不代表要交办到 A，反过来也一样。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerPanelSelection），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerPanelSelection = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const listOf = (projects) =>
    (Array.isArray(projects) ? projects : []).filter((item) => item && item.id);

  /** 按 id 找项目；找不到返回 null。所有「按 id 取项目」都走这里，不再各写一份。 */
  const findProject = (projects, id) => {
    const key = String(id ?? '');
    if (!key) return null;
    return listOf(projects).find((item) => item.id === key) ?? null;
  };

  /**
   * 视图项目：显式选过且项目还在就用它，否则默认第一个；都没有时返回 null。
   * 这层默认只决定「看什么」，不代表用户做了选择，也不写回任何配置。
   */
  const viewProject = (projects, selectedId) => {
    const list = listOf(projects);
    if (!list.length) return null;
    return findProject(list, selectedId) ?? list[0];
  };

  /**
   * 交办目标：只有显式选过、且项目仍然存在才算数。
   * 没选或项目已删都返回 null——调用方必须拦下发送，不能悄悄退回第一个。
   */
  const submitProject = (projects, selectedId) =>
    findProject(projects, selectedId) ?? null;

  /** 交办按钮上的项目名；没选时给出明确的「未选项目」。 */
  const targetLabel = (project) => {
    if (!project) return '未选项目';
    return String(project.name || project.id || '').trim() || '未选项目';
  };

  return { findProject, viewProject, submitProject, targetLabel };
});
