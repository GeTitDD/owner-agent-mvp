// 执行记录 → Lesson 的模型提取器。
//
// 输入只有一条执行记录与它的证据摘要；输出严格 JSON：
// { phenomenon, mechanism, countermeasure, evidenceRefs[] }。
//
// 边界：
// - 用 Pi 的无工具会话（noTools），不读文件、不联网；
// - 只把证据摘要交给模型，不传完整 stdout/stderr；
// - evidenceRefs 只能从给定 ref 列表里选，写错的会在蒸馏时被过滤（lesson.mjs 负责）；
// - 解析失败 / 模型不返回 JSON 一律抛错，由调用方记「提取失败」，不伪造经验。
import { DefaultPiSessionFactory } from '../pi-session-factory.mjs';

export const DISTILL_MAX_EVIDENCE = 8;

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * 提炼提示词：只给记录字段与证据摘要，要求 JSON。
 * 纯函数，测试可以直接断言包含哪些信息。
 */
export function buildDistillPrompt({ record = {}, evidence = [] } = {}) {
  const refs = evidence.map((item) => String(item.ref ?? '')).filter(Boolean);
  const lines = [
    '你是只读的项目经验提炼器。根据一条执行记录及其证据，提炼一条可复核的经验。',
    '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。字段：',
    '{',
    '  "phenomenon": "现象：发生了什么（一句话，具体）",',
    '  "mechanism": "原因：为什么会这样（没有证据就写空字符串）",',
    '  "countermeasure": "对策：下次怎么做（可执行）",',
    `  "evidenceRefs": ["只能从下面 ref 列表里选，最多 ${Math.min(refs.length, DISTILL_MAX_EVIDENCE)} 个"]`,
    '}',
    '',
    '执行记录：',
    `- id: ${clip(record.id, 120)}`,
    `- 项目: ${clip(record.projectId, 120)}`,
    `- 任务: ${clip(record.taskTitle, 160) || '（无）'}`,
    `- 状态: ${clip(record.status, 40) || 'unknown'}`,
    `- 测试: ${clip(record.testStatus, 40) || 'unknown'}`,
    `- 改动文件: ${(record.changedFiles ?? []).slice(0, 8).join(', ') || '（无）'}`,
    '',
    '证据（ref｜摘要）：'
  ];
  for (const item of evidence.slice(0, DISTILL_MAX_EVIDENCE)) {
    lines.push(`- ${item.ref} | ${clip(item.excerpt, 220)}`);
  }
  if (!evidence.length) lines.push('-（没有证据：mechanism 必须留空）');
  lines.push('');
  lines.push(`允许的 evidenceRefs：${refs.length ? refs.join(', ') : '（空）'}`);
  return lines.join('\n');
}

/** 从模型输出里取第一个 JSON 对象；容忍代码围栏与前后废话。 */
export function parseLessonJson(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new Error(`模型返回的 JSON 解析失败：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型返回的不是一个对象');
  }
  return parsed;
}

/**
 * 创建提取器。会话按命令复用一次，结束后由调用方 dispose。
 *
 * @param {object} input
 * @param {string} [input.model]  provider/model
 * @param {string} input.cwd      会话 cwd（不读盘，只给 SDK 一个合法目录）
 * @param {object} [input.factory] 默认真实 Pi 会话工厂；测试可注入
 */
export function createLessonExtractor({ model = '', cwd, factory = DefaultPiSessionFactory } = {}) {
  if (!cwd) throw new Error('cwd is required');
  let session = null;
  let disposed = false;

  const ensure = async () => {
    if (disposed) throw new Error('提取器已释放');
    if (!session) session = await factory.create({ cwd, model });
    return session;
  };

  return {
    async extract({ record, evidence } = {}) {
      const active = await ensure();
      await active.prompt(buildDistillPrompt({ record, evidence }));
      return parseLessonJson(active.getLastText());
    },
    dispose() {
      disposed = true;
      try { session?.dispose?.(); } catch { /* 释放失败不影响结果 */ }
      session = null;
    }
  };
}
