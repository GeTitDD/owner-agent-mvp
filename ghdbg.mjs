import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGithub } from './plugins/owner-companion/node/lib/github.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghdbg-'));
const gh = createGithub();
try {
  const repo = await gh.repoSlug(root);
  console.log('repo', repo);
  console.log('issues', await gh.listIssues(root));
} catch (e) {
  console.log('ERR', String(e?.message ?? e).slice(0, 200));
}
fs.rmSync(root, { recursive: true, force: true });
