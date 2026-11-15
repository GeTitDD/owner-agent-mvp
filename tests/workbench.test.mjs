import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PersonalKnowledgeStore } from '../src/personal-store.mjs';
import { applyWorkspaceOverlay } from '../src/workspace-overlay.mjs';
import { createDomainEngine } from '../src/engine.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';

const ROOT=path.resolve(import.meta.dirname,'..');
const temp=async fn=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'domain-workbench-test-'));
  try {return await fn(path.join(dir,'knowledge.sqlite'));} finally {await rm(dir,{recursive:true,force:true});}
};
const item=(overrides={})=>({title:'Context boundary',content:'A stable context can be reused under exact-prefix conditions',kind:'claim',scope:'personal',layer:'applied',
  projectId:null,domains:['pi-sdk','context-engineering'],tags:['cache','context'],verificationStatus:'unverified',
  evidenceRefs:[],relations:{depends_on:['pi.context']},...overrides});

test('personal revisions are immutable; modifying verified claim invalidates evidence',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    const first=store.create(item({verificationStatus:'verified',evidenceRefs:['source:test:1']}));
    assert.equal(first.revision,1);
    const edited=store.update(first.id,item({content:'Rewritten claim',verificationStatus:'verified',evidenceRefs:['source:test:1']}),{expectedRevision:1});
    assert.equal(edited.revision,2);
    assert.equal(edited.verificationStatus,'needs_reverification');
    assert.deepEqual(edited.evidenceRefs,[]);
    const revisions=store.revisions(first.id);
    assert.equal(revisions.length,2);
    assert.equal(revisions[1].payload.verificationStatus,'verified');
    assert.equal(revisions[1].payload.content,first.content);
    assert.throws(()=>store.update(first.id,item(),{expectedRevision:1}),/Revision conflict/);
    const restored=store.revert(first.id,1,2);
    assert.equal(restored.revision,3);
    assert.equal(restored.content,first.content);
    assert.equal(store.revisions(first.id).length,3);
  } finally {store.close();}
}));

test('project scope requires exact project ID and never allows cross-project accidental sharing',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    assert.throws(()=>store.create(item({scope:'project'})),/Project scope requires/);
    assert.throws(()=>store.create(item({layer:'project',scope:'domain',projectId:'pi-local-research'})),/Project scope requires/);
    assert.throws(()=>store.create(item({verificationStatus:'verified'})),/requires evidence/);
    assert.throws(()=>store.create(item({content:'api_key = 1234567890123456789'})),/Potential credential/);
    const a=store.create(item({scope:'project',layer:'project',projectId:'pi-local-research'}));
    const b=store.create(item({scope:'project',layer:'project',projectId:'pi-service-research'}));
    assert.deepEqual(store.list({projectId:'pi-local-research'}).map(x=>x.id),[a.id]);
    assert.deepEqual(store.list({projectId:'pi-service-research'}).map(x=>x.id),[b.id]);
  } finally {store.close();}
}));

test('agent proposals do not mutate knowledge until approved; rejection and stale target handling',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    const first=store.create(item());
    const proposed=store.submitProposal({targetId:first.id,payload:item({content:'A better context hypothesis'}),actor:'pi-agent'});
    assert.equal(store.get(first.id).revision,1);
    assert.equal(proposed.status,'pending');
    store.update(first.id,item({content:'user concurrently edited'}),{expectedRevision:1});
    assert.throws(()=>store.reviewProposal(proposed.id,{decision:'approved',expectedRevision:1}),/Target changed/);
    assert.equal(store.proposal(proposed.id).status,'pending');
    const done=store.reviewProposal(proposed.id,{decision:'rejected'});
    assert.equal(done.status,'rejected');
    assert.equal(store.get(first.id).revision,2);
    assert.throws(()=>store.reviewProposal(proposed.id,{decision:'approved',expectedRevision:2}),/already reviewed/);
    const other=store.submitProposal({payload:item({title:'New experiment'}),actor:'pi-agent'});
    const accepted=store.reviewProposal(other.id,{decision:'approved'});
    assert.equal(store.get(accepted.applied_id).title,'New experiment');
    assert.equal(store.get(accepted.applied_id).revision,1);
    assert.equal(store.revisions(accepted.applied_id)[0].actor,'user');
  } finally {store.close();}
}));

