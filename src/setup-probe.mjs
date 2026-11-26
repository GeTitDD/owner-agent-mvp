// #128 `/setup` 探测与写盘确认（纯函数）。
//
// 流程固定为：探测本机 → 逐项判定 → 建议写入清单 → 一次确认 → 写入 → 回执。
//
// 边界：
// - 本文件不读盘、不读环境变量、不联网、不写文件：证据由调用方注入（env / paths / io），
//   真正建目录与写配置由调用方注入的 mkdir 与 settings 保存完成。测试因此不用临时目录。
// - 探测值只来自「这次看到的本机」；配置里已有的值分两种来源（#127 的同一套标注）：
//   探测（还是上次探测写进去的）与手改（人写过）。合并规则只有一条：**手改优先**，
//   重新探测只更新探测类字段，手改值一个都不覆盖。
// - 判定四档：可用 / 只读 / 缺失 / 需新建。技能目录数量为 0 是「存在但为空」，
//   仍然是可用（或只读），绝不降级成「缺失」。
// - 会写盘的项只有两类：新建自有目录（导出根 / matt 技能目录），以及把探测到的路径
//   写进 companion.json。两者共用一次确认；取消时本文件不产生任何副作用。
// - 密钥只有两件事可展示：候选环境变量名与配没配。值永远不进入返回值。

import { SOURCE, SOURCE_LABELS } from './config-box.mjs';

/** `/setup` 是整句命令，不是技能；解析不中的输入原样走普通消息。 */
export const SETUP_COMMAND = '/setup';

/** 四档判定。界面只认这四个字符串。 */
export const VERDICT = Object.freeze({
  ok: 'ok',
  readonly: 'readonly',
  missing: 'missing',
  create: 'create'
});

export const VERDICT_LABELS = Object.freeze({
  ok: '可用',
  readonly: '只读',
  missing: '缺失',
  create: '需新建'
});

/**
 * 模型密钥的候选环境变量：与 Pi 的提供方凭据同一批名字。
 * 只回答「有没有一个非空值」，不读取、不回传值。
 */
export const MODEL_KEY_ENVS = Object.freeze([
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'OPENCODE_API_KEY',
  'PI_KEY'
]);

/** 会被探测改写的配置键；主进程算「来源」时也用这一份，避免两处名单。 */
export const SETUP_PATH_KEYS = Object.freeze([
  'codexSessions',
  'opencodeData',
  'exportRoot',
  'pstackSkills',
  'mattSkills'
]);

/**
 * 六类探测项。
 * role=own 表示自有目录（可在确认后新建）；role=source 表示只读来源（只扫描，不写）。
 * layout 只对技能目录有意义：pstack 是一级目录，matt 是「分类/技能」两级。
 */
export const PROBE_ITEMS = Object.freeze([
  Object.freeze({
    id: 'modelKey',
    label: '模型密钥',
    kind: 'secret',
    envs: MODEL_KEY_ENVS,
    writeTo: '不写盘：只读环境变量'
  }),
  Object.freeze({
    id: 'codexSessions',
    label: 'Codex 会话目录',
    kind: 'dir',
    role: 'source',
    configKey: 'codexSessions',
    writeTo: 'companion.json · codexSessions'
  }),
  Object.freeze({
    id: 'opencodeData',
    label: 'OpenCode 数据目录',
    kind: 'dir',
    role: 'source',
    configKey: 'opencodeData',
    writeTo: 'companion.json · opencodeData'
  }),
  Object.freeze({
    id: 'exportRoot',
    label: '导出根',
    kind: 'dir',
    role: 'own',
    configKey: 'exportRoot',
    writeTo: '新建目录 + companion.json · exportRoot'
  }),
  Object.freeze({
    id: 'pstackSkills',
    label: 'pstack 技能目录',
    kind: 'skills',
    role: 'source',
    layout: 'flat',
    configKey: 'pstackSkills',
    writeTo: 'companion.json · pstackSkills'
  }),
  Object.freeze({
    id: 'mattSkills',
    label: 'matt 技能目录',
    kind: 'skills',
    role: 'own',
    layout: 'nested',
    configKey: 'mattSkills',
    writeTo: '新建目录 + companion.json · mattSkills'
  })
]);

