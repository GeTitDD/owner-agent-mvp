import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDomainEngine } from '../src/engine.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const engine = createDomainEngine({ dbPath: ':memory:' });
try {
  const inputs = [
    ['pi-local-research', 'Design a cache prefix experiment in the Pi extension with isolated runner'],
    ['pi-service-research', 'Design a cache prefix experiment in the Pi extension with isolated runner']
  ];
  for (const [name, task] of inputs) {
    const snapshot = await engine.resolve({ cwd: path.join(base, name), sessionId: `${name}-demo` });
    const plan = engine.compile({ snapshot, task });
    const view = engine.explain({ snapshot });
    console.log(JSON.stringify({ project: name, importedDomains: snapshot.domainItems.map(({ id, version, profiles }) => ({ id, version, profiles })),
      sharedSnapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId, stableHash: plan.stableHash,
      selectedKnowledge: plan.knowledgeRefs, states: view.knowledge.map(({ key, state }) => ({ key, state })),
      estimatedTokens: plan.estimatedTokens }, null, 2));
  }
} finally { engine.close(); }
