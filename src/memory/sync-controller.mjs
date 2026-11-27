// 桌面宿主只接这层小接口；凭据、基线与真实传输始终留在主进程。
import path from 'node:path';
import { MemorySyncService } from './sync-service.mjs';
import { GitMemoryTransport, normalizeSyncTarget } from './sync-git.mjs';
import { SyncStatusStore } from './sync-status-store.mjs';
import { applySyncAttempt } from './sync-status.mjs';

export class MemorySyncController {
  constructor({store,root,repo,branch='main',env=process.env,testRemote=''}={}) {
    const target=normalizeSyncTarget(repo,branch);
    const transport=new GitMemoryTransport({root:path.join(root,'git'),...target,env,testRemote});
    this.service=new MemorySyncService({store,transport,stateFile:path.join(transport.root,'baseline.json')});
    this.statusStore=new SyncStatusStore({file:path.join(transport.root,'status.json')});
    this.credential=!!transport.token||transport.localTest;
  }
  status() {
    const counts=this.service.dirtyCount();
    return {...this.statusStore.read(),...counts,availability:{available:this.credential,mode:'manual-preview',reason:this.credential?'':'auth-missing'}};
  }
  async prepare() {
    try {
      const preview=await this.service.prepare();
      if(!preview.empty)this.record({status:'pending',code:'preview-pending',message:'已发现待同步文档，请核对清单后确认。'});
      return preview;
    }
    catch(error){this.record({status:'error',code:error.code||'sync-check-failed',message:error.message});throw error;}
  }
  detail(input) {return this.service.detail(input?.id,input?.documentId);}
  cancel(input) {return this.service.cancel(input?.id);}
  archives() {return this.service.archives();}
  restore(input) {return this.service.restoreArchived(input);}
  record(result) {this.statusStore.save(applySyncAttempt(this.statusStore.read(),result,new Date()));}
  async execute(input) {
    try {
      const result=await this.service.execute(input);this.record(result);
      return {...result,text:result.status==='ok'?`同步完成：接收或更新 ${(result.applied?.length||0)-(result.archived?.length||0)} 篇，推送 ${result.pushed?.length||0} 篇，归档 ${result.archived?.length||0} 篇。`:result.text};
    } catch(error){this.record({status:'error',code:error.code||'sync-failed',message:error.message});throw error;}
  }
}
