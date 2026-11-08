// 与 pstack `scripts/decision-log.sh` 同列的 TSV 决策日志。
// 追加式；证据一列只放路径/ID，不写长段落。
import fs from 'node:fs';
import path from 'node:path';

const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult\n';
const clean = (value) => {
  const text = String(value ?? '').replace(/[\t\n\r]+/gu, ' ').trim();
  return /^[=+\-@]/u.test(text) ? `'${text}` : text;
};

export function appendDecision(file, { phase, decision, why = '', evidence = '', result = '' }, clock = () => new Date().toISOString()) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) fs.appendFileSync(target, HEADER, 'utf8');
  const row = [clock(), phase, decision, why, evidence, result].map(clean).join('\t');
  fs.appendFileSync(target, `${row}\n`, 'utf8');
  return { file: target, row };
}
