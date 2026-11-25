// 同步执行器（#130）：把 #129 算出的计划真正执行一遍，但顺序写死——先拉，再推。
//
// ADR-0013 的三条硬规矩落在这里：
// 1. 不先拉就推等于拿旧副本覆盖；所以拉取是第一步，拉失败就整场停下，不推任何东西。
// 2. 冲突不自动合并：计划里只要还有「两边都改过」的条目，就停在确认，不推送任何东西
//    （已经完成的拉取照旧生效）。人四选一：远端覆盖本地 / 本地覆盖远端 / 两段都留着 / 跳过。
// 3. 「跳过」只跳过这一篇：其余照常推送，跳过的这篇在本地留一条「未解决」标记；
//    下次同步开始时把标记读回来，仍然提示，直到人给出选择。
//
// 本文件不自己碰 git、不自己读盘：拉取、推送、读写文档、存「未解决」清单全部由 deps 注入,
// 测试用假实现断言「顺序、参数、副作用」，不需要真仓库，也不会写用户的目录。
// 凭证只从环境变量读（GITHUB_TOKEN / GH_TOKEN），本文件只回答「配没配、从哪个变量读」，
// 不回显值，也不把值传给 deps：真正的 git 实现自己去读环境变量。
//
// 返回形状统一四态：ok / conflict / unconfigured / error。失败一律带 step + code + message，
// 不静默：读不到「未解决」清单、拉取网络错误、推送被拒，调用方都拿得到一个能显示的原因。

/** 冲突四选一。顺序固定，界面按这个顺序排按钮。 */
export const SYNC_CHOICES = Object.freeze(['remote', 'local', 'both', 'skip']);

/** 四选一的人读标签；判定与文案共用同一份事实，别处不要再起别名。 */
export const SYNC_CHOICE_LABELS = Object.freeze({
  remote: '远端覆盖本地',
  local: '本地覆盖远端',
  both: '两段都留着',
  skip: '跳过（记未解决）'
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const textOf = (value) => (typeof value === 'string' ? value.trim() : '');

/** id 排序不依赖语言环境：同一份输入每次得到同一份结果。 */
const compareId = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** 去重 + 按 id 排序：拉取/推送的参数顺序由 id 决定，不由调用顺序决定。 */
const orderedIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(textOf).filter(Boolean))]
  .sort(compareId);

/** 错误压成一行一句话：git stderr / 异常信息可能带换行，界面只显示一行。 */
const describe = (error) => String(error?.message ?? error ?? '')
  .split(/\r?\n/u)[0]
  .trim();

/** 时间统一成 ISO 串；测试可传固定时刻，Date 也认，解析不了就退回当前时间。 */
const stampOf = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return new Date().toISOString();
};

/**
 * 凭证来源：只回答「配没配、从哪个环境变量读」，绝不回显值。
 * 空串按「没有」处理——空 token 不等于已配置，否则失败会变成一次莫名的 401。
 *
 * @param {{env?: object}} [input]
 * @returns {{configured: boolean, source: string}}
 */
export function syncCredential({ env = globalThis.process?.env ?? {} } = {}) {
  const candidates = ['GITHUB_TOKEN', 'GH_TOKEN'];
  for (const name of candidates) {
    if (String(env?.[name] ?? '').trim()) return { configured: true, source: name };
  }
  return { configured: false, source: '' };
}

/** 把「未解决」清单归一化：认不出 id 的丢弃，attempts 缺省 0，不猜别的。 */
const normalizeUnresolved = (list) => {
  const markers = new Map();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!isObject(raw)) continue;
    const id = textOf(raw.id);
    if (!id) continue;
    const attempts = Number(raw.attempts);
    markers.set(id, {
      id,
      reason: textOf(raw.reason) || 'conflict-skipped',
      since: textOf(raw.since),
      attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
      local: raw.local ?? null,
      remote: raw.remote ?? null
    });
  }
  return [...markers.values()].sort((left, right) => compareId(left.id, right.id));
};

/**
 * 列出本地「未解决」清单：只做归一化，不碰计划，也不改任何东西。
 * 界面单独显示「未解决」时用它；下次 runSync 读同一个来源，所以两边不会各说各话。
 *
 * @param {{deps?: object}} [input]
 * @returns {Promise<object[]>} 归一化后的标记（按 id 排序）；没有注入读取实现时返回空清单
 */
