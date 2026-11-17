'use strict';
window.PiJobControls={render(session,control){
  let panel=document.querySelector('#workbench-jobs');if(!panel){panel=document.createElement('section');panel.id='workbench-jobs';panel.setAttribute('aria-label','后台任务');document.querySelector('.workbench-footer').before(panel);}
  panel.replaceChildren();
  const labels={queued:'等待中',running:'运行中',cancelling:'正在取消',completed:'已完成',failed:'失败',cancelled:'已取消'};
  for(const job of Object.values(session.jobs||{}).slice(-4)){
    const row=document.createElement('div'),label=document.createElement('span'),progress=document.createElement('progress');
    label.textContent=job.action+' · '+(labels[job.status]||job.status)+(job.message?' · '+job.message:'');progress.max=1;progress.value=job.progress||0;row.append(label,progress);
    if(['queued','running'].includes(job.status)){const button=document.createElement('button');button.className='button';button.textContent='取消';button.onclick=async()=>{button.disabled=true;try{await control(session,{operation:'cancel',id:job.id});}catch(error){label.textContent=error.message;button.disabled=false;}};row.append(button);}
    if(job.error){const error=document.createElement('small');error.textContent=job.error;row.append(error);}panel.append(row);
  }
}};