const COMMAND_PATTERN = /^\/setup(?:\s+([\s\S]*))?$/u;

const textOf = (value) => (value === null || value === undefined ? '' : String(value));
const listOf = (value) => (Array.isArray(value) ? value : []);

/** 拼接路径：跟随基路径的分隔符，不把 Windows 路径混成两种斜杠。 */
const joinPath = (base, name) => {
  const clean = textOf(base).replace(/[\\/]+$/u, '');
  if (!clean) return textOf(name);
  return `${clean}${clean.includes('\\') ? '\\' : '/'}${textOf(name)}`;
};

/**
 * 解析 `/setup`。
 * 只认整句：`/setup` 或 `/setup <备注>`；`/setup-pstack` 不命中，免得吞掉真正的技能命令。
 *
 * @param {unknown} input
 * @returns {{kind: 'setup', arg: string} | null}
 */
export function parseSetupCommand(input) {
  const match = COMMAND_PATTERN.exec(textOf(input).trim());
  if (!match) return null;
  return { kind: 'setup', arg: textOf(match[1]).trim() };
}

export const isSetupCommand = (input) => parseSetupCommand(input) !== null;

/**
 * 某个路径配置键的来源：空值 = 探测；等于上次探测写入的值 = 探测；其余 = 手改。
 *
 * 用「值 vs 上次探测值」而不是「值 vs 内置默认」来判，是因为探测自己也会写值：
 * 若按默认值判，探测写入后就会被误标成手改。这里与 #127 的结论保持一致——
 * 手改优先，重新探测只动探测类字段。
 */
export function setupValueSource({ key, config = {}, probed = {} } = {}) {
  const current = textOf(config?.[key]).trim();
  if (!current) return SOURCE.probe;
  return current === textOf(probed?.[key]).trim() ? SOURCE.probe : SOURCE.manual;
}

/** 目录里的一级子目录名；读不到就当空目录，不抛错（与技能扫描的容错口径一致）。 */
const childDirs = (io, target) => {
  if (typeof io?.listDirs !== 'function') return [];
  try {
    return listOf(io.listDirs(target))
      .map((name) => textOf(name).trim())
      .filter((name) => name && !name.startsWith('.'));
  } catch {
    return [];
  }
};

/**
 * 技能目录计数：matt 是两级（分类被 deprecated 整组跳过），pstack 是一级。
 * 只数目录，不读 SKILL.md：数量只回答「放了几处」，有效性仍由技能面板负责。
 */
export const countSkillDirs = (io, dir, layout = 'flat') => {
  if (!dir) return 0;
  if (layout === 'nested') {
    return childDirs(io, dir)
      .filter((category) => category !== 'deprecated')
      .reduce((sum, category) => sum + childDirs(io, joinPath(dir, category)).length, 0);
  }
  return childDirs(io, dir).length;
};

const verdictItem = (item) => Object.freeze({
  ...item,
  verdictLabel: VERDICT_LABELS[item.verdict],
  sourceLabel: SOURCE_LABELS[item.source] ?? SOURCE_LABELS.probe
});

/**
 * 探测本机：只产出判定与可展示的值，不写任何东西。
 *
 * @param {object} [input]
 * @param {Record<string, string|undefined>} [input.env] 注入的环境变量（测试用假 env）
 * @param {Record<string, string>} [input.paths] 六类探测项里路径类的「这次看到的位置」
 * @param {{stat?: Function, listDirs?: Function}} [input.io] 注入的只读文件系统
 * @param {object} [input.config] 当前配置（用于判断手改值）
 * @param {object} [input.probed] 上次探测写入的值（setupProbed）
 * @param {string} [input.at] 时间（测试可固定）
 * @returns {{at: string, items: object[], counts: object}}
 */