test('workspace overlay composes into project context but cannot alter shared knowledge prefix',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    store.create(item({title:'Workspace cache note',content:'Context prefill cache accuracy',scope:'domain',layer:'applied'}));
    store.create(item({title:'Private note',content:'Do not import me to any project',scope:'personal'}));
    store.create(item({title:'Local-only sandbox',content:'Requires isolated experiment runner',scope:'project',layer:'project',projectId:'pi-local-research'}));
  } finally {store.close();}
  const engine=createDomainEngine({dbPath});
  try {
    const localBase=await engine.resolve({cwd:path.join(ROOT,'examples/pi-local-research')});
    const serviceBase=await engine.resolve({cwd:path.join(ROOT,'examples/pi-service-research')});
    assert.equal(localBase.id,serviceBase.id);
    // The example configurations enable workspace; re-apply over a clean base to force this temp DB.
    const config={enabled:true,importDomainIds:['pi-sdk','context-engineering'],includeProject:true};
    const local=applyWorkspaceOverlay(localBase,{config,dbPath});
    const remote=applyWorkspaceOverlay(serviceBase,{config,dbPath});
    assert.equal(local.id,remote.id);
    assert.notEqual(local.projectSnapshotId,remote.projectSnapshotId);
    assert.equal(engine.renderStable(local),engine.renderStable(remote));
    assert.equal(local.projectRecords.some(r=>r.title==='Workspace cache note'),true);
    assert.equal(remote.projectRecords.some(r=>r.title==='Workspace cache note'),true);
    assert.equal(local.projectRecords.some(r=>r.title==='Local-only sandbox'),true);
    assert.equal(remote.projectRecords.some(r=>r.title==='Local-only sandbox'),false);
    assert.equal(local.projectRecords.some(r=>r.title==='Private note'),false);
    const search=engine.retrieve({snapshot:local,query:'sandbox isolated'});
    assert.equal(search.some(r=>r.title==='Local-only sandbox'),true);
  } finally {engine.close();}
}));

