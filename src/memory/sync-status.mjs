// 同步状态（#131）：把「同步执行器返回了什么」翻译成顶栏能显示的三态。
//
// 为什么单独一层：#130 的 runSync 返回的是「这一次发生了什么」（ok / conflict / unconfigured / error），
// 界面需要的是「本地副本现在算不算同步过」。两者不是一回事——第一次就失败既不是「已同步」，
// 也不是「同步过又离线」，所以三态写成：
//   - `synced`：最后一次尝试成功，且之后没有再失败；
//   - `unsynced`：曾经成功同步过，但最近一次尝试没有成功（断网、推送被拒……）；
//   - `unknown`：从来没有成功同步过（没试过、或试过但每次都没成功）。
// 「没试过」与「试过但失败」都落在 unknown，靠 `failure` 是否为 null 区分，不会混成一句「未同步」。
//
// 失败判定完全由执行器的结果形状（status + step + code + message）驱动，这里不探测网络、
// 不读 git、不碰环境变量：注入什么结果，就记什么状态。
//
// 纯函数：不读盘、不读时钟（时刻由调用方传入），测试可以直接喂固定时间。

/** 三态。顺序固定：界面与测试都按这个顺序理解。 */
export const SYNC_STATES = Object.freeze(['synced', 'unsynced', 'unknown']);

/**
 * 三态到界面语气：只有 synced 用绿色（ok）。
 * unsynced 用橙色（warn）表示「要处理」，unknown 用灰色（muted）表示「还没同步过」。
 * 这里把「不假装已同步」落成一条可断言的规则：非 synced 一律不给 ok。
 */
