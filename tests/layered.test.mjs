import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createDomainEngine } from '../src/engine.mjs';
import { resolveApplicability, validateKnowledgeApplicability } from '../src/applicability.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const local = path.join(ROOT,'examples/pi-local-research');
const service = path.join(ROOT,'examples/pi-service-research');
const withEngine = (fn) => {
  const engine = createDomainEngine({ dbPath: ':memory:' });
  return Promise.resolve().then(() => fn(engine)).finally(() => engine.close());
};
const stateOf = (explanation, id) => explanation.knowledge.find((x) => x.key.endsWith(`:${id}`))?.state;
function copyFixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'layered-fixture-'));
  cpSync(path.join(ROOT, 'domains'), path.join(tmp, 'domains'), { recursive: true });
  mkdirSync(path.join(tmp, 'project'), {recursive: true});
  const config = JSON.parse(readFileSync(path.join(local,'domain-context.json'),'utf8'));
  config.project.id = 'test-fixture';
  config.domainRoot = '../domains';
  config.projectKnowledgeFiles = [];
  writeFileSync(path.join(tmp, 'project/domain-context.json'), JSON.stringify(config));
  return { tmp, cwd: path.join(tmp, 'project'), config };
}

test('two project environments share domain snapshot but never their project context', () => withEngine(async (e) => {
  const a = await e.resolve({ cwd: local });
  const b = await e.resolve({ cwd: service });
  assert.equal(a.id,b.id);
  assert.notEqual(a.projectSnapshotId,b.projectSnapshotId);
  assert.deepEqual(a.domainItems.map((d)=>d.id), ['context-engineering','pi-sdk','software-testing']);
  const pa = e.compile({ snapshot:a, task:'pi extension cache experiment isolated runner' });
  const pb = e.compile({ snapshot:b, task:'pi extension cache experiment isolated runner' });
  assert.equal(pa.stableHash,pb.stableHash);
  assert.notEqual(pa.compilationHash,pb.compilationHash);
  assert.match(pa.dynamicContext,/local-mac/);
  assert.match(pb.dynamicContext,/linux-container/);
  assert.doesNotMatch(pa.stableContext,/local-mac|linux-container/);
}));

test('conditions: eligible, explicitly incompatible, and unknown are distinct', () => withEngine(async (e) => {
  const a = await e.resolve({ cwd: local });
  const b = await e.resolve({ cwd: service });
  const x = e.explain({ snapshot:a });
  const y = e.explain({ snapshot:b });
  assert.equal(stateOf(x,'context.prefix-cache'),'applicable');
  assert.equal(stateOf(y,'context.prefix-cache'),'not_applicable');
  assert.equal(stateOf(y,'context.cache-metrics'),'needs_verification');
  assert.equal(stateOf(y,'testing.isolated'),'not_applicable');
  const aPlan = e.compile({ snapshot:a, task:'cache prefix caching metrics isolated runner' });
  const bPlan = e.compile({ snapshot:b, task:'cache prefix caching metrics isolated runner' });
  assert.match(aPlan.dynamicContext,/Stable prefix caching strategy/);
  assert.doesNotMatch(bPlan.dynamicContext,/Stable prefix caching strategy/);
  assert.match(bPlan.dynamicContext,/NEEDS LOCAL VERIFICATION/);
  assert.ok(bPlan.skipped.some((x)=>x.key.endsWith('context.prefix-cache') && x.reason==='not_applicable'));
}));

test('project-only knowledge is visible locally and never stored in shared SQLite FTS', () => withEngine(async (e) => {
  const a = await e.resolve({ cwd: local });
  const b = await e.resolve({ cwd: service });
  assert.equal(a.projectRecords.length,1);
  assert.equal(b.projectRecords.length,1);
  assert.equal(e.retrieve({snapshot:a,query:'local sandbox extension'}).some((x)=>x.key.startsWith('project:pi-local-research:')), true);
  assert.equal(e.retrieve({snapshot:b,query:'local sandbox extension'}).some((x)=>x.key.startsWith('project:pi-local-research:')), false);
  const stored=e.evolution.db.prepare("SELECT count(*) AS n FROM knowledge WHERE key LIKE 'project:%'").get();
  assert.equal(stored.n,0);
  assert.ok(e.compile({snapshot:a,task:'local sandbox extension'}).knowledgeRefs.some((x)=>x.startsWith('project:pi-local-research:')));
}));

