// #96 灵感整理：抓一次链接正文，写出「问题 / 想法 / 预期收益 / 风险」四段。
//
// 这是系统里第一个主动访问外网的地方，所以边界写在最前面，后面每个函数都在守它们：
// 1. 只抓公网 http / https。localhost、回环、私网、链路本地、IPv6 本机 / 内网地址、
//    非法协议、带用户名密码的地址一律拒绝，并给出人能看懂的原因。重定向的每一跳、
//    以及域名解析出来的地址，都要重新过一遍同样的判定——主机名写的是公网域名、
//    解析到 127.0.0.1，一样不放行。
// 2. 抓取有限：默认 5 秒总预算、1 MB 上限、最多 3 跳重定向。非 2xx、非网页、超限都
//    明说抓不到，不拿残缺正文冒充内容。
// 3. 抓不到就不编：四段里缺的那段标 missing 并写明原因，绝不填「未说明」这类占位词。
//    原文始终留在 raw_text，整理结果只写 sorted_result；失败时一个字都不写，重试由人点。
//
// 抓取与提炼都是注入的：fetch 由调用方传入（测试与视觉验收都换假的），提炼器缺省是本地
// 「按标题切」的保守实现——页面里没有「风险：」这一段，就真的留空，而不是编一段出来。

import { lookup } from 'node:dns/promises';
import { flatText } from './utils.mjs';

/** 默认总预算：一次整理从发出第一个请求到读完正文，最多 5 秒。 */
export const FETCH_TIMEOUT_MS = 5000;
/** 默认正文上限：1 MB。链接正文是拿来做四段摘要的，再多也读不完。 */
export const FETCH_MAX_BYTES = 1024 * 1024;
/** 默认最多跟 3 跳重定向；第 4 跳直接判失败，避免被引到环里。 */
export const FETCH_MAX_REDIRECTS = 3;
/** 缓存进条目的正文上限：sorted_result 整列限 20000 字，还要留四段与元信息的位置。 */
export const PAGE_TEXT_LIMIT = 8000;
/** 单段上限：面板里一段太长没人看，超出截断并保留省略号。 */
export const SECTION_TEXT_LIMIT = 800;

const stamp = () => new Date().toISOString();

/** 四段的唯一来源：键、显示名、可识别的标题写法。顺序就是面板里的顺序。 */
export const IDEA_SECTIONS = [
  { key: 'problem', label: '问题', aliases: ['问题', 'problem', 'pain point', 'pain'] },
  { key: 'idea', label: '想法', aliases: ['想法', '点子', 'idea', 'solution', '提案'] },
  {
    key: 'benefit',
    label: '预期收益',
    aliases: ['预期收益', '收益', 'benefit', 'benefits', 'value', '预期价值']
  },
  { key: 'risk', label: '风险', aliases: ['风险', 'risk', 'risks'] }
];

const refuse = (code, reason) => ({ ok: false, code, reason });

/** 只说地址的前 80 字：拒绝原因要能让日志和面板都放下。 */
const short = (value, max = 80) => {
  const text = flatText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

const ipv4Parts = (value) => {
  const match = IPV4.exec(String(value ?? ''));
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
};

/**
 * IPv4 的网段归类：命中的都返回一句「哪个网段」，公网地址返回空串。
 * 除任务点名的 127/8、10/8、172.16/12、192.168/16、169.254/16 之外，还挡了
 * 0/8（本网络）、100.64/10（运营商级 NAT）、192.0.0/24、198.18/15（基准测试）
 * 与 224/4 以上（组播 / 保留）——这些都不是「公网上的一个网页」。
 */
const ipv4Block = (value) => {
  const parts = ipv4Parts(value);
  if (!parts) return '';
  const [a, b, c] = parts;
  if (a === 0) return '0.0.0.0/8（本网络）';
  if (a === 10) return '10.0.0.0/8';
  if (a === 127) return '127.0.0.0/8（回环）';
  if (a === 169 && b === 254) return '169.254.0.0/16（链路本地）';
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12';
  if (a === 192 && b === 168) return '192.168.0.0/16';
  if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10（运营商级 NAT）';
  if (a === 192 && b === 0 && c === 0) return '192.0.0.0/24（协议保留）';
  if (a === 198 && (b === 18 || b === 19)) return '198.18.0.0/15（基准测试）';
  if (a >= 224) return '224.0.0.0/4（组播 / 保留）';
  return '';
};

/**
 * IPv6 的网段归类：::1、::、fc00::/7、fe80::/10、ff00::/8 以及 IPv4 映射地址。
 * 传进来的可能是 URL 解析留下的 `[::1]` 形式，也可能是 dns.lookup 给的裸地址。
 */
const ipv6Block = (value) => {
  const host = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[/u, '')
    .replace(/\]$/u, '')
    .split('%')[0];
  if (!host.includes(':')) return '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(host);
  if (mapped) return ipv4Block(mapped[1]);
  if (host === '::1') return '::1（回环）';
  if (host === '::') return '::（未指定）';
  if (host.startsWith('::')) return '::/8（IPv4 兼容 / 未指定）';
  const head = parseInt(host.split(':')[0] || '0', 16);
  if (!Number.isFinite(head)) return '';
  if ((head & 0xfe00) === 0xfc00) return 'fc00::/7（唯一本地）';
  if ((head & 0xffc0) === 0xfe80) return 'fe80::/10（链路本地）';
  if ((head & 0xff00) === 0xff00) return 'ff00::/8（组播）';
  return '';
};

