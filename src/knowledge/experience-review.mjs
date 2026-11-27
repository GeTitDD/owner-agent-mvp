// 流内审阅只接收允许编辑的字段。来源、验证状态和归属由数据库记录决定，不信任卡片快照。
import { canonical, sha256 } from '../utils.mjs';
import { ideaToLesson, promoteIdeaToLesson } from '../idea-lesson.mjs';
const text=(value,label,max,required=false)=>{
 if(typeof value!=='string'||value.length>max||(required&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw Error(`${label}${required?'不能为空，且':''}最多 ${max} 字；原输入已保留。`);
 return value.trim();
};
export const proposalReviewHash=p=>sha256(canonical({payload:p.payload,meta:p.meta,status:p.status}));
const sourceHash=item=>sha256(canonical({id:item.id,rawText:item.rawText||'',title:item.title||''}));

/** 只读预览，不写半条经验，也不消耗第一次人工确认。 */
export function ideaLessonDraft({ownerStore,personalStore,ideaId,projectId}){
 const project=ownerStore.getProject(projectId);if(!project)throw Error('先选一个已登记项目，再整理经验。');
 const item=ownerStore.getIdeaItem(ideaId);if(!item)throw Error('原始灵感已不存在，未准备经验。');
 const existing=personalStore.listLessons({sourceRecordId:ideaId,limit:10})[0];
 if(existing)return {ok:true,created:false,lesson:existing};
 const lesson=ideaToLesson(item,{projectId});
 return {ok:true,preview:true,card:{type:'review',kind:'lesson',editKind:'idea',title:'整理经验 · 第一次确认',ideaId,projectId,expectedHash:sourceHash(item),
  rows:[['来源',`灵感 ${ideaId} · 项目 ${project.name||projectId}`],['验证','人工整理仍为推断；不会自动成为已验证结论。']],
  editValues:{phenomenon:lesson.phenomenon,mechanism:'',countermeasure:'',content:lesson.content},actions:[{id:'save-lesson',label:'确认保存经验'},{id:'cancel-experience',label:'取消'}],
  note:'补齐现象、机制与对策。原始记录正文单独完整保留，标题缩短不会截断正文。取消不写经验。'}};
}

export function confirmIdeaLesson({ownerStore,personalStore,ideaId,projectId,expectedHash,edits}){
 const item=ownerStore.getIdeaItem(ideaId);if(!item||sourceHash(item)!==expectedHash)throw Error('原始灵感在打开后已变化；未保存。请重新打开，原输入可复制保留。');
 const fields={phenomenon:text(edits?.phenomenon,'现象',160,true),mechanism:text(edits?.mechanism,'机制',1000,true),countermeasure:text(edits?.countermeasure,'对策',1000,true),content:text(edits?.content,'记录正文',16000,true)};
 return promoteIdeaToLesson({store:ownerStore,personalStore,id:ideaId,projectId,edits:fields});
}

/** 候选的编辑不会修改来源、证据或验证状态。领域范围必须显式指定至少一个领域。 */
export function knowledgeReviewEdits(proposal,edits){
 const title=text(edits?.title,'标题',200,true);const content=text(edits?.content,'正文',20000,true);
 const applicability=text(edits?.applicability,'适用条件',1000,true);const exceptions=text(edits?.exceptions,'例外 / 边界',1000,true);
 if(!['project','domain'].includes(edits?.scope))throw Error('请选择仅当前项目或领域共享。');
 const domains=edits.scope==='domain'?text(edits?.domains,'共享领域',1000,true).split(/[,，\n]/u).map(x=>x.trim()).filter(Boolean):[];
 if(domains.length>20||domains.some(d=>!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(d)))throw Error('领域 ID 使用字母、数字、点、下划线或连字符，最多 20 个。');
 const sourceProject=proposal.payload.projectId||proposal.meta?.sourceProjectId;
 if(edits.scope==='project'&&!sourceProject)throw Error('来源项目未记录，不能把领域知识凭空绑定到一个项目。');
 return {...proposal.payload,title,content: `${content}\n\n适用条件：${applicability}\n例外 / 边界：${exceptions}`,scope:edits.scope,layer:edits.scope==='domain'?'applied':'project',projectId:edits.scope==='domain'?null:sourceProject,domains:[...new Set(domains)]};
}
