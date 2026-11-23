// Loopback-only local knowledge workbench. No remote accounts, network calls or telemetry.
import http from 'node:http';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PersonalKnowledgeStore, KnowledgeValidationError } from './personal-store.mjs';
import { OwnerStore, OwnerInputError } from './owner-store.mjs';
import { OwnerAgent } from './owner-agent.mjs';
import { loadSnapshot } from './loader.mjs';
import { createDomainEngine } from './engine.mjs';
import { defaultDbPath } from './storage.mjs';
import { ObserverStore } from './observer/store.mjs';
import { BOARD_EVENT_LIMIT, buildBoardViewModel, renderBoardPage } from './observer/board.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const WEB=path.join(ROOT,'web','workbench');
const json=(res,value,status=200)=>{
  const data=JSON.stringify(value);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'"});
  res.end(data);
};
const notFound=(msg='Not found')=>{const e=new Error(msg);e.status=404;throw e;};
// 观察台页面自带数据，不允许任何外部资源与脚本，避免只读页面变成攻击面。
const html=(res,text)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
  'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
  'content-security-policy':"default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(text);};
async function body(req) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) { const e=new Error('JSON content-type required'); e.status=415;throw e; }
  const buffers=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>120000){const e=new Error('Request too large');e.status=413;throw e;}buffers.push(chunk);}
  try{return JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{const e=new Error('Malformed JSON');e.status=400;throw e;}
}
async function catalog() {
  const packages=[],knowledge=[],projects=[];
  const domainsDir=path.join(ROOT,'domains');
  for (const domain of await readdir(domainsDir,{withFileTypes:true})) {
    if(!domain.isDirectory() || domain.isSymbolicLink()) continue;
    const versionsDir=path.join(domainsDir,domain.name);
    for (const v of await readdir(versionsDir,{withFileTypes:true})) {
      if(!v.isDirectory()||v.isSymbolicLink()) continue;
      const base=path.join(versionsDir,v.name);
      let manifest;
      try { manifest=JSON.parse(await readFile(path.join(base,'manifest.json'),'utf8')); }catch{continue;}
      packages.push({id:manifest.id,version:manifest.version,description:manifest.description??'',profiles:Object.keys(manifest.profiles??{})});
      for (const filename of manifest.knowledgeFiles??[]) {
        if(!/^knowledge\/[a-zA-Z0-9._-]+\.json$/.test(filename))continue;
        const unit=JSON.parse(await readFile(path.join(base,filename),'utf8'));
        if(unit.status!=='published'||unit.sharing!=='shared')continue;
        knowledge.push({
          id:`${manifest.id}@${manifest.version}:${unit.id}`, title:unit.title,content:unit.claim,
          kind:unit.kind??'claim',layer:unit.layer??(unit.kind==='invariant'?'domain':'applied'),
          scope:'package',projectId:null,domains:[manifest.id],tags:unit.keywords??[],
          evidenceRefs:unit.evidenceRefs??[],verificationStatus:unit.verification?.status??'unverified',
          relations:unit.relations??{},revision:0,sourceRef:`${manifest.id}@${manifest.version}`,
          readOnly:true
        });
      }
    }
  }
  for (const entry of await readdir(path.join(ROOT,'examples'),{withFileTypes:true})) {
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    try {
      const config=JSON.parse(await readFile(path.join(ROOT,'examples',entry.name,'domain-context.json'),'utf8'));
      projects.push({id:config.project.id,primaryDomain:config.project.primaryDomain,environment:config.project.environment,requirements:config.project.requirements,imports:config.domains});
      for(const filename of config.projectKnowledgeFiles??[]) {
        if(!/^knowledge\/[a-zA-Z0-9._-]+\.json$/.test(filename))continue;
        const item=JSON.parse(await readFile(path.join(ROOT,'examples',entry.name,filename),'utf8'));
        if(item.status!=='published')continue;
        knowledge.push({id:`example:${config.project.id}:${item.id}`,title:item.title,content:item.claim,
          kind:item.kind??'claim',layer:'project',scope:'example-project',projectId:config.project.id,
          domains:[config.project.primaryDomain??'software-engineering'],tags:item.keywords??[],
          evidenceRefs:item.evidenceRefs??[],verificationStatus:item.verification?.status??'unverified',
          relations:item.relations??{},revision:0,sourceRef:`examples/${entry.name}`,readOnly:true});
      }
    } catch { continue; }
  }
  return {packages,knowledge,projects};
}
const filterEntries=(items,filters)=>items.filter(x=>(!filters.q||[x.title,x.content,...x.tags,...x.domains].join(' ').toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()))
  &&(!filters.domain||x.domains.includes(filters.domain))&&(!filters.layer||x.layer===filters.layer)
  &&(!filters.scope||x.scope===filters.scope)&&(!filters.status||x.verificationStatus===filters.status)
  &&(!filters.projectId||x.projectId===filters.projectId));

