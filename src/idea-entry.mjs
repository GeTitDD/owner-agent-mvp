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
// 去重键也放在这里：同一条 = 同一段正文 + 同一个来源（粘贴 / 链接）。
// 比较前只把空白归一（换行、制表、多空格），原文按用户输入原样入库，方便查回。

import { ideaTitle } from './idea-capture.mjs';

// 与 owner-store 的列宽保持一致：原文 8000、链接 2000、标题 300。
export const RAW_TEXT_LIMIT = 8000;
export const LINK_LIMIT = 2000;

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
 * 去重键：来源 + 空白归一后的正文。
 *
 * 只归空白，不折叠大小写、不改标点：同一条应该真的同一段话，
 * 而不是「看起来差不多」就被吞掉。
 */
export function ideaDedupeKey({ rawText = '', captureSource = 'paste' } = {}) {
  const text = String(rawText ?? '').replace(/\s+/gu, ' ').trim();
  return `${String(captureSource ?? 'paste')}\u0000${text}`;
}