export function probeSetup({
  env = {}, paths = {}, io = null, config = {}, probed = {}, at = ''
} = {}) {
  const items = PROBE_ITEMS.map((spec) => {
    // 密钥：只回答「有没有一个非空值」，命中的变量名可以展示，值一个字都不带。
    if (spec.kind === 'secret') {
      const hit = spec.envs.find((name) => textOf(env?.[name]).trim().length > 0) ?? '';
      return verdictItem({
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        role: '',
        configKey: '',
        writeTo: spec.writeTo,
        verdict: hit ? VERDICT.ok : VERDICT.missing,
        value: hit ? `环境变量 ${hit}` : '未配置',
        envName: hit,
        path: '',
        count: null,
        empty: false,
        manual: false,
        source: SOURCE.probe,
        detail: hit
          ? '只检查环境变量是否存在；值不回显、不写进配置。'
          : `未检测到（候选：${spec.envs.join(' / ')}）`
      });
    }

    const key = spec.configKey;
    const source = key ? setupValueSource({ key, config, probed }) : SOURCE.probe;
    const manual = source === SOURCE.manual;
    // 手改时以配置文件里的值为准；否则用这次探测到的位置。
    const fresh = textOf(paths[spec.id]).trim();
    const path = manual ? textOf(config?.[key]).trim() : fresh;
    const stat = path && typeof io?.stat === 'function'
      ? (io.stat(path) ?? {})
      : {};
    const isDir = stat.exists === true && stat.isDir === true;

    let verdict;
    const detail = [];
    if (stat.exists !== true) {
      verdict = spec.role === 'own' ? VERDICT.create : VERDICT.missing;
      detail.push(spec.role === 'own' ? '目录不存在（确认后新建）' : '目录不存在');
    } else if (!isDir) {
      verdict = VERDICT.missing;
      detail.push('路径存在但不是目录');
    } else if (spec.role === 'own') {
      verdict = stat.writable === false ? VERDICT.readonly : VERDICT.ok;
      if (stat.writable === false) detail.push('存在但不可写');
    } else {
      verdict = VERDICT.readonly;
      detail.push(stat.readable === false
        ? '存在但读不到（按只读处理）'
        : '只读来源：只扫描，不写入');
    }

    // 技能数量：0 一律是「存在但为空」，与「缺失」分开。
    let count = null;
    let empty = false;
    if (isDir && spec.kind === 'skills') {
      count = countSkillDirs(io, path, spec.layout);
      empty = count === 0;
      detail.push(empty ? '0 个 · 存在但为空' : `${count} 个技能`);
    }
    if (manual) detail.push('手改值保留：重新探测不覆盖');

    return verdictItem({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      role: spec.role,
      configKey: key,
      writeTo: spec.writeTo,
      verdict,
      value: path || '—',
      envName: '',
      path,
      count,
      empty,
      manual,
      source,
      detail: detail.join('；')
    });
  });

  const counts = { ok: 0, readonly: 0, missing: 0, create: 0 };
  for (const item of items) counts[item.verdict] += 1;
  return { at: textOf(at), items, counts };
}

/** 探测结果的摘要文案：界面顶端那一行，测试也按它断言四档都出现过。 */
export function summarizeProbe(probe) {
  const items = listOf(probe?.items);
  const counts = { ok: 0, readonly: 0, missing: 0, create: 0 };
  for (const item of items) {
    if (Object.hasOwn(counts, item?.verdict)) counts[item.verdict] += 1;
  }
  return {
    total: items.length,
    counts,
    text: `共 ${items.length} 项：可用 ${counts.ok} · 只读 ${counts.readonly}`
      + ` · 缺失 ${counts.missing} · 需新建 ${counts.create}`
  };
}

