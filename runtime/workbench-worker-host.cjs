'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const workers=new Set();
const sessions=new Map();
const workerFile=()=>path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/,'app.asar.unpacked'),'workbench-worker.cjs');
function sessionKey(root,id){return path.resolve(root).toLowerCase()+':'+id;}
function shutdown(item,reason){
  for(const pending of item.pending.values()){clearTimeout(pending.timer);pending.resolve({ok:false,error:reason});}item.pending.clear();
  item.closeTimer=setTimeout(()=>void item.worker.terminate(),1500);item.closeTimer.unref();
  item.worker.postMessage({type:'close'});
}
function closeSession(root,id){const key=sessionKey(root,id),item=sessions.get(key);if(!item)return Promise.resolve();const closed=new Promise(resolve=>item.worker.once('exit',resolve));sessions.delete(key);shutdown(item,'工作台已关闭');return closed;}
function executePath(root,input={},onEvent){
  const id=String(input.sessionId||input.taskId||'default'),key=sessionKey(root,id);let item=sessions.get(key);
  if(!item){
    if(sessions.size>=8)return Promise.resolve({ok:false,error:'打开的工作台后端过多，请先关闭不用的工作台'});
    const worker=new Worker(workerFile(),{workerData:{root,operation:'session'}});item={worker,pending:new Map(),sequence:0,onEvent};sessions.set(key,item);workers.add(worker);
    worker.on('message',message=>{
      if(message.type==='closed'){clearTimeout(item.closeTimer);void worker.terminate();return;}
      if(sessions.get(key)!==item)return;
      if(message.type==='event'){try{item.onEvent?.(message.event);}catch{}return;}
      const pending=item.pending.get(message.id);if(!pending)return;item.pending.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.result);
    });
    const failed=error=>{clearTimeout(item.closeTimer);for(const pending of item.pending.values()){clearTimeout(pending.timer);pending.resolve({ok:false,error});}item.pending.clear();if(sessions.get(key)===item)sessions.delete(key);workers.delete(worker);};
    worker.once('error',error=>failed(error.message));worker.once('exit',code=>failed('工作台后端已退出：'+code));
  }
  if(onEvent)item.onEvent=onEvent;
  return new Promise(resolve=>{const request=++item.sequence;const timer=setTimeout(()=>{
    item.pending.delete(request);
    item.worker.postMessage({type:'cancel-request',id:request});
    resolve({ok:false,error:'工作台请求超时，已请求取消该操作；连接保留，请读取状态核对结果。长时间计算请使用后台任务。'});
  },60000);item.pending.set(request,{resolve,timer});item.worker.postMessage({id:request,input});});
}
function execute(root,input,operation='dispatch'){
  return new Promise(resolve=>{
    const worker=new Worker(path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/,'app.asar.unpacked'),'workbench-worker.cjs'),{workerData:{root,input,operation}});
    workers.add(worker);
    let settled=false;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);workers.delete(worker);void worker.terminate();resolve(result);};
    const timer=setTimeout(()=>finish({ok:false,error:'工作台后端执行超时，已终止执行；请核对已产生的文件或设备操作。'}),60000);
    worker.once('message',finish);
    worker.once('error',error=>finish({ok:false,error:error.message}));
    worker.once('exit',code=>finish({ok:false,error:'工作台后端退出：'+code}));
  });
}
function dispose(){
  const exits=[...workers].map(worker=>new Promise(resolve=>worker.once('exit',resolve)));
  const activeWorkers=new Set([...sessions.values()].map(item=>item.worker));
  for(const item of sessions.values())shutdown(item,'应用已关闭');sessions.clear();
  for(const worker of workers)if(!activeWorkers.has(worker))void worker.terminate();
  return Promise.all(exits);
}
function cancelSource(source){for(const item of sessions.values())item.worker.postMessage({type:'cancel-source',source});}
module.exports={execute,executePath,closeSession,dispose,cancelSource};
