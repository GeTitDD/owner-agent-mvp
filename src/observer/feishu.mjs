// 飞书群投递。
//
// 只支持自定义机器人 incoming webhook 的文本消息（msg_type=text），
// 不处理回执、按钮或双向交互。投递失败返回结果对象，不向调用方抛异常：
// 观察流程不能因为一次网络错误而中断，#30 才负责重试与失败原因上报。

/**
 * 停滞事件的人读消息。
 * @param {object} event detectStaleEvent 的输出
 * @returns {string}
 */
export const formatStaleMessage = (event) => [
  `【停滞】${event.projectName || event.projectId} 已停滞 ${event.daysStale} 天`,
  `项目：${event.projectName || event.projectId}（${event.projectId}）`,
  `分支：${event.branchLabel}`,
  `最后提交：${event.lastCommitAt}`
].join('\n');

/**
 * 发送一条飞书文本消息。
 * @param {{webhookUrl?:string, text:string, fetchImpl?:Function, timeoutMs?:number}} options
 * @returns {Promise<{status:'sent'|'failed'|'skipped', detail:string}>}
 */
export async function deliverFeishu({
  webhookUrl = '',
  text,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
} = {}) {
  const configured = typeof webhookUrl === 'string' ? webhookUrl.trim() : '';
  if (!configured) return { status: 'skipped', detail: 'feishu webhook not configured' };

  let url;
  try {
    url = new URL(configured);
  } catch {
    return { status: 'failed', detail: 'invalid feishu webhook url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { status: 'failed', detail: 'invalid feishu webhook url' };
  }

  const payload = { msg_type: 'text', content: { text: String(text ?? '') } };
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    // 不回显 URL：webhook 本身就是凭据。
    return { status: 'failed', detail: `feishu request failed: ${error?.message ?? error}` };
  }

  const body = await response.text().catch(() => '');
  if (!response.ok) return { status: 'failed', detail: `feishu http ${response.status}` };

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'failed', detail: 'feishu returned non-JSON response' };
  }
  const code = Number(parsed.code ?? parsed.StatusCode ?? NaN);
  if (code !== 0) {
    const message = parsed.msg ?? parsed.StatusMessage ?? '';
    return { status: 'failed', detail: `feishu code ${Number.isNaN(code) ? 'unknown' : code}${message ? `: ${message}` : ''}` };
  }
  return { status: 'sent', detail: 'feishu code 0' };
}
