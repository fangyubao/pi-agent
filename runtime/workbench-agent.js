'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PiWorkbenchAgent=api;})(typeof window==='object'?window:globalThis,()=>{
  const actions=['inspectWorkbenchRuntime','scaffoldWorkbench','startWorkbenchTrial','stopWorkbenchTrial','callWorkbenchBackend','readWorkbenchEvents','verifyWorkbench','inspectWorkbenchUI','actWorkbenchUI','captureWorkbenchUI','startWorkbenchJob','listWorkbenchJobs','getWorkbenchJob','cancelWorkbenchJob','searchWorkbenchKnowledge','readWorkbenchKnowledge'];
  const interactionRule='先自行读取可用状态、文件、日志和工具结果，再判断是否缺少需求。用户已要求诊断、修复或操作时，范围内的检查、复现、修复和验证直接执行，不再问“需要我修吗”或让用户代点按钮、抄状态和报错。只有用户偏好、无法自行获取的外部信息或会实质改变目标的歧义才提问。操作批准由工具权限机制处理，不用需求卡重复批准。';
  function context(){return {id:'workbench-host',kind:'workbench',version:1,actions:[...actions],prompt:'工作台前端供用户交互，Agent 与前端共用同一个后端会话。先 workbench_action inspectWorkbenchRuntime 读取当前模式、源码路径、后端动作和运行状态；设计模式下若 sourcePath 为空，可先调用 scaffoldWorkbench({name,prompt?}) 创建独立工程目录。需要验证时自行 startWorkbenchTrial；需重载修改后的后端代码时先 stopWorkbenchTrial 再 startWorkbenchTrial。用 callWorkbenchBackend({action,payload}) 调用返回的真实动作（含 readState），结果包含 state/result/events；参数不明时读取源码或协议文档，不猜测。readWorkbenchEvents({after,limit}) 按需读取与界面共用的近期实时事件，返回游标和截断提示。工作台功能完成后，必须在最后一次源码修改之后调用 verifyWorkbench，让宿主实际运行 tests/**/*.test.cjs/js/mjs，并完成打开会话→读取动作→关闭→重新打开→再次读取的完整生命周期检查；验证失败、跳过、源码变化或未覆盖动作时不得报告交互验证完成，也不得提交阶段报告或发布。试运行和布局切换不推进设计阶段、不发布工作台。保持用户已打开的会话，避免无必要地重启或断开设备；必须断开时说明影响并遵守批准设置。需要用户偏好才提问；先完成能自行检查的部分。只有实际执行并读取结果后才能报告验证成功；后端验证不等于界面视觉验证。'};}
  function access(command,payload,manifest){
    if(['inspectWorkbenchUI','captureWorkbenchUI'].includes(command))return {access:'read'};
    if(command==='actWorkbenchUI')return {access:'write',requiresConfirmation:Boolean(manifest?.actions?.some(a=>a.requiresConfirmation))};
    if(['listWorkbenchJobs','getWorkbenchJob','searchWorkbenchKnowledge','readWorkbenchKnowledge'].includes(command))return {access:'read'};
    if(command==='cancelWorkbenchJob')return {access:'write'};
    if(command==='startWorkbenchJob')return access('callWorkbenchBackend',payload,manifest);
    if(['inspectWorkbenchRuntime','readWorkbenchEvents','readLayout','readDesignWorkflow'].includes(command))return {access:'read'};
    if(['scaffoldWorkbench','startWorkbenchTrial','stopWorkbenchTrial','setLayout','reportDesignStage','verifyWorkbench'].includes(command))return {access:'write'};
    const action=command==='callWorkbenchBackend'?payload?.action:command;
    const found=manifest?.actions?.find(x=>(typeof x==='string'?x:x.name)===action);
    if(!found)throw new Error('当前工作台未声明后端动作：'+String(action||'(空)')+'；请先 inspectWorkbenchRuntime 读取动作，再检查 manifest.json 与源码。');
    return {access:typeof found==='object'&&found.access==='read'?'read':'write',requiresConfirmation:found?.requiresConfirmation===true};
  }
  function recordEvent(session,event){
    if(!session||!event)return;
    session.eventSequence=(session.eventSequence||0)+1;
    const text=JSON.stringify(event),entry={sequence:session.eventSequence,event:text.length<=8192?JSON.parse(text):{type:event.type,truncated:true,preview:text.slice(0,8192)}};
    (session.recentEvents ||= []).push(entry);
    if(session.recentEvents.length>100)session.recentEvents.shift();
  }
  function readEvents(session,payload={}){
    const after=Math.max(0,Number(payload.after)||0),limit=Math.max(1,Math.min(50,Number(payload.limit)||20)),all=session?.recentEvents||[];
    const events=all.filter(x=>x.sequence>after).slice(0,limit);
    return {events,next:events.at(-1)?.sequence||after,latest:session?.eventSequence||0,hasMore:(session?.eventSequence||0)>(events.at(-1)?.sequence||after),truncated:Boolean(all.length&&after<all[0].sequence-1)};
  }
  const baseContext=context;
  function fullContext(){const value=baseContext();value.prompt+=' 长时间计算使用 startWorkbenchJob({action,payload,timeoutMs?})，立即返回任务 ID；listWorkbenchJobs/getWorkbenchJob({id}) 获取进度、状态与结果，cancelWorkbenchJob({id}) 请求取消，不关闭连接。job.updated 事件与用户界面一致。后台任务没有默认 60 秒计算上限。需要多步计算时持续检查实际结果；取消中的任务不等于已停止。 前端自主测试：startWorkbenchTrial 后用 inspectWorkbenchUI({offset,limit}) 读取真实页面控件、选择器和错误；actWorkbenchUI({operation,selector,value?,checked?,key?,from?,to?,toSelector?}) 支持 click/fill/select/check/press/drag，随后读取页面与后端确认效果；captureWorkbenchUI 返回截图。正式验收要编写 tests/ui-scenarios.json，verifyWorkbench 会独立运行真实页面、后端、关闭重开和控件覆盖；空白页、未测控件、脚本错误或断言不符都会失败。失败返回 ok:false 与 frontend.failure、evidencePath，先读取证据自行修复并重测，不让用户代点。前端测试协议在工作台工程 agent/TESTING.md；缺少时读取宿主 contexts/workbench-testing.md。';return value;}
  return {actions,context:fullContext,interactionRule,access,recordEvent,readEvents};
});
