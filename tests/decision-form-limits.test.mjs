// #138 浏览器侧 decision-form.cjs 的 LIMITS 是服务端上限的副本（经典脚本不能 import ESM）。
// 这里直接读两个源文件比对数字：任一侧改了而另一侧没跟上，测试就失败——不靠注释提醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

/** 服务端唯一真源：src/memory/decision-scan.mjs 的 TEXT。 */
const serverLimits = () => {
  const source = read('src/memory/decision-scan.mjs');
  const block = /const TEXT = \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? '';
  assert.ok(block, '在 decision-scan.mjs 里找不到 TEXT 上限表');
  const pick = (key) => {
    const match = new RegExp(`\\b${key}:\\s*(\\d+)`, 'u').exec(block);
    assert.ok(match, `TEXT 缺少 ${key} 上限`);
    return Number(match[1]);
  };
  return {
    phenomenon: pick('phenomenon'),
    intent: pick('intent'),
    abandoned: pick('abandoned'),
    reason: pick('reason')
  };
};

test('decision-form.cjs 的 LIMITS 与服务端 TEXT 逐项一致', () => {
  const form = require('../desktop/decision-form.cjs');
  assert.deepEqual(
    { ...form.DECISION_FORM_LIMITS },
    serverLimits(),
    '浏览器侧上限已与服务端漂移：改数字时两处都要改'
  );
});

test('服务端入库（decisionContentOf）也按同一组数字截断', () => {
  const source = read('src/memory/decision-confirm.mjs');
  const body = /export function decisionContentOf\([\s\S]*?\n\}/u.exec(source)?.[0] ?? '';
  assert.ok(body, '找不到 decisionContentOf');
  const literals = [...body.matchAll(/flatText\([^,]+,\s*(\d+)\)/gu)].map((match) => Number(match[1]));
  assert.deepEqual(literals, [500, 2000, 2000, 2000], '现象 500 / 选择、放弃、理由各 2000');
});
