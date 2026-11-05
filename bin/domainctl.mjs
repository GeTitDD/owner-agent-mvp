#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDomainEngine } from '../src/engine.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [command, action, ...raw] = process.argv.slice(2);
const args = ['inspect', 'search', 'compile', 'explain', 'lock', 'demo', 'publish'].includes(command) ? [action, ...raw] : raw;
const flag = (key, fallback) => { const p = args.indexOf(`--${key}`); return p < 0 ? fallback : args[p + 1]; };
const required = (key) => { const value = flag(key); if (!value || value.startsWith('--')) throw new Error(`Missing --${key}`); return value; };
const readInput = async () => JSON.parse(await readFile(path.resolve(required('file')), 'utf8'));
const engine = createDomainEngine();
const print = (value) => console.log(JSON.stringify(value, null, 2));
async function resolveProject() {
  const cwd = path.resolve(flag('project', process.cwd()));
  const snapshot = await engine.resolve({ cwd });
  if (!snapshot) throw new Error(`No domain-context.json found above ${cwd}`);
  return snapshot;
}

async function run() {
  if (command === 'demo') {
    for (const [project, task] of [
      ['payment-service', 'Implement retry and idempotency for payment callback'],
      ['queue-worker', 'Implement job retries with lease expiry'],
      ['webhook-service', 'Handle duplicate webhook delivery and verification']
    ]) {
      const snapshot = await engine.resolve({ cwd: path.join(repoRoot, 'examples', project) });
      const plan = engine.compile({ snapshot, task });
      print({ project, snapshotId: snapshot.id.slice(0, 12), stableHash: plan.stableHash.slice(0, 12), knowledgeRefs: plan.knowledgeRefs, estimatedTokens: plan.estimatedTokens });
    }
    return;
  }
  if (command === 'inspect' || command === 'compile' || command === 'search' || command === 'explain' || command === 'lock') {
    const snapshot = await resolveProject();
    if (command === 'inspect') print({ project: snapshot.profile.id, primaryDomain: snapshot.profile.primaryDomain, sharedSnapshotId: snapshot.id, projectSnapshotId: snapshot.projectSnapshotId, captureMode: snapshot.profile.captureMode, domains: snapshot.domainItems.map(({ id, version, profiles }) => ({ id, version, profiles })), sharedKnowledgeCount: snapshot.records.length, projectKnowledgeCount: snapshot.projectRecords.length, environment: snapshot.profile.environment, requirements: snapshot.profile.requirements, decisions: snapshot.profile.decisions, skills: snapshot.skillPaths });
    if (command === 'explain') print(engine.explain({ snapshot }));
    if (command === 'lock') print(await engine.writeContextLock(path.resolve(required('out')), engine.createContextLock(snapshot)));
    if (command === 'compile') print(engine.compile({ snapshot, task: required('task') }));
    if (command === 'search') console.log(engine.renderEvidence(engine.retrieve({ snapshot, query: required('query') })));
    return;
  }
  const store = engine.evolution;
  if (command === 'trace') {
    if (action === 'list') { print(store.listRuns(flag('project-id'))); return; }
    if (action === 'show') { print(store.getRunTrace(required('run'))); return; }
  }
  if (command === 'evidence' && action === 'add') { print(store.addEvidence(await readInput())); return; }
  if (command === 'evidence' && action === 'verify-test') {
    const snapshot = await resolveProject();
    print(await engine.verifyNodeTest({
      runId: required('run'), projectRoot: snapshot.profile.root, testFile: required('test'),
      summary: required('summary'), sharingConsent: flag('share', 'false') === 'true'
    }));
    return;
  }
  if (command === 'candidate') {
    if (action === 'propose') { print(store.propose(await readInput())); return; }
    if (action === 'list') { print(store.listCandidates(flag('status'))); return; }
    if (action === 'inspect') { print({ ...store.readiness(required('id')) }); return; }
    if (action === 'review') {
      print(store.review({ candidateId: required('id'), decision: required('decision'), reviewer: required('reviewer'), note: flag('note', '') })); return;
    }
  }
  if (command === 'publish') {
    const snapshot = await resolveProject();
    const domainId = required('domain');
    const baseVersion = required('from');
    const newVersion = required('to');
    if (!snapshot.domainItems.some((d) => d.id === domainId && d.version === baseVersion)) throw new Error('Project must reference the base domain version');
    const candidateIds = required('candidates').split(',').map((s) => s.trim());
    print(await engine.publish({ domainRoot: snapshot.domainRoot, domainId, baseVersion, newVersion, candidateIds }));
    return;
  }
  console.error(`Usage:
  domainctl demo
  domainctl inspect|compile|search|explain --project PATH [--task TEXT|--query TEXT]
  domainctl lock --project PATH --out PATH
  domainctl trace list [--project-id ID]
  domainctl trace show --run RUN_ID
  domainctl evidence add --file evidence.json
  domainctl evidence verify-test --project PATH --run RUN_ID --test tests/example.test.mjs --summary TEXT [--share true]
  domainctl candidate propose --file candidate.json
  domainctl candidate list [--status candidate|approved|rejected|published]
  domainctl candidate inspect --id CANDIDATE_ID
  domainctl candidate review --id ID --decision approve|reject --reviewer PERSON [--note TEXT]
  domainctl publish --project PATH --domain ID --from VERSION --to VERSION --candidates ID[,ID]`);
  process.exitCode = 2;
}
try { await run(); } catch (err) { console.error(`domainctl: ${err.message}`); process.exitCode = 1; }
finally { engine.close(); }
