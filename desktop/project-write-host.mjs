// 把 src/project-write.mjs 的纯函数挂到 window，并持有「这次运行期」的两份状态：
// 会话授权表与待确认的写入清单。
//
// 为什么状态在这一层：
// - 授权按会话（ADR-0012）：键是会话 id，换会话查不到就是未授权；渲染进程重启也一并清空，
//   所以不存在「上次批过的项目目录」被继承；
// - 写入清单（路径 + 正文）只在内存里等到用户点「允许这一次」：确认卡本身是普通块，
//   存储里读回来的卡没有正文，这里宁可说「清单已失效，请重新发起」，也不猜内容去写；
// - 判定与回执仍只来自 src/project-write.mjs 与 src/write-gate.mjs，这里不重复规则。
//
// 真正落盘走主进程的 companion:project-sync-plan / companion:project-sync-write；
// e2e 可用 window.OwnerProjectWriteExecutor 注入写入结果（与 #114 同一套做法）。
import {
  PROJECT_SYNC_COMMAND,
  PROJECT_SYNC_ALIAS,
  PROJECT_NOTE_DIR,
  ProjectWriteError,
  buildProjectSyncCard,
  grantProject,
  isProjectSyncCommand,
  noteSlugOf,
  parseProjectSyncCommand,
  planProjectSync,
  projectCancelReceipt,
  projectGranted,
  projectWriteDecision,
  projectWriteReceipt,
  resetProjectGrant,
  resolveUnderRoot,
  runProjectSync,
  sessionNoteDoc
} from '../src/project-write.mjs';

let grants = {};
const plans = new Map();
let cardSeq = 0;

const riskApi = () => window.OwnerRiskCard ?? null;

const bridge = () => window.companion?.projectSync ?? null;

/** 让主进程算清单：完整路径（含项目根）与字节数都从同一处来，渲染层不猜根目录。 */
const planOf = async ({ projectId, docs }) => {
  const api = bridge();
  if (!api || typeof api.plan !== 'function') {
    throw new Error('主进程没有提供项目目录同步接口，这次什么都没写。');
  }
  return api.plan({ projectId, docs });
};

/** 写入点：e2e 可注入；否则走主进程（主进程会再校验路径必须落在项目根下）。 */
const writeFiles = async ({ projectId, files }) => {
  const injected = window.OwnerProjectWriteExecutor;
  if (typeof injected === 'function') return injected({ projectId, files });
  const api = bridge();
  if (!api || typeof api.write !== 'function') {
    throw new Error('主进程没有提供项目目录写入接口，这次什么都没写。');
  }
  return api.write({
    projectId,
    // 主进程按 docs 重新算一遍清单再落盘：写入路径不直接采用渲染层的路径字符串。
    docs: files.map((file) => ({ relativePath: file.relativePath, content: file.content }))
  });
};

/**
 * 一次「同步到项目目录」：已授权就直接写，未授权就出确认卡。
 *
 * @returns {Promise<{mode: 'written'|'confirm', text: string, blocks: object[], ok?: boolean}>}
 */
const request = async ({ sessionId, projectId, docs }) => {
  const plan = await planOf({ projectId, docs });
  const decision = projectWriteDecision({ sessionId, grants });
  if (decision.allowed) {
    const result = await runProjectSync({ sessionId, grants, plan, write: writeFiles });
    return { mode: 'written', ok: result.ok, text: result.receipt.text, blocks: result.receipt.blocks };
  }
  const api = riskApi();
  if (!api?.assessRisk) throw new ProjectWriteError('确认卡模块（desktop/risk-card.cjs）未加载。');
  // 评估器只看「目的地 + 路径」：本次不含删除、不离开本机，规则化占位给中风险。
  const risk = await api.assessRisk({
    input: { destination: 'project', deletes: false, paths: plan.paths }
  });
  cardSeq += 1;
  const card = buildProjectSyncCard({ plan, risk, riskCard: api, id: `project-sync-${cardSeq}` });
  plans.set(card.id, { plan, docs, projectId });
  return {
    mode: 'confirm',
    text: `要把 ${plan.paths.length} 份文档同步进「${plan.projectName || projectId}」：`
      + '先看清逐条路径与影响面；允许后本次会话内不再重复确认，换会话要重新确认。',
    blocks: [card]
  };
};

/**
 * 确认卡上的四个动作。返回与 #113 riskAction 同形的结果，由对话流统一落库；
 * 返回 null 表示这个动作不该被处理（例如非低风险点了「低风险免问」）。
 */
const act = async ({ card, action, level = '', note = '', sessionId }) => {
  const api = riskApi();
  const known = plans.get(String(card?.id ?? '')) ?? null;

  if (action === 'override') {
    const next = api?.riskAction?.({ card, action, level, note });
    if (!next) return null;
    // 改判只改等级，不改要写哪些文件：新卡沿用同一份清单。
    if (known && next.card) plans.set(next.card.id, known);
    return next;
  }

  if (action === 'cancel') {
    const receipt = projectCancelReceipt({ plan: known?.plan ?? null, paths: card?.paths ?? [] });
    return {
      kind: 'cancel',
      answeredLabel: '取消',
      userText: '取消',
      reply: { text: receipt.text, blocks: receipt.blocks }
    };
  }

  if (action === 'allow-once' || action === 'defer-low') {
    // 「低风险免问」只对低风险可点；项目目录的常规评级是中风险，这里再守一次。
    if (action === 'defer-low' && card?.level !== 'low') return null;
    const answeredLabel = action === 'defer-low' ? '低风险免问' : '允许这一次';
    if (!known) {
      return {
        kind: action,
        answeredLabel,
        userText: answeredLabel,
        reply: {
          text: '这次同步的写入清单已经失效（刷新或换会话后会作废）：什么都没写，请重新发起 /同步到项目。'
        }
      };
    }
    const nextGrants = grantProject({ grants, sessionId });
    const result = await runProjectSync({
      sessionId,
      grants: nextGrants,
      plan: known.plan,
      write: writeFiles
    });
    // 只有写成才留下会话授权：失败不顺手把下一次也放过去。
    if (result.ok) grants = nextGrants;
    return {
      kind: action,
      answeredLabel,
      userText: answeredLabel,
      reply: { text: result.receipt.text, blocks: result.receipt.blocks }
    };
  }
  return null;
};

window.OwnerProjectWrite = Object.freeze({
  PROJECT_SYNC_COMMAND,
  PROJECT_SYNC_ALIAS,
  PROJECT_NOTE_DIR,
  parseCommand: parseProjectSyncCommand,
  isCommand: isProjectSyncCommand,
  noteSlugOf,
  sessionNoteDoc,
  plan: planProjectSync,
  resolveUnderRoot,
  decide: projectWriteDecision,
  granted: (sessionId) => projectGranted({ grants, sessionId }),
  card: buildProjectSyncCard,
  receipt: projectWriteReceipt,
  cancelReceipt: projectCancelReceipt,
  run: runProjectSync,
  resetSession: (sessionId) => { grants = resetProjectGrant({ grants, sessionId }); },
  knowsCard: (id) => plans.has(String(id ?? '')),
  cardCount: () => plans.size,
  request,
  act
});
window.dispatchEvent(new Event('owner-project-write-ready'));
