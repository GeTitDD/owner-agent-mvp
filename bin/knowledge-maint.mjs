#!/usr/bin/env node
// Knowledge Maintenance & Provenance CLI。
//
// 所有命令默认只读；写入命令只登记来源/观察/采纳与同步，不生成知识内容。
// 示例：
//   node bin/knowledge-maint.mjs project register --project demo --root <dir>
//   node bin/knowledge-maint.mjs observe --kind git --project demo --root <dir> --path src/retry.js
//   node bin/knowledge-maint.mjs link --knowledge personal.x --revision 2 --observation obs.y
//   node bin/knowledge-maint.mjs explain --knowledge personal.x
//   node bin/knowledge-maint.mjs sync export --project demo --out bundle.json
//   node bin/knowledge-maint.mjs sync import --in bundle.json --dry-run
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnerStore } from '../src/owner-store.mjs';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { KnowledgeProvenance } from '../src/knowledge/provenance.mjs';
import { KnowledgeContextLedger } from '../src/knowledge/context-ledger.mjs';
import { resolveGitFileSource, resolveLocalFileSource, resolveGitHubSource, resolveOwnerRunSource, resolveSessionSource } from '../src/knowledge/resolvers.mjs';
import { exportBundle, importBundle } from '../src/knowledge/sync.mjs';
import { deviceId } from '../src/knowledge/sources.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const group = args[0] && !args[0].startsWith('--') ? args.shift() : '';
const read = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
};
const has = (flag) => args.includes(flag);
const json = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = (message) => { console.error(message); process.exitCode = 1; };

const defaultDb = (name) => path.join(os.homedir(), '.domain-context', name);
const ownerDb = read('--owner-db', process.env.OWNER_AGENT_DB || defaultDb('owner.sqlite'));
const knowledgeDb = read('--knowledge-db', process.env.DOMAIN_CONTEXT_DB || defaultDb('index.sqlite'));

const open = ({ owner = false } = {}) => {
  const personal = new PersonalKnowledgeStore(knowledgeDb);
  const ownerStore = owner ? new OwnerStore(ownerDb) : null;
  const provenance = new KnowledgeProvenance({ personalStore: personal });
  const ledger = new KnowledgeContextLedger({ personalStore: personal });
  return { personal, ownerStore, provenance, ledger };
};
const close = (stores) => {
  stores.ownerStore?.close?.();
  stores.personal.close();
};

const projectArgs = () => ({
  projectId: read('--project'),
  root: read('--root', process.cwd())
});

const resolveDescriptor = async (stores) => {
  const kind = read('--kind', 'git');
  const { projectId, root } = projectArgs();
  const observedAt = read('--observed-at') || undefined;
  const captureRunId = read('--capture-run');
  const evidence = {};
  if (kind === 'git' || kind === 'file') {
    const relPath = read('--path');
    if (!relPath) throw new Error('--path is required for git/file sources');
    const result = (kind === 'git' ? resolveGitFileSource : resolveLocalFileSource)({
      root, relPath, projectId, captureRunId, observedAt
    });
    Object.assign(evidence, result);
  } else if (kind === 'github') {
    Object.assign(evidence, resolveGitHubSource({
      repo: read('--repo'), kind: read('--github-kind', 'commit'), ref: read('--ref'),
      projectId, captureRunId, observedAt
    }));
  } else if (kind === 'run') {
    const { ownerStore } = stores;
    if (!ownerStore) throw new Error('--owner-db 打开失败');
    Object.assign(evidence, resolveOwnerRunSource({ ownerStore, runId: read('--run'), captureRunId, observedAt }));
  } else if (kind === 'session') {
    Object.assign(evidence, resolveSessionSource({
      sessionId: read('--session'), transcriptHash: read('--transcript-hash'),
      namespace: read('--namespace', 'pi'), projectId, captureRunId, observedAt
    }));
  } else {
    throw new Error(`Unsupported --kind: ${kind}`);
  }
  evidence.descriptor.projectId = projectId || null;
  return evidence;
};