// 这些后缀是内网 / 本机专用名：即使解析到公网地址也不当公网网页抓。
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * 链接守卫（纯函数）：只放行公网 http / https。
 *
 * 只做字符串与 URL 解析，不发请求、不做 DNS——所以能脱离网络单测每一个网段与协议。
 * 真正的 DNS 复查在 fetchIdeaPage 里用 guardResolvedAddresses 做。
 *
 * @param {string} value 用户存下的链接
 * @returns {{ok: true, url: string, host: string, protocol: string, reason: ''}
 *   | {ok: false, code: string, reason: string}}
 */
export function guardIdeaLink(value) {
  const text = String(value ?? '').trim();
  if (!text) return refuse('empty', '没有链接：这条灵感是纯文本。');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return refuse('malformed', `地址解析不出来：${short(text)}。`);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return refuse('protocol', `只抓 http / https，这条是 ${protocol} 协议。`);
  }
  if (parsed.username || parsed.password) {
    return refuse('credentials', '地址里带了用户名或密码，这种链接不抓。');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return refuse('malformed', '这条地址没有主机名。');
  // 方括号留给 IPv6 判定；其余情况去掉结尾的点（`localhost.` 与 `localhost` 是同一台机器）。
  const host = hostname.startsWith('[') ? hostname : hostname.replace(/\.+$/u, '');
  const bare = host.replace(/^\[/u, '').replace(/\]$/u, '');
  if (bare.includes(':')) {
    const block = ipv6Block(host);
    if (block) return refuse('private', `这是 IPv6 ${block} 地址，不抓内网与本机。`);
  } else if (IPV4.test(bare)) {
    const block = ipv4Block(bare);
    if (block) return refuse('private', `这是内网 / 本机 IPv4 地址（${block}），不抓。`);
  } else if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return refuse('private', '这是本机地址（localhost），不抓。');
  } else if (LOCAL_SUFFIXES.some((suffix) => bare.endsWith(suffix))) {
    return refuse('private', `这是内网域名（${bare}），不抓。`);
  } else if (!bare.includes('.')) {
    // 没有点的主机名只能是内网机器名，公网域名一定有后缀。
    return refuse('private', `主机名「${bare}」不是公网域名（没有点，像内网机器名），不抓。`);
  }
  return { ok: true, url: parsed.toString(), host: bare, protocol, reason: '' };
}

/**
 * 解析结果复查：主机名可能是公网域名，但解析到一个内网地址（DNS 指向本机 / 内网）。
 * 只有全部地址都是公网才放行；一个内网地址就整条拒绝，不给「碰巧先连公网」的机会。
 */
export function guardResolvedAddresses(addresses) {
  const list = Array.isArray(addresses) ? addresses : [];
  if (list.length === 0) return refuse('dns', '这个域名没有解析出任何地址，抓不到。');
  let checked = 0;
  for (const entry of list) {
    const address = String(typeof entry === 'string' ? entry : entry?.address ?? '').trim();
    if (!address) continue;
    checked += 1;
    const block = address.includes(':')
      ? ipv6Block(address)
      : (IPV4.test(address) ? ipv4Block(address) : '');
    if (block) {
      return refuse('private', `域名解析到了内网 / 本机地址（${address}，${block}），不抓。`);
    }
  }
  // 解析器给了条目却一条地址都读不出来：宁可不抓，也不当成公网。
  if (checked === 0) return refuse('dns', '域名解析没有给出可用的地址，抓不到。');
  return { ok: true, code: '', reason: '' };
}

