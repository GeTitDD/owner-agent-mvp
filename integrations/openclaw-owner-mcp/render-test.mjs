import fs from 'node:fs';
import { renderPng } from './diagrams.mjs';
const owner = JSON.parse(fs.readFileSync('C:/Users/Administrator/.owner-companion/owner.json', 'utf8'));
for (const kind of ['dependency', 'sequence', 'state']) {
  const g = owner.diagrams['cultivation-agent'][kind];
  if (!g) continue;
  const png = renderPng(g.kind, g.data, { width: 1400 });
  const file = `D:/nautilus_trader/.tmp/opencode/test-${kind}.png`;
  fs.writeFileSync(file, png);
  console.log(kind, png.length, file);
}
