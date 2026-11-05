const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-workbench-request':'1'},body:body===undefined?undefined:JSON.stringify(body)});const p=await r.json();if(!r.ok)throw Error(p.error||`HTTP ${r.status}`);return p;}
async function showSummary(){try{const s=await api('/api/owner/summary');$('overview').textContent=`项目 ${s.projectCount} · 正在运行 ${s.activeRuns} · 阻塞任务 ${s.blockedTasks} · 待审建议 ${s.pendingSuggestions}`;}catch{$('overview').textContent='Owner Runtime 未就绪';}}
let expanded=false;
const toggle=value=>{expanded=value;$('panel').hidden=!value;window.ownerDesktop?.resize?.(value);if(value)void showSummary();};
$('pet').addEventListener('click',()=>toggle(!expanded));$('collapse').addEventListener('click',()=>toggle(false));
$('openWorkbench').addEventListener('click',()=>{if(window.ownerDesktop?.openWorkbench)window.ownerDesktop.openWorkbench();else window.open('/','_blank');});
$('chat').addEventListener('submit',async e=>{e.preventDefault();const q=$('query').value.trim();if(!q)return;$('query').value='';const box=$('messages');box.insertAdjacentHTML('beforeend',`<div class="msg you">${esc(q)}</div>`);
try{const answer=await api('/api/owner/ask',{question:q});box.insertAdjacentHTML('beforeend',`<div class="msg">${esc(answer.answer)}<small>依据：${esc(answer.basis.join(' · '))} · ${esc(answer.mode)}</small></div>`);}catch(err){box.insertAdjacentHTML('beforeend',`<div class="msg">${esc(err.message)}</div>`);}box.scrollTop=box.scrollHeight;});
