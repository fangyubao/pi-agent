'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { buildModel } = require('./pi-model.cjs');
const recovery = require('./agent-recovery.cjs');
const { waitForRpcReady } = require('./agent-launch.cjs');
test('real Pi RPC retains the session after length and sends the configured output budget', { skip: process.env.PI_WORKBENCH_RPC_TEST !== '1' || !process.env.PI_WORKBENCH_PI_ROOT, timeout: 120000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(process.env.PI_WORKBENCH_PI_ROOT, 'dist/index.js')).href);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw=''; for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const first=requests.length===1,limited=requests.length===2;
    const delta=first?{role:'assistant',tool_calls:[{index:0,id:'read-evidence',type:'function',function:{name:'read',arguments:JSON.stringify({path:'evidence.txt'})}}]}:{role:'assistant',content:limited?'RPC_PARTIAL':'RPC_RECOVERED_OK'};
    for(const choices of [[{index:0,delta,finish_reason:null}],[{index:0,delta:{},finish_reason:first?'tool_calls':limited?'length':'stop'}]])res.write('data: '+JSON.stringify({id:'rpc-local',object:'chat.completion.chunk',model:'local-model',choices})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const dir=await fs.mkdtemp(path.join(path.resolve(__dirname,'..'),'.pi-rpc-test-'));
  await fs.writeFile(path.join(dir,'evidence.txt'),'RPC_SUCCESSFUL_TOOL_PRESERVED');
  const model=buildModel({model:'local-model',effort:'off',contextWindow:65536,maxOutputTokens:12000});
  await fs.writeFile(path.join(dir,'models.json'),JSON.stringify({providers:{'local-recovery':{baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',apiKey:'local-test-key',models:[model]}}}));
  const events=[];
  const client=new sdk.RpcClient({cliPath:path.join(process.env.PI_WORKBENCH_PI_ROOT,'dist/cli.js'),cwd:dir,provider:'local-recovery',model:'local-model',args:['--no-session','--thinking','off','--no-approve','--tools','read'],env:{...process.env,PI_CODING_AGENT_DIR:dir}});
  client.onEvent(e=>events.push(e));
  function nextSettlement(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{off();reject(new Error('Pi settlement timed out'));},20000);const off=client.onEvent(e=>{if(e.type==='agent_settled'){clearTimeout(timer);off();resolve();}});});}
  try {
    const startedAt = Date.now();
    await client.start();await waitForRpcReady(client);await client.setAutoRetry(false);
    console.log('RPC ready in ' + (Date.now() - startedAt) + ' ms');
    let wait=nextSettlement();await client.prompt('完成简短任务');await wait;
    const first=events.findLast(e=>e.type==='message_end'&&e.message.role==='assistant').message;
    assert.equal(first.stopReason,'length');
    const run={lastAssistant:first,tools:[]},failure=recovery.diagnose(run);assert.equal(failure.code,'OUTPUT_LIMIT');
    const pid=client.process.pid;wait=nextSettlement();await client.prompt(recovery.resumePrompt({message:'完成简短任务'},run,failure,{}));await wait;
    assert.equal(client.process.pid,pid);
    assert.equal(requests.length,3);
    assert.match(JSON.stringify(requests[2].messages),/RPC_SUCCESSFUL_TOOL_PRESERVED/);
    assert.doesNotMatch(JSON.stringify(requests[2].messages),/RPC_PARTIAL/);
    for(const request of requests)assert.equal(request.max_completion_tokens||request.max_tokens,12000);
    const last=events.findLast(e=>e.type==='message_end'&&e.message.role==='assistant').message;
    assert.match(recovery.textOf(last),/RPC_RECOVERED_OK/);assert.equal(recovery.diagnose({lastAssistant:last,tools:[]}),null);
  } finally { await client.stop();server.close(); /* Retain isolated test data only, no personal profile deletions. */ }
});