// 只有网页值得读正文：图片、PDF、JSON 接口都不该被当成「一篇文章」来切四段。
const HTML_TYPE = /(?:text\/html|application\/xhtml\+xml)/iu;

const headerOf = (response, name) => {
  try {
    return String(response?.headers?.get?.(name) ?? '');
  } catch {
    return '';
  }
};

const timeoutFailure = (timeoutMs) => refuse('timeout', `超过 ${timeoutMs} 毫秒还没抓完，放弃了。`);

const abortOrNetwork = (error, timeoutMs) => {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return timeoutFailure(timeoutMs);
  return refuse('network', `请求发不出去：${short(error?.message ?? error)}。`);
};

/** 按 content-type 里的 charset 解码；标注不认识就退回 UTF-8，不因为编码问题判抓取失败。 */
const decodeBody = (bytes, contentType) => {
  const charset = /charset\s*=\s*"?([\w.-]+)"?/iu.exec(String(contentType ?? ''))?.[1];
  const buffer = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch { /* 认不出的 charset：按 UTF-8 读 */ }
  }
  return new TextDecoder('utf-8').decode(buffer);
};

/**
 * 读正文并限大小：边读边数，超过上限立刻停手，不等读完再判。
 * 流式接口拿不到时（有的假 fetch 只给 arrayBuffer）退一步整块读，读完再比大小。
 */
const readCapped = async (response, maxBytes) => {
  const stream = response?.body;
  if (!stream || typeof stream.getReader !== 'function') {
    let buffer;
    try {
      buffer = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return refuse('network', `正文读不出来：${short(error?.message ?? error)}。`);
    }
    if (buffer.length > maxBytes) {
      return refuse('too-large', `正文超过上限 ${maxBytes} 字节，不抓。`);
    }
    return { ok: true, bytes: buffer, size: buffer.length };
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.length;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
        return refuse('too-large', `正文超过上限 ${maxBytes} 字节，读到一半就停了。`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return refuse('timeout', '读正文时超时了，抓不到完整的。');
    }
    return refuse('network', `正文读到一半断了：${short(error?.message ?? error)}。`);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes, size };
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”'
};

