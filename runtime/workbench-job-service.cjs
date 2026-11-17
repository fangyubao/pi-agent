'use strict';
const crypto=require('node:crypto');
// Lives in the session worker: UI and Agent query the same jobs, state and events.
function createJobs({dispatch,emit,schedule}){
  const jobs=new Map();
  const view=job=>{const {controller,...data}=job;return structuredClone(data);};
  const notify=job=>emit({type:'job.updated',time:Date.now(),payload:view(job)});
  function control(input){
    const payload=input.payload||{};
    if(input.action==='__jobs.list')return {ok:true,result:{jobs:[...jobs.values()].map(view)}};
    if(input.action==='__jobs.get'){const job=jobs.get(payload.id);return job?{ok:true,result:view(job)}:{ok:false,error:'后台任务不存在'};}
    if(input.action==='__jobs.cancel'){
      const job=jobs.get(payload.id);if(!job)return {ok:false,error:'后台任务不存在'};
      if(['queued','running'].includes(job.status)){job.status='cancelling';job.controller.abort();notify(job);}
      return {ok:true,result:view(job)};
    }
    if(input.action!=='__jobs.start')return null;
    if(!payload.action||payload.action.startsWith('__jobs.'))return {ok:false,error:'请指定已声明的后端动作'};
    if([...jobs.values()].filter(j=>['queued','running','cancelling'].includes(j.status)).length>=8)return {ok:false,error:'当前工作台等待中的任务过多'};
    const job={id:crypto.randomUUID(),action:payload.action,source:input.source||'ui',status:'queued',progress:0,message:'等待执行',createdAt:Date.now(),controller:new AbortController()};jobs.set(job.id,job);
    for(const [id,item] of jobs)if(jobs.size>50&&['completed','failed','cancelled'].includes(item.status))jobs.delete(id);
    notify(job);
    schedule(async()=>{
      if(job.controller.signal.aborted){job.status='cancelled';job.finishedAt=Date.now();notify(job);return;}
      job.status='running';job.startedAt=Date.now();notify(job);
      let timeout;
      if(payload.timeoutMs>0)timeout=setTimeout(()=>{job.message='达到计算时限，正在请求取消';job.status='cancelling';job.controller.abort();notify(job);},Math.min(Number(payload.timeoutMs),24*3600*1000));
      try{
        const result=await dispatch({...input,action:payload.action,payload:payload.payload||{},signal:job.controller.signal,progress:(value,message)=>{job.progress=Math.max(0,Math.min(1,Number(value)||0));job.message=String(message||'').slice(0,500);notify(job);}});
        job.response=result;job.status=job.controller.signal.aborted?'cancelled':result.ok?'completed':'failed';job.error=result.ok||job.status==='cancelled'?'':result.error;
        if(job.status==='completed'){job.progress=1;job.message='结果已同步';}
        if(job.status==='cancelled')job.message='取消请求已结束，请核对已产生的文件或设备操作。';
      }catch(error){job.status=job.controller.signal.aborted?'cancelled':'failed';job.error=job.status==='cancelled'?'':error.message;if(job.status==='cancelled')job.message='已停止本次计算';}
      finally{clearTimeout(timeout);job.finishedAt=Date.now();notify(job);}
    });
    return {ok:true,result:view(job)};
  }
  function cancelSource(source){for(const job of jobs.values())if(job.source===source&&['queued','running'].includes(job.status))control({action:'__jobs.cancel',payload:{id:job.id}});}
  function close(){for(const job of jobs.values())job.controller.abort();}
  return {control,close,cancelSource};
}
module.exports={createJobs};
