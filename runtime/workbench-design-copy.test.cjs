'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {forkBuiltin}=require('./workbench-design-copy.cjs'),runtime=require('./workbench-runtime.cjs');
const appRoot=path.resolve(__dirname,'..'),root=path.join(appRoot,'workbenches');
test('内置工作台副本包含独立后端、HTML 设计入口及布局继承，原始源码不变',async()=>{
  const userData=await fs.mkdtemp(path.join(os.tmpdir(),'pi-design-copy-'));
  try{
    const before=await fs.readFile(path.join(root,'qubo','manifest.json'),'utf8');
    const copy=await forkBuiltin({root,appRoot,userData,key:'qubo',state:{_layout:{revision:3,nodes:{'qubo/div[0]':{x:25,y:10}},order:['qubo/div[0]'],titles:{'qubo/div[0]':'主控件'}}}});
    const manifest=JSON.parse(await fs.readFile(path.join(copy.path,'manifest.json'),'utf8'));assert.equal(manifest.ui.entry,'index.html');
    assert.match(await fs.readFile(path.join(copy.path,'ui/index.html'),'utf8'),/layout-runtime.js/);
    const layout=JSON.parse(await fs.readFile(path.join(copy.path,'ui/layout.json'),'utf8'));assert.equal(layout.nodes['preview/main#app/div[0]'].x,25);assert.equal(layout.titles['preview/main#app/div[0]'],'主控件');
    const result=await runtime.dispatchPath(copy.path,{action:'solve'});assert.equal(result.ok,true);assert.match(result.state.result.bits,/^[01]{4}$/);
    assert.equal(await fs.readFile(path.join(root,'qubo','manifest.json'),'utf8'),before);
    for(const key of ['circuit','mcu','workflow']){
      const other=await forkBuiltin({root,appRoot,userData,key});
      const spec=JSON.parse(await fs.readFile(path.join(other.path,'manifest.json'),'utf8'));
      const read=await runtime.dispatchPath(other.path,{action:spec.actions.find(a=>a.access==='read').name});assert.equal(read.ok,true,JSON.stringify(read));
    }
  }finally{runtime.clearCache?.();await fs.rm(userData,{recursive:true,force:true});}
});
test('设计复制拒绝目录越界与设置类入口',async()=>{
  for(const key of ['../qubo','builder','editor'])await assert.rejects(forkBuiltin({root,appRoot,userData:os.tmpdir(),key}));
});