const decodeEntities = (value) => String(value ?? '').replace(
  /&(#x?[0-9a-f]+|[a-z]+);/giu,
  (match, name) => {
    const lower = String(name).toLowerCase();
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  }
);

/**
 * HTML → 纯文本。只为了切标题：块级元素与 <br> 留成换行，其余标签换成空格。
 * 不追求完整的 HTML 解析——正文的格式不重要，四段标题在哪一行才重要。
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/giu, ' ')
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<\/(?:h[1-6]|p|li|div|section|article|header|footer|tr|blockquote|dd|dt)>/giu, '\n')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<[^>]*>/gu, ' ')
  )
    .replace(/[ \t\f\v\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** 页面标题：只用来给面板一行上下文，取不到就空着。 */
export function pageTitleOf(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(String(html ?? ''));
  return match ? flatText(decodeEntities(match[1]), 160) : '';
}

/**
 * 抓一次网页正文。
 *
 * 每一跳都重新过守卫：重定向到 127.0.0.1 与一开始就写 127.0.0.1 一样被拒。
 * 时间预算是整次抓取共用的（不是每跳重新计时），否则 3 跳重定向能把 5 秒拖成 20 秒。
 *
 * @param {object} input
 * @param {string} input.url 已通过 guardIdeaLink 的地址
 * @param {(url: string, init: object) => Promise<object>} [input.fetchImpl] 注入的 fetch；缺省用全局
 * @param {(host: string) => Promise<object[]>} [input.resolveHost] 注入的 DNS 解析；缺省用 dns.lookup
 * @returns {Promise<object>} ok=true 时带 text / status / bytes；失败时带 code 与中文原因
 */
export async function fetchIdeaPage({
  url = '',
  fetchImpl = null,
  resolveHost = null,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = FETCH_MAX_BYTES,
  maxRedirects = FETCH_MAX_REDIRECTS,
  now = stamp()
} = {}) {
  const first = guardIdeaLink(url);
  if (!first.ok) return first;
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return refuse('no-fetch', '没有可用的抓取器。');
  const resolve = resolveHost ?? ((host) => lookup(host, { all: true }));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || FETCH_TIMEOUT_MS);
  let current = first;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let addresses;
    try {
      addresses = await resolve(current.host);
    } catch {
      return refuse('dns', `域名 ${current.host} 解析失败，抓不到。`);
    }
    const resolved = guardResolvedAddresses(addresses);
    if (!resolved.ok) return resolved;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return timeoutFailure(timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      let response;
      try {
        response = await doFetch(current.url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            'user-agent': 'OwnerCompanionIdeaSort/1.0'
          }
        });
      } catch (error) {
        return abortOrNetwork(error, timeoutMs);
      }

      const status = Number(response?.status ?? 0);
      const location = headerOf(response, 'location');
      if (status >= 300 && status < 400 && location) {
        if (hop === maxRedirects) {
          return refuse('redirect', `重定向超过 ${maxRedirects} 跳，抓不到。`);
        }
        let next;
        try {
          next = new URL(location, current.url).toString();
        } catch {
          return refuse('redirect', `重定向地址解析不出来：${short(location)}。`);
        }
        const guarded = guardIdeaLink(next);
        if (!guarded.ok) {
          return refuse('redirect', `重定向到了不放行的地址：${guarded.reason}`);
        }
        current = guarded;
        continue;
      }
      if (!response?.ok) {
        return refuse('status', `服务器返回 ${status || '未知状态'}，不是 2xx，抓不到。`);
      }
      const contentType = headerOf(response, 'content-type');
      if (!HTML_TYPE.test(contentType)) {
        return refuse(
          'content-type',
          `返回的不是网页正文（${contentType || '没有 content-type'}），抓不到。`
        );
      }
      const declared = Number(headerOf(response, 'content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        return refuse('too-large', `正文声明 ${declared} 字节，超过上限 ${maxBytes} 字节，不抓。`);
      }
      const body = await readCapped(response, maxBytes);
      if (!body.ok) return body;
      const html = decodeBody(body.bytes, contentType);
      return {
        ok: true,
        code: '',
        reason: '',
        url: current.url,
        status,
        contentType,
        bytes: body.size,
        title: pageTitleOf(html),
        text: htmlToText(html),
        redirects: hop,
        at: now
      };
    } catch (error) {
      return abortOrNetwork(error, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }
  return refuse('redirect', `重定向超过 ${maxRedirects} 跳，抓不到。`);
}

const escapeRe = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** 「问题：」「## 问题」「**问题**」这类行首标记；行内提到「问题」不算标题。 */
const markerPattern = (alias) => new RegExp(
  `^[\\t ]*(?:#{1,6}[\\t ]*)?(?:\\*\\*|__|【)?[\\t ]*${escapeRe(alias)}[\\t ]*(?:\\*\\*|__|】)?[\\t ]*(?::|：|$)`,
  'gimu'
);

