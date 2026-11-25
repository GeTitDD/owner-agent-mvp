// 测试等待统一出口的自身测试：默认上限、环境变量覆盖、超时仍然失败。
// 这里不碰任何业务，只证明 TEST_WAIT_MS 真的被读到，且 0/非法值不会把等待变成「永远通过」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor, waitLimit } from './helpers/wait.mjs';

test('waitLimit：默认 15000ms，TEST_WAIT_MS 只接受正数', () => {
  assert.equal(waitLimit({}), 15000);
  assert.equal(waitLimit({ TEST_WAIT_MS: '250' }), 250);
  assert.equal(waitLimit({ TEST_WAIT_MS: '0' }), 15000);
  assert.equal(waitLimit({ TEST_WAIT_MS: '-5' }), 15000);
  assert.equal(waitLimit({ TEST_WAIT_MS: 'abc' }), 15000);
});

test('TEST_WAIT_MS 对真实 waitFor 生效：收紧后仍按条件失败，不会假通过', async () => {
  const previous = process.env.TEST_WAIT_MS;
  process.env.TEST_WAIT_MS = '60';
  try {
    const started = Date.now();
    await assert.rejects(waitFor(() => false, 'never'), /waitFor timeout: never/u);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 50 && elapsed < 3000, `elapsed=${elapsed}`);
  } finally {
    if (previous === undefined) delete process.env.TEST_WAIT_MS;
    else process.env.TEST_WAIT_MS = previous;
  }
});
