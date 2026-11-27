// 模型目录和会话共用 SDK 的模型/凭据运行时，不能把字符串或半份模型对象直接交给 SDK。
// 否则会生成 undefined/undefined，丢失 provider、API 与地址。
import os from 'node:os';
import path from 'node:path';

export function piAgentDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.OWNER_AGENT_PI_HOME) return path.join(env.OWNER_AGENT_PI_HOME, 'agent');
  const explicit = String(env.PI_CODING_AGENT_DIR ?? '').trim();
  if (explicit) return explicit.startsWith('~/') || explicit.startsWith('~\\')
    ? path.join(home, explicit.slice(2)) : explicit;
  return path.join(home, '.pi', 'agent');
}

/** 仅从本地目录恢复；禁止打开设置或创建会话时联网刷新模型目录。 */
export async function createPiModelRuntime({ sdk = null, env = process.env, home } = {}) {
  const api = sdk ?? await import('@earendil-works/pi-coding-agent');
  const agentDir = piAgentDir({ env, home });
  return api.ModelRuntime.create({
    modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'models-store.json'),
    authPath: path.join(agentDir, 'auth.json'), allowModelNetwork: false
  });
}

/** 选择与后续请求使用同一运行时，凭据始终留在主进程。 */
export async function resolvePiModel(model, { sdk = null, env = process.env, home } = {}) {
  if (!model) return {};
  if (typeof model !== 'string') return { model };
  const value = model.trim();
  const split = value.indexOf('/');
  if (split <= 0 || split === value.length - 1) {
    throw Object.assign(new Error('模型格式应为 provider/model，请在模型设置中重新选择。'), { category: 'unknown-model' });
  }
  const modelRuntime = await createPiModelRuntime({ sdk, env, home });
  const selected = modelRuntime.getModel(value.slice(0, split), value.slice(split + 1));
  if (!selected) throw Object.assign(new Error('模型不在当前 Pi 目录中，请刷新模型目录或重新选择。'), { category: 'unknown-model' });
  return { model: selected, modelRuntime };
}
