'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const runtime = require('./workbench-runtime.cjs');
if(workerData.operation==='session'){
  let queue=Promise.resolve(),session=null,closing=false;
  const controllers=new Map();
  const emit=event=>{if(!closing)parentPort.postMessage({type:'event',event});};
  async function dispatch(input){session ||= await runtime.createSessionAt(workerData.root,input,emit);return session.dispatch(input);}
  const jobs=require('./workbench-job-service.cjs').createJobs({dispatch,emit,schedule:fn=>{queue=queue.catch(()=>{}).then(()=>closing?undefined:fn());}});
  parentPort.on('message',message=>{
    if(message.type==='cancel-request'){controllers.get(message.id)?.abort();return;}
    if(message.type==='cancel-source'){jobs.cancelSource(message.source);for(const item of controllers.values())if(item.source===message.source)item.abort();return;}
    if(message.type==='close'){
      if(closing)return;
      closing=true;
      jobs.close();for(const controller of controllers.values())controller.abort();
      queue=queue.catch(()=>{}).then(async()=>{try{await session?.close();}finally{parentPort.postMessage({type:'closed'});parentPort.close();}});
      return;
    }
    if(closing)return;
    if(message.input?.action?.startsWith('__jobs.')){const result=jobs.control(message.input);parentPort.postMessage({id:message.id,result:result||{ok:false,error:'未知后台任务操作'}});return;}
    const controller=new AbortController();controller.source=message.input?.source;controllers.set(message.id,controller);
    queue=queue.catch(()=>{}).then(async()=>{
      if(closing)return;
      try{
        if(controller.signal.aborted){parentPort.postMessage({id:message.id,result:{ok:false,error:'操作已取消，未执行'}});return;}
        session ||= await runtime.createSessionAt(workerData.root,message.input,emit);
        if(closing)return;
        const result=await session.dispatch({...message.input,signal:controller.signal});
        if(!closing)parentPort.postMessage({id:message.id,result});
      }catch(error){if(!closing)parentPort.postMessage({id:message.id,result:{ok:false,error:error.message}});}finally{controllers.delete(message.id);}
    });
  });
}else Promise.resolve().then(()=>workerData.operation==='inspectPath'?runtime.inspectPath(workerData.root):workerData.operation==='dispatchPath'?runtime.dispatchPath(workerData.root,workerData.input):runtime.dispatch(workerData.root, workerData.input))
  .then(result=>parentPort.postMessage(result))
  .catch(error=>parentPort.postMessage({ok:false,error:error.message}));
