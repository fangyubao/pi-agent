'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createPairingServer } = require('./agent-pairing-server.cjs');

test('HTTP 配对注册与自包含 Connect 包写入：极简提示词指向 CONNECT.md，含完整 MCP 部署文件', async () => {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-connect-bundle-'));
  const registered = [];
  const srv = createPairingServer({
    bundleDir,
    async onRegister(payload, meta) {
      registered.push({ payload, meta });
      return {
        profileId: 'agent-pair-1',
        name: payload.name,
        agentTransport: payload.agentTransport,
        capabilities: { chat: true, workflow: true, workbench: false, maxConcurrency: 3, mode: 'probed' }
      };
    }
  });
  try {
    const info = await srv.startSession({ rotateToken: true });
    assert.ok(fs.existsSync(path.join(bundleDir, 'CONNECT.md')));
    assert.ok(fs.existsSync(path.join(bundleDir, 'pairing.json')));
    assert.ok(fs.existsSync(path.join(bundleDir, 'mcp-config.json')));
    assert.ok(fs.existsSync(path.join(bundleDir, 'mcp-server.cjs')));
    // 提示词极简：直接让源 Agent 读取本地 CONNECT.md 与附属 MCP 包
    assert.ok(info.prompt.includes('CONNECT.md'));
    assert.ok(info.prompt.split('\n').length <= 6);
    const guideText = fs.readFileSync(path.join(bundleDir, 'CONNECT.md'), 'utf8');
    assert.ok(guideText.includes('前置过滤'));
    assert.ok(guideText.includes(info.mcpUrl));
    assert.ok(guideText.includes(info.registerUrl));

    const denied = await fetch(info.registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ name: 'Bad' })
    });
    assert.equal(denied.status, 401);

    const okRes = await fetch(info.registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + info.token },
      body: JSON.stringify({ name: 'OpenClaw 自接入', agentTransport: 'openclaw-gateway', baseUrl: 'ws://127.0.0.1:18789', models: ['main'] })
    });
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.profileId, 'agent-pair-1');
    assert.equal(registered.length, 1);
    assert.equal(registered[0].meta.viaMcp, false);
    assert.equal(srv.getInfo().state.status, 'connected');
    assert.equal(srv.getInfo().state.profileId, 'agent-pair-1');
  } finally {
    await srv.close();
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});

test('部署 Connect 目录生成的 mcp-config.json：stdio MCP 过滤 + 注册 + 在线接力任务收发', async () => {
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-connect-mcp-'));
  const srv = createPairingServer({
    bundleDir,
    async onRegister(payload) {
      return {
        profileId: 'relay-1',
        name: payload.name,
        agentTransport: payload.agentTransport,
        capabilities: { chat: true, workflow: true, workbench: true, maxConcurrency: 1, mode: 'probed' }
      };
    }
  });
  try {
    await srv.startSession();
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(bundleDir, 'mcp-config.json'), 'utf8'));
    const entry = mcpCfg.mcpServers['pi-workbench-connect'];
    const child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...(entry.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const pending = new Map();
    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) {
          const resolve = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = 'rpc_' + Math.random().toString(36).slice(2, 8);
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.delete(id)) reject(new Error('rpc timeout: ' + method)); }, 10000);
    });

    try {
      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } });
      assert.equal(init.result.serverInfo.name, 'pi-workbench-onboarding');

      const tools = await rpc('tools/list', {});
      assert.ok(tools.result.tools.some(t => t.name === 'pi_workbench_register_agent'));
      assert.ok(tools.result.tools.some(t => t.name === 'pi_workbench_await_task'));

      const rejected = await rpc('tools/call', { name: 'pi_workbench_check_compatibility', arguments: { hasMcp: false, hasShellOrHttp: false, hasDirectEntry: false } });
      assert.equal(JSON.parse(rejected.result.content[0].text).eligible, false);

      const accepted = await rpc('tools/call', { name: 'pi_workbench_check_compatibility', arguments: { hasMcp: true } });
      assert.equal(JSON.parse(accepted.result.content[0].text).eligible, true);

      const reg = await rpc('tools/call', { name: 'pi_workbench_register_agent', arguments: { name: 'WorkBuddy MCP Relay', agentTransport: 'mcp-relay', models: ['relay-main'] } });
      const regData = JSON.parse(reg.result.content[0].text);
      assert.equal(regData.ok, true);
      assert.equal(regData.profileId, 'relay-1');

      const awaitPromise = rpc('tools/call', { name: 'pi_workbench_await_task', arguments: { profileId: 'relay-1', timeoutMs: 8000 } });
      await new Promise(r => setTimeout(r, 30));
      const dispatchPromise = srv.dispatchRelayTask('relay-1', { system: 'sys', user: 'hello relay', mode: 'chat', timeoutMs: 10000 });
      const awaited = await awaitPromise;
      const taskObj = JSON.parse(awaited.result.content[0].text);
      assert.equal(taskObj.idle, false);
      assert.equal(taskObj.task.user, 'hello relay');

      await rpc('tools/call', { name: 'pi_workbench_submit_result', arguments: { profileId: 'relay-1', requestId: taskObj.task.requestId, text: 'RELAY_ANSWER_OK' } });
      const finalOut = await dispatchPromise;
      assert.equal(finalOut.text, 'RELAY_ANSWER_OK');
    } finally {
      child.kill();
    }
  } finally {
    await srv.close();
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
});


test('模型更新支持 HTTP 和 MCP，错误令牌不能更新', async () => {
  const updates=[];
  const srv=createPairingServer({onUpdateModels:async p=>{updates.push(p);return {profileId:p.profileId,count:p.models.length};}});
  try {
    const info=await srv.startSession();
    const post=(url,body,token=info.token)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
    const payload={profileId:'relay-1',models:['model-a','model-b']};
    assert.equal((await post(info.baseUrl+'/pair/update-models',payload,'wrong')).status,401);
    assert.equal(updates.length,0);
    assert.equal((await (await post(info.baseUrl+'/pair/update-models',payload)).json()).count,2);
    const rpc=await (await post(info.mcpUrl,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'pi_workbench_update_models',arguments:payload}})).json();
    assert.equal(JSON.parse(rpc.result.content[0].text).count,2);
    assert.equal(updates.length,2);
  } finally {await srv.close();}
});
