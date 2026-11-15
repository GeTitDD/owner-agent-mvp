// 打包 Cindy 插件：生成 plugins/dist/<插件目录>-<version>.cindy。
//
// 用法：node scripts/build-cindy-plugin.mjs [插件目录名]
// 缺省打包 owner-companion；插件目录必须在 plugins/ 下并带 ghost.json。
//
// 注意：zip 条目必须用正斜杠；Windows 的 Compress-Archive 会写成反斜杠，
// Cindy 无法识别 node/worker.cjs 这类路径，会直接拒装。
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const root = path.resolve(import.meta.dirname, '..');
const name = process.argv[2] || 'owner-companion';
const src = path.join(root, 'plugins', name);
if (!fs.existsSync(path.join(src, 'ghost.json'))) {
  throw new Error(`插件目录不存在或缺少 ghost.json：${src}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'ghost.json'), 'utf8'));
const outDir = path.join(root, 'plugins', 'dist');
const outFile = path.join(outDir, `${manifest.id || name}-${manifest.version}.cindy`);

const zip = new JSZip();
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, rel);
    else zip.file(rel, fs.readFileSync(full));
  }
};
walk(src);

const buffer = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 }
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, buffer);
console.log(`packed ${path.relative(root, outFile)} (${buffer.length} bytes)`);
