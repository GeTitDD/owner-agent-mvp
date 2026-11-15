// 创建 GitHub PR 的纯函数：分支安全校验、PR 文案与预览哈希。
//
// 远端写操作必须由主进程执行；这里只放可直接单元测试的规则。
import { createHash } from 'node:crypto';

/**
 * 只允许推送 Owner 自己创建的分支，且不能是 main / master。
 * @param {string} branch
 */
export function isSafeHeadBranch(branch) {
  const value = String(branch ?? '');
  if (!value || value.length > 120) return false;
  if (!/^owner\/[A-Za-z0-9._/-]+$/u.test(value)) return false;
  if (/(^|\/)(main|master)$/iu.test(value)) return false;
  if (value.includes('..') || value.includes('//')) return false;
  return true;
}

/**
 * 生成 PR 标题、正文与 commit message。
 * 默认创建 Draft PR，正文明确写“不会合并”。
 */
export function buildPrDraft({
  taskTitle = '', projectName = '', cycleId = '', proposalId = '',
  runId = '', files = [], base = '', head = ''
} = {}) {
  const title = `[Owner] ${String(taskTitle || projectName || '项目改动').replace(/\s+/gu, ' ').trim().slice(0, 120)}`;
  const fileList = [...new Set(files.map((file) => String(file)))].sort();
  const body = [
    '## 由 Owner Companion 创建',
    '',
    `- 项目：${projectName || '未命名'}`,
    `- 修复周期：${cycleId || '—'}（复测通过）`,
    `- 补丁：${proposalId || '—'}`,
    `- 测试运行：${runId || '—'}`,
    `- 分支：${head || '—'} → ${base || '—'}`,
    '',
    '## 变更文件',
    ...(fileList.length ? fileList.map((file) => `- \`${file}\``) : ['- （无）']),
    '',
    '> 这是 Owner Companion 创建的 Draft PR，不会自动合并。请审阅 diff 与测试证据后再决定。'
  ].join('\n').slice(0, 6000);
  return {
    title,
    body,
    commitMessage: `owner: ${title}`
  };
}

/**
 * 预览哈希：把即将推送的内容固定下来，创建时必须带同一个哈希。
 * @param {object} parts
 */
export function prPreviewHash(parts = {}) {
  const stable = {
    repo: String(parts.repo ?? ''),
    base: String(parts.base ?? ''),
    head: String(parts.head ?? ''),
    files: [...new Set((parts.files ?? []).map((file) => String(file)))].sort(),
    proposalHash: String(parts.proposalHash ?? ''),
    commitMessage: String(parts.commitMessage ?? ''),
    cycleId: String(parts.cycleId ?? '')
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