const findMarkers = (body) => {
  const markers = [];
  for (const section of IDEA_SECTIONS) {
    for (const alias of section.aliases) {
      for (const match of body.matchAll(markerPattern(alias))) {
        markers.push({ key: section.key, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  // 同一位置多个别名命中时先取更长的那个（「预期收益」先于「收益」）。
  markers.sort((a, b) => a.start - b.start || b.end - a.end);
  return markers;
};

const cleanSection = (value) => {
  const text = String(value ?? '')
    .replace(/^[\s:：\-—·•]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > SECTION_TEXT_LIMIT ? `${text.slice(0, SECTION_TEXT_LIMIT - 1)}…` : text;
};

/**
 * 本地保守提炼：只认行首的段标题，命中就取到下一个标题之前的内容。
 * 没有标题就没有内容——这是「不编」的唯一实现方式，模型提炼器可以整体替换这一步。
 */
export function sectionsFromText(text) {
  // 先把 CRLF 归一：`$` 只认 \n，留着 \r 会让「问题」这一行整条对不上。
  const body = String(text ?? '').replace(/\r\n?/gu, '\n');
  const markers = findMarkers(body);
  const found = {};
  for (const [index, marker] of markers.entries()) {
    const next = markers.slice(index + 1).find((item) => item.start >= marker.end);
    const chunk = cleanSection(body.slice(marker.end, next ? next.start : body.length));
    if (!chunk) continue;
    // 同一段出现两次（例如页面目录 + 正文）：留更长的那份，短的通常是目录里的空壳。
    if (!found[marker.key] || chunk.length > found[marker.key].length) found[marker.key] = chunk;
  }
  return found;
}

/**
 * 把页面（或原文）切成四段，缺的段标 missing 并写明原因。
 *
 * @param {object} input
 * @param {string} [input.rawText] 原文；没有链接时四段只能从原文里找
 * @param {string} [input.link] 链接（仅用于给提炼器上下文）
 * @param {object|null} [input.page] fetchIdeaPage 的成功结果
 * @param {(input: object) => object|null} [input.extract] 注入的提炼器；缺省用本地保守提炼
 * @returns {{sections: object[], missing: string[], complete: boolean, note: string, source: string}}
 */
export function tidyIdeaSections({ rawText = '', link = '', page = null, extract = null } = {}) {
  const source = link ? 'link' : 'text';
  const pageText = String(page?.text ?? '');
  let fields;
  if (typeof extract === 'function') {
    // 提炼器回答「这四段各是什么」；它抛错或不给对象，都按「一段都没提炼出来」处理。
    try {
      const value = extract({ rawText, link, page: page ?? null });
      fields = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      fields = {};
    }
  } else {
    // 有链接正文就只读正文；纯文本条目才读原文，避免把用户原话拿去当「网页摘要」。
    fields = sectionsFromText(pageText || rawText);
  }
  const sections = IDEA_SECTIONS.map((definition) => {
    const text = flatText(fields?.[definition.key]);
    if (text) {
      return {
        key: definition.key, label: definition.label, text, missing: false, reason: ''
      };
    }
    const where = source === 'link' ? '抓到的正文里' : '原文里';
    return {
      key: definition.key,
      label: definition.label,
      text: '',
      missing: true,
      reason: `${where}没有「${definition.label}」这一段`
    };
  });
  const missing = sections.filter((section) => section.missing).map((section) => section.key);
  return {
    sections,
    missing,
    complete: missing.length === 0,
    note: missing.length === 0
      ? ''
      : `缺 ${missing.length} 段：${sections.filter((section) => section.missing)
        .map((section) => section.label).join(' / ')}`,
    source
  };
}

/**
 * 整理一条灵感：只在有条目链接时抓一次正文，写出四段，成功就把状态推到「已整理」。
 *
 * 缓存落在条目自己的 sorted_result 上：同一链接第二次整理直接复用上次的正文，
 * 不再发请求（fetch.attempts 只有真正发过请求才 +1，这就是「只抓一次」的证据）。
 * 失败时什么都不写——条目还是原样，人再点一次就是重试。
 *
 * @param {object} input
 * @param {object} input.store OwnerStore（只用灵感方法与 setIdeaStatus）
 * @param {string} input.id 条目 id
 * @param {(url: string, init: object) => Promise<object>} [input.fetchImpl] 注入的 fetch
 * @param {Function|null} [input.resolveHost] 注入的 DNS 解析
 * @param {Function|null} [input.extract] 注入的提炼器
 * @returns {Promise<object>} ok=true 时带 {item, cached, attempts, sorted}；失败时带 code / reason
 */
export async function sortIdeaEntry({
  store,
  id,
  fetchImpl = null,
  resolveHost = null,
  extract = null,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = FETCH_MAX_BYTES,
  maxRedirects = FETCH_MAX_REDIRECTS,
  now = stamp()
} = {}) {
  const item = store?.getIdeaItem?.(id);
  if (!item) return refuse('missing', '这条灵感不存在，可能已经删了。');
  if (item.ideaStatus === 'adopted' || item.ideaStatus === 'discarded') {
    return refuse('status', '已经采纳 / 丢弃的条目不整理；要再改请先回收件箱。');
  }
  const previous = item.sorted && typeof item.sorted === 'object' ? item.sorted : null;
  const guarded = item.link ? guardIdeaLink(item.link) : null;
  if (guarded && !guarded.ok) return guarded;

  let page = null;
  let attempts = Number.isSafeInteger(previous?.fetch?.attempts) ? previous.fetch.attempts : 0;
  let cached = false;
  if (guarded?.ok) {
    const reusable = Boolean(
      previous?.fetch?.ok
      && previous?.link === guarded.url
      && String(previous?.fetch?.text ?? '').trim()
    );
    if (reusable) {
      page = { ...previous.fetch, cached: true };
      cached = true;
    } else {
      const fetched = await fetchIdeaPage({
        url: guarded.url, fetchImpl, resolveHost, timeoutMs, maxBytes, maxRedirects, now
      });
      // 抓不到就到此为止：条目一个字都不改，原因原样回给面板。
      if (!fetched.ok) return fetched;
      attempts += 1;
      page = { ...fetched, attempts, cached: false };
    }
  } else {
    attempts = 0;
  }

  const tidied = tidyIdeaSections({
    rawText: item.rawText, link: guarded?.url ?? '', page, extract
  });
  const sorted = {
    version: 1,
    at: now,
    source: tidied.source,
    link: guarded?.url ?? '',
    extractor: typeof extract === 'function' ? 'injected' : 'builtin',
    sections: tidied.sections,
    missing: tidied.missing,
    complete: tidied.complete,
    note: tidied.note,
    fetch: page
      ? {
        ok: true,
        url: page.url,
        status: page.status,
        contentType: page.contentType,
        bytes: page.bytes,
        title: page.title ?? '',
        at: page.at ?? null,
        attempts,
        // 只缓存切四段要用的正文；整页 HTML 不进库，条目也不会被一次抓取撑大。
        text: String(page.text ?? '').slice(0, PAGE_TEXT_LIMIT)
      }
      : null
  };

  const saved = store.updateIdeaItem(id, { sorted });
  // 状态只从收件箱往前走一步；已经整理过的条目重排只是换 sorted_result，状态不动。
  const advanced = item.ideaStatus === 'inbox'
    ? store.setIdeaStatus(id, 'sorted', { now })
    : saved;
  return { ok: true, code: '', reason: '', item: advanced, cached, attempts, sorted };
}

/**
 * 视觉验收用的假抓取器：http(s) 请求全部由本地页面顶替，不碰真实网络。
 * 只由桌面端的 OWNER_COMPANION_FAKE_SORT=1 打开；守卫与抓取流程本身完全不变，
 * 换掉的只是最外面这一层 fetch —— 跟 OWNER_COMPANION_FAKE_SOURCE 的做法一致。
 *
 * 返回 { fetch, resolve } 两个可注入件：resolve 固定回一个公网地址，
 * 免得验收机没有 DNS 时被「域名解析失败」挡在门外。
 */
export function fakeIdeaFetch() {
  const fourSections = `<!doctype html><html><head><title>把灵感整理成四段</title></head><body>
    <h1>把灵感整理成四段</h1>
    <p>收件箱里的链接不再是只有一行地址的条目，整理时读一次正文，就能看出值不值得做。</p>
    <h2>问题</h2><p>灵感存下来之后只有一句话，回头看不出当时为什么觉得它重要。</p>
    <h2>想法</h2><p>整理时抓一次公网链接正文，按「问题 / 想法 / 预期收益 / 风险」写成四段，原文完整保留。</p>
    <h2>预期收益</h2><p>决定采纳或丢弃时，能直接对照四段与原文，不用重新读完全文。</p>
    <h2>风险</h2><p>抓不到公开正文的链接会缺段，缺段要显式标出来，不能编。</p>
  </body></html>`;
  const threeSections = `<!doctype html><html><head><title>没有风险一节的想法</title></head><body>
    <h2>问题</h2><p>这条链接的正文里没有「风险」这一段。</p>
    <h2>想法</h2><p>四段里缺一段时，整理结果要明确标出来，而不是留空看着像没有风险。</p>
    <h2>预期收益</h2><p>缺段可见，人才知道要补哪一段。</p>
  </body></html>`;
  const pages = new Map([
    ['https://example.com/ideas/96-four-sections', { status: 200, html: fourSections }],
    ['https://example.com/ideas/96-no-risk', { status: 200, html: threeSections }],
    ['https://example.com/ideas/96-broken', { status: 500, html: '<html><body>boom</body></html>' }]
  ]);
  // 每个地址真的被请求过几次：96-flaky 第一次 503、第二次成功，用来演「失败后人来重试」。
  const calls = new Map();
  const fetchImpl = async (target) => {
    const url = String(target);
    const count = (calls.get(url) ?? 0) + 1;
    calls.set(url, count);
    if (url === 'https://example.com/ideas/96-flaky' && count === 1) {
      return new Response('try again later', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    }
    const page = pages.get(url)
      ?? (url === 'https://example.com/ideas/96-flaky' ? { status: 200, html: fourSections } : null);
    if (!page) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(page.html, {
      status: page.status,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  };
  return {
    fetch: fetchImpl,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }]
  };
}