test('tool recall marks verification status and applicability instead of claiming trust', () => withEngine(async (e) => {
  const snap=await e.resolve({cwd:service});
  const records=e.retrieve({snapshot:snap,query:'cache metrics'});
  assert.ok(records.some((r)=>r.applicabilityState==='needs_verification'));
  assert.doesNotMatch(e.renderEvidence(records),/verification=verified/);
  assert.match(e.renderEvidence(records),/applicability=needs_verification/);
  assert.ok(!records.some((r)=>r.id==='context.prefix-cache'));
}));

test('unknown profiles fail closed rather than importing all domain knowledge', async () => {
  const {tmp,cwd,config}=copyFixture();
  try { config.domains[0].profile='nonexistent'; writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
    await withEngine((e)=>assert.rejects(e.resolve({cwd}),/Unknown knowledge profile/));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('explicit profile does not accidentally pull unrelated records', async () => {
  const {tmp,cwd,config}=copyFixture();
  try {
    const filename=path.join(tmp,'domains/context-engineering/0.1.0/manifest.json');
    const manifest=JSON.parse(readFileSync(filename,'utf8'));
    manifest.profiles.minimal={knowledgeIds:['context.foundations'],stableKnowledgeIds:['context.foundations']};
    writeFileSync(filename,JSON.stringify(manifest));
    config.domains=[{id:'context-engineering',version:'0.1.0',profile:'minimal'}];
    writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
    await withEngine(async (e)=>{ const s=await e.resolve({cwd});
      assert.deepEqual(s.domainItems.map((x)=>x.id),['context-engineering']);
      assert.deepEqual(s.records.map((x)=>x.id),['context.foundations']);
    });
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('domain dependencies are import-order independent and deduplicated', async () => {
  const {tmp,cwd,config}=copyFixture();
  try {
    await withEngine(async (e)=>{
      const a=await e.resolve({cwd});
      config.domains.reverse();
      config.domains.push({id:'pi-sdk',version:'0.1.0',profile:'core'});
      writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
      const b=await e.resolve({cwd});
      assert.equal(a.id,b.id);
      assert.deepEqual(a.records.map((r)=>r.key),b.records.map((r)=>r.key));
    });
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('dependency version conflicts fail closed', async () => {
  const {tmp,cwd,config}=copyFixture();
  try {
    config.domains.push({id:'pi-sdk',version:'9.0.0'});
    writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
    await withEngine(e=>assert.rejects(e.resolve({cwd}),/Incompatible domain versions/));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('circular dependencies fail closed', async () => {
  const {tmp,cwd}=copyFixture();
  try {
    const f=path.join(tmp,'domains/pi-sdk/0.1.0/manifest.json');
    const man=JSON.parse(readFileSync(f,'utf8'));
    man.dependencies=[{id:'context-engineering',version:'0.1.0',profile:'cache'}];
    writeFileSync(f,JSON.stringify(man));
    await withEngine(e=>assert.rejects(e.resolve({cwd}),/Circular domain dependency/));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('session pin includes project environment, requirements and local knowledge', async () => {
  const {tmp,cwd,config}=copyFixture();
  try {
    await withEngine(async (e)=>{
      const a=await e.resolve({cwd,sessionId:'pinned-session'});
      config.project.requirements.ids.push('new-requirement');
      writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
      const fresh=await e.resolve({cwd,sessionId:'another-session'});
      assert.equal(a.id,fresh.id);
      assert.notEqual(a.projectSnapshotId,fresh.projectSnapshotId);
      await assert.rejects(e.resolve({cwd,sessionId:'pinned-session'}),/pinned to a different/);
    });
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('stable record cannot contain project-conditional applicability', async () => {
  const {tmp,cwd}=copyFixture();
  try {
    const f=path.join(tmp,'domains/pi-sdk/0.1.0/knowledge/pi.agent-loop.json');
    const rec=JSON.parse(readFileSync(f,'utf8'));
    rec.applicability={requires:[{source:'environment',path:'capabilities.prefix_cache',op:'eq',value:true}]};
    writeFileSync(f,JSON.stringify(rec));
    await withEngine(e=>assert.rejects(e.resolve({cwd}),/Conditional knowledge cannot be stable/));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('explicit contradictions are reported and not silently injected', async () => {
  const {tmp,cwd}=copyFixture();
  try {
    const f=path.join(tmp,'domains/context-engineering/0.1.0/knowledge/context.prefix-cache.json');
    const rec=JSON.parse(readFileSync(f,'utf8'));
    rec.relations={contradicts:['context.cache-metrics']};
    writeFileSync(f,JSON.stringify(rec));
    await withEngine(async e=>{
      const snapshot=await e.resolve({cwd});
      const plan=e.compile({snapshot,task:'cache metrics stable prefix experiment'});
      assert.equal(plan.conflicts.length,1);
      assert.equal(stateOf(e.explain({snapshot}),'context.prefix-cache'),'conflict');
      assert.match(plan.dynamicContext,/UNRESOLVED KNOWLEDGE CONFLICT/);
      assert.doesNotMatch(plan.dynamicContext,/Stable prefix caching strategy/);
    });
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('project knowledge cannot be published as cross-project material by accident', async () => {
  const {tmp,cwd,config}=copyFixture();
  try {
    mkdirSync(path.join(cwd,'knowledge'));
    writeFileSync(path.join(cwd,'knowledge/secret.json'),JSON.stringify({id:'secret',layer:'project',title:'Confidential',claim:'internal only',keywords:['internal'],status:'published',sharing:'shared'}));
    config.projectKnowledgeFiles=['knowledge/secret.json'];
    writeFileSync(path.join(cwd,'domain-context.json'),JSON.stringify(config));
    await withEngine(e=>assert.rejects(e.resolve({cwd}),/cannot be shared automatically/));
  } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('invalid predicate paths and operators are rejected, no arbitrary path execution', () => {
  assert.throws(()=>validateKnowledgeApplicability({id:'bad',applicability:{requires:[{source:'environment',path:'__proto__.polluted',op:'eq',value:true}]}}),/Invalid applicability predicate|Unknown applicability path/);
  assert.throws(()=>validateKnowledgeApplicability({id:'bad',applicability:{requires:[{source:'environment',path:'capabilities.cache',op:'eval',value:true}]}}),/Invalid applicability predicate/);
});

test('context lock captures exact knowledge hashes, conditions, imports and project profile', () => withEngine(async e => {
  const a = await e.resolve({cwd:local});
  const b = await e.resolve({cwd:service});
  const lockA=e.createContextLock(a), lockA2=e.createContextLock(a), lockB=e.createContextLock(b);
  assert.deepEqual(lockA,lockA2);
  assert.equal(lockA.sharedSnapshotId,lockB.sharedSnapshotId);
  assert.notEqual(lockA.projectSnapshotId,lockB.projectSnapshotId);
  assert.notEqual(lockA.lockHash,lockB.lockHash);
  assert.equal(lockA.imports.length,3);
  assert.ok(lockA.records.some((r)=>r.key.startsWith('project:pi-local-research:') && r.layer==='project'));
  assert.ok(lockA.records.some((r)=>r.key.endsWith('context.prefix-cache') && r.applicability==='applicable'));
  assert.ok(lockB.records.some((r)=>r.key.endsWith('context.prefix-cache') && r.applicability==='not_applicable'));
}));

test('context lock output is idempotent and will not silently overwrite a prior experiment', async () => {
  const tmp=mkdtempSync(path.join(os.tmpdir(),'layered-lock-'));
  try { await withEngine(async e => {
    const a=await e.resolve({cwd:local}), b=await e.resolve({cwd:service});
    const out=path.join(tmp,'experiment/context.lock.json');
    await e.writeContextLock(out,e.createContextLock(a));
    await e.writeContextLock(out,e.createContextLock(a));
    await assert.rejects(e.writeContextLock(out,e.createContextLock(b)),/already exists with different contents/);
  }); } finally { rmSync(tmp,{recursive:true,force:true}); }
});

test('project snapshot and context lock are portable between identical checkout paths', async () => {
  const first=copyFixture(), second=copyFixture();
  try { await withEngine(async e => {
    const a=await e.resolve({cwd:first.cwd});
    const b=await e.resolve({cwd:second.cwd});
    assert.notEqual(a.profile.root,b.profile.root);
    assert.equal(a.projectSnapshotId,b.projectSnapshotId);
    assert.equal(e.createContextLock(a).lockHash,e.createContextLock(b).lockHash);
  }); } finally {
    rmSync(first.tmp,{recursive:true,force:true});
    rmSync(second.tmp,{recursive:true,force:true});
  }
});
