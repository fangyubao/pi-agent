'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const transport=require('./context-transport.js');
test('task plugin reads only enabled current-run metadata, without raw messages',()=>{
  const context={plugins:['task-context'],contexts:[{id:'plugin:task-context',kind:'plugin',actions:['readTaskContext']}],task:{id:'a',name:'当前任务',project:'项目',messageCount:23,messages:[{text:'PRIVATE'}]},memory:{items:[{content:'SECRET'}]}};
  assert.deepEqual(transport.readTaskContext(context),{project:'项目',task:'当前任务',messageCount:23,source:'当前运行任务的元数据快照'});
  assert.throws(()=>transport.readTaskContext(context,{taskId:'b'}),/其他任务/);
  assert.throws(()=>transport.readTaskContext({...context,plugins:[]}),/未.*启用/);
  assert.throws(()=>transport.readTaskContext({...context,contexts:[]}),/未.*启用/);
  assert.doesNotMatch(JSON.stringify(transport.readTaskContext(context)),/PRIVATE|SECRET/);
});
test('compiled context uses edited blocks and excludes raw history',()=>{
  const result=transport.compile({task:{messages:[{role:'assistant',text:'raw'}]},contextOverrides:{includeAttachments:true}},{
    blocks:[
      {id:'conversation:recent',enabled:true,content:'edited recent'},
      {id:'conversation:summary',enabled:true,content:'summary'},
      {id:'request:current',enabled:true,content:'request'},
      {id:'attachments:pending',enabled:false,content:'secret'}
    ]
  },'request',[{name:'x.txt',kind:'text',data:'raw attachment'}]);
  assert.deepEqual(result.context.task.messages,[{role:'user',text:'edited recent'}]);
  assert.equal(result.context.summary,'summary');
  assert.equal(result.message,'request');
  assert.deepEqual(result.attachments,[]);
  assert.doesNotMatch(JSON.stringify(result.context), /raw/);
});
