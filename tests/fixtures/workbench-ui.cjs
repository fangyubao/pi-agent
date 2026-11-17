'use strict';
const fs=require('node:fs');
const path=require('node:path');
function counter(root){
  fs.writeFileSync(path.join(root,'ui/index.html'),`<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><h1>可验收计数器</h1><button id="increment">增加计数</button><output id="value">0</output><script>
    window.addEventListener('workbench-state',e=>document.querySelector('#value').textContent=String(e.detail.data?.count||0));
    document.querySelector('#increment').onclick=async()=>{const s=window.__wbState||{};await window.__wbTransport('updateState',{baseRevision:s.revision||0,patch:{count:(s.data?.count||0)+1}});};
  </script></body></html>`);
  scenario(root,{selector:'#increment',output:'#value',state:{'data.count':1},text:'1',actions:['updateState']});
}
function scenario(root,{selector='#run',output='#out',state={'data.ran':true},text,contains='"ran":true',actions=['updateState']}={}){
  const ui={selector:output,...(text===undefined?{contains}:{text})};
  fs.writeFileSync(path.join(root,'tests/ui-scenarios.json'),JSON.stringify({schema:1,initialState:{revision:0,data:{}},cases:[{name:'用户操作、后端响应与重新打开',steps:[{operation:'click',selector,expect:{actions,state,ui:[ui]}}],afterReopen:[ui]}]},null,2));
}
function restoreOutput(root,selector='#out'){
  const file=path.join(root,'ui/index.html'),source=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,source+'<script>window.addEventListener("workbench-state",e=>{document.querySelector('+JSON.stringify(selector)+').textContent=JSON.stringify({state:e.detail})});</script>');
}
module.exports={counter,scenario,restoreOutput};
