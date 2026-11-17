'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PiContextTransport=api;})(typeof window==='object'?window:globalThis,()=>{
  const clone=value=>JSON.parse(JSON.stringify(value));
  // The same materialized blocks power the viewer and the IPC input. Original
  // content/history must never leak alongside an edited or excluded block.
  function compile(envelope,snapshot,request='',attachments=[]){
    const context=clone(envelope||{}),blocks=snapshot?.blocks||[],find=id=>blocks.find(b=>b.id===id),value=id=>{const b=find(id);return b?.enabled?b.content:'';};
    context.task={...context.task,goal:value('task:goal'),notes:'',messages:[]};
    const recent=value('conversation:recent');if(recent)context.task.messages=[{role:'user',text:recent}];
    context.summary=value('conversation:summary');
    context.memory={...context.memory,items:blocks.filter(b=>b.enabled&&b.source==='memory'&&b.type!=='empty').map(b=>({id:b.id.slice(7),content:b.content,scope:b.scope,version:b.version,kind:b.type}))};
    const wb=find('tools:workbench-state');context.workbenchState=null;
    if(wb?.enabled){try{context.workbenchState=JSON.parse(wb.content);}catch{context.workbenchState={userContextNote:wb.content};}}
    context.toolHistory=value('tools:file-io');
    const requestBlock=find('request:current');
    const message=requestBlock?(requestBlock.enabled?requestBlock.content:'本轮输入已在上下文查看中排除。'):request;
    const attach=find('attachments:pending');
    const included=attach?.enabled!==false&&context.contextOverrides?.includeAttachments!==false&&!context.contextOverrides?.excluded?.includes('attachments:pending');
    const effectiveAttachments=!included?[]:attach?.overridden?[{name:'用户修订的附件上下文',kind:'text',mimeType:'text/plain',data:attach.content}]:attachments;
    return {context,message,attachments:effectiveAttachments};
  }
  function liveState(context={}){return {revision:context.revision||0,task:context.task||null,memory:context.memory||{items:[]},summary:context.summary||'',workbenchState:context.workbenchState||null,toolHistory:context.toolHistory||[],contextManifest:context.contextManifest||null};}
  function trustedState(context={}){return {core:context.core,contexts:context.contexts||[],workbench:context.workbench||null,mode:context.mode||'base',policies:context.policies||{}};}
  function readTaskContext(context={},payload={}){
    const enabled=(context.plugins||[]).includes('task-context')&&(context.contexts||[]).some(x=>x.id==='plugin:task-context'&&x.kind==='plugin'&&x.actions?.includes('readTaskContext'));
    if(!enabled)throw new Error('任务上下文插件未在当前请求中启用');
    if(!context.task?.id)throw new Error('当前没有可读取的任务');
    if(payload.taskId&&payload.taskId!==context.task.id)throw new Error('不能读取其他任务的上下文');
    return {project:String(context.task.project||'').slice(0,200),task:String(context.task.name||'').slice(0,200),messageCount:Math.max(0,Number(context.task.messageCount)||0),source:'当前运行任务的元数据快照'};
  }
  return {compile,liveState,trustedState,readTaskContext};
});
