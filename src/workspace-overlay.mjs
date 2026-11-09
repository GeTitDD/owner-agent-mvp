// Explicitly opted-in, project-local view of editable personal knowledge.
// Overlay records are always dynamic project-context records; shared package hashes stay unchanged.
import { PersonalKnowledgeStore } from './personal-store.mjs';
import { defaultDbPath } from './storage.mjs';
import { canonical, sha256 } from './utils.mjs';
import { validateKnowledgeApplicability } from './applicability.mjs';

export function applyWorkspaceOverlay(snapshot, options={}) {
  const config=options.config ?? {};
  if(!config.enabled) return snapshot;
  if(config.enabled!==true) throw new Error('workspace.enabled must be a boolean');
  if(config.importDomainIds !== undefined && (!Array.isArray(config.importDomainIds) || config.importDomainIds.some(x=>typeof x!=='string'))) throw new Error('Invalid workspace.importDomainIds');
  if(config.includeProject !== undefined && typeof config.includeProject!=='boolean') throw new Error('Invalid workspace.includeProject');
  const allowedDomains=new Set(config.importDomainIds ?? []);
  const imported=new Set(snapshot.domainItems.map(d=>d.id));
  // A project may narrow its declared package profiles without rewriting the workspace allowlist.
  // An unimported domain is never loaded, even if listed in the allowlist.
  const activeAllowed=new Set([...allowedDomains].filter(id=>imported.has(id)));
  const store=new PersonalKnowledgeStore(options.dbPath ?? defaultDbPath());
  const adoptedRevision=(id)=>{
    try {
      const row=store.db.prepare('SELECT adopted_revision FROM knowledge_adoptions WHERE unit_id=?').get(id);
      return row ? row.adopted_revision : null;
    } catch { return null; }
  };
  let records;
  try {
    records=store.list({limit:2000}).map(item=>{
      const adopted=adoptedRevision(item.id);
      // Owner 已采纳的修订优先；没有采纳记录时沿用 Head（旧库隐式行为）。
      if(config.requireAdoption===true && adopted===null) return null;
      const revision=adopted ?? item.revision;
      const revisionRow=store.db.prepare('SELECT payload,payload_hash FROM personal_revisions WHERE unit_id=? AND revision=?')
        .get(item.id,revision);
      if(!revisionRow) return null; // fail closed：没有对应修订就不注入
      const payload=JSON.parse(revisionRow.payload);
      return {
        ...item,
        title:payload.title,content:payload.content,
        kind:payload.kind,layer:payload.layer,scope:payload.scope,
        projectId:payload.projectId,tags:payload.tags,domains:payload.domains,
        evidenceRefs:payload.evidenceRefs,verificationStatus:payload.verificationStatus,
        relations:payload.relations,revision,
        _payloadHash:revisionRow.payload_hash
      };
    }).filter(Boolean).filter(item=>
      item.scope==='domain' && item.domains.some(domain=>activeAllowed.has(domain)) ||
      item.scope==='project' && config.includeProject===true && item.projectId===snapshot.profile.id
    );
  } finally { store.close(); }
  const overlay=records.map(item=>{
    const rec={
      id:item.id,title:item.title,claim:item.content,
      keywords:[...new Set([...item.tags,...item.domains])],
      layer:item.scope==='project'?'project':item.layer,
      status:'published',sharing:item.scope==='project'?'project':'shared',
      relations:item.relations,verificationStatus:item.verificationStatus,
      evidenceRefs:item.evidenceRefs,
      domain:item.scope==='project'?snapshot.profile.id:item.domains[0]??'personal',
      version:`workspace-r${item.revision}`,
      key:`workspace:${item.id}:r${item.revision}`,
      contentHash:item._payloadHash ?? sha256(canonical(item))
    };
    validateKnowledgeApplicability(rec);
    return rec;
  }).sort((a,b)=>a.key.localeCompare(b.key));
  const projectRecords=[...snapshot.projectRecords,...overlay].sort((a,b)=>a.key.localeCompare(b.key));
  return {...snapshot, projectRecords, projectSnapshotId:sha256(canonical({
    base:snapshot.projectSnapshotId,workspace:overlay.map(x=>({key:x.key,hash:x.contentHash}))
  }))};
}