export async function listUnresolved({ deps = {} } = {}) {
  if (typeof deps.loadUnresolved !== 'function') return [];
  return normalizeUnresolved(await deps.loadUnresolved());
}

/**
 * 本次需要人回答的条目：计划里的冲突 + 上次跳过的「未解决」标记。
 *
 * 标记优先用计划里更新的两侧摘要；计划没再列成冲突的，用标记里存的两侧摘要继续提示。
 * 这正是「跳过只影响该篇，下次同步仍会提示」的实现点：提示不依赖计划重新判冲突。
 *
 * @param {object} plan syncPlan 的输出
 * @param {object[]} [unresolved] 本地「未解决」清单
 * @returns {Array<{id: string, reason: string, local: object|null, remote: object|null, attempts: number}>}
 */
export function pendingOf(plan, unresolved = []) {
  const markers = new Map(normalizeUnresolved(unresolved).map((marker) => [marker.id, marker]));
  const pending = [];
  const seen = new Set();

  for (const conflict of Array.isArray(plan?.conflicts) ? plan.conflicts : []) {
    const id = textOf(conflict?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const marker = markers.get(id);
    pending.push({
      id,
      reason: textOf(conflict?.reason) || 'both-changed',
      local: conflict?.local ?? null,
      remote: conflict?.remote ?? null,
      attempts: marker?.attempts ?? 0
    });
  }

  for (const marker of markers.values()) {
    if (seen.has(marker.id)) continue;
    seen.add(marker.id);
    pending.push({
      id: marker.id,
      reason: marker.reason,
      local: marker.local,
      remote: marker.remote,
      attempts: marker.attempts
    });
  }

  return pending.sort((left, right) => compareId(left.id, right.id));
}

/** 把 Markdown 拆成「块」：空行分段，块内空白保留原样去掉首尾。 */
const blocksOf = (value) => String(value ?? '')
  .replace(/\r\n/gu, '\n')
  .split(/\n{2,}/u)
  .map((block) => block.trim())
  .filter(Boolean);

/** 最长公共子序列：文档不大，块级比对足够；结果确定，不依赖 diff 工具。 */
const commonBlocks = (left, right) => {
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
};

/** 一段块加上来源标注：读的人一眼看得出这几段是从哪边留的。 */
const annotated = (label, blocks) => [
  `<!-- 来源：${label} 开始 -->`,
  blocks.join('\n\n'),
  `<!-- 来源：${label} 结束 -->`
].join('\n\n');

/**
 * 「两段都留着」：按块拼接两份正文，相同的块只留一份，不同的块分段标注来源。
 *
 * 不做逐行合并、不猜谁对：只保证两边说过的内容都在，且每一段能追溯回哪边。
 *
 * @param {{id?: string, local?: string, remote?: string, at?: string}} input
 * @returns {string} 合并后的 Markdown
 */
export function mergeConflictText({ id = '', local = '', remote = '', at = '' } = {}) {
  const left = blocksOf(local);
  const right = blocksOf(remote);
  if (!left.length && !right.length) return '';

  const header = `<!-- 同步合并：${id || '未命名文档'} · 两段都留${at ? ` · ${at}` : ''} -->`;
  const output = [header];
  const emit = (localOnly, remoteOnly) => {
    if (localOnly.length) output.push(annotated('本地', localOnly));
    if (remoteOnly.length) output.push(annotated('远端', remoteOnly));
  };

  let leftIndex = 0;
  let rightIndex = 0;
  for (const [matchLeft, matchRight] of commonBlocks(left, right)) {
    emit(left.slice(leftIndex, matchLeft), right.slice(rightIndex, matchRight));
    output.push(left[matchLeft]);
    leftIndex = matchLeft + 1;
    rightIndex = matchRight + 1;
  }
  emit(left.slice(leftIndex), right.slice(rightIndex));
  return output.join('\n\n');
}

/** choices 收成 id → 选择；数组、Map、普通对象三种写法都认。 */
const chooseMapOf = (choices) => {
  const map = new Map();
  const put = (id, value) => {
    const key = textOf(id);
    if (key) map.set(key, textOf(value));
  };
  if (choices instanceof Map) {
    for (const [id, value] of choices) put(id, value);
  } else if (Array.isArray(choices)) {
    for (const entry of choices) {
      if (isObject(entry)) put(entry.id, entry.choice);
    }
  } else if (isObject(choices)) {
    for (const [id, value] of Object.entries(choices)) put(id, value);
  }
  return map;
};

/** 调用注入的拉取/推送：异常与 `{ok:false}` 都折成同一个失败形状，原因不吞。 */
const attempt = async (step, run, payload) => {
  try {
    const outcome = await run(payload);
    if (isObject(outcome) && outcome.ok === false) {
      return {
        ok: false,
        code: textOf(outcome.code) || `${step}-failed`,
        message: textOf(outcome.message) || '没有给出原因'
      };
    }
    return { ok: true, outcome: isObject(outcome) ? outcome : {} };
  } catch (error) {
    return { ok: false, code: `${step}-failed`, message: describe(error) || '未知原因' };
  }
};

/** 读一份正文：undefined 视为「没读到」，空串是合法的空文档。 */
const readText = async (read, id, label) => {
  try {
    const value = await read(id);
    if (value === undefined) return { ok: false, message: `${label}没有返回内容` };
    return { ok: true, text: String(value) };
  } catch (error) {
    return { ok: false, message: describe(error) || '未知原因' };
  }
};

const writeText = async (write, id, content, label) => {
  try {
    await write(id, content);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: describe(error) || '未知原因' };
  }
};