export async function createWorkbenchServer({
  host = '127.0.0.1',
  port = 4317,
  dbPath = defaultDbPath(),
  // 桌面版把知识库放在 ~/.domain-context，Owner 数据放在 userData/owner.sqlite，
  // 两者可能是不同文件；不传时退回单库模式（CLI 与测试）。
  personalDbPath = dbPath,
  ownerDbPath = dbPath
} = {}) {
  if(!['127.0.0.1','::1','localhost'].includes(host)) throw new Error('Workbench must bind to loopback');
  const store=new PersonalKnowledgeStore(personalDbPath),owner=new OwnerStore(ownerDbPath),ownerAgent=new OwnerAgent(owner),staticCatalog=await catalog();
  // 观察台每次请求现查审计库（ADR-0002），读完即关，页面不会落后于事件表。
  const boardView=()=>{const observer=new ObserverStore(ownerDbPath);try{
    return buildBoardViewModel({projects:owner.listProjects(),events:observer.listEvents({limit:BOARD_EVENT_LIMIT})});
  }finally{observer.close();}};
  const allUnits=()=>[...store.list({limit:2000}).map(x=>({...x,readOnly:false})),...staticCatalog.knowledge];
  const handler=async(req,res)=>{
    try {
      const hostname=req.headers.host??'';
      if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(hostname)) {json(res,{error:'Invalid Host header'},403);return;}
      const url=new URL(req.url,`http://${hostname}`);
      if(req.method==='GET' && ['/', '/app.js', '/markdown.js', '/styles.css'].includes(url.pathname)) {
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        const data=await readFile(path.join(WEB,name));
        res.writeHead(200,{'content-type':name.endsWith('.js')?'application/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8',
          'cache-control':'no-cache','x-content-type-options':'nosniff',
          'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'referrer-policy':'no-referrer'});res.end(data);return;
      }
      // 观察台是普通 HTTP 路由：浏览器直接打开即可，不依赖 Electron 是否运行。
      if(req.method==='GET'&&url.pathname==='/observer'){html(res,renderBoardPage(boardView()));return;}
      if(req.method==='GET'&&url.pathname==='/observer.css') {
        const css=await readFile(path.join(ROOT,'web','observer','observer.css'));
        res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});
        res.end(css);return;
      }
      if(!url.pathname.startsWith('/api/'))return notFound();
      if(req.method!=='GET') {
        const origin=req.headers.origin;
        if(origin && origin!==`http://${hostname}`) {json(res,{error:'Cross-site request rejected'},403);return;}
        if(req.headers['x-workbench-request']!=='1') {json(res,{error:'Missing same-origin mutation header'},403);return;}
      }
      const fragments=url.pathname.split('/').filter(Boolean), method=req.method;
      if(method==='GET'&&url.pathname==='/api/health')return json(res,{ok:true,version:'0.5.0',localOnly:true});
      if(method==='GET'&&url.pathname==='/api/observer/board')return json(res,boardView());
      if(method==='GET'&&url.pathname==='/api/owner/summary')return json(res,owner.summary());
      if(method==='GET'&&url.pathname==='/api/owner/attention')return json(res,ownerAgent.attention());
      if(method==='GET'&&url.pathname==='/api/owner/events')return json(res,owner.listEvents({projectId:url.searchParams.get('projectId')??'',limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??40)))}));
      if(method==='GET'&&url.pathname==='/api/owner/tasks')return json(res,owner.listTasks(url.searchParams.get('projectId')??''));
      if(method==='GET'&&url.pathname==='/api/owner/suggestions')return json(res,owner.listSuggestions(url.searchParams.get('status')??''));
      if(method==='POST'&&url.pathname==='/api/owner/projects')return json(res,owner.registerProject(await body(req)),201);
      if(method==='PATCH'&&fragments[1]==='owner'&&fragments[2]==='projects'&&fragments[3]&&fragments.length===4)
        return json(res,owner.updateProject(decodeURIComponent(fragments[3]),await body(req)));
      if(method==='POST'&&url.pathname==='/api/owner/tasks')return json(res,owner.createTask(await body(req)),201);
      if(method==='PATCH'&&fragments[1]==='owner'&&fragments[2]==='tasks'&&fragments[3]&&fragments.length===4)
        return json(res,owner.updateTask(decodeURIComponent(fragments[3]),await body(req)));
      if(method==='POST'&&url.pathname==='/api/owner/ask')return json(res,ownerAgent.answer((await body(req)).question));
      if(method==='POST'&&url.pathname==='/api/owner/suggestions')return json(res,owner.proposeReuse(await body(req)),201);
      if(method==='POST'&&fragments[1]==='owner'&&fragments[2]==='suggestions'&&fragments[3]&&fragments[4]==='review')
        return json(res,owner.reviewSuggestion(decodeURIComponent(fragments[3]),await body(req)));
      
      if(method==='GET'&&url.pathname==='/api/stats')return json(res,{
        personal:store.list({limit:2000}).length,packages:staticCatalog.packages.length,
        packageKnowledge:staticCatalog.knowledge.filter(x=>x.scope==='package').length,
        pendingProposals:store.proposals('pending').length,projects:staticCatalog.projects.length
      });
      if(method==='GET'&&url.pathname==='/api/domains') {
        const ids=new Set([...staticCatalog.packages.map(p=>p.id),...store.domains().map(d=>d.id),...store.list({limit:2000}).flatMap(u=>u.domains)]);
        return json(res,[...ids].sort().map(id=>({...store.domains().find(d=>d.id===id),id,label:store.domains().find(d=>d.id===id)?.label??id,
          packageVersions:staticCatalog.packages.filter(x=>x.id===id).map(x=>x.version),knowledgeCount:allUnits().filter(x=>x.domains.includes(id)).length})));
      }
      if(method==='POST'&&url.pathname==='/api/domains')return json(res,store.createDomain(await body(req)),201);
      if(method==='GET'&&url.pathname==='/api/knowledge/experiences')
        return json(res,store.listExperiences({projectId:url.searchParams.get('projectId')??'',outcome:url.searchParams.get('outcome')??'',limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??100)))}));
      if(method==='GET'&&url.pathname==='/api/knowledge/usages')
        return json(res,store.listUsages({targetRunId:url.searchParams.get('targetRunId')??'',projectId:url.searchParams.get('projectId')??'',knowledgeId:url.searchParams.get('knowledgeId')??'',limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??100)))}));
      if(method==='GET'&&url.pathname==='/api/knowledge/feedback')
        return json(res,store.listFeedback({usageId:url.searchParams.get('usageId')??'',limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??100)))}));
      if(method==='GET'&&url.pathname==='/api/knowledge/candidates')
        return json(res,store.proposals(url.searchParams.get('status')??'pending').filter(x=>x.meta?.contract==='knowledge-candidate/v1'));
      if(method==='GET'&&url.pathname==='/api/knowledge/loop-summary') {
        const units=store.list({limit:2000});
        return json(res,{
          experiences:store.listExperiences({limit:1000}).length,
          pendingCandidates:store.proposals('pending').filter(x=>x.meta?.contract==='knowledge-candidate/v1').length,
          approvedKnowledge:units.filter(x=>x.verificationStatus==='verified').length,
          knowledgeAtL2:units.filter(x=>x.layer==='applied').length,
          knowledgeAtL1:units.filter(x=>x.layer==='domain').length,
          usages:store.listUsages({limit:1000}).length,
          positiveUsages:store.listUsages({limit:1000}).filter(x=>x.observedBenefit==='positive').length,
          negativeUsages:store.listUsages({limit:1000}).filter(x=>x.observedBenefit==='negative').length
        });
      }
      if(method==='GET'&&url.pathname==='/api/projects')return json(res,staticCatalog.projects);
      if(method==='GET'&&url.pathname==='/api/knowledge') {
        const filters=Object.fromEntries(['q','domain','layer','scope','status','projectId'].map(k=>[k,url.searchParams.get(k)??'']));
        return json(res,filterEntries(allUnits(),filters).map(({content,...rest})=>({...rest,excerpt:content.slice(0,170)})));
      }
      if(method==='POST'&&url.pathname==='/api/knowledge')return json(res,store.create(await body(req)),201);
      if(fragments[1]==='knowledge'&&fragments[2]) {
        const id=decodeURIComponent(fragments[2]);
        const item=allUnits().find(x=>x.id===id);
        if(!item)return notFound('Knowledge not found');
        if(method==='GET'&&fragments.length===3)return json(res,item);
        if(method==='GET'&&fragments[3]==='revisions') {
          if(item.readOnly)return json(res,[]);
          return json(res,store.revisions(id));
        }
        if(method==='PATCH'&&fragments.length===3) {
          if(item.readOnly){const e=new Error('Published knowledge is immutable; fork to edit');e.status=403;throw e;}
          const p=await body(req);
          return json(res,store.update(id,p,{expectedRevision:p.expectedRevision,note:p.note??'Web edit'}));
        }
        if(method==='POST'&&fragments[3]==='revert') {
          if(item.readOnly) {const e=new Error('Cannot revert immutable package');e.status=403;throw e;}
          const p=await body(req);return json(res,store.revert(id,p.revision,p.expectedRevision));
        }
        if(method==='POST'&&fragments[3]==='fork') {
          if(!item.readOnly){const e=new Error('Use edit for personal knowledge');e.status=400;throw e;}
          const p=await body(req);
          const project=p.scope==='project'?item.projectId:null;
          const layer=project?'project':item.layer==='project'?'applied':item.layer;
          return json(res,store.create({title:item.title,content:item.content,kind:item.kind,
            scope:project?'project':'personal',projectId:project,layer,domains:item.domains,tags:item.tags,
            evidenceRefs:[],verificationStatus:'unverified',relations:item.relations,sourceRef:item.id},
            {note:`Forked from ${item.id}`}),201);
        }
      }
      if(method==='GET'&&url.pathname==='/api/proposals')return json(res,store.proposals(url.searchParams.get('status')??''));
      if(method==='POST'&&url.pathname==='/api/proposals')return json(res,store.submitProposal(await body(req)),201);
      if(method==='POST'&&fragments[1]==='proposals'&&fragments[2]&&fragments[3]==='review')return json(res,store.reviewProposal(fragments[2],await body(req)));
      if(method==='POST'&&url.pathname==='/api/context-preview') {
        const p=await body(req);
        const example=staticCatalog.projects.find(x=>x.id===p.projectId);
        if(!example)return notFound('Unknown example project');
        const engine=createDomainEngine({dbPath});
        try {
          const snapshot=await engine.resolve({cwd:path.join(ROOT,'examples',p.projectId)});
          const compiled=engine.compile({snapshot,task:String(p.task??'Domain knowledge')});
          return json(res,{sharedSnapshotId:compiled.snapshotId,projectSnapshotId:compiled.projectSnapshotId,
            knowledgeRefs:compiled.knowledgeRefs,stableContext:compiled.stableContext,dynamicContext:compiled.dynamicContext,
            applicability:compiled.applicability,estimatedTokens:compiled.estimatedTokens});
        } finally {engine.close();}
      }
      return notFound();
    } catch(e) {
      let status=e.status??500;
      if(e instanceof KnowledgeValidationError || e instanceof OwnerInputError) status=e.status??400;
      if(/UNIQUE constraint failed/.test(e.message)){status=409;}
      json(res,{error:status===500?'Internal server error':e.message},status);
      if(status===500)console.error('Workbench internal error:',e);
    }
  };
  const server=http.createServer((req,res)=>{void handler(req,res);});
  return {
    async listen() {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address();},
    close() {return new Promise((resolve,reject)=>server.close(e=>{store.close();owner.close();e?reject(e):resolve();}));},
    server,store
  };
}
