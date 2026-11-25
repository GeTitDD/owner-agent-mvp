// 会话脱敏的纯函数测试：覆盖的类别、占位符形状、计数与幂等。
// 全部用临时造的假秘密，不读真实配置、不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCandidate, redactSecrets } from '../src/memory/redact.mjs';
import { rejectObviousSecrets } from '../src/evolution.mjs';

const fake = {
  openai: `sk-${'a'.repeat(24)}`,
  github: `ghp_${'b'.repeat(24)}`,
  aws: `AKIA${'A1B2C3D4E5F6G7H8'}`,
  slack: 'xoxb-123456789012-abcdefghij',
  bearer: 'Bearer abcdefghijklmnop',
  url: 'https://deploy:pw123456@example.com/repo',
  password: 'password=hunter233',
  secret: 'secret="s3cr3t!"',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  hex: '0123456789abcdef'.repeat(4),
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
};

test('覆盖密钥前缀、Bearer、URL 口令、赋值、JWT、长 hex 与私钥块，每处计数一次', () => {
  const text = Object.values(fake).join('\n');
  const result = redactSecrets(text);

  assert.deepEqual(Object.keys(result).sort(), ['hits', 'text']);
  assert.equal(result.hits, Object.keys(fake).length);
  // 占位符保留类型，语义不断裂。
  for (const placeholder of [
    '<redacted:api-key>',
    '<redacted:github-token>',
    '<redacted:aws-key>',
    '<redacted:slack-token>',
    '<redacted:bearer-token>',
    '<redacted:url-password>',
    '<redacted:credential>',
    '<redacted:jwt>',
    '<redacted:hex>',
    '<redacted:private-key>'
  ]) {
    assert.ok(result.text.includes(placeholder), placeholder);
  }
  // 原文一个都不该留下。
  assert.ok(!result.text.includes(fake.openai));
  assert.ok(!result.text.includes('hunter233'));
  assert.ok(!result.text.includes('MIIEowIBAAKCAQEA'));
  // 私钥块整段换掉：保留 BEGIN/END 会被存前凭据检测拒收。
  assert.ok(!result.text.includes('-----BEGIN RSA PRIVATE KEY-----'));
});

test('同一段文本脱敏两次结果不变，计数归零（指纹不会因重复脱敏漂移）', () => {
  const once = redactSecrets(`key=${fake.openai} and ${fake.url}`);
  assert.equal(once.hits, 2);
  const twice = redactSecrets(once.text);
  assert.equal(twice.hits, 0);
  assert.equal(twice.text, once.text);
});

test('脱敏后的文本能通过知识库存前凭据检测；原文仍会被拦下', () => {
  const text = Object.values(fake).join('\n');
  const redacted = redactSecrets(text).text;
  // 这是 e2e 发现的真实交互：占位符若保留「password=连续值」或私钥抬头，会被自家防线拒收。
  assert.doesNotThrow(() => rejectObviousSecrets(redacted));
  assert.throws(() => rejectObviousSecrets('password=hunter233'), /Potential credential/u);
  assert.throws(() => rejectObviousSecrets(fake.privateKey), /Potential credential/u);
});

test('普通文本与未达阈值的长串不动：不把普通词误伤成秘密', () => {
  const text = [
    'sk-learn 是库名，token 在这里是普通词。',
    '短 hex 0123456789abcdef0123456789abcd（30 位）不算长串。',
    'a.b.c 不是 JWT。',
    '说明：password 要放环境变量（没有等号与值）。'
  ].join('\n');
  const result = redactSecrets(text);
  assert.equal(result.hits, 0);
  assert.equal(result.text, text);
});

test('候选六个字段全部经过脱敏，返回新对象不改原候选', () => {
  const secret = fake.openai;
  const candidate = {
    fingerprint: 'fp-1',
    phenomenon: `不要再用 ${secret}`,
    intent: `改成 ${secret}`,
    abandoned: `旧 key ${secret}`,
    reason: `因为 ${secret} 泄露了`,
    quote: { user: `不要再用 ${secret}`, assistant: `收到，换掉 ${secret}` }
  };
  const { candidate: cleaned, hits } = redactCandidate(candidate);

  assert.equal(hits, 6);
  assert.equal(candidate.phenomenon, `不要再用 ${secret}`);
  for (const key of ['phenomenon', 'intent', 'abandoned', 'reason']) {
    assert.ok(cleaned[key].includes('<redacted:api-key>'), key);
    assert.ok(!cleaned[key].includes(secret), key);
  }
  assert.ok(cleaned.quote.user.includes('<redacted:api-key>'));
  assert.ok(cleaned.quote.assistant.includes('<redacted:api-key>'));
  assert.equal(cleaned.fingerprint, 'fp-1');
});
