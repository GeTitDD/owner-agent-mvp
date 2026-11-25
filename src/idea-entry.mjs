// #95 灵感捕获：把粘贴进来的一段话或一个链接分拣成「正文 + 来源 + 链接」。
//
// 只做识别，不做抓取：认出是链接也只把地址存进收件箱，真正的抓取是整理那一步的事。
// 所以这个文件里不出现任何网络调用——没有 fetch、没有 http 请求、没有 DNS 解析，
// 连重定向都不跟。`new URL()` 只在本地解析字符串，不会发出请求。
//
// 为什么要求「整段就是一个链接」才算链接来源：一段话里夹着链接时，用户想记的是那段话，
// 把这种条目只留链接会把正文丢掉。整段只有一条 http(s) 地址时，正文与链接是同一个东西，
// 才按链接来源记，并让列表可以只显示地址。
//
// 去重键还从这个文件出口（实现见 idea-dedupe.mjs）：同一条 = 同一段正文 + 同一个来源（粘贴 / 链接）。
// 比较前只把空白归一（换行、制表、多空格），原文按用户输入原样入库，方便查回。

import { ideaTitle } from './idea-capture.mjs';
import { IDEA_LINK_LIMIT, IDEA_RAW_TEXT_LIMIT } from './owner-store.mjs';

// 列宽不在这里另写一份：上限由 owner-store 导出，动一处两处同步（改宽会连带迁移，见那边注释）。
export const RAW_TEXT_LIMIT = IDEA_RAW_TEXT_LIMIT;
export const LINK_LIMIT = IDEA_LINK_LIMIT;

// 只认 http(s)：其它协议（file:、ftp:、mailto:）不是「网页链接」，当普通文本处理。
const HTTP_URL = /^https?:\/\/\S+$/iu;

/**
 * 整段文本是否就是一个网页链接；是则返回原样的地址，否则返回空串。
 * 只做字符串与 URL 解析，不发任何请求。
 */
export function asIdeaLink(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > LINK_LIMIT) return '';
  if (!HTTP_URL.test(text)) return '';
  try {
    const url = new URL(text);
    // `https://` 后面没有主机名时 URL 会抛错；再兜一层空主机名，避免存进一条打不开的「链接」。
    return url.hostname ? text : '';
  } catch {
    return '';
  }
}

/**
 * 分拣一次粘贴。
 *
 * @param {string} value 用户粘贴的原文（文本框里的全部内容）
 * @returns {{ok: true, text: string, title: string, source: 'paste'|'link', link: string}
 *   | {ok: false, text: string, reason: string}} 可入库时带上标题与来源；不可入库时给原因
 */
export function parseIdeaCapture(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return { ok: false, text: '', reason: '空内容：先粘贴一段话或一个链接。' };
  }
  if (text.length > RAW_TEXT_LIMIT) {
    return {
      ok: false,
      text,
      reason: `一次最多记 ${RAW_TEXT_LIMIT} 字，这条有 ${text.length} 字；请拆开发。`
    };
  }
  const link = asIdeaLink(text);
  if (link) {
    // 链接来源：正文就是地址本身，标题用截断后的地址，列表里不会空白。
    return { ok: true, text, title: ideaTitle(link), source: 'link', link };
  }
  return { ok: true, text, title: ideaTitle(text), source: 'paste', link: '' };
}

/**
 * 去重键仍在 idea-entry 的公共出口上，但实现已挪到 idea-dedupe.mjs：
 * owner-store 要用同一个键，而 idea-entry 又从这里导入列宽，留在本文件会形成循环依赖。
 */
export { ideaDedupeKey } from './idea-dedupe.mjs';
