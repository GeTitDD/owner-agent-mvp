import fs from 'node:fs';
const owner = JSON.parse(fs.readFileSync('C:/Users/Administrator/.owner-companion/owner.json', 'utf8'));
const out = 'D:/nautilus_trader/.tmp/opencode/mmd';
fs.mkdirSync(out, { recursive: true });
for (const kind of ['dependency', 'control', 'dataflow', 'sequence', 'state']) {
  const g = owner.diagrams['cultivation-agent'][kind];
  if (!g?.mermaid) continue;
  fs.writeFileSync(`${out}/${kind}.mmd`, g.mermaid, 'utf8');
  console.log(kind, g.mermaid.length);
}
