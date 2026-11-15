// Agent 沙箱建议：规范化与只读会话输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSuggestion, suggestSandboxPlan } from '../src/sandbox-detect.mjs';

test('normalizeSuggestion 只接受白名单 profile 与安全子目录', () => {
  const ok = normalizeSuggestion({
    projectDir: 'godot-project', profile: 'godot-headless', reason: 'found project.godot', confidence: 0.9
  });
  assert.equal(ok.profile, 'godot-headless');
  assert.equal(ok.projectDir, 'godot-project');
  assert.equal(ok.image, 'barichello/godot-ci:4.3');
  assert.equal(ok.confidence, 0.9);

  const rootLevel = normalizeSuggestion({ projectDir: '', profile: 'node-smoke', confidence: 2 });
  assert.equal(rootLevel.projectDir, '');
  assert.equal(rootLevel.confidence, 1);

  assert.equal(normalizeSuggestion({ profile: 'unknown', projectDir: '' }), null);
  assert.equal(normalizeSuggestion({ profile: 'node-smoke', projectDir: '../escape' }), null);
  assert.equal(normalizeSuggestion({ profile: 'node-smoke', projectDir: '/abs' }), null);
});

test('suggestSandboxPlan 解析只读会话的 JSON 输出', async () => {
  let seenPrompt = '';
  const factory = {
    async create() {
      return {
        prompt: async (prompt) => { seenPrompt = prompt; },
        getLastText: () => '```json\n{"projectDir":"godot-project","profile":"godot-headless","reason":"project.godot in subdir","confidence":0.8}\n```',
        dispose: () => {}
      };
    }
  };
  const suggestion = await suggestSandboxPlan({ projectRoot: process.cwd(), factory });
  assert.equal(suggestion.profile, 'godot-headless');
  assert.equal(suggestion.projectDir, 'godot-project');
  assert.match(seenPrompt, /project\.godot/u);
});

test('suggestSandboxPlan 拒绝不可用输出', async () => {
  const factory = {
    async create() {
      return { prompt: async () => {}, getLastText: () => '我不知道', dispose: () => {} };
    }
  };
  await assert.rejects(
    () => suggestSandboxPlan({ projectRoot: process.cwd(), factory }),
    /没有返回可用的沙箱方案/u
  );
});
