'use strict';
// Only the visible history window owns DOM. Complete messages remain in task
// storage, context, search and export; no transcript data is truncated.
window.PiChatHistory=(()=>{
  const PAGE=24,LIMIT=72,views=new Map();let host=null,currentId=null;
  const key=el=>el.dataset.group?'group:'+el.dataset.group:el.dataset.step?'step:'+el.dataset.step:el.dataset.summaryKind?'summary:'+el.dataset.summaryKind:el.dataset.graphDetails?'graph:'+el.dataset.graphDetails:null;
  const query=id=>'[data-message-id="'+CSS.escape(id)+'"]';
  function view(id){if(!views.has(id)){if(views.size>=30)views.delete(views.keys().next().value);views.set(id,{start:null,anchor:null,offset:0,follow:true,details:[]});}return views.get(id);}
  function capture(){
    const box=document.querySelector('#messages');if(!box||!currentId)return;
    const v=view(currentId);
    if(!v.jumpLatest){v.follow=v.atLatest!==false&&box.scrollHeight-box.clientHeight-box.scrollTop<50;
    const top=box.getBoundingClientRect().top,anchor=[...box.querySelectorAll(':scope>.message')].find(el=>el.getBoundingClientRect().bottom>top);
    v.anchor=anchor?.dataset.messageId;v.offset=anchor?anchor.getBoundingClientRect().top-top:0;}
    v.details=[...box.querySelectorAll('details[open]')].map(el=>({message:el.closest('.message')?.dataset.messageId,key:key(el),scroll:el.querySelector('.tool-list,.execution-graph-scroll,pre')?.scrollTop||0})).filter(x=>x.key&&x.message);
  }
  function range(t){const v=view(t.id),n=t.messages.length;let start=v.follow||!v.start?Math.max(0,n-PAGE):t.messages.findIndex(m=>m.id===v.start);if(start<0)start=Math.max(0,n-PAGE);const end=Math.min(n,start+LIMIT);return {start,end};}
  function markup(t,render){const {start,end}=range(t);view(t.id).start=t.messages[start]?.id||null;view(t.id).atLatest=end===t.messages.length;
    return (start?'<button type="button" class="history-page-control" data-history-page="older">查看更早的消息 · 还有 '+start+' 条</button>':'')+t.messages.slice(start,end).map(render).join('')+(end<t.messages.length?'<button type="button" class="history-page-control" data-history-page="newer">查看后面的消息 · 还有 '+(t.messages.length-end)+' 条</button><button type="button" class="history-page-control" data-history-page="latest">回到最新消息</button>':'');
  }
  function hydrate(details){
    const kind=details?.dataset.lazyDetail;if(!kind||!details.open)return;
    const m=host.task()?.messages.find(m=>m.id===details.closest('.message')?.dataset.messageId);if(!m)return;
    const body=details.querySelector(kind==='tools'?'.tool-list':'.run-summary-tab-body');if(!body)return;
    body.innerHTML=window.PiTranscript.detailMarkup(m,kind,details.dataset.group);delete details.dataset.lazyDetail;
  }
  function restoreDetails(box,items){for(const item of items){const message=box.querySelector(query(item.message));if(!message)continue;const detail=[...message.querySelectorAll('details')].find(el=>key(el)===item.key);if(detail){detail.open=true;hydrate(detail);const list=detail.querySelector('.tool-list,.execution-graph-scroll,pre');if(list)list.scrollTop=item.scroll;}}}
  function mounted(t){currentId=t.id;const box=document.querySelector('#messages'),v=view(t.id);restoreDetails(box,v.details);const anchor=v.anchor&&box.querySelector(query(v.anchor));if(v.follow)box.scrollTop=box.scrollHeight;else if(anchor)box.scrollTop+=anchor.getBoundingClientRect().top-box.getBoundingClientRect().top-v.offset;else if(v.start)box.scrollTop=0;v.jumpLatest=false;}
  function latest(t){const v=view(t.id);v.follow=true;v.start=null;v.anchor=null;v.atLatest=true;v.jumpLatest=true;}
  function reveal(id){const t=host.task();if(!t)return;const index=t.messages.findIndex(m=>m.id===id);if(index<0)return;const v=view(t.id);v.follow=false;v.start=t.messages[Math.max(0,index-2)]?.id;v.anchor=id;v.offset=0;host.render({restoreHistory:true});}
  function init(options){host=options;document.addEventListener('toggle',e=>hydrate(e.target),true);document.addEventListener('click',e=>{const button=e.target.closest('[data-history-page]');if(!button)return;const t=host.task();if(!t)return;capture();const v=view(t.id),r=range(t),direction=button.dataset.historyPage;if(direction==='latest')latest(t);else{const start=direction==='older'?Math.max(0,r.start-PAGE):Math.min(Math.max(0,t.messages.length-PAGE),r.start+PAGE);v.start=t.messages[start]?.id;v.follow=false;if(direction==='newer'){v.anchor=v.start;v.offset=0;}}host.render({restoreHistory:true});});}
  return {init,capture,markup,mounted,latest,reveal,hydrate,restoreDetails,key,range};
})();
