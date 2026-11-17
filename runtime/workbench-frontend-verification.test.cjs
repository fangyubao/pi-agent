'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {scaffold}=require('./workbench-scaffold.cjs');
const {verifyFrontend}=require('./workbench-frontend-launch.cjs');
const {counter}=require('../tests/fixtures/workbench-ui.cjs');
async function fixture(fn){const base=await fs.mkdtemp(path.join(os.tmpdir(),'pi-ui-verifier-test-'));try{const p=await scaffold(base,{name:'前端验收'});counter(p.path);await fn(p.path,path.join(base,'evidence'));}finally{const resolved=path.resolve(base);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('pi-ui-verifier-test-'))throw new Error('清理路径越界');await fs.rm(resolved,{recursive:true,force:true,maxRetries:3});}}
test('真实页面、实际后端调用和关闭重开全流程通过',()=>fixture(async(root,evidencePath)=>{const r=await verifyFrontend({root,evidencePath});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.cases[0].steps[0].backend[0].action,'updateState');assert.equal(r.controls.find(c=>c.selector==='#increment').exercised,true);assert.ok((await fs.stat(r.cases[0].screenshot.path)).size>100); }));
test('按钮未绑定不能因后端正常而通过；错误含失败控件、页面和截图',()=>fixture(async(root,evidencePath)=>{const file=path.join(root,'ui/index.html');await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace("document.querySelector('#increment').onclick=",'window.unbound='));const r=await verifyFrontend({root,evidencePath});assert.equal(r.ok,false);assert.equal(r.failure.step,1);assert.ok(r.failure.page);assert.ok(r.failure.screenshot.path);assert.equal(r.failure.backend.length,0);}));
test('页面脚本异常、未测控件、后端与页面显示不符分别被拒绝',()=>fixture(async(root,evidencePath)=>{
  const file=path.join(root,'ui/index.html'),original=await fs.readFile(file,'utf8');
  for(const [name,html] of [
    ['脚本异常',original.replace('</body>','<script>throw new Error("UI_BROKEN")</script></body>')],
    ['未测控件',original.replace('</body>','<button id="forgotten">遗漏操作</button></body>')],
    ['显示错误',original.replace("String(e.detail.data?.count||0)","'错误数值'")]
  ]){await fs.writeFile(file,html);const r=await verifyFrontend({root,evidencePath:path.join(evidencePath,name)});assert.equal(r.ok,false,name);if(name==='未测控件')assert.match(r.message,/forgotten/);if(name==='脚本异常')assert.ok(r.failure.page.errors.some(e=>e.message.includes('UI_BROKEN')));}
}));
test('空白模板与伪验收（点击后只断言按钮可见）不能通过',()=>fixture(async(root,evidencePath)=>{
  const file=path.join(root,'tests/ui-scenarios.json');await fs.writeFile(file,JSON.stringify({schema:1,cases:[]}));assert.equal((await verifyFrontend({root,evidencePath})).ok,false);
  await fs.writeFile(path.join(root,'ui/index.html'),'<html><body><button id="noop">无动作</button></body></html>');
  await fs.writeFile(file,JSON.stringify({schema:1,cases:[{name:'伪验收',steps:[{operation:'click',selector:'#noop',expect:{ui:[{selector:'#noop',visible:true}]}}],afterReopen:[{selector:'#noop',visible:true}]}]}));
  const r=await verifyFrontend({root,evidencePath});assert.equal(r.ok,false);assert.match(r.message,/没有可验证的效果/);
}));
test('文本、选项、勾选、键盘和画布拖拽都经过真实页面；结果重开恢复',()=>fixture(async(root,evidencePath)=>{
  await fs.writeFile(path.join(root,'ui/index.html'),`<html><body><input id="name"><select id="choice"><option value="a">A</option><option value="b">B</option></select><input id="check" type="checkbox"><input id="key"><canvas id="canvas" width="300" height="150" style="border:1px solid"></canvas><output id="drag">0</output><output id="saved">0</output><script>
  let downs=false;canvas.onpointerdown=()=>downs=true;canvas.onpointerup=()=>{if(downs){drag.textContent='1';downs=false;}};
  key.onkeydown=async e=>{if(e.key==='Enter')await __wbTransport('updateState',{baseRevision:__wbState.revision||0,patch:{saved:true}})};
  window.addEventListener('workbench-state',e=>saved.textContent=e.detail.data?.saved?'1':'0');
  </script></body></html>`);
  const steps=[{operation:'fill',selector:'#name',value:'输入测试',expect:{ui:[{selector:'#name',value:'输入测试'}]}},{operation:'select',selector:'#choice',value:'b',expect:{ui:[{selector:'#choice',value:'b'}]}},{operation:'check',selector:'#check',checked:true,expect:{ui:[{selector:'#check',checked:true}]}},{operation:'drag',selector:'#canvas',from:{x:.2,y:.2},to:{x:.8,y:.8},expect:{ui:[{selector:'#drag',text:'1'}]}},{operation:'press',selector:'#key',key:'Enter',expect:{actions:['updateState'],state:{'data.saved':true},ui:[{selector:'#saved',text:'1'}]}}];
  await fs.writeFile(path.join(root,'tests/ui-scenarios.json'),JSON.stringify({schema:1,cases:[{name:'全部输入类型',steps,afterReopen:[{selector:'#saved',text:'1'}]}]}));
  const r=await verifyFrontend({root,evidencePath});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.controls.length,5);
}));
