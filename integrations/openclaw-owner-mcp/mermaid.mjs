// 用 Mermaid CLI（开源，MIT）把 Mermaid 源码渲染成 PNG。
//
// 为什么不用自己画的 SVG：Mermaid 使用 dagre/ELK 分层布局，
// 依赖图、控制流、数据流、时序和状态机的走线、换行、标签避让都更成熟。
// 这里复用系统已安装的 Edge（puppeteer-config.json），不额外下载 Chromium。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
const puppeteerConfig = path.join(here, 'puppeteer-config.json');

/**
 * 渲染 Mermaid 为 PNG。失败返回 null，由调用方回退到文本/旧渲染器。
 * @param {string} mermaid
 * @param {{ size?: number, theme?: string }} options
 * @returns {Promise<Buffer|null>}
 */
const renderOnce = (mermaid, size, theme) => new Promise((resolve) => {
  const source = String(mermaid || '').trim();
  if (!source) {
    resolve(null);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mermaid-'));
  const input = path.join(dir, 'diagram.mmd');
  const output = path.join(dir, 'diagram.png');
  try {
    fs.writeFileSync(input, source, 'utf8');
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    resolve(null);
    return;
  }
  const args = [
    cli,
    '-i', input,
    '-o', output,
    '--size', String(size),
    '-b', 'white',
    '-t', theme,
    '-p', puppeteerConfig,
    '-q'
  ];
  execFile(process.execPath, args, { timeout: 90000, windowsHide: true }, (error) => {
    let png = null;
    try {
      if (!error) png = fs.readFileSync(output);
    } catch {
      png = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    if (png && png.length > 0 && png.length <= 9 * 1024 * 1024) resolve(png);
    else resolve(null);
  });
});

export const renderMermaidPng = async (mermaid, { size = 1600, theme = 'neutral' } = {}) => {
  const first = await renderOnce(mermaid, size, theme);
  if (first) return first;
  // Edge/CLI 偶发启动失败时重试一次。
  await new Promise((resolve) => setTimeout(resolve, 600));
  return renderOnce(mermaid, size, theme);
};