/**
 * 建议写入清单：只收**会写盘**的项。
 *
 * 两类写入：
 *   mkdir  —— 自有目录不存在（需新建）时建目录；
 *   config —— 探测到的路径与配置文件里的值不同，且这一项不是手改。
 * 手改项不产生任何写入（配置不覆盖，目录也不代建），只进 skipped 供回执说明。
 *
 * @returns {{entries: object[], skipped: object[], totalWrites: number,
 *   mkdirCount: number, configCount: number}}
 */
export function planSetupWrites({ probe, config = {}, probed = {} } = {}) {
  const entries = [];
  const skipped = [];
  for (const item of listOf(probe?.items)) {
    if (!item || item.kind === 'secret') continue;
    const manual = item.manual === true
      || (item.configKey
        ? setupValueSource({ key: item.configKey, config, probed }) === SOURCE.manual
        : false);
    if (manual) {
      skipped.push({
        itemId: item.id,
        label: item.label,
        key: item.configKey || '',
        value: textOf(config?.[item.configKey]).trim(),
        reason: '手改值保留，不覆盖'
      });
      continue;
    }

    const writes = [];
    if (item.verdict === VERDICT.create && item.path) {
      writes.push({
        kind: 'mkdir',
        itemId: item.id,
        label: `新建目录 ${item.path}`,
        path: item.path
      });
    }
    if (item.configKey) {
      const current = textOf(config?.[item.configKey]).trim();
      const next = textOf(item.path).trim();
      // 缺失的外部目录不写进配置：探测没验证过的路径不该被当成默认值保存下来。
      if (next && current !== next && item.verdict !== VERDICT.missing) {
        writes.push({
          kind: 'config',
          itemId: item.id,
          label: `写入配置 ${item.configKey} = ${next}`,
          key: item.configKey,
          value: next
        });
      }
    }
    if (writes.length > 0) {
      entries.push({
        id: item.id,
        label: item.label,
        writeTo: item.writeTo,
        writes
      });
    }
  }

  const all = entries.flatMap((entry) => entry.writes);
  return {
    entries,
    skipped,
    totalWrites: all.length,
    mkdirCount: all.filter((write) => write.kind === 'mkdir').length,
    configCount: all.filter((write) => write.kind === 'config').length
  };
}

/**
 * 写入回执：写成了什么、跳过了什么、结果如何。
 * 回执是一条普通回复 `{ text, blocks }`，与 #114 / #115 的键值块同一个形状。
 */
export function setupReceipt({
  plan, written = [], skipped = [], ok = true, reason = '', at = ''
} = {}) {
  const stamp = textOf(at) || new Date().toISOString();
  const dirs = listOf(written).filter((write) => write.kind === 'mkdir');
  const configs = listOf(written).filter((write) => write.kind === 'config');
  const rows = [
    ['目的地', '自有配置 · companion.json 与配置根目录'],
    ['判定', ok ? '自有目录 · 一次确认后写入' : '自有目录 · 写入未完成'],
    ['写入', ok
      ? `${written.length} 项（新建目录 ${dirs.length} · 配置 ${configs.length}）`
      : `已写入 ${written.length} 项后中断`]
  ];
  for (const write of listOf(written)) {
    rows.push([
      write.kind === 'mkdir' ? '新建目录' : '配置',
      write.kind === 'mkdir' ? textOf(write.path) : `${textOf(write.key)} = ${textOf(write.value)}`
    ]);
  }
  for (const skip of listOf(skipped)) {
    rows.push(['跳过', `${textOf(skip.label)}：${textOf(skip.reason)}`]);
  }
  if (!ok) rows.push(['原因', textOf(reason) || '没有给出原因']);
  rows.push(['结果', ok ? '成功' : '失败']);
  rows.push(['时间', stamp]);

  const text = ok
    ? `写入回执（/setup）：新建 ${dirs.length} 个目录、写入 ${configs.length} 项配置`
      + `${skipped.length ? `；跳过 ${skipped.length} 项手改值` : ''}。`
    : `写入回执（/setup）：没有完成：${textOf(reason) || '没有给出原因'}`;
  return {
    text,
    blocks: [{
      type: 'kv',
      title: ok ? '探测写入回执' : '探测写入回执（失败）',
      rows
    }]
  };
}

