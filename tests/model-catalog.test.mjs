// 模型目录：把 Pi 的两个目录文件合并成配置箱可选的行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelCatalog, hasCredential } from '../src/model-catalog.mjs';

const store = {
  file: 'models-store.json',
  data: {
    providers: {
      deepseek: { models: [{ id: 'deepseek-v4' }, { id: 'deepseek-v4-flash' }] },
      'zai-coding-cn': { models: [{ id: 'glm-5.3-flash' }] }
    }
  }
};
const custom = {
  file: 'models.json',
  data: {
    providers: {
      supergpt: { models: [{ id: 'deepseek-v4.1-flash' }] }
    }
  }
};

test('合并两个目录文件，id 用 provider/model 且不重复', () => {
  const catalog = buildModelCatalog({ stores: [store, custom, store], env: {} });
  const ids = catalog.items.map((item) => item.id);
  assert.deepEqual(ids.sort(), [
    'deepseek/deepseek-v4',
    'deepseek/deepseek-v4-flash',
    'supergpt/deepseek-v4.1-flash',
    'zai-coding-cn/glm-5.3-flash'
  ]);
  assert.equal(catalog.providers.length, 3);
});

test('凭据只看 auth.json 键名与环境变量是否非空', () => {
  const catalog = buildModelCatalog({
    stores: [store],
    auth: { deepseek: { token: 'x' } },
    env: { ANTHROPIC_API_KEY: 'y', OPENAI_API_KEY: '' }
  });
  const byId = new Map(catalog.items.map((item) => [item.id, item]));
  assert.equal(byId.get('deepseek/deepseek-v4').ready, true, 'auth.json 有该 provider');
  assert.equal(byId.get('zai-coding-cn/glm-5.3-flash').ready, false);
  assert.equal(hasCredential('anthropic', new Set(), { ANTHROPIC_API_KEY: 'y' }), true);
  assert.equal(hasCredential('openai', new Set(), { OPENAI_API_KEY: '   ' }), false);
});

test('有凭据的排前面，其余按 id 字典序', () => {
  const catalog = buildModelCatalog({
    stores: [store, custom],
    auth: { 'zai-coding-cn': {} },
    env: {}
  });
  assert.equal(catalog.items[0].id, 'zai-coding-cn/glm-5.3-flash');
  assert.equal(catalog.items[0].ready, true);
  const rest = catalog.items.slice(1).map((item) => item.id);
  assert.deepEqual(rest, [...rest].sort());
});

test('读不到目录时返回空表而不是抛错', () => {
  const catalog = buildModelCatalog({ stores: [{ file: 'x', data: null }, { file: 'y', data: {} }] });
  assert.deepEqual(catalog.items, []);
  assert.deepEqual(catalog.providers, []);
});
