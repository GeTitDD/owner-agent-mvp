// 模型失败后的恢复卡：只指向原问题，不再复制一份正文；重试动作只由受控分类决定。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerChatRecovery = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  const TITLES = Object.freeze({
    'no-model': '先连接一个模型', 'unknown-model': '需要重新选择模型', 'auth-error': '模型凭据不可用',
    'network-error': '模型连接中断', 'quota-exceeded': '模型额度或频率受限', timeout: '这次回答超时',
    'empty-response': '模型没有返回内容', 'session-error': '这次回答未完成',
    'readonly-violation': '只读校验未通过', 'question-too-long': '问题超过长度限制',
    'skill-unavailable':'指定技能已不可用', 'unknown-skill': '没有找到指定技能', 'no-project': '项目暂时不可用'
  });
  const modelCategories = new Set(['no-model', 'unknown-model', 'auth-error', 'quota-exceeded', 'empty-response', 'session-error', 'network-error', 'timeout']);
  const normalize = (input = {}) => {
    const category = Object.hasOwn(TITLES, input.category) ? input.category : 'session-error';
    const sourceSeq = Number(input.sourceSeq);
    const valid = Number.isSafeInteger(sourceSeq) && sourceSeq > 0;
    const actions = [];
    if (modelCategories.has(category)) actions.push({ id: 'configure', label: '模型设置' });
    if (valid && modelCategories.has(category)) actions.push({ id: 'retry', label: '重试原问题' });
    if (valid && category !== 'readonly-violation') actions.push({ id: 'restore', label: '取回问题' });
    return { type: 'chat-recovery', category, sourceSeq: valid ? sourceSeq : 0,
      projectId: String(input.projectId ?? ''), skillId: String(input.skillId ?? ''), skillPrefix: String(input.skillPrefix ?? ''),
      title: TITLES[category], actions,
      note: category === 'readonly-violation' ? '已中止本次请求。请先排查只读工具配置，再继续使用。'
        : '原问题保存在会话中。重试不会清除当前草稿，也不会重复添加问题。' };
  };
  return { normalize };
});
