'use strict';
const {fork}=require('node:child_process'),path=require('node:path'),fs=require('node:fs');
function call(root,operation,...args){return new Promise(resolve=>{
  // PDF parsers may load native libraries. A native crash must not take down
  // Electron, so this boundary is a process, not a worker thread.
  const bundled=process.resourcesPath&&path.join(process.resourcesPath,'runtime','node.exe');
  const child=fork(path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/,'app.asar.unpacked'),'knowledge-index-worker.cjs'),[],{execPath:bundled&&fs.existsSync(bundled)?bundled:process.execPath,windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'',NODE_TEST_CONTEXT:''}});let done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);if(child.connected)child.disconnect();const stop=setTimeout(()=>{if(child.exitCode===null)child.kill();},1000);stop.unref();child.once('exit',()=>clearTimeout(stop));};
  const timer=setTimeout(()=>finish({ok:false,error:'知识库处理超时，请缩小导入范围后重试'}),90000);
  child.once('message',finish);child.once('error',error=>finish({ok:false,error:error.message}));child.once('exit',code=>finish({ok:false,error:'知识库解析进程退出（'+code+'），桌面与原资料已保留；请检查文件格式或改用文本资料。'}));
  child.send({root,operation,args});
});}
module.exports={call};
