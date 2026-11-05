// Explicit local verification helper. Never executes an LLM-supplied shell string.
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { sha256, validateRelativeFile } from './utils.mjs';

export async function verifyNodeTest({ store, runId, projectRoot, testFile, summary, sharingConsent = false, timeoutMs = 30000 }) {
  validateRelativeFile(testFile);
  const root = await realpath(projectRoot);
  const fullPath = await realpath(path.resolve(root, testFile));
  if (!fullPath.startsWith(root + path.sep)) throw new Error('Test file escapes project root');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('Invalid test timeout');
  const run = store.getRun(runId);
  if (!run || run.status !== 'settled') throw new Error('Only settled runs can have evidence');
  // Windows 下 TMP 可能是 8.3 短路径，realpath 展开后与记录值字符串不同；先把记录的根路径归一再比较
  let recordedRoot = run.project_root;
  try { recordedRoot = await realpath(recordedRoot); } catch { /* 目录可能已被清理，退回原字符串 */ }
  if (recordedRoot !== root) throw new Error('Test project root must match recorded run project root');
  const fileHash = sha256(await readFile(fullPath));
  const state = await new Promise((resolve, reject) => {
    // A verifier may itself run under node:test; remove its worker marker so the child is independent.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--test', fullPath], { cwd: root, env, shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
  });
  const passed = state.code === 0 && !state.timedOut && !state.signal;
  const evidence = store.addEvidence({
    runId, kind: 'test', outcome: passed ? 'passed' : 'failed',
    summary, reference: `node-test:${testFile}@${fileHash.slice(0, 16)}:${passed ? 'pass' : 'fail'}`,
    sharingConsent, verificationMethod: 'node-test'
  });
  return { evidence, passed, code: state.code, signal: state.signal, timedOut: state.timedOut };
}
