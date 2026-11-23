// 观察员投递配置。
//
// 优先级：环境变量 OWNER_OBSERVER_FEISHU_WEBHOOK → ~/.owner-agent/feishu.json 的 webhook 字段 → 无。
// webhook URL 等同于往群里发消息的凭据，只存在本机配置或环境变量，绝不写进仓库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认配置文件位置：与 Owner 数据同目录（~/.owner-agent）。 */
export const defaultFeishuConfigPath = () => path.join(os.homedir(), '.owner-agent', 'feishu.json');

/**
 * 解析飞书 webhook 配置。
 * @param {{env?:object, configPath?:string}} [options]
 * @returns {{webhook:string, source:'env'|'config'|'none'} }
 */
export function resolveFeishuWebhook({ env = process.env, configPath = defaultFeishuConfigPath() } = {}) {
  const fromEnv = typeof env?.OWNER_OBSERVER_FEISHU_WEBHOOK === 'string'
    ? env.OWNER_OBSERVER_FEISHU_WEBHOOK.trim()
    : '';
  if (fromEnv) return { webhook: fromEnv, source: 'env' };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const fromFile = typeof parsed?.webhook === 'string' ? parsed.webhook.trim() : '';
    if (fromFile) return { webhook: fromFile, source: 'config' };
  } catch {
    // 文件不存在、不可读或不是合法 JSON 都按“未配置”处理，观察流程不因此失败。
  }
  return { webhook: '', source: 'none' };
}