async function main() {
  if (!command || command === 'help' || has('--help')) {
    console.log(`knowledge-maint <command>

  project register --project <id> --root <dir>
  source list [--project <id>]
  observe --kind git|file|github|run|session [--project <id>] [--root <dir>] [--path <p>] [--repo <o/r>] [--ref <sha>] [--run <id>] [--session <id>]
  link --knowledge <id> --revision <n> --observation <id> [--relation supports|contradicts|derived_from|validates]
  adopt --knowledge <id> [--revision <n>] [--note <text>]
  explain --knowledge <id>
  revalidate list [--status pending] [--knowledge <id>]
  revalidate resolve --id <id> --decision accepted|dismissed [--note <text>]
  context latest --project <id> [--session <id>]
  context restore --snapshot <id>
  sync export [--project <id>] [--all] --out <file>
  sync import --in <file> [--dry-run]

DB: --knowledge-db <path> (default ${knowledgeDb})
    --owner-db <path> (default ${ownerDb})
`);
    return;
  }

  const stores = open({ owner: command === 'observe' || (command === 'source' && group === 'list') });
  try {
    if (command === 'project' && group === 'register') {
      const { projectId, root } = projectArgs();
      if (!projectId) throw new Error('--project is required');
      json(stores.provenance.ensureProjectFromRoot({ projectId, root }));
      return;
    }
    if (command === 'source' && group === 'list') {
      json(stores.provenance.listSources({ projectId: read('--project'), limit: Number(read('--limit', '100')) }));
      return;
    }
    if (command === 'observe') {
      const resolved = await resolveDescriptor(stores);
      const result = stores.provenance.observeSource(resolved.descriptor, {
        observedBy: read('--observed-by', 'agent'),
        captureRunId: read('--capture-run')
      });
      json({
        sourceId: result.observation.sourceId,
        observationId: result.observation.observationId,
        sourceVersion: result.observation.sourceVersion,
        contentHash: result.observation.contentHash,
        availability: result.observation.availability,
        created: result.created,
        revalidations: result.revalidations.map((item) => ({ id: item.id, unitId: item.unitId, revision: item.revision }))
      });
      return;
    }
    if (command === 'link') {
      const link = stores.provenance.linkRevision({
        unitId: read('--knowledge'),
        revision: Number(read('--revision')),
        observationId: read('--observation'),
        relation: read('--relation', 'supports'),
        by: read('--by', 'owner')
      });
      json(link);
      return;
    }
    if (command === 'adopt') {
      json(stores.provenance.adopt({
        unitId: read('--knowledge'),
        revision: read('--revision') ? Number(read('--revision')) : undefined,
        actor: read('--actor', 'owner'),
        note: read('--note')
      }));
      return;
    }
    if (command === 'explain') {
      json(stores.provenance.explain(read('--knowledge')));
      return;
    }
    if (command === 'revalidate' && group === 'list') {
      json(stores.provenance.listRevalidations({ status: read('--status', 'pending'), unitId: read('--knowledge') }));
      return;
    }
    if (command === 'revalidate' && group === 'resolve') {
      json(stores.provenance.resolveRevalidation({
        id: read('--id'),
        decision: read('--decision', 'accepted'),
        actor: read('--actor', 'owner'),
        note: read('--note')
      }));
      return;
    }
    if (command === 'context' && group === 'latest') {
      json(stores.ledger.latest({ projectId: read('--project'), sessionId: read('--session') }));
      return;
    }
    if (command === 'context' && group === 'restore') {
      json(stores.ledger.restore(read('--snapshot')));
      return;
    }
    if (command === 'sync' && group === 'export') {
      const out = read('--out');
      if (!out) throw new Error('--out is required');
      const bundle = exportBundle({
        personalStore: stores.personal,
        provenance: stores.provenance,
        projectId: read('--project'),
        all: has('--all'),
        device: deviceId()
      });
      fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
      json({ out, units: bundle.units.length, sources: bundle.sources.length, observations: bundle.observations.length });
      return;
    }
    if (command === 'sync' && group === 'import') {
      const file = read('--in');
      if (!file) throw new Error('--in is required');
      const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
      json(importBundle({
        personalStore: stores.personal,
        provenance: stores.provenance,
        bundle,
        apply: !has('--dry-run'),
        device: deviceId()
      }));
      return;
    }
    fail(`Unknown command: ${command} ${group}`);
  } finally {
    close(stores);
  }
}

main().catch((error) => {
  console.error(`knowledge-maint failed: ${error.message}`);
  process.exitCode = 1;
});
