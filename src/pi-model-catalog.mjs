// 把 `provider/model` 字符串解析成 Pi SDK 的 Model 对象。
//
// SDK 在使用临时 agentDir 时不会读取全局 models-store.json；这会让
// 非内置模型（如 glm-5.3-flash）变成 provider=undefined。这里只读取模型
// 目录元数据，不加载扩展、Skill 或项目上下文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const catalogCandidates = () => [
  path.join(os.homedir(), '.pi', 'agent', 'models-store.json'),
  path.join(os.homedir(), '.pi', 'agent', 'models.json')
];

function findModel(provider, id) {
  for (const file of catalogCandidates()) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const providerEntry = data.providers?.[provider] ?? data[provider];
      const models = providerEntry?.models;
      if (!Array.isArray(models)) continue;
      const found = models.find((item) => item?.id === id);
      if (found) return found;
    } catch { /* try next catalog */ }
  }
  return null;
}

export function resolvePiModel(model) {
  if (!model || typeof model !== 'string') return model;
  const [provider, ...rest] = model.split('/');
  if (!provider || rest.length === 0) return model;
  return findModel(provider, rest.join('/')) ?? model;
}
