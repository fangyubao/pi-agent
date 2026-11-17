'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {createVault,encodeProject,decodeProject}=require('./local-vault.cjs');
const {scaffold}=require('./workbench-scaffold.cjs');
const {execute}=require('./workbench-worker-host.cjs');
const root=path.join(__dirname,'..','workbenches');
test('Worker action preserves layout and knowledge and rejects invalid writes',async()=>{
  const state={revision:2,_layout:{revision:3,nodes:{x:{x:4}}},knowledge:{roots:['local'],readCount:1,files:[{id:'a',content:'完整资料，不能被 readDraft 删除'}]},promptDraft:'old'};
  const draft=await execute(root,{key:'builder',action:'readDraft',state});
  assert.equal(draft.ok,true);assert.equal(draft.state.knowledge.files[0].content,state.knowledge.files[0].content);
  assert.deepEqual(draft.state._layout,state._layout);assert.equal(draft.result.knowledge,undefined);
  const update=await execute(root,{key:'builder',action:'setKnowledgePrompt',state:draft.state,payload:{baseRevision:2,prompt:'new'}});
  assert.equal(update.state.promptDraft,'new');assert.equal(update.state.knowledge.files[0].content,state.knowledge.files[0].content);
  const invalid=await execute(root,{key:'qubo',action:'setMatrix',state:{},payload:{matrix:[[1]]}});
  assert.equal(invalid.ok,false);
  const bell=await execute(root,{key:'circuit',action:'applyPreset',state:{},payload:{kind:'bell'}});
  const simulated=await execute(root,{key:'circuit',action:'runSimulation',state:bell.state});
  assert.equal(simulated.state.probabilities.length,2);assert.ok(Math.abs(simulated.state.probabilities[0].probability-.5)<1e-10);
});
test('Full snapshot roundtrip, bounded history, encrypted project export and restore',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-vault-test-'));
  try{
    const vault=createVault(dir),original={html:'x'.repeat(160000),knowledge:{files:[{content:'全量正文'}]},revision:1};
    await vault.record({taskId:'t',key:'mcu',state:original,source:'ui'});
    const history=await vault.list('t');assert.equal((await vault.get('t',history[0].id)).state.html.length,160000);
    const project={id:'p',name:'完整项目',tasks:[{id:'t',messages:[],workbenches:{mcu:original}}]};
    for(let i=0;i<7;i++)await vault.backup({...project,name:'v'+i});
    const before=await vault.backups('p');assert.equal(before.length,5);
    const stable={id:'stable',name:'stable',tasks:[]};await vault.backup(stable,{ifChanged:true,fingerprint:'same'});await vault.backup(stable,{ifChanged:true,fingerprint:'same'});
    assert.equal((await vault.backups('stable')).length,1);
    const backups=await vault.backups('p');assert.equal(backups.length,5);
    assert.equal((await vault.restore('p',backups[0].id)).name,'v6');
    const data=await encodeProject(project,'test-password');assert.ok(!data.includes('全量正文'));
    assert.deepEqual(await decodeProject(data,'test-password'),project);
    await assert.rejects(()=>decodeProject(data,'incorrect'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Generated backend runs with Node alone and handles revision conflicts',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-scaffold-test-'));
  try{
    const pkg=await scaffold(dir,{name:'独立工程'});
    const api=require(path.join(pkg.path,'server/index.cjs'));
    const first=await api.dispatch({action:'updateState',payload:{baseRevision:0,patch:{value:7}}});
    assert.equal(first.state.data.value,7);
    const child=spawn(process.execPath,[path.join(pkg.path,'server/transport/stdio.cjs')],{cwd:pkg.path,windowsHide:true});
    const output=await new Promise((resolve,reject)=>{let text='';child.stdout.on('data',d=>text+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve(text):reject(new Error('exit '+code)));child.stdin.end(JSON.stringify({id:'read',action:'readState'})+'\n');});
    assert.equal(JSON.parse(output).ok,true);
    await assert.rejects(()=>api.dispatch({action:'updateState',state:first.state,payload:{baseRevision:0,patch:{}}}),/Revision conflict/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
