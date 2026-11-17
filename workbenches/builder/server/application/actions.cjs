'use strict';
const {normalize}=require('../domain/state.cjs');
const {event}=require('../contracts/events.cjs');
async function dispatch({ action, payload = {}, state = {} }) {
  const next = normalize(state);
  if(action==='searchKnowledge'){
    const query=String(payload.query||'').trim().toLowerCase();if(!query)throw new Error('请输入检索内容');
    if(next.knowledge?.indexId)throw new Error('全文索引由宿主检索，请通过工作台调用 searchKnowledge');
    const matches=(next.knowledge?.files||[]).filter(file=>file.content?.toLowerCase().includes(query)).slice(0,6).map(file=>{const offset=Math.max(0,file.content.toLowerCase().indexOf(query)-200);return {sourceId:file.id,path:file.path,offset,text:file.content.slice(offset,offset+2000),partial:file.status==='partial'};});
    return {state:next,result:{matches,note:'旧版摘录；重新导入可建立全文索引'},events:[]};
  }
  if (action === 'readDraft') {const result={...next,files:(next.knowledge?.files||[]).map(({content,...meta})=>meta)};delete result.knowledge;return {state:next,result,events:[]};}
  if (action === 'readKnowledge') {
    const files=next.knowledge?.files||[];
    if(!payload.sourceId)return {state:next,result:{sources:files.map(({content,...meta})=>meta),note:'传 sourceId 和 offset 分页读取资料，每页最多 6000 字。'},events:[]};
    const file=files.find(item=>item.id===payload.sourceId);
    if(!file||typeof file.content!=='string')throw new Error('此来源没有已导入文本');
    const offset=Math.max(0,Math.floor(Number(payload.offset)||0));
    return {state:next,result:{id:file.id,path:file.path,text:file.content.slice(offset,offset+6000),nextOffset:offset+6000<file.content.length?offset+6000:null},events:[]};
  }
  if (action === 'setKnowledgePrompt') {
    if (payload.baseRevision !== undefined && Number(payload.baseRevision) !== next.revision) throw new Error('设计草稿已更新，请重新读取当前 revision');
    next.promptDraft = String(payload.prompt || '').slice(0, 12000);
    next.promptMethod = 'Agent 整理后待设计者审阅';
    next.promptVersion++;
    next.revision++;
    return { state: next, result: { revision: next.revision, promptVersion: next.promptVersion }, events: [event('prompt.updated', { revision: next.revision })] };
  }
  if (action === 'applyPrompt') {
    if (!next.promptDraft.trim()) throw new Error('没有可应用的提示词草稿');
    next.appliedPrompt = next.promptDraft;
    next.promptVersion++;
    next.revision++;
    return { state: next, result: { revision: next.revision, promptVersion: next.promptVersion }, events: [event('prompt.applied', { revision: next.revision })] };
  }
  throw new Error('工作台设计后端不支持动作：' + action);
}
module.exports={dispatch};