/** 一条处置记录：进会话的是它（调用方把它追加进会话即可，本文件不碰会话存储）。 */
const recordOf = (id, choice) => ({
  id,
  choice,
  summary: {
    remote: '远端覆盖本地：本地文件已替换为远端内容，本次不再推送这一篇。',
    local: '本地覆盖远端：已排入本次推送。',
    both: '两段都留着：已按块拼接并标注来源，结果排入本次推送。',
    skip: '跳过：只跳过这一篇，本地记「未解决」，下次同步仍会提示。'
  }[choice]
});

/**
 * 执行一次同步：先拉，再判断冲突，最后推送。
 *
 * 返回 `status`：
 * - `ok`：拉取与（需要时的）推送都完成，冲突都已处置；
 * - `conflict`：停在冲突确认，不推送任何东西；`missing` 是还缺选择的 id，
 *   `pending` 是全部待确认条目（含上次跳过的）；
 * - `unconfigured`：缺 GITHUB_TOKEN / GH_TOKEN，什么都没做；
 * - `error`：某一步失败，带 `step` / `code` / `message`。
 *
 * @param {object} input
 * @param {object} input.plan syncPlan 的输出（status 必须是 ok）
 * @param {object|Map|Array} [input.choices] 冲突选择：`{ [id]: 'remote'|'local'|'both'|'skip' }`
 * @param {object} [input.deps] 注入的依赖（见下）
 * @param {string|Date} [input.at] 本次时刻（测试可固定）
 * @param {object} [input.deps.env] 环境变量（默认 process.env，凭证只从这里读）
 * @param {(p: {pull: string[], archived: string[]}) => Promise<object>} input.deps.pull
 * @param {(p: {ids: string[]}) => Promise<object>} input.deps.push
 * @param {(id: string) => Promise<string>} [input.deps.readLocal]
 * @param {(id: string) => Promise<string>} [input.deps.readRemote]
 * @param {(id: string, content: string) => Promise<void>} [input.deps.writeLocal]
 * @param {() => Promise<object[]>} [input.deps.loadUnresolved]
 * @param {(list: object[]) => Promise<void>} [input.deps.saveUnresolved]
 * @returns {Promise<object>}
 */