export const SYNC_TONES = Object.freeze({
  synced: 'ok',
  unsynced: 'warn',
  unknown: 'unknown'
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

/** 时刻统一成 UTC ISO；Date、毫秒数、ISO 串都认，认不出返回空串（不把 0 当默认值）。 */
const isoOf = (value) => {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? value.toISOString() : '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? Math.round(value * 1000) : Math.round(value);
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  }
  return '';
};

/** 展示用时间：固定按 UTC 写，不随机器时区变，测试与截图都能复现。 */
export const formatSyncTime = (value) => {
  const iso = isoOf(value);
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
};

/** 从未同步过的空状态；每次返回新对象，调用方改它不会污染别人。 */
export const emptySyncStatus = () => ({
  state: 'unknown',
  lastSuccessAt: '',
  lastAttemptAt: '',
  failure: null
});

/** 失败原因归一化：只留可显示的四项，缺 message 时如实写「没有给出原因」。 */
const failureOf = (raw) => {
  if (!isObject(raw)) return null;
  const code = textOf(raw.code);
  const message = textOf(raw.message) || textOf(raw.text);
  if (!code && !message) return null;
  return {
    code: code || 'sync-failed',
    message: message || '没有给出原因',
    step: textOf(raw.step),
    at: isoOf(raw.at),
    conflict: raw.conflict === true
  };
};

/**
 * 把磁盘上/上次保存的状态归一化。
 *
 * 两条防呆规则：
 * 1. 没有成功过就绝不返回 `synced`——旧文件里写了也不认，宁可显示「未同步」。
 * 2. 失败时刻早于最后一次成功 = 已经恢复，旧失败不压着成功状态（防止乱序写入把标记卡住）。
 *
 * @param {object} [raw]
 * @returns {{state: string, lastSuccessAt: string, lastAttemptAt: string, failure: object|null}}
 */
export function normalizeSyncStatus(raw) {
  const source = isObject(raw) ? raw : {};
  const lastSuccessAt = isoOf(source.lastSuccessAt);
  const lastAttemptAt = isoOf(source.lastAttemptAt) || lastSuccessAt;
  let failure = failureOf(source.failure);
  if (failure && lastSuccessAt && failure.at && Date.parse(failure.at) <= Date.parse(lastSuccessAt)) {
    failure = null;
  }

  let state;
  if (failure) {
    // 最近一次没成功：同步过就是「离线/未同步」，没成功过仍是「从未成功同步」。
    state = lastSuccessAt ? 'unsynced' : 'unknown';
  } else if (lastSuccessAt) {
    state = 'synced';
  } else if (source.state === 'unsynced') {
    state = 'unsynced';
  } else {
    state = 'unknown';
  }

  return { state, lastSuccessAt, lastAttemptAt, failure };
}

/**
 * 记录一次同步尝试：成功就刷新「最后成功时间」并清掉失败；失败就保留上次成功时间、
 * 换上这次的原因。状态只由「有没有成功过 + 这次成没成」决定，不让调用方自己算。
 *
 * @param {object} previous 之前的状态（可为空/坏形状）
 * @param {object} result 执行器返回的形状（`runSync` 的输出；status/step/code/message/text）
 * @param {string|number|Date} [at] 本次时刻（测试固定）
 * @returns {{state: string, lastSuccessAt: string, lastAttemptAt: string, failure: object|null}}
 */
export function applySyncAttempt(previous, result, at = new Date()) {
  const before = normalizeSyncStatus(previous);
  const stamp = isoOf(at) || new Date().toISOString();
  const status = textOf(result?.status);

  if (status === 'ok') {
    return {
      state: 'synced',
      lastSuccessAt: stamp,
      lastAttemptAt: stamp,
      failure: null
    };
  }

  return {
    state: before.lastSuccessAt ? 'unsynced' : 'unknown',
    lastSuccessAt: before.lastSuccessAt,
    lastAttemptAt: stamp,
    failure: {
      // 没给 code 时用本次结果状态起一个名字；连 status 都没有就是一次没有结果的尝试。
      code: textOf(result?.code) || (status ? `${status}-failed` : 'attempt-failed'),
      message: textOf(result?.message) || textOf(result?.text) || '同步没有完成，也没有给出原因。',
      step: textOf(result?.step),
      at: stamp,
      conflict: status === 'conflict'
    }
  };
}

/** 日常反馈只说原因和下一步，底层步骤名与原始错误留在详情中。 */
export function syncFailureSummary(failure) {
  if (!failure) return '';
  const raw = `${failure.code || ''} ${failure.message || ''}`;
  if (failure.code==='preview-pending') return '已发现待同步文档，等待确认';
  if (failure.conflict) return '有文档冲突，等待逐篇确认';
  if (/sync-target-missing/u.test(raw)) return '尚未设置同步仓库';
  if (/401|403|auth|credential|permission|denied|凭据|权限/iu.test(raw)) return '无法验证同步权限，请检查凭据后重试';
  if (/network|unreachable|ECONN|ENOTFOUND|offline|timed?\s*out|timeout|网络|断网/iu.test(raw)) return '连接失败，请联网后重试';
  return '同步未完成，请查看详情后重试';
}

/** IPC 包装与底层 Git 错误只放详情；日常提示保留用户能采取的下一步。 */
export function syncErrorView(error) {
  const raw=String(error?.message ?? error ?? '同步没有返回原因。');
  const detail=raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error): /u,'');
  if(/Git 同步未完成|git-failed|does not appear to be a git repository|could not resolve|unable to access/iu.test(detail)) {
    return {text:'无法连接同步仓库，请检查网络、仓库地址和权限后重新检查。',detail};
  }
  return {text:detail,detail:detail===raw?'':raw};
}

/**
 * 顶栏要画的这一格：标签、语气、一行说明、要不要显示「补同步」。
 *
 * `label` 在非 synced 时永远写「未同步」，不写「已同步」；`tone` 在非 synced 时永远不是 ok，
 * 界面据此着色。`detail` 同时带最后成功时间与失败原因，鼠标悬停能看到完整事实。
 *
 * @param {object} status
 * @returns {{state: string, tone: string, label: string, detail: string, hint: string, retry: boolean, retryLabel: string}}
 */
