// 让 Owner Agent 识别沙箱方案：只读会话看仓库，给出 projectDir + profile 建议。
//
// 安全边界：Agent 只产出“建议”，不执行命令；真正运行仍走 sandbox-protocol 的
// 白名单 profile 与镜像校验，且必须由 Owner 在面板里点击采用。
import { createReadonlySessionFactory } from './pstack/readonly-session.mjs';
import { SANDBOX_PROFILES } from './sandbox-protocol.mjs';

const MAX_TEXT = 6000;

const clean = (value, max = 200) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

function parseJson(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const safeProjectDir = (value) => {
  const input = clean(value, 120).replace(/\\/gu, '/');
  if (input.startsWith('/') || /^[A-Za-z]:\//u.test(input)) return null;
  const dir = input.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!dir || dir === '.') return '';
  if (dir.split('/').includes('..')) return null;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(dir)) return null;
  return dir;
};

export function normalizeSuggestion(raw) {
  if (!raw) return null;
  const profile = String(raw.profile ?? '');
  if (!SANDBOX_PROFILES[profile]) return null;
  const projectDir = safeProjectDir(raw.projectDir);
  if (projectDir === null) return null;
  const confidence = Number(raw.confidence);
  return {
    profile,
    image: SANDBOX_PROFILES[profile].image,
    projectDir,
    reason: clean(raw.reason, 500),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null
  };
}

export async function suggestSandboxPlan({ projectRoot, model = '', timeoutMs = 120000, factory = null } = {}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  const sessionFactory = factory ?? createReadonlySessionFactory({
    playbook: { id: 'sandbox-detect', title: '沙箱方案识别' },
    skillsDir: null
  });
  const profiles = Object.entries(SANDBOX_PROFILES)
    .map(([id, def]) => `- ${id}: image=${def.image}, runtime=${def.runtime}, argv=${def.command.join(' ')}`)
    .join('\n');
  const prompt = [
    '你在为一个本地项目选择沙箱测试方案。只能读文件，不能写文件或执行命令。',
    '先看仓库根目录，再找最多一层子目录里是否存在 project.godot / package.json / pyproject.toml / Cargo.toml / go.mod。',
    '从下面的 profile 中选择最匹配的一个；如果都不匹配，profile 返回空字符串。',
    profiles,
    '',
    '输出严格 JSON：',
    '{"projectDir":"相对仓库根的项目目录，根目录用空字符串","profile":"profile id 或空字符串","reason":"一句话依据","confidence":0到1}',
    '不要输出代码块或解释文字。'
  ].join('\n');
  const session = await sessionFactory.create({ cwd: projectRoot, model });
  let timer = null;
  try {
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('sandbox detect timeout')), timeoutMs);
    });
    await Promise.race([session.prompt(prompt), timedOut]);
    const text = String(session.getLastText() ?? '').slice(0, MAX_TEXT);
    const parsed = parseJson(text);
    const suggestion = normalizeSuggestion(parsed);
    if (!suggestion) throw new Error('模型没有返回可用的沙箱方案');
    return suggestion;
  } finally {
    if (timer) clearTimeout(timer);
    try { session.dispose(); } catch { /* ignore */ }
  }
}
