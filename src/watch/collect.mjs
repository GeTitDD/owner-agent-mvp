// 监控采集入口（#120）：按监控对象的 type 分派到三个采集器，接口只有一个：
// `collect(target, { since, now, deps }) → { type, ref, status, items, cursor, error }`。
//
// 为什么入口只做分派：三件采集器各自知道自己的事实从哪来（git / 会话文件 / GitHub），
// 但「水位怎么用、失败怎么表达、结果长什么样」必须只有一份（collect-result.mjs）。
// 入口额外只做一件事：先用 target.mjs 校验描述符，坏对象在碰任何来源之前就被拒绝。
//
// 不写文件、不联网（除 GitHub 采集器的那几个 GET）：父 spec 的硬边界。
// 变化计算与入队是 #118 的事，这里只回答「取到什么」。
import { normalizeWatchTarget } from './target.mjs';
import { collectProject } from './collect-project.mjs';
import { collectSession } from './collect-session.mjs';
import { collectGithub } from './collect-github.mjs';

export { COLLECT_STATUS, isAfter, isoOf, toMillis } from './collect-result.mjs';
export { collectProject, collectSession, collectGithub };

// 与 target.mjs 同一写法：Map 只认这三个键，原型链上的名字不会变成类型。
const COLLECTORS = new Map([
  ['project', collectProject],
  ['session', collectSession],
  ['github', collectGithub]
]);

/**
 * 采一个监控对象。
 *
 * @param {object} target 监控对象描述符（形状见 target.mjs）
 * @param {{since?:string|number|Date|null, now?:Date|number|string, deps?:object}} [options]
 *   since：上次水位（ISO / Date / 毫秒）；null 表示首次心跳
 *   now：本次快照时刻，成功后作为 cursor 返回
 *   deps：注入依赖（git 执行器 / 会话读取器 / fetch 与 token），测试用假实现
 * @returns {Promise<{type:string, ref:string, status:'ok'|'unconfigured'|'error',
 *   items:Array<object>, cursor:string|null, error:null|{code:string, message:string, focus:string}}>}
 * @throws {import('./target.mjs').WatchTargetError} 描述符非法时（未知类型、缺字段、空 focus 等）
 */
export async function collect(target, { since = null, now = new Date(), deps = {} } = {}) {
  const normalized = normalizeWatchTarget(target);
  const run = COLLECTORS.get(normalized.type);
  // 不可达：normalizeWatchTarget 已经只放行这三个类型；留着是为了改词表时当场炸而不是静默返回空。
  if (!run) throw new Error(`没有 ${normalized.type} 类型的采集器`);
  return run(normalized, { since, now, deps });
}