/**
 * 取消回执：证明「一项都没写」。这里不读 plan 以外的任何东西，也不调用 mkdir。
 */
export function setupCancelReceipt({ plan, at = '' } = {}) {
  const entries = listOf(plan?.entries);
  const writes = entries.flatMap((entry) => listOf(entry.writes));
  const rows = [
    ['目的地', '自有配置 · companion.json 与配置根目录'],
    ['写入', '未写入（0 处）'],
    ['清单', `${entries.length} 项 · ${writes.length} 处写入全部取消`],
    ...writes.map((write) => [
      write.kind === 'mkdir' ? '未新建' : '未写入',
      write.kind === 'mkdir' ? textOf(write.path) : `${textOf(write.key)} = ${textOf(write.value)}`
    ]),
    ['结果', '已取消 · 文件系统没有变化'],
    ['时间', textOf(at) || new Date().toISOString()]
  ];
  return {
    text: `已取消：清单里 ${writes.length} 处写入一个都没做，配置与目录保持原样。`,
    blocks: [{ type: 'kv', title: '未写入 · /setup', rows }]
  };
}

/**
 * 执行一次已确认的写入。
 *
 * confirm=false 时直接返回取消回执，并且**不调用** mkdir：取消不是「稍后执行」，
 * 而是根本不排队，所以调用方可以让文件系统前后完全一致。
 *
 * @param {object} input
 * @param {object} input.plan planSetupWrites 的输出
 * @param {object} [input.config]
 * @param {object} [input.probed]
 * @param {boolean} [input.confirm]
 * @param {(path: string) => Promise<unknown>} [input.mkdir] 建目录的一步（测试注入）
 * @param {string} [input.at]
 * @returns {Promise<{ok: boolean, cancelled: boolean, written: object[],
 *   skipped: object[], patch: object, probed: object, receipt: object}>}
 */
export async function applySetup({
  plan, config = {}, probed = {}, confirm = false, mkdir, at = ''
} = {}) {
  const skipped = listOf(plan?.skipped);
  if (!confirm) {
    return {
      ok: false,
      cancelled: true,
      written: [],
      skipped,
      patch: {},
      probed: { ...probed },
      receipt: setupCancelReceipt({ plan, at })
    };
  }

  const written = [];
  const patch = {};
  const nextProbed = { ...probed };
  for (const entry of listOf(plan?.entries)) {
    for (const write of listOf(entry.writes)) {
      if (write.kind === 'mkdir') {
        try {
          if (typeof mkdir !== 'function') throw new Error('没有可用的建目录实现');
          await mkdir(write.path);
        } catch (error) {
          return {
            ok: false,
            cancelled: false,
            written,
            skipped,
            patch: {},
            probed: nextProbed,
            receipt: setupReceipt({
              plan,
              written,
              skipped,
              ok: false,
              reason: `新建目录失败：${textOf(error?.message ?? error) || '未知原因'}`,
              at
            })
          };
        }
        written.push({ ...write, itemId: entry.id });
        continue;
      }
      if (write.kind === 'config') {
        patch[write.key] = write.value;
        nextProbed[write.key] = write.value;
        written.push({ ...write, itemId: entry.id });
      }
    }
  }
  return {
    ok: true,
    cancelled: false,
    written,
    skipped,
    patch,
    probed: nextProbed,
    receipt: setupReceipt({ plan, written, skipped, ok: true, at })
  };
}
