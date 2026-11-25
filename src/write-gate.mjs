// 写入闸门：给定「写到哪里、删不删、本次会话授没授权」，回答「放行 / 需确认 / 拒绝」。
//
// 为什么单独一个文件：ADR-0012 把「Agent 能不能写」从开关改成按目的地分级，规则只有四条，
// 但会被顶栏、确认卡（#113）、实际写入（#114–#116）反复引用。判定必须先落在一处，
// 否则每个调用方都会顺手补一句「自己的例外」，最后一个入口一个说法。
//
// 本文件是纯函数：不读盘、不联网、不读环境变量、不持有状态。
// 授权按会话（ADR-0012）：调用方把「当前会话的授权」传进来，换会话就是换一份入参，
// 这里不做记忆、不落库——重置授权是调用方不传 granted 的结果，不是本函数的副作用。
// 本票只做判定与顶栏文案（#112），确认卡与风险评估是 #113，真正写文件是 #114–#116。
//
// 判定表（严格照 ADR-0012；顺序固定：先看目的地，再看是否删除）：
//
//   目的地      删除   授权       结果
//   自有目录    否     任意       放行
//   自有目录    是     任意       确认（删除永远逐次确认，授权不解除）
//   项目目录    否     未授权     确认（要写就一次一申请）
//   项目目录    否     已授权     放行
//   项目目录    是     任意       确认（删除永远逐次确认）
//   外发        否     任意       确认（发出即不可逆，永不放行）
//   外发        是     任意       确认
//   未知        -      -          拒绝（未知比放行安全）
//
// 「删除」是横切的：它不改变目的地，只把该行的结果压到 confirm——外发与项目目录本来也
// 不是 allow，所以删除只对「自有目录」与「已授权项目目录」有可观察的收紧作用。
// 未知目的地按 deny 处理，且优先于删除判定：看不懂的目的地不该因为「反正要确认」而被放行到确认卡。

/** 三类已知目的地：与 ADR-0012 的写范围一一对应，别处不要再起别名。 */
const DESTINATIONS = new Set(['own', 'project', 'external']);

/** 目的地在理由文案里的中文称呼；未知目的地单独一句，不冒充三类之一。 */
const DESTINATION_LABELS = Object.freeze({
  own: '自有目录',
  project: '项目目录'
});

/**
 * 会话授权是否覆盖项目目录。
 * 只认严格 true：'true'、1 之类的「看起来像授权」不算，宁可多一次确认。
 * @param {object} granted 当前会话的授权（形状 { project: boolean }）
 * @returns {boolean}
 */
const projectGranted = (granted) => granted?.project === true;

/**
 * 删除标记是否成立。
 * 这里取「真值即删除」：调用方多传了 'true'、1 也只是多一次确认，不会漏掉删除。
 * @param {unknown} deletes
 * @returns {boolean}
 */
const deleting = (deletes) => Boolean(deletes);

/**
 * 判定一次写入。
 *
 * @param {object} [input]
 * @param {'own'|'project'|'external'} [input.destination] 写到哪里
 * @param {boolean} [input.deletes] 本次动作是否包含删除（调用方声明，默认不含）
 * @param {{ project?: boolean }} [input.granted] 当前会话的授权；缺省即未授权
 * @returns {{outcome: 'allow'|'confirm'|'deny', reason: string, scope: string}}
 *   outcome 三值：allow 直接放行 / confirm 出确认卡 / deny 直接拒绝；
 *   scope 是归一化后的目的地（未知为 'unknown'），顶栏与回执按它取词。
 */
export function writeGate({ destination, deletes = false, granted = {} } = {}) {
  const scope = typeof destination === 'string' && DESTINATIONS.has(destination)
    ? destination
    : 'unknown';

  // ① 目的地看不懂：直接拒绝。放在删除判定之前，避免「反正要确认」把未知放过去。
  if (scope === 'unknown') {
    return {
      outcome: 'deny',
      reason: `未知目的地「${String(destination ?? '')}」，一律拒绝：看不懂的写范围比放行危险。`,
      scope
    };
  }

  // ② 删除是横切动作：任何目的地、任何授权，都逐次确认（ADR-0012「删除永远逐次确认」）。
  if (deleting(deletes)) {
    return {
      outcome: 'confirm',
      reason: `包含删除：删除需逐次确认（目的地：${DESTINATION_LABELS[scope]}），会话授权不解除删除确认。`,
      scope
    };
  }

  // ③ 按目的地分级。自有目录默认放行，不打扰。
  if (scope === 'own') {
    const grantedNow = projectGranted(granted);
    return {
      outcome: 'allow',
      reason: grantedNow
        ? '自有目录默认放行（本次会话另有项目目录授权，不影响自有目录）。'
        : '自有目录默认放行：写自己的库不产生对外后果，不打扰。',
      scope
    };
  }

  // ④ 项目目录：按会话授权，未授权就一次一申请。
  if (scope === 'project') {
    return projectGranted(granted)
      ? {
        outcome: 'allow',
        reason: '项目目录已授权（仅本次会话），且本次不含删除。',
        scope
      }
      : {
        outcome: 'confirm',
        reason: '项目目录（被观察仓库）未授权：要写就一次一申请，授权只在本次会话有效。',
        scope
      };
  }

  // ⑤ 外发：发出即不可逆，永远要确认，授权也不放行。
  return {
    outcome: 'confirm',
    reason: '外发（离开本机）发出即不可逆，需逐次确认；外发授权不持久化。',
    scope
  };
}

/**
 * 顶栏的写范围文案：只读当前会话授权，不参与判定。
 * 判定仍在上面的 writeGate，这里只回答「顶栏这一格写什么」。
 *
 * 两种形态（ADR-0012：项目目录授权按会话）：
 * - 未授权：`写·自有`，scope='own'；
 * - 已授权：`项目目录已授权`，scope='project'。
 * 外发不放行，所以顶栏没有第三种形态。
 *
 * @param {object} [input]
 * @param {{ project?: boolean }} [input.granted] 当前会话的授权
 * @returns {{label: string, scope: 'own'|'project', granted: boolean, hint: string}}
 */
export function writeScopeLabel({ granted = {} } = {}) {
  if (projectGranted(granted)) {
    return {
      label: '项目目录已授权',
      scope: 'project',
      granted: true,
      hint: '本次会话已授权写项目目录；删除与外发仍需逐次确认'
    };
  }
  return {
    label: '写·自有',
    scope: 'own',
    granted: false,
    hint: '只能写自有目录；项目目录要一次一申请，外发与删除逐次确认'
  };
}
