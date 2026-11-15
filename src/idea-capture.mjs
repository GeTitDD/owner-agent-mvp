// 灵感采集：只判断「这句话像不像一条改进意见」，不执行任何改动。
//
// 规则尽量保守：明确要求动手（"帮我改…"）和纯提问不采集，
// 只有带建议语气、且有一定长度的表述才进入想法池。

const IDEA_HINTS = /(我觉得|建议|可以|能不能|能否|不如|希望|考虑|也许|或许|优化|改进|提升|新增|增加|加个|加一个|支持|改成|换成|简化|统一|重构|补充|拆分|合并)/u;
// 明确要求落地动作的消息按任务处理，不进想法池。
const ACTION_HINTS = /^(?:请|帮我|麻烦|直接|马上|立即|现在)?\s*(?:改|修改|实现|修复|删除|删掉|加上|新增|编写|重写|替换|更新)\b/u;

/** 这条用户消息是否值得收进「想法」池。 */
export function looksLikeIdea(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (value.length < 8 || value.length > 2000) return false;
  if (ACTION_HINTS.test(value)) return false;
  if (!IDEA_HINTS.test(value)) return false;
  // 纯提问（以问号结尾且没有建议词落地）通常是在讨论，不强行采集。
  if (/[?？]\s*$/u.test(value) && !/(我觉得|建议|可以|希望|不如)/u.test(value)) return false;
  return true;
}

/** 生成想法标题：保留原句，过长时截断。 */
export function ideaTitle(text, max = 140) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
