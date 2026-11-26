// 提炼提取器：提示词、JSON 解析、会话复用与释放。全部用假会话，不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDistillPrompt,
  createLessonExtractor,
  parseLessonJson
} from '../src/knowledge-loop/distill-extractor.mjs';

const evidence = [
  { ref: 'sandbox:run-1', kind: 'sandbox-run', excerpt: 'status=failed; test=failed; exit=1' },
  { ref: 'record:r1', kind: 'record', excerpt: '记录=r1; status=failed' }
];

test('buildDistillPrompt：带记录字段、证据 ref 与「只输出 JSON」', () => {
  const prompt = buildDistillPrompt({
    record: { id: 'r1', projectId: 'demo', taskTitle: '修复重试', status: 'failed', testStatus: 'failed', changedFiles: ['src/a.mjs'] },
    evidence
  });
  assert.match(prompt, /只输出一个 JSON 对象/u);
  assert.match(prompt, /r1/u);
  assert.match(prompt, /修复重试/u);
  assert.match(prompt, /sandbox:run-1/u);
  assert.match(prompt, /允许的 evidenceRefs：sandbox:run-1, record:r1/u);
});

test('buildDistillPrompt：没有证据时明确要求 mechanism 留空', () => {
  const prompt = buildDistillPrompt({ record: { id: 'r2' }, evidence: [] });
  assert.match(prompt, /没有证据/u);
  assert.match(prompt, /mechanism 必须留空/u);
});

test('parseLessonJson：容忍代码围栏与前后废话，坏 JSON 要报错', () => {
  const parsed = parseLessonJson('说明\n```json\n{"phenomenon":"p","mechanism":"m","countermeasure":"c","evidenceRefs":[]}\n```');
  assert.equal(parsed.phenomenon, 'p');
  assert.throws(() => parseLessonJson('完全没有 JSON'), /没有返回 JSON/u);
  assert.throws(() => parseLessonJson('{ not json }'), /解析失败/u);
});

test('createLessonExtractor：复用会话、返回对象、释放后再用要报错', async () => {
  const calls = [];
  let disposed = 0;
  const factory = {
    async create({ cwd, model }) {
      calls.push({ cwd, model });
      return {
        prompt: async (text) => calls.push({ prompt: text }),
        getLastText: () => '{"phenomenon":"p","mechanism":"","countermeasure":"c","evidenceRefs":["record:r1"]}',
        dispose: () => { disposed += 1; }
      };
    }
  };
  const extractor = createLessonExtractor({ cwd: 'D:/demo', model: 'fake/model', factory });
  const draft = await extractor.extract({ record: { id: 'r1' }, evidence });
  assert.equal(draft.countermeasure, 'c');
  // 第二次提取复用同一个会话：模型只加载一次。
  await extractor.extract({ record: { id: 'r2' }, evidence: [] });
  assert.equal(calls.filter((item) => item.model).length, 1, '两次提取只建一个会话');
  assert.equal(calls.filter((item) => item.prompt).length, 2);

  extractor.dispose();
  assert.equal(disposed, 1);
  await assert.rejects(() => extractor.extract({ record: { id: 'r2' }, evidence: [] }), /已释放/u);
});
