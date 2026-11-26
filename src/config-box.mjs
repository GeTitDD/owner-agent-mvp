// #127 配置箱的数据与来源标注：七个分区、每行「标签 + 值 + 一句后果」，
// 并标清这一项来自「探测」还是「手改」。
//
// 边界：
// - 本文件是纯函数：不读盘、不读环境变量、不联网、不持有状态。值、路径、密钥状态与
//   来源由调用方一次传入（主进程 settings.get 的 configBox 字段），界面只画。
// - 真实探测在 #128；这一轮传进来的 facts 就是「本轮注入的初始数据」。
// - 密钥只有两件事可展示：来源（环境变量名）与状态（已检测到 / 未配置）。值永远不进
//   渲染进程，这里也就没有存放值的字段——想回显也无从回显。
//
// 来源规则（探测 vs 手改，谁优先）：
// 1. 只读行（路径 / ADR 策略 / 上限）与密钥行恒为「探测」：值由系统读取或写死在 ADR 里，
//    配置箱改不了，也就谈不上「手改」。
// 2. 可写行看 facts.sources[配置键]：'manual' = 配置文件里的值偏离内置默认（人写过），
//    'probe' = 还是默认值（没人动过）。缺省按「探测」，不猜。
// 3. 合并时「手改优先」：同一项既能探测到、又有人写过的值，显示「手改」——执行时以配置
//    文件为准，标注必须跟着真正生效的那一份走；密钥行是唯一例外，永远「探测」。
//
// ADR-0012「写入按目的地分级」的写法：这一区只复述分级本身（自有目录 / 项目目录 / 外发 /
// 删除），不给「能不能写」的开关，也不在这里判定某一次写入。

/** 两个来源值：'probe' 探测 / 'manual' 手改。界面只认这两个字符串。 */
export const SOURCE = Object.freeze({ probe: 'probe', manual: 'manual' });

/** 来源的中文标注：配置箱里直接显示这两个词。 */
export const SOURCE_LABELS = Object.freeze({ probe: '探测', manual: '手改' });

/** 密钥状态的两种说法：只说配没配，不说值。 */
export const SECRET_LABELS = Object.freeze({ present: '已检测到', missing: '未配置' });

