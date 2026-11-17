'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const transcript=require('./transcript.js');
test('legacy final answers without tool steps still render',()=>{
  const message={text:'旧回复保持可读',run:{status:'complete',hasFinal:true,changedFiles:[]}};
  assert.doesNotThrow(()=>transcript.progressMarkup(message,true,text=>text));
  assert.equal(transcript.copyText(message),'旧回复保持可读');
});
test('legacy interrupted run without steps can be closed safely',()=>{
  const message={text:'已完成部分',run:{status:'running',hasFinal:false}};
  assert.doesNotThrow(()=>transcript.finish(message,'stopped'));
  assert.equal(message.run.status,'stopped');
  assert.match(transcript.progressMarkup(message,true,text=>text),/run-summary/);
});
test('长轮次过程分页可完整遍历，复制保留全部过程，定位旧步骤不会漏掉记录',()=>{
  const message={text:'final answer',run:{status:'complete',steps:Array.from({length:200},(_,i)=>({kind:i%2?'tool':'text',id:'s'+i,label:'tool',status:'done',text:'progress-'+i,target:'file-'+i,output:'result-'+i})),changedFiles:[]}};
  const render=()=>transcript.progressMarkup(message,true,x=>x,{lazy:true});
  const found=new Set();for(let page=0;page<20;page++){const html=render();for(const m of html.matchAll(/progress-(\d+)/g))found.add(Number(m[1]));if(!html.includes('data-process-page="older"'))break;transcript.processPage(message,'older');}
  assert.equal(found.size,100);assert.match(transcript.copyText(message),/progress-0/);assert.match(transcript.copyText(message),/progress-198/);
  transcript.processPage(message,'latest');assert.match(render(),/progress-198/);assert.doesNotMatch(render(),/progress-0</);
  transcript.revealStep(message,'s1');assert.match(render(),/data-group="s1"/);assert.match(transcript.detailMarkup(message,'tools','s1'),/file-1</);
});
