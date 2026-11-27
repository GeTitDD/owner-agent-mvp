// #116 外发 / 删除 / 写后外发的脚本化入口：把「判定计划」接上「确认卡」。
//
// 为什么需要这一层：src/confirm-plan.mjs 是 ESM（要 import write-gate），卡片是
// 经典脚本 desktop/confirm-cards.cjs（渲染层同步 require / 读 window），两者不能互相
// import。这个模块只做装配——先算计划，再把计划变成卡片；它不判定、不渲染、不执行。
//
// 三条脚本化命令（都只出卡，不真的发、不真的删）：
//   /外发 [目标]  纯外发：一张外发卡；
//   /删除         纯删除：一张删除卡；
//   /样例同步     同一动作里既有写入又有外发：两张卡，先写后发，并写明顺序理由。
//
// 时序：模块脚本晚于经典脚本执行，confirm-cards.cjs / risk-card.cjs 已经挂在 window；
// 这里再挂 window.OwnerConfirm，shell-compose 在发送时读取。
import { planConfirmations, ORDER_REASON } from '../src/confirm-plan.mjs';

const cardsApi = () => globalThis.OwnerConfirmCards ?? null;
const riskApi = () => globalThis.OwnerRiskCard ?? null;

const DEFAULT_TARGET = '飞书 · Companion 群';

// 脚本化样本：完整路径写死，验收才能断言「逐条、不合并、不省略」。
const EXTERNAL_ITEMS = Object.freeze([
  {
    label: 'ADR 0012 摘要',
    path: 'D:\\work\\integration\\docs\\adr\\0012-write-by-destination.md',
    note: '作为消息正文发出'
  },
  {
    label: '导出快照 index.md',
    path: 'C:\\Users\\Owner\\.owner-agent\\knowledge\\exports\\snapshot-index.md',
    note: '作为附件发出'
  }
]);

const SYNC_WRITES = Object.freeze([
  'D:\\work\\integration\\docs\\adr\\0012-write-by-destination.md'
]);

const DELETE_ITEMS = Object.freeze([
  {
    label: '0014-export-policy.md',
    path: 'D:\\work\\integration\\docs\\adr\\0014-export-policy.md',
    note: '旧版导出策略'
  },
  {
    label: '0013-write-by-destination.md',
    path: 'D:\\work\\integration\\docs\\adr\\0013-write-by-destination.md',
    note: '与 0012 重复'
  },
  {
    label: '项目导出目录 v3',
    path: 'C:\\Users\\Owner\\.owner-agent\\exports\\cmp-demo\\v3',
    note: '已发布快照的导出'
  }
]);

/** 计划里必须恰好有要的那一步：脚本化入口不接受「没有确认卡」这种静默降级。 */
const confirmationOf = (plan, kind) => {
  if (plan.blocked.length > 0) {
    const reasons = plan.blocked.map((item) => item.reason).join('；');
    throw new Error(`这个动作被拒绝，不能出确认卡：${reasons}`);
  }
  const found = plan.confirmations.find((item) => item.kind === kind);
  if (!found) throw new Error(`计划里没有 ${kind} 这一步：先检查判定输入。`);
  return found;
};

const externalReply = (command) => {
  const cards = cardsApi();
  if (!cards) throw new Error('确认卡模块（desktop/confirm-cards.cjs）未加载');
  const target = command.arg || DEFAULT_TARGET;
  const plan = planConfirmations({ destination: 'external', sends: EXTERNAL_ITEMS });
  confirmationOf(plan, 'external');
  const card = cards.externalCardModelOf({
    id: 'external-sample',
    target,
    items: EXTERNAL_ITEMS,
    sequence: '第 1 次确认 / 共 1 次：外发单独一档'
  });
  return {
    text: '外发单独确认：发出即收不回，没有「以后不用问」。本轮是脚本化样本，不会真的发出。',
    blocks: [card]
  };
};

const deleteReply = () => {
  const cards = cardsApi();
  if (!cards) throw new Error('确认卡模块（desktop/confirm-cards.cjs）未加载');
  // 项目目录已在本会话授权也不影响删除：write-gate 对删除恒 confirm。
  const plan = planConfirmations({
    destination: 'project',
    deletes: true,
    deleteItems: DELETE_ITEMS,
    granted: { project: true }
  });
  confirmationOf(plan, 'delete');
  const card = cards.deleteCardModelOf({
    id: 'delete-sample',
    items: DELETE_ITEMS,
    sequence: '第 1 次确认 / 共 1 次：删除逐条确认'
  });
  return {
    text: '删除单独确认：逐条列出将删对象，没有批量放行；本会话已授权写项目目录，也不解除删除确认。本轮是脚本化样本，不会真的删除。',
    blocks: [card]
  };
};

/** 同一动作里的写入 + 外发：两张卡，写入在前、外发在后。 */
const syncReply = async () => {
  const cards = cardsApi();
  const risk = riskApi();
  if (!cards || !risk) throw new Error('确认卡或风险卡模块未加载');
  const plan = planConfirmations({
    destination: 'project',
    writes: SYNC_WRITES,
    sends: EXTERNAL_ITEMS
  });
  const writeStep = confirmationOf(plan, 'write');
  const externalStep = confirmationOf(plan, 'external');
  if (plan.order.join('>') !== 'write>external') {
    throw new Error(`拆分的顺序不对：${plan.order.join('>')}`);
  }

  // 写入这一步复用 #113 的风险卡：这里不另造一套等级与判据。
  const assessed = await risk.assessRisk({
    input: { destination: 'project', deletes: false, paths: writeStep.paths }
  });
  const writeCard = risk.riskCardModelOf(assessed, {
    id: 'sync-write',
    title: '写入确认 · 同步到项目目录',
    paths: writeStep.paths,
    destination: 'project'
  });
  const externalCard = cards.externalCardModelOf({
    id: 'sync-external',
    target: DEFAULT_TARGET,
    items: EXTERNAL_ITEMS,
    sequence: '第 2 次确认 / 共 2 次：先写后发'
  });
  return {
    text: `同一动作里既有写入又有外发，拆成两次确认。${ORDER_REASON}`,
    blocks: [writeCard, externalCard]
  };
};

/** 命令 → 回复（与 /risk 同一形状：{ text, blocks }）。 */
async function buildReply(command) {
  if (command?.kind === 'external') return externalReply(command);
  if (command?.kind === 'delete') return deleteReply();
  if (command?.kind === 'sync') return syncReply();
  return null;
}

const api = Object.freeze({
  // /样例同步 不走 confirm-cards 的 parseCommand（那条只管外发与删除），在这里补上。
  parseCommand: (input) => {
    const text = String(input ?? '').trim();
    if (text === '/样例同步') return { kind: 'sync', arg: '' };
    return cardsApi()?.parseCommand(text) ?? null;
  },
  isCommand: (input) => api.parseCommand(input) !== null,
  buildReply,
  // 动作落点也走同一份归一化，避免渲染层再 require 一次：
  confirmAction: (input) => cardsApi()?.confirmAction(input) ?? null,
  planConfirmations
});

window.OwnerConfirm = api;
window.dispatchEvent(new Event('owner-confirm-ready'));
