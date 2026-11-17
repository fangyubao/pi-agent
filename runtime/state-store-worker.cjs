'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const store = require('./state-store.cjs').createStateStore(workerData.root);
const vault = require('./local-vault.cjs').createVault(workerData.vaultRoot || require('node:path').join(workerData.root,'vault'));
let latest=null,queue=Promise.resolve();
parentPort.on('message', request=>{
  queue=queue.catch(()=>{}).then(async()=>{
    const {id,operation,state,mirrorHash,patch}=request;
    try{
      let result;
      if(operation==='load'){result=await store.load();latest=result.state;}
      else if(operation==='save'){
        let next=state;
        if(patch){
          if(!latest)latest=(await store.load()).state;
          if(!latest)throw new Error('缺少完整存档，请重试保存');
          const tasks=new Map(latest.projects.flatMap(p=>p.tasks.map(t=>[t.id,t])));for(const t of patch.tasks)tasks.set(t.id,t);
          for(const change of patch.taskPatches||[]){
            const previous=tasks.get(change.id),messages=new Map((previous?.messages||[]).map(m=>[m.id,m]));
            if(!previous&&!change.meta)throw new Error('任务存档缺失：'+change.id);
            for(const m of change.messages)messages.set(m.id,m);
            tasks.set(change.id,{...(change.meta||previous),...(change.fields||{}),messages:change.messageIds.map(id=>{const m=messages.get(id);if(!m)throw new Error('消息存档缺失：'+id);return m;})});
          }
          next={...patch.meta,projects:patch.projects.map(({taskIds,...meta})=>({...meta,tasks:taskIds.map(id=>{const t=tasks.get(id);if(!t)throw new Error('任务存档缺失：'+id);return t;})}))};
        }
        result=await store.save(next,mirrorHash);latest=next;
      }else if(operation==='backup'){
        if(!latest)latest=(await store.load()).state;
        let count=0;
        for(const project of latest?.projects||[]){
          const fingerprint=require('./state-store.cjs').hash(JSON.stringify(project));
          const result=await vault.backup(project,{ifChanged:true,fingerprint});if(!result.unchanged)count++;
        }
        result={count};
      }else if(operation==='vault'){
        if(!['record','list','get','backup','backups','restore','usage'].includes(request.method))throw new Error('未知存储操作');
        result=await vault[request.method](...request.args);
      }else result=await store[operation]();
      parentPort.postMessage({id,ok:true,result});
    }catch(error){parentPort.postMessage({id,ok:false,error:error.message});}
  });
});
