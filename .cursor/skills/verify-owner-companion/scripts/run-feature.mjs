// 跑一个功能 drive：起隔离实例 → 执行 drive → 截图/写 result.json → 关实例。
// 用法：node .cursor/skills/verify-owner-companion/scripts/run-feature.mjs <drive.mjs>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// node:sqlite 会打 ExperimentalWarning；验证输出要干净，否则调用方容易把警告当失败。
process.removeAllListeners('warning');
const { createSession } = await import('./session.mjs');

const stepPath = process.argv[2];
if (!stepPath) {
  console.error('用法：node run-feature.mjs <drive.mjs>');
  process.exit(2);
}
const step = path.resolve(stepPath);
if (!fs.existsSync(step)) {
  console.error(`找不到 drive：${step}`);
  process.exit(2);
}

const session = await createSession({ name: path.basename(step, '.mjs') });
const started = Date.now();
const writeResult = (payload) => fs.writeFileSync(
  path.join(session.evidenceDir, 'result.json'),
  JSON.stringify({ step: path.basename(step), evidenceDir: session.evidenceDir, ...payload }, null, 2),
  'utf8'
);

try {
  const mod = await import(pathToFileURL(step).href);
  if (typeof mod.default !== 'function') {
    throw new Error('drive 需要 `export default async function (session) { ... }`');
  }
  await mod.default(session);
  writeResult({ status: 'PASS', durationMs: Date.now() - started });
  console.log(`PASS ${path.basename(step)}`);
  console.log(`evidence ${session.evidenceDir}`);
} catch (error) {
  await session.shot('failure.png').catch(() => {});
  writeResult({
    status: 'FAIL',
    durationMs: Date.now() - started,
    error: String(error?.stack ?? error)
  });
  console.error(`FAIL ${path.basename(step)}: ${error?.message ?? error}`);
  console.error(`evidence ${session.evidenceDir}`);
  process.exitCode = 1;
} finally {
  await session.stop();
  // 清理之后再确认一次证据还在：清理只删临时实例，不删证据。
  if (!fs.existsSync(path.join(session.evidenceDir, 'result.json'))) {
    console.error(`证据被清理掉了：${session.evidenceDir}`);
    process.exitCode = 1;
  }
}
