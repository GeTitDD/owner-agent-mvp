// 对话模式的「交办」开关：纯函数，不读配置、不碰 DOM、不发请求。
//
// 为什么单独一个文件：这个开关决定一句输入走哪条互斥路径——
// 关（默认）＝只读会话只回答；开＝走既有审批链路（companion:submit）生成待批准任务。
// 开关是一次性动作而不是设置项：不写 localStorage、不写 companion.json，进程内保存即可。
// 双份导出：浏览器当普通脚本加载（挂到 window.OwnerChatHandoff），Node 测试用 require 读。
(function attach(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OwnerChatHandoff = api;
})(typeof globalThis === 'undefined' ? null : globalThis, () => {
  /** 默认关闭：没按开关时，发送永远只是提问。 */
  const DEFAULT_ARMED = false;

  /**
   * 发送路由：唯一决定「要不要建任务」的地方。
   * 只有显式打开开关才走交办，其它任何值都退回只回答，避免状态漏写变成偷偷建任务。
   */
  const routeOf = (armed) => (armed === true ? 'handoff' : 'answer');

  /**
   * 交办目标沿用 #41 的规则：必须是这次会话显式绑定的项目，而且项目还在。
   * 会话没绑定项目、项目已被删，都返回 null，由调用方拦下并提示，绝不静默回退到第一个项目。
   */
  const targetOf = (projects, session) => {
    const id = String(session?.projectId ?? '');
    if (!id) return null;
    return (Array.isArray(projects) ? projects : []).find((item) => item?.id === id) ?? null;
  };

  /** 发送按钮文案：打开时写「交办」，让「这次会建任务」在按下之前就看得见。 */
  const sendLabel = (armed) => (armed === true ? '交办' : '发送');

  /**
   * 一次性开关的消费结果：发送过一次就复位。
   * consumed 表示这次发送确实用掉了开关，调用方据此复位界面按钮。
   */
  const consume = (armed) => ({ armed: false, consumed: armed === true });

  /**
   * 把 companion:submit 的结果收敛成三类，界面只按类型说话：
   * - task：真的生成了待批准任务（写请求）；
   * - answer：分诊判断不需要改文件，只给结论，没有任务；
   * - error：分诊/创建失败，也没有任务。
   */
  const resultKind = (result) => {
    const mode = String(result?.mode ?? '');
    if (mode === 'write-request') return 'task';
    if (mode === 'answer') return 'answer';
    return 'error';
  };

  return { DEFAULT_ARMED, routeOf, targetOf, sendLabel, consume, resultKind };
});