export function syncBadge(status) {
  const view = normalizeSyncStatus(status);
  const successText = view.lastSuccessAt ? `最后同步 ${formatSyncTime(view.lastSuccessAt)}` : '';
  const technicalReason = view.failure
    ? `${view.failure.step ? `${view.failure.step}：` : ''}${view.failure.message}`
    : '';
  const reason = syncFailureSummary(view.failure);

  if (status?.availability?.mode === 'manual-preview') {
    const ready=status.availability.available;
    const pending=Number(status.count)||0;const unresolved=Number(status.unresolved)||0;
    const clean=ready&&view.state==='synced'&&!pending&&!unresolved;
    return {state:clean?'synced':ready?'unsynced':'local-only',tone:clean?'ok':ready?'warn':'unknown',
      label:clean?'已同步':ready?'待检查':'仅本机',
      detail:!ready?(status.availability.reason==='auth-missing'?'未检测到同步令牌':'尚未设置同步仓库')
        :unresolved?`${unresolved} 篇冲突未解决`:pending?`${pending} 篇本机变化待同步`:reason||successText||'尚未检查远端',
      hint:[reason,technicalReason,successText,'检查后先预览，确认后才传输；远端变化需再次检查'].filter(Boolean).join('；'),
      retry:true,retryLabel:ready?'检查同步':'设置同步',action:'info'};
  }

  if (status?.availability?.available === false) {
    return { state: 'local-only', tone: SYNC_TONES.unknown, label: '仅本机',
      detail: '跨设备同步尚未接入',
      hint: ['当前版本只保存到本机，跨设备同步执行器尚未接入。本机读写照常。', successText,
        technicalReason].filter(Boolean).join('；'),
      retry: true, retryLabel: '了解同步', action: 'info' };
  }

  if (view.state === 'synced') {
    return {
      state: 'synced',
      tone: SYNC_TONES.synced,
      label: '已同步',
      detail: successText,
      hint: successText ? `${successText}，本地与远端一致。` : '已同步。',
      retry: false,
      retryLabel: '补同步'
    };
  }

  if (view.state === 'unsynced') {
    return {
      state: 'unsynced',
      tone: SYNC_TONES.unsynced,
      label: '未同步',
      // 时间放前面：440px 的顶栏放不下长原因时会截断尾部，最后成功时间不能被截掉。
      detail: [successText, reason].filter(Boolean).join(' · '),
      hint: [`未同步：${reason || '本次同步没有完成'}`, successText, technicalReason].filter(Boolean).join('；'),
      retry: true,
      retryLabel: '补同步'
    };
  }

  return {
    state: 'unknown',
    tone: SYNC_TONES.unknown,
    label: '未同步',
    detail: ['从未成功同步过', reason].filter(Boolean).join(' · '),
    hint: ['从未成功同步过，本地读写照常', reason, technicalReason].filter(Boolean).join('；'),
    retry: true,
    retryLabel: '补同步'
  };
}

/** 一行文字版状态：给浮层/回执用，与顶栏同一份判定。 */
export function syncStatusLine(status) {
  const badge = syncBadge(status);
  return badge.detail || badge.label;
}

/**
 * 一次补同步之后给用户的那句话：成功报时间，失败报原因；不把失败说成「已完成」。
 *
 * @param {{status?: object, result?: object}} [outcome] 主进程返回的 `{status, result}`
 * @returns {string}
 */
export function syncAttemptText({ status, result } = {}) {
  const ok = textOf(result?.status) === 'ok';
  if (ok) {
    return textOf(result?.text) || (status?.lastSuccessAt
      ? `同步完成，${formatSyncTime(status.lastSuccessAt)}。`
      : '同步完成。');
  }
  const reason = syncFailureSummary({ ...result, conflict: result?.status === 'conflict' }) || '请稍后重试';
  return `补同步未完成：${reason}`;
}