test('HTTP workbench enforces same-origin mutations; editable copy is separate from immutable package',()=>temp(async dbPath=>{
  const workbench=await createWorkbenchServer({port:0,dbPath});
  const addr=await workbench.listen();
  const base=`http://127.0.0.1:${addr.port}`;
  const request=async(path,method='GET',body,headers={})=>{
    const res=await fetch(base+path,{method,headers:{...(method==='GET'?{}:{'content-type':'application/json','x-workbench-request':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return [res.status,res.headers.get('content-type'),await (res.headers.get('content-type')?.includes('json')?res.json():res.text())];
  };
  try {
    let [code]=await request('/');assert.equal(code,200);
    [code,,]=await request('/app.js');assert.equal(code,200);
    [code,,]=await request('/api/health');assert.equal(code,200);
    let response;
    [code,,response]=await request('/api/knowledge');assert.equal(code,200);
    const immutable=response.find(x=>x.scope==='package');assert.ok(immutable);
    [code]=await request(`/api/knowledge/${encodeURIComponent(immutable.id)}`,'PATCH',{title:'hacked',expectedRevision:0});assert.equal(code,403);
    [code]=await request('/api/knowledge','POST',item(),{'x-workbench-request':''});assert.equal(code,403);
    [code]=await request('/api/knowledge','POST',item(),{origin:'https://malicious.invalid'});assert.equal(code,403);
    [code,,response]=await request('/api/knowledge','POST',item());assert.equal(code,201);
    const myId=response.id;assert.equal(response.revision,1);
    [code,,response]=await request(`/api/knowledge/${encodeURIComponent(myId)}`,'PATCH',{...item({title:'Edited'}),expectedRevision:1});assert.equal(code,200);
    assert.equal(response.revision,2);
    [code,,response]=await request(`/api/knowledge/${encodeURIComponent(myId)}`,'PATCH',{...item(),expectedRevision:1});assert.equal(code,409);
    [code,,response]=await request(`/api/knowledge/${encodeURIComponent(immutable.id)}/fork`,'POST',{scope:'personal'});
    assert.equal(code,201);assert.equal(response.sourceRef,immutable.id);
    [code,,response]=await request('/api/domains');assert.equal(code,200);assert.ok(response.some(x=>x.id==='pi-sdk'));
    [code,,response]=await request('/api/context-preview','POST',{projectId:'pi-local-research',task:'pi context cache'});
    assert.equal(code,200);assert.ok(response.stableContext.includes('Shared Domain Context'));
  } finally {await workbench.close();}
}));

test('workbench review center reads proposals from the personal knowledge DB, not the owner DB', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-workbench-split-'));
  const personalDbPath = path.join(dir, 'knowledge.sqlite');
  const ownerDbPath = path.join(dir, 'owner.sqlite');
  const store = new PersonalKnowledgeStore(personalDbPath);
  try {
    store.submitProposal({
      payload: item({ title: '待审候选', scope: 'project', projectId: 'demo', layer: 'project' }),
      actor: 'agent',
      meta: { contract: 'knowledge-candidate/v1' }
    });
  } finally {
    store.close();
  }
  const wb = await createWorkbenchServer({ port: 0, personalDbPath, ownerDbPath });
  const addr = await wb.listen();
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/proposals`);
    assert.equal(res.status, 200);
    const items = await res.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].payload.title, '待审候选');
    assert.equal(items[0].status, 'pending');
  } finally {
    await wb.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('proposal is pinned to submission revision: reviewer cannot approve stale data by passing current revision',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    const original=store.create(item({content:'Known initial model'}));
    const proposal=store.submitProposal({targetId:original.id,payload:item({content:'Suggested model'})});
    assert.equal(proposal.target_revision,1);
    const edited=store.update(original.id,item({content:'New evidence changes the model'}),{expectedRevision:1});
    assert.equal(edited.revision,2);
    assert.throws(()=>store.reviewProposal(proposal.id,{decision:'approved',expectedRevision:2}),/Target changed/);
    assert.equal(store.get(original.id).content,'New evidence changes the model');
    assert.equal(store.proposal(proposal.id).status,'pending');
    const second=store.submitProposal({targetId:original.id,payload:item({content:'Updated suggestion'})});
    assert.equal(second.target_revision,2);
    const approved=store.reviewProposal(second.id,{decision:'approved',expectedRevision:2});
    assert.equal(approved.applied_id,original.id);
    assert.equal(store.get(original.id).revision,3);
    assert.equal(store.get(original.id).content,'Updated suggestion');
  } finally {store.close();}
}));

test('agent proposals cannot silently change a knowledge unit between projects or to global scope',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    const original=store.create(item({scope:'project',layer:'project',projectId:'pi-local-research'}));
    const changedProject=item({scope:'project',layer:'project',projectId:'pi-service-research'});
    const leakedGlobally=item({scope:'domain',layer:'applied',projectId:null});
    assert.throws(()=>store.submitProposal({targetId:original.id,payload:changedProject}),/cannot change target scope or project ownership/);
    assert.throws(()=>store.submitProposal({targetId:original.id,payload:leakedGlobally}),/cannot change target scope or project ownership/);
    assert.equal(store.get(original.id).scope,'project');
    assert.equal(store.get(original.id).projectId,'pi-local-research');
  } finally {store.close();}
}));

test('SQLite migrates an old proposal table and fails closed on legacy proposals without target revision',()=>temp(async dbPath=>{
  const { DatabaseSync }=await import('node:sqlite');
  const old=new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE personal_proposals (
    id TEXT PRIMARY KEY, target_id TEXT, payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    actor TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_at TEXT, reviewer TEXT, applied_id TEXT
  );`);
  old.close();
  const store=new PersonalKnowledgeStore(dbPath);
  try {
    const original=store.create(item());
    const proposal=store.submitProposal({targetId:original.id,payload:item({content:'Valid proposal after migration'})});
    assert.equal(proposal.target_revision,1);
    store.db.prepare('UPDATE personal_proposals SET target_revision=NULL WHERE id=?').run(proposal.id);
    assert.throws(()=>store.reviewProposal(proposal.id,{decision:'approved',expectedRevision:1}),/Target changed/);
    assert.equal(store.get(original.id).revision,1);
    assert.equal(store.reviewProposal(proposal.id,{decision:'rejected'}).status,'rejected');
  } finally {store.close();}
}));

test('custom workbench database is used by both Pi engine resolution and HTTP project preview',()=>temp(async dbPath=>{
  const store=new PersonalKnowledgeStore(dbPath);
  const original=store.create(item({title:'Unique Workbench Context Marker',content:'customdb unique experimental hypothesis cache validation',scope:'domain',layer:'applied'}));
  store.create(item({title:'Never leak private project observation',content:'supersecret isolated local experiment',scope:'project',layer:'project',projectId:'pi-local-research'}));
  store.close();
  const engine=createDomainEngine({dbPath});
  try {
    const local=await engine.resolve({cwd:path.join(ROOT,'examples/pi-local-research')});
    const remote=await engine.resolve({cwd:path.join(ROOT,'examples/pi-service-research')});
    assert.equal(local.projectRecords.some(r=>r.id===original.id),true);
    assert.equal(remote.projectRecords.some(r=>r.id===original.id),true);
    assert.equal(remote.projectRecords.some(r=>r.title==='Never leak private project observation'),false);
    assert.equal(local.id,remote.id);
    assert.notEqual(local.projectSnapshotId,remote.projectSnapshotId);
  } finally {engine.close();}
  const wb=await createWorkbenchServer({port:0,dbPath});
  const addr=await wb.listen();
  const base=`http://127.0.0.1:${addr.port}`;
  async function preview(projectId) {
    const response=await fetch(`${base}/api/context-preview`,{
      method:'POST',headers:{'content-type':'application/json','x-workbench-request':'1'},
      body:JSON.stringify({projectId,task:'customdb unique experimental hypothesis cache validation'})
    });
    assert.equal(response.status,200);
    return response.json();
  }
  try {
    const local=await preview('pi-local-research');
    const remote=await preview('pi-service-research');
    assert.equal(local.projectSnapshotId===remote.projectSnapshotId,false);
    assert.equal(local.sharedSnapshotId,remote.sharedSnapshotId);
    assert.ok(local.dynamicContext.includes('Unique Workbench Context Marker'));
    assert.ok(remote.dynamicContext.includes('Unique Workbench Context Marker'));
    assert.ok(!remote.dynamicContext.includes('Never leak private project observation'));
  } finally {await wb.close();}
}));