/** 分区顺序照 issue #127：模型接口 / 目录 / 分享 / 技能 / 写入范围 / 监控 / 同步。 */
export const SECTIONS = Object.freeze([
  Object.freeze({
    id: 'model',
    label: '模型接口',
    hint: '模型从哪来、用哪个。保存后下一条消息就换。',
    rows: Object.freeze([
      Object.freeze({
        id: 'model',
        label: '主模型',
        kind: 'model',
        key: 'model',
        placeholder: '留空 = Pi 默认模型',
        effect: '对话、补丁、Playbook 都改用它；可从已装模型里选，也可手填 provider/model。'
      }),
      Object.freeze({
        id: 'diagramModel',
        label: '图谱模型',
        kind: 'model',
        key: 'diagramModel',
        placeholder: '留空 = 跟主模型',
        effect: '只在生成依赖图时用；留空不单独计费。'
      }),
      Object.freeze({
        id: 'gatewayUrl',
        label: '网关地址',
        kind: 'text',
        key: 'gatewayUrl',
        placeholder: 'http://127.0.0.1:18789',
        effect: '连不上就只有直连 Workbench 可用，快照会标红。'
      })
    ])
  }),
  Object.freeze({
    id: 'paths',
    label: '目录',
    hint: '自有数据放哪。换目录等于换一份数据，重启才生效。',
    rows: Object.freeze([
      Object.freeze({
        id: 'userData',
        label: '配置根',
        kind: 'readonly',
        from: { bag: 'paths', key: 'userData' },
        effect: '快照、导出、经验、决策、变更队列都落在这里，默认允许写。'
      }),
      Object.freeze({
        id: 'configFile',
        label: '配置文件',
        kind: 'readonly',
        from: { bag: 'paths', key: 'config' },
        effect: '保存写回这个文件；取消一个字都不改。'
      }),
      Object.freeze({
        id: 'includePaths',
        label: '快照包含',
        kind: 'list',
        key: 'includePaths',
        placeholder: 'package.json, README.md',
        effect: '导出与快照带上这些文件；留空只带目录结构。'
      }),
      Object.freeze({
        id: 'knowledgeDb',
        label: '知识库',
        kind: 'readonly',
        from: { bag: 'paths', key: 'knowledge' },
        effect: '经验与决策只存这里；换路径不会自动搬旧数据。'
      })
    ])
  }),
  Object.freeze({
    id: 'share',
    label: '分享',
    hint: '往外发的东西。密钥只显示来源与环境状态，值不回显。',
    rows: Object.freeze([
      Object.freeze({
        id: 'feishuWebhook',
        label: '飞书 webhook',
        kind: 'secret',
        env: 'OWNER_OBSERVER_FEISHU_WEBHOOK',
        effect: '留空就不发送；发布卡片与观察员摘要共用这一个出口。'
      }),
      Object.freeze({
        id: 'approvalToken',
        label: '审批令牌',
        kind: 'secret',
        env: 'OWNER_AGENT_APPROVAL_TOKEN',
        effect: '外发与删除确认的凭据；配置箱只报状态，不写回。'
      }),
      Object.freeze({
        id: 'mobilePort',
        label: '手机桥',
        kind: 'readonly',
        text: '随机端口（启动时算）',
        effect: '配对码每次启动重算；端口可用 OWNER_MOBILE_PORT 固定。'
      })
    ])
  }),
  Object.freeze({
    id: 'skills',
    label: '技能',
    hint: '每条对话默认带哪些技能；缺的目录会标「缺失」。',
    rows: Object.freeze([
      Object.freeze({
        id: 'chatSkills',
        label: '对话隐式技能',
        kind: 'list',
        key: 'chatSkills',
        placeholder: '留空 = 默认七个',
        effect: '每条对话都带这些技能；最多 12 个，超了保存会失败。'
      }),
      Object.freeze({
        id: 'mattSkills',
        label: '自定义技能目录',
        kind: 'readonly',
        from: { bag: 'paths', key: 'skills' },
        effect: '扫描时缺目录标「缺失」；安装新技能要先确认才写盘。'
      }),
      Object.freeze({
        id: 'skillCap',
        label: '技能上限',
        kind: 'readonly',
        text: '12 个',
        effect: '再多会把提示词撑爆，主进程会拒绝保存。'
      })
    ])
  }),
  Object.freeze({
    id: 'write',
    label: '写入范围',
    hint: '按目的地分级（ADR-0012），不是「能不能写」的开关。',
    rows: Object.freeze([
      Object.freeze({
        id: 'ownDir',
        label: '自有目录',
        kind: 'readonly',
        text: '默认允许，不打扰',
        effect: '配置根下的快照、导出、经验、决策、变更队列；不产生对外后果。'
      }),
      Object.freeze({
        id: 'projectDir',
        label: '项目目录',
        kind: 'readonly',
        text: '默认禁止；一次一申请',
        effect: '只在你要求同步时才写，写前先出清单与风险评级。'
      }),
      Object.freeze({
        id: 'external',
        label: '对外发送',
        kind: 'readonly',
        text: '单独确认',
        effect: '发出即不可逆：发布卡片、Push、PR 都先出确认卡。'
      }),
      Object.freeze({
        id: 'deletes',
        label: '删除',
        kind: 'readonly',
        text: '永远逐次确认',
        effect: '横切所有目的地；确认里写明删什么、能不能找回。'
      })
    ])
  }),
  Object.freeze({
    id: 'watch',
    label: '监控',
    hint: '心跳与变更队列只写自有目录，项目目录一个文件都不留。',
    rows: Object.freeze([
      Object.freeze({
        id: 'watchDb',
        label: '监控状态库',
        kind: 'readonly',
        from: { bag: 'paths', key: 'watch' },
        effect: '水位、变更队列、心跳只写这里。'
      }),
      Object.freeze({
        id: 'heartbeat',
        label: '心跳',
        kind: 'readonly',
        text: '显式触发（observerctl）',
        effect: '还没做定时心跳；手动跑一次才收集一次。'
      }),
      Object.freeze({
        id: 'tidy',
        label: '定时整理',
        kind: 'readonly',
        text: '按计划时刻判定迟到',
        effect: '整理只在心跳之后跑；迟到记在运行记录里。'
      })
    ])
  }),
  Object.freeze({
    id: 'sync',
    label: '同步',
    hint: '方向已经定了（ADR-0013）；这一区是说明，不是开关。',
    rows: Object.freeze([
      Object.freeze({
        id: 'syncCredential',
        label: '同步令牌',
        kind: 'secret',
        credential: 'sync',
        env: 'GITHUB_TOKEN',
        effect: '只回答配没配、从哪个变量读（GITHUB_TOKEN / GH_TOKEN），不传值。'
      }),
      Object.freeze({
        id: 'sidecarToken',
        label: '侧车令牌',
        kind: 'secret',
        env: 'OWNER_AGENT_SIDECAR_TOKEN',
        effect: '手机桥与侧车接口的凭据；配置箱只报状态，不回显。'
      }),
      Object.freeze({
        id: 'syncRun',
        label: '同步执行',
        kind: 'readonly',
        text: '引擎已有，未接界面（#130/#131）',
        effect: '本票只读说明：配置箱不触发拉取或推送。'
      }),
      Object.freeze({
        id: 'syncOrder',
        label: '启动顺序',
        kind: 'readonly',
        text: '先拉后推；冲突交人',
        effect: '拉失败就整场停下；冲突四选一（远端 / 本地 / 都留 / 跳过）。'
      })
    ])
  })
]);

/** 所有可写行（有配置键、且有输入框）。保存只碰这些。 */
export function editableRows() {
  return SECTIONS.flatMap((section) => section.rows)
    .filter((row) => row.kind !== 'secret' && row.kind !== 'readonly' && Boolean(row.key));
}