export async function runSync({ plan, choices = {}, deps = {}, at } = {}) {
  const atText = stampOf(at);
  const empty = {
    pulled: [], pushed: [], resolved: [], records: [], unresolved: [], pending: []
  };
  const failed = (step, code, message, extra = {}) => ({
    status: 'error',
    step,
    code,
    message,
    ...empty,
    ...extra,
    text: `同步失败（${step}）：${message}`
  });

  if (!isObject(plan)) {
    return failed('plan', 'invalid-plan', '缺少同步计划，本次什么都没做。');
  }
  if (plan.status !== 'ok') {
    return failed(
      'plan',
      'plan-unavailable',
      textOf(plan.unavailableText) || '同步计划算不出来（缺少本地或远端清单），本次什么都没做。'
    );
  }

  const credential = syncCredential({ env: deps.env ?? globalThis.process?.env ?? {} });
  if (!credential.configured) {
    return {
      ...empty,
      status: 'unconfigured',
      step: 'auth',
      code: 'auth-missing',
      message: '缺少 GITHUB_TOKEN（或 GH_TOKEN），同步没有开始。',
      pending: pendingOf(plan, []),
      text: '同步未开始：缺少 GITHUB_TOKEN（或 GH_TOKEN），凭证只从环境变量读。'
    };
  }

  const choiceMap = chooseMapOf(choices);
  const invalidChoices = [...choiceMap.entries()]
    .filter(([, value]) => !SYNC_CHOICES.includes(value))
    .map(([id]) => id)
    .sort(compareId);
  if (invalidChoices.length) {
    return failed(
      'choice',
      'invalid-choice',
      `有认不出的选择：${invalidChoices.join('、')}；只接受 ${SYNC_CHOICES.join(' / ')}。本次什么都没做。`
    );
  }

  if (typeof deps.pull !== 'function') {
    return failed('pull', 'missing-dependency', '没有注入拉取实现，本次什么都没做（不假装拉过了）。');
  }
  if (typeof deps.push !== 'function') {
    return failed('push', 'missing-dependency', '没有注入推送实现，本次什么都没做。');
  }

  let unresolved = [];
  if (typeof deps.loadUnresolved === 'function') {
    try {
      unresolved = normalizeUnresolved(await deps.loadUnresolved());
    } catch (error) {
      // 读不到「未解决」清单就不敢往下走：否则可能把上次跳过的东西当成已解决。
      return failed('unresolved', 'unresolved-load-failed', `读不到「未解决」清单：${describe(error) || '未知原因'}`);
    }
  }

  // 待确认清单只由计划与本地的「未解决」标记决定，不依赖拉取结果；先算出来，
  // 好在动任何东西之前就发现「跳过却存不下」这种缺依赖。
  const pending = pendingOf(plan, unresolved);
  const skipNeedsSave = pending.some((entry) => choiceMap.get(entry.id) === 'skip');
  const needsSave = unresolved.length > 0 || skipNeedsSave;
  if (needsSave && typeof deps.saveUnresolved !== 'function') {
    return failed('unresolved', 'missing-dependency', '「未解决」清单需要更新，但没有注入保存实现；本次什么都没做。');
  }

  // 第一步：拉。拉取参数只含计划里要拉的条目；冲突条目不在这里动，留给人的选择。
  const pullIds = orderedIds((plan.updated ?? []).filter((entry) => entry?.direction === 'pull').map((entry) => entry?.id));
  const archivedIds = orderedIds((plan.archived ?? []).map((entry) => entry?.id));
  const pullCall = await attempt('pull', deps.pull, { pull: pullIds, archived: archivedIds });
  if (!pullCall.ok) {
    return failed('pull', pullCall.code, pullCall.message, { pending });
  }
  const pulled = Array.isArray(pullCall.outcome.pulled)
    ? orderedIds(pullCall.outcome.pulled)
    : [...pullIds, ...archivedIds].sort(compareId);

  // 第二步：冲突闸门。还有人不选，就停在确认，一个字节也不推。
  const missing = pending.filter((entry) => !choiceMap.has(entry.id));
  if (missing.length) {
    return {
      ...empty,
      status: 'conflict',
      step: 'conflict',
      code: 'awaiting-choice',
      pulled,
      pending,
      unresolved,
      missing: missing.map((entry) => entry.id),
      text: `同步停在冲突确认：还有 ${missing.length} 篇没有选择（${missing.map((entry) => entry.id).join('、')}），本次未推送任何内容。`
    };
  }

  // 第三步：执行选择。先全部算完并落盘，再决定推什么；中途失败就带着已做的记录返回。
  const markers = new Map(unresolved.map((marker) => [marker.id, marker]));
  const pushQueue = new Set([
    ...(plan.added ?? []).map((entry) => textOf(entry?.id)),
    ...(plan.updated ?? []).filter((entry) => entry?.direction === 'push').map((entry) => textOf(entry?.id))
  ].filter(Boolean));
  const records = [];
  const resolved = [];

  for (const entry of pending) {
    const choice = choiceMap.get(entry.id);

    if (choice === 'skip') {
      markers.set(entry.id, {
        id: entry.id,
        reason: 'conflict-skipped',
        since: atText,
        attempts: (markers.get(entry.id)?.attempts ?? 0) + 1,
        local: entry.local,
        remote: entry.remote
      });
      records.push(recordOf(entry.id, choice));
      resolved.push({ id: entry.id, choice, queued: false });
      continue;
    }

    if (choice === 'local') {
      markers.delete(entry.id);
      pushQueue.add(entry.id);
      records.push(recordOf(entry.id, choice));
      resolved.push({ id: entry.id, choice, queued: true });
      continue;
    }

    // remote / both 都要读正文，缺哪块依赖就现在说清楚。
    if (typeof deps.writeLocal !== 'function' || typeof deps.readRemote !== 'function'
      || (choice === 'both' && typeof deps.readLocal !== 'function')) {
      return failed('choice', 'missing-dependency', `处置「${entry.id}」需要读写文档的注入实现，本次什么都没做。`, {
        pulled, records, resolved
      });
    }

    const remote = await readText(deps.readRemote, entry.id, '远端文档');
    if (!remote.ok) {
      return failed('read-remote', 'read-failed', `读不到「${entry.id}」的远端内容：${remote.message}`, {
        pulled, records, resolved
      });
    }

    let content = remote.text;
    if (choice === 'both') {
      const local = await readText(deps.readLocal, entry.id, '本地文档');
      if (!local.ok) {
        return failed('read-local', 'read-failed', `读不到「${entry.id}」的本地内容：${local.message}`, {
          pulled, records, resolved
        });
      }
      content = mergeConflictText({ id: entry.id, local: local.text, remote: remote.text, at: atText });
      if (!content) {
        return failed('merge', 'merge-empty', `「${entry.id}」两边都是空的，拼不出内容，本次什么都没写。`, {
          pulled, records, resolved
        });
      }
      pushQueue.add(entry.id);
    }

    const written = await writeText(deps.writeLocal, entry.id, content, '本地文档');
    if (!written.ok) {
      return failed('write-local', 'write-failed', `写不进「${entry.id}」：${written.message}`, {
        pulled, records, resolved
      });
    }

    markers.delete(entry.id);
    records.push(recordOf(entry.id, choice));
    resolved.push({ id: entry.id, choice, queued: choice === 'both' });
  }

  const nextUnresolved = [...markers.values()].sort((left, right) => compareId(left.id, right.id));

  // 只有真的需要落盘时才调用：没有「未解决」要记时，不因为缺存储实现就卡住同步。
  if (pending.length && typeof deps.saveUnresolved === 'function') {
    try {
      await deps.saveUnresolved(nextUnresolved);
    } catch (error) {
      return failed('unresolved', 'unresolved-save-failed', `写不进「未解决」清单：${describe(error) || '未知原因'}`, {
        pulled, records, resolved
      });
    }
  }

  // 第四步：推。只有前面全部过关才走到这里；没有要推的就一次都不调用。
  const pushIds = [...pushQueue].sort(compareId);
  let pushed = [];
  if (pushIds.length) {
    const pushCall = await attempt('push', deps.push, { ids: pushIds });
    if (!pushCall.ok) {
      return failed('push', pushCall.code, pushCall.message, {
        pulled, records, resolved, unresolved: nextUnresolved
      });
    }
    pushed = Array.isArray(pushCall.outcome.pushed) ? orderedIds(pushCall.outcome.pushed) : pushIds;
  }

  const parts = [`拉取 ${pulled.length} 篇`, `推送 ${pushed.length} 篇`];
  if (records.length) parts.push(`处置冲突 ${records.length} 篇`);
  return {
    status: 'ok',
    step: 'done',
    code: '',
    message: '',
    pulled,
    pushed,
    resolved,
    records,
    unresolved: nextUnresolved,
    pending: [],
    text: `同步完成：${parts.join('，')}。`
  };
}
