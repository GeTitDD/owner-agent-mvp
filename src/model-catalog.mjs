// 模型目录：把 Pi 的 provider/model 目录读成「配置箱里可选的一行」。
//
// 为什么需要：模型 ID 是 `provider/model`，靠人背不现实。这里只做两件事：
// 1. 合并 models-store.json 与 models.json 里的 provider/models（后者是自定义 provider）；
// 2. 标出「这个 provider 有没有凭据」——只看 auth.json 的键名与环境变量是否非空，
//    不读、不回传任何密钥值。
//
// 纯函数：文件内容与 env 由调用方注入，测试不碰真实家目录。

/** provider 与常见环境变量名的对应：只用于判断「有没有配」，不用于读取值。 */
export const PROVIDER_ENV = Object.freeze({
  deepseek: ['DEEPSEEK_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY']
});

/**
 * 合并多个目录文件。
 *
 * @param {object} input
 * @param {Array<{file: string, data: unknown}>} input.stores 已解析的目录文件
 * @param {Record<string, unknown>} [input.auth] auth.json（只取键名）
 * @param {Record<string, string|undefined>} [input.env]
 * @returns {{items: Array<{id: string, provider: string, model: string,
 *   label: string, ready: boolean, source: string}>, providers: string[]}}
 */
export function buildModelCatalog({ stores = [], auth = {}, env = {} } = {}) {
  const seen = new Map();
  const providerKeys = new Set(Object.keys(auth ?? {}));

  for (const store of stores) {
    const data = store?.data ?? {};
    const providers = data.providers && typeof data.providers === 'object'
      ? data.providers
      : data;
    if (!providers || typeof providers !== 'object') continue;
    for (const [provider, entry] of Object.entries(providers)) {
      const models = Array.isArray(entry?.models) ? entry.models : [];
      for (const model of models) {
        const id = String(model?.id ?? model?.name ?? '').trim();
        if (!id) continue;
        const key = `${provider}/${id}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          id: key,
          provider,
          model: id,
          label: String(model?.label ?? model?.displayName ?? id),
          ready: hasCredential(provider, providerKeys, env),
          source: store?.file ?? ''
        });
      }
    }
  }

  const items = [...seen.values()].sort((a, b) => {
    // 已登录的排前面，再按 id 字典序：打开选择器第一眼看到的是能用的。
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return {
    items,
    providers: [...new Set(items.map((item) => item.provider))]
  };
}

/** 这个 provider 有没有可用凭据：auth.json 里有键，或对应的环境变量非空。 */
export function hasCredential(provider, authKeys = new Set(), env = {}) {
  if (authKeys.has(provider)) return true;
  const names = PROVIDER_ENV[provider] ?? [];
  return names.some((name) => String(env?.[name] ?? '').trim().length > 0);
}

/** SDK 的本地目录是实际请求的依据；输出白名单字段，绝不把 API key、地址或鉴权头带到界面。 */
export function modelCatalogOf(runtime) {
  const items = runtime.getModels().map((model) => ({
    id: `${model.provider}/${model.id}`, provider: String(model.provider), model: String(model.id),
    label: String(model.name || model.id), ready: runtime.hasConfiguredAuth(model.provider) === true,
    source: 'Pi 本地目录'
  })).sort((a, b) => Number(b.ready) - Number(a.ready) || a.id.localeCompare(b.id));
  return { items, providers: [...new Set(items.map((item) => item.provider))],
    warning: runtime.getError?.() ? '部分模型目录读取失败，请检查 Pi 的 models.json 配置。' : '' };
}
