'use strict';
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PiResponseLanguage=api;})(typeof window==='object'?window:globalThis,()=>{
  let host=null,busy=false,timer=null;
  function language(settings={},system='zh-CN'){const value=settings.language||'zh-CN';return value==='auto'?(/^zh/i.test(system)?'zh-CN':'en'):value==='en'?'en':'zh-CN';}
  function rule(lang){return lang==='en'?'Use English for all user-visible replies, progress commentary, questions, and final summaries. Keep code, commands, paths, identifiers, and verbatim errors unchanged.':'面向用户的回复、进度说明、提问和最终总结全部使用简体中文。代码、命令、路径、标识符和原始错误保留原文；引用英文错误时在下方说明中文含义。';}
  function needsTranslation(text,lang){const prose=String(text||'').replace(/```[\s\S]*?```/g,'').replace(/`[^`]*`/g,'').replace(/https?:\/\/\S+/g,'');const chinese=(prose.match(/[\u3400-\u9fff]/g)||[]).length,words=(prose.match(/[A-Za-z]{2,}/g)||[]).length;return lang==='en'?chinese>3:words>=4&&chinese<words*.5;}
  function key(text,lang){let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return lang+'-'+(hash>>>0).toString(16)+'-'+text.length;}
  const target=()=>language(host?.settings?.(),typeof navigator==='object'?navigator.language:'zh-CN');
  const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function markup(message,text,render){
    const original=render(text),lang=target();if(!host||host.settings().autoTranslate===false||!needsTranslation(text,lang))return original;
    const id=key(text,lang),entry=message.displayTranslations?.[id];
    const label=lang==='en'?'English translation':'中文翻译';
    const body=entry?.source===text&&entry.status==='done'?render(entry.text):'<p class="translation-status">'+(entry?.status==='error'?esc(entry.error):host.canTranslate()?'正在翻译…':'配置模型后自动翻译')+'</p>';
    return original+'<section class="response-translation" lang="'+lang+'" aria-label="'+label+'"><header><span>'+label+'</span>'+(entry?.status==='error'?'<button type="button" data-action="retry-translation" data-message="'+esc(message.id)+'" data-key="'+id+'">重试</button>':'')+'</header><div>'+body+'</div></section>';
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(()=>void pump(),100);}
  async function pump(){
    if(busy||!host||host.settings().autoTranslate===false||!host.canTranslate())return;
    const lang=target(),batch=[];let size=0;
    for(const message of host.messages().slice(-100)){
      if(message.role!=='assistant')continue;
      const texts=[...(message.run?.steps||[]).filter(s=>s.kind==='text').map(s=>s.text),...(message.run?.status==='running'?[]:[message.text])].filter(Boolean);
      for(const text of texts){if(!needsTranslation(text,lang))continue;const id=key(text,lang),old=message.displayTranslations?.[id];if(old?.source===text&&old.status!=='pending')continue;
        if(batch.length>=6||size+text.length>10000&&batch.length)break;
        if(text.length>10000){message.displayTranslations||={};message.displayTranslations[id]={source:text,status:'error',error:'这段内容较长，暂未自动翻译。'};continue;}
        batch.push({message,id,text});size+=text.length;
      }if(batch.length>=6||size>=10000)break;
    }
    if(!batch.length)return;busy=true;
    for(const item of batch){item.message.displayTranslations||={};item.message.displayTranslations[item.id]={source:item.text,status:'pending'};}
    host.refresh(batch.map(x=>x.message));
    try{
      const r=await host.translate({language:lang,items:batch.map(x=>({id:x.id,text:x.text}))});
      if(!r.ok)throw new Error(r.error||'翻译失败');
      for(const item of batch){const translation=r.items.find(x=>x.id===item.id);if(!translation)throw new Error('翻译结果不完整');item.message.displayTranslations[item.id]={source:item.text,text:translation.text,status:'done'};}
    }catch(error){for(const item of batch)item.message.displayTranslations[item.id]={source:item.text,status:'error',error:'翻译未完成：'+error.message};}
    finally{busy=false;host.save(batch.map(x=>x.message));host.refresh(batch.map(x=>x.message));schedule();}
  }
  function init(options){host=options;new MutationObserver(schedule).observe(document.querySelector('#page'),{childList:true,subtree:true});schedule();}
  function retry(messageId,id){const m=host.messages().find(m=>m.id===messageId);if(m?.displayTranslations)delete m.displayTranslations[id];schedule();}
  return {language,rule,needsTranslation,key,markup,init,retry,schedule};
});
