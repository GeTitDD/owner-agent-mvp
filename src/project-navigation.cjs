// 项目导航只选择独立会话；跨项目查看仍走原来的显式确认，不在这里改历史归属。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerProjectNavigation = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const idOf = (value) => String(value ?? '').trim();
  const viewOf = (session) => idOf(session?.viewProjectId ?? session?.projectId);
  const recentAt = (session) => String(session.lastOpenedAt || session.updatedAt || session.createdAt || '');

  /** 置顶影响展示，不应让陈旧或跨项目会话挤掉上次的工作上下文。 */
  const resumeSessionOf = (sessions, projectId) => (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && !session.deletedAt && idOf(session.projectId) === idOf(projectId)
      && viewOf(session) === idOf(projectId))
    .slice().sort((a, b) => recentAt(b).localeCompare(recentAt(a)) || idOf(a.id).localeCompare(idOf(b.id)))[0] ?? null;

  /** 只返回导航意图；空全局会话能否复用，最终仍由存储层校验标题、置顶与草稿。 */
  const projectNavigationPlan = ({ sessions, projectId = '', currentSession = null, hasDraft = false } = {}) => {
    const target = idOf(projectId);
    if (currentSession && !currentSession.deletedAt && idOf(currentSession.projectId) === target && viewOf(currentSession) === target) {
      return { kind: 'stay', sessionId: currentSession.id, projectId: target };
    }
    const existing = resumeSessionOf(sessions, target);
    if (existing) return { kind: 'resume', sessionId: existing.id, projectId: target };
    const emptyGlobal = currentSession && !idOf(currentSession.projectId) && !viewOf(currentSession)
      && !currentSession.deletedAt && !Number(currentSession.messageCount) && !hasDraft;
    return { kind: 'create', projectId: target, reuseEmptyGlobalId: emptyGlobal && target ? currentSession.id : '' };
  };
  return { resumeSessionOf, projectNavigationPlan };
});
