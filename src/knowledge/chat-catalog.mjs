// 窗口与只读对话共用同一份身份映射；短名只作唯一时的兼容别名，不决定来源。
import fs from 'node:fs';
import path from 'node:path';

export const skillBodyOf = raw => String(raw).replace(/^\uFEFF/u,'').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u,'').trim();

export function chatSkillRegistry(items=[]) {
  const names=new Map();const groups=new Map();
  for(const item of items)groups.set(item.id,[...(groups.get(item.id)||[]),item]);
  const rows=[...groups.values()].map(group=>{
    const item=group[0];
    const commandName=item.path?path.basename(path.dirname(item.path)):String(item.name||item.id).split(/[:/]/u).pop();
    let reason=item.missing?(item.reason||'技能文件缺失'):item.playbookOnly?'仅供 Playbook 使用，不支持在对话中调用。':'';
    if(new Set(group.map(entry=>entry.path)).size>1)reason='目录存在指向不同正文的重复身份，请修复来源声明后刷新。';
    if(!reason && (!item.path || /\s/u.test(item.id) || item.id.length>160))reason='技能身份或正文路径不可用于对话。';
    if(!reason){try{const raw=fs.readFileSync(item.path,'utf8');const body=skillBodyOf(raw);if(!body)reason='技能正文为空，请补齐 SKILL.md 后刷新。';}catch{reason='技能文件无法读取，请检查目录后刷新。';}}
    const row={...item,commandName,callable:!reason,callId:item.id,callReason:reason};
    if(row.callable)names.set(commandName,(names.get(commandName)||0)+1);
    return row;
  });
  const skills=rows.filter(row=>row.callable).map(row=>({id:row.id,name:row.name,description:row.description,path:row.path,origin:row.origin||row.source,
    aliases:names.get(row.commandName)===1?[row.commandName]:[]}));
  return {items:rows,skills};
}

/** 一个短名指向多处来源时拒绝猜测；完整身份精确命中优先。 */
export function resolveChatSkill(skills,id) {
  const exact=skills.filter(skill=>skill.id===id);if(exact.length===1)return exact[0];
  if(exact.length>1)return null;
  const aliases=skills.filter(skill=>skill.aliases?.includes(id));return aliases.length===1?aliases[0]:null;
}