/** 按 id 找一行；找不到返回 null，不兜底成第一行。 */
export function rowById(id) {
  const wanted = String(id ?? '');
  for (const section of SECTIONS) {
    const row = section.rows.find((item) => item.id === wanted);
    if (row) return row;
  }
  return null;
}

const textOf = (value) => (value === null || value === undefined ? '' : String(value));

/** 列表类配置在输入框里的样子：逗号分隔，读回来还能原样拆开。 */
export const listText = (value) => (Array.isArray(value) ? value.map(textOf).filter(Boolean).join(', ') : '');

/**
 * 一项的显示值。
 * - 可写行直接给配置值（列表拼成逗号串）；
 * - 只读行先看注入的事实，再看写死的文案；
 * - 密钥行不在这里取值（见 secretStateOf）。
 */
export function displayOf(row, values = {}, facts = {}) {
  if (!row) return '';
  if (row.kind === 'list') return listText(values[row.key]);
  if (row.kind === 'text' || row.kind === 'model') return textOf(values[row.key]);
  if (row.kind === 'readonly') {
    const bag = row.from ? facts[row.from.bag] : null;
    const picked = bag ? textOf(bag[row.from.key]) : '';
    return picked || textOf(row.text) || '—';
  }
  return '';
}

/**
 * 密钥这一行能说的全部：来源（环境变量名 / feishu.json）与状态。
 * 同步令牌按 #130 的 syncCredential 口径：只回答配没配、命中的是哪个变量。
 */
export function secretStateOf(row, facts = {}) {
  if (!row) return { present: false, envText: '', origin: '', label: SECRET_LABELS.missing };
  if (row.credential === 'sync') {
    const sync = facts.sync ?? {};
    const present = sync.present === true;
    const source = textOf(sync.source);
    return {
      present,
      envText: present && source ? `环境变量 ${source}` : '环境变量 GITHUB_TOKEN / GH_TOKEN',
      origin: present ? '环境变量' : '',
      label: present ? SECRET_LABELS.present : SECRET_LABELS.missing
    };
  }
  const entry = (facts.secrets ?? {})[row.env] ?? {};
  const present = entry.present === true;
  return {
    present,
    envText: `环境变量 ${textOf(row.env)}`,
    origin: textOf(entry.origin),
    label: present ? SECRET_LABELS.present : SECRET_LABELS.missing
  };
}

/**
 * 一项的来源：只读行与密钥行恒为「探测」，可写行看注入的 sources。
 * 「手改」只在 sources[key] === 'manual' 时成立；其它任何值都按「探测」，不猜。
 */
export function resolveSource(row, facts = {}) {
  if (!row) return SOURCE.probe;
  if (row.kind === 'secret' || row.kind === 'readonly' || !row.key) return SOURCE.probe;
  return (facts.sources ?? {})[row.key] === SOURCE.manual ? SOURCE.manual : SOURCE.probe;
}

/**
 * 画一行要的全部字段。扁平的：分区 id 跟着行一起给，界面按 section 分组即可。
 *
 * @param {object} [input]
 * @param {object} [input.values] 当前配置值（settings.get 回来的那份）
 * @param {object} [input.facts] 本轮注入的事实：paths / secrets / sync / sources
 * @returns {Array<object>} 23 行，顺序与 SECTIONS 一致
 */
export function buildRows({ values = {}, facts = {} } = {}) {
  return SECTIONS.flatMap((section) => section.rows.map((row) => {
    const source = resolveSource(row, facts);
    const built = {
      id: row.id,
      section: section.id,
      label: row.label,
      kind: row.kind,
      key: row.key ?? '',
      effect: row.effect,
      input: row.kind === 'text' || row.kind === 'list' || row.kind === 'model',
      placeholder: row.placeholder ?? '',
      source,
      sourceLabel: SOURCE_LABELS[source]
    };
    if (row.kind === 'secret') {
      const secret = secretStateOf(row, facts);
      built.display = secret.envText;
      built.state = secret.label;
      built.origin = secret.origin;
      // 状态位的数据源也带出去：界面按 present 上色，不再自己判一遍。
      built.secret = secret;
    } else {
      built.display = displayOf(row, values, facts);
      built.state = '';
      built.origin = '';
      built.secret = null;
    }
    return built;
  }));
}

/**
 * 把输入框里的草稿收成 settings.set 的补丁。
 * - 列表类拆成数组（逗号 / 分号 / 换行都认）；
 * - 文本类去首尾空白；
 * - 草稿里没有的 id 不动，密钥与只读行即使被塞进来也丢掉。
 */
export function patchForSave(draft = {}) {
  const patch = {};
  for (const row of editableRows()) {
    if (!Object.hasOwn(draft, row.id)) continue;
    const raw = textOf(draft[row.id]);
    patch[row.key] = row.kind === 'list'
      ? raw.split(/[,，;；\n]/u).map((item) => item.trim()).filter(Boolean)
      : raw.trim();
  }
  return patch;
}
