'use strict';
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { resolveCommand } = require('./mcp-client.cjs');
const { buildCall } = require('./provider-call.cjs');
const { isExternalAgent, normalizeCapabilities } = require('./provider-capabilities.js');

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function normalizeWsUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('请填写 Gateway 地址（如 ws://127.0.0.1:18789）');
  let uri;
  try { uri = new URL(input); } catch { throw new Error('Gateway 地址格式无效：' + input); }
  if (uri.username || uri.password) throw new Error('Gateway 地址不能内嵌账号密码');
  if (uri.protocol === 'http:') uri.protocol = 'ws:';
  else if (uri.protocol === 'https:') uri.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(uri.protocol)) throw new Error('Gateway 地址必须使用 ws://、wss://、http:// 或 https://');
  const queryToken = uri.searchParams.get('token') || '';
  if (uri.searchParams.has('token')) uri.searchParams.delete('token');
  return { url: uri.toString(), queryToken };
}

function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return process.platform || 'linux';
}

function extractOpenClawText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('');
  }
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

async function openClawExchange({
  gatewayUrl,
  token = '',
  agentId = 'main',
  sessionKey,
  prompt,
  thinking = 'off',
  timeoutMs = 60000,
  signal,
  onDelta,
  WebSocketImpl = globalThis.WebSocket
}) {
  if (typeof WebSocketImpl !== 'function') throw new Error('当前运行时不支持 WebSocket');
  const parsed = normalizeWsUrl(gatewayUrl);
  const authToken = String(token || parsed.queryToken || '').trim();
  const targetSession = String(sessionKey || `agent:${agentId || 'main'}:main`);
  const messageText = String(prompt || '').trim();
  if (!messageText) throw new Error('消息内容不能为空');

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let challengeTimer = null;
    let connectSent = false;
    let connectId = '';
    let chatReqId = '';
    let activeRunId = '';
    let accumulated = '';
    let timeoutTimer = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (challengeTimer) clearTimeout(challengeTimer);
      signal?.removeEventListener('abort', onAbort);
      try { if (ws && ws.readyState <= 1) ws.close(); } catch {}
    };

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const onAbort = () => done(reject, Object.assign(new Error('已停止'), { name: 'AbortError' }));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });

    timeoutTimer = setTimeout(() => {
      done(reject, new Error('OpenClaw Gateway 响应超时'));
    }, Math.max(2000, Number(timeoutMs) || 60000));

    const sendJson = obj => {
      if (!ws || ws.readyState !== 1) throw new Error('Gateway WebSocket 未连接');
      ws.send(JSON.stringify(obj));
    };

    const sendConnect = () => {
      if (connectSent) return;
      connectSent = true;
      if (challengeTimer) { clearTimeout(challengeTimer); challengeTimer = null; }
      connectId = 'conn-' + crypto.randomUUID().slice(0, 8);
      sendJson({
        type: 'req',
        id: connectId,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: 'gateway-client', version: '1.0.0', platform: platformName(), mode: 'ui' },
          role: 'operator',
          scopes: ['operator.read', 'operator.write'],
          locale: 'zh-CN',
          ...(authToken ? { auth: { token: authToken } } : {})
        }
      });
    };

    const sendChat = () => {
      chatReqId = 'chat-' + crypto.randomUUID().slice(0, 8);
      sendJson({
        type: 'req',
        id: chatReqId,
        method: 'chat.send',
        params: {
          message: messageText,
          sessionKey: targetSession,
          idempotencyKey: 'piwb-' + crypto.randomUUID(),
          thinking: ['minimal', 'low', 'medium', 'high'].includes(thinking) ? thinking : 'off'
        }
      });
    };

    try {
      ws = new WebSocketImpl(parsed.url);
    } catch (err) {
      done(reject, new Error('无法创建 WebSocket 连接：' + err.message));
      return;
    }

    const onOpen = () => {
      challengeTimer = setTimeout(() => {
        try { sendConnect(); } catch (err) { done(reject, err); }
      }, 400);
    };

    const onError = evt => {
      const msg = evt?.message || evt?.error?.message || 'Gateway 连接错误';
      done(reject, new Error(String(msg)));
    };

    const onClose = evt => {
      if (!settled) {
        done(reject, new Error(`Gateway 连接已关闭 (${evt?.code || 1000}${evt?.reason ? ': ' + evt.reason : ''})`));
      }
    };

    const onMessage = evt => {
      let msg;
      try {
        const text = typeof evt?.data === 'string' ? evt.data : Buffer.isBuffer(evt?.data) ? evt.data.toString('utf8') : String(evt?.data || '');
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const { type, event, payload, id, error } = msg;

      if (type === 'event' && event === 'connect.challenge') {
        try {
          connectSent = false; // allow responding cleanly to server challenge nonce
          sendConnect();
        } catch (err) {
          done(reject, err);
        }
        return;
      }

      if (type === 'res' || type === 'auth.success' || type === 'auth.failed') {
        if (type === 'auth.failed' || error) {
          const errText = typeof error === 'string' ? error : error?.message || JSON.stringify(error);
          done(reject, new Error('Gateway 鉴权或请求失败：' + errText));
          return;
        }
        if (type === 'auth.success' || (id && id === connectId)) {
          try { sendChat(); } catch (err) { done(reject, err); }
          return;
        }
        if (id && id === chatReqId && msg.result?.runId) {
          activeRunId = String(msg.result.runId);
        }
        return;
      }

      if (type === 'error' || event === 'error') {
        done(reject, new Error(String(msg.error || msg.message || payload?.error || 'Gateway 返回错误')));
        return;
      }

      if (type === 'event' && event === 'agent' && payload) {
        if (payload.sessionKey && payload.sessionKey !== targetSession && activeRunId && payload.runId !== activeRunId) return;
        if (payload.stream === 'assistant' && typeof payload.data?.delta === 'string') {
          if (!activeRunId && payload.runId) activeRunId = String(payload.runId);
          accumulated += payload.data.delta;
          onDelta?.(payload.data.delta);
        } else if (payload.stream === 'assistant' && typeof payload.data?.text === 'string' && !accumulated && !payload.data.text.startsWith('HEARTBEAT')) {
          accumulated = payload.data.text;
          onDelta?.(accumulated);
        }
        return;
      }

      if (type === 'event' && event === 'chat' && payload) {
        if (payload.sessionKey && payload.sessionKey !== targetSession) return;
        if (payload.state === 'error') {
          done(reject, new Error(String(payload.errorMessage || payload.error || 'Agent 执行错误')));
          return;
        }
        if (payload.state === 'final' || payload.state === 'completed') {
          const finalText = extractOpenClawText(payload.message) || accumulated;
          done(resolve, { text: finalText, usage: payload.usage || null, sessionKey: targetSession });
          return;
        }
        return;
      }

      // 兼容简化响应包
      if (type === 'response.chunk') {
        const delta = String(msg.chunk ?? msg.content ?? '');
        if (delta) { accumulated += delta; onDelta?.(delta); }
      } else if (type === 'response.complete') {
        const finalText = String(msg.content ?? '') || accumulated;
        done(resolve, { text: finalText, usage: null, sessionKey: targetSession });
      }
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    } else {
      ws.onopen = onOpen;
      ws.onerror = onError;
      ws.onclose = onClose;
      ws.onmessage = onMessage;
    }
  });
}

function parseArgsList(raw) {
  if (Array.isArray(raw)) return raw.map(x => String(x)).filter(x => x.length > 0);
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(x => String(x));
    } catch {}
  }
  return text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function resolveCliExecutable(bin) {
  const cmd = String(bin || '').trim();
  if (process.platform !== 'win32' || !cmd || /[\\/]/.test(cmd) || /\.[A-Za-z0-9]{1,8}$/.test(cmd)) return cmd;
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fsSync.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return cmd;
}

function parseCliStreamChunk(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return { delta: trimmed + '\n', json: false };
  try {
    const obj = JSON.parse(trimmed);
    if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') return { delta: obj.delta.text, json: true };
    if (obj.type === 'message_update' && obj.assistantMessageEvent?.type === 'text_delta') return { delta: String(obj.assistantMessageEvent.delta || ''), json: true };
    if (obj.type === 'text' && typeof obj.part?.text === 'string') return { delta: obj.part.text, json: true };
    if (typeof obj.delta === 'string') return { delta: obj.delta, json: true };
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      return { final: obj.message.content.filter(c => c.type === 'text').map(c => c.text).join(''), json: true };
    }
    if (obj.type === 'result' && typeof obj.result === 'string') return { final: obj.result, json: true };
    if (typeof obj.text === 'string') return { final: obj.text, json: true };
    if (obj.type === 'error' && obj.error) throw new Error(typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error));
    if (obj.error) throw new Error(typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error));
    return { json: true };
  } catch (err) {
    if (err.message && !/JSON/i.test(err.message)) throw err;
    return { delta: trimmed + '\n', json: false };
  }
}

async function cliExchange({
  command,
  args = [],
  promptMode = 'stdin',
  mcpSupport = 'mcp-config',
  mcpEnv = null,
  extraEnv = {},
  cwd,
  system = '',
  user = '',
  model = '',
  approval = 'ask',
  timeoutMs = 60000,
  signal,
  onDelta,
  nodePath = process.execPath
}) {
  const bin = String(command || '').trim();
  if (!bin) throw new Error('请填写本地 CLI 启动命令');
  const combinedPrompt = system ? `${system}\n\n${user}` : String(user || '');
  let tempDir = '';
  let mcpConfigFile = '';
  try {
    if (mcpEnv && mcpSupport !== 'none') {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ext-cli-'));
      mcpConfigFile = path.join(tempDir, 'mcp-config.json');
      const serverScript = path.join(__dirname, 'workbench-mcp-server.cjs').replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
      const mcpCommand = nodePath || process.execPath;
      const runAsNode = /electron(\.exe)?$|pi[\s-]*workbench/i.test(path.basename(mcpCommand));
      await fs.writeFile(mcpConfigFile, JSON.stringify({
        mcpServers: {
          'pi-workbench': {
            command: mcpCommand,
            args: [serverScript],
            env: { ...mcpEnv, ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
          }
        }
      }, null, 2), 'utf8');
    }

    const argTemplate = parseArgsList(args);
    let injectedPromptInArgs = false;
    const replacements = {
      '{prompt}': combinedPrompt,
      '{system}': String(system || ''),
      '{user}': String(user || ''),
      '{model}': String(model || ''),
      '{workspace}': String(cwd || process.cwd()),
      '{mcpConfig}': mcpConfigFile,
      '{approval}': String(approval || 'ask')
    };
    const finalArgs = [];
    for (let i = 0; i < argTemplate.length; i++) {
      const item = argTemplate[i];
      if ((item === '-m' || item === '--model') && argTemplate[i + 1] === '{model}' && (!model || model === 'main')) {
        i++;
        continue;
      }
      if (item === '{prompt}' || item === '{user}') injectedPromptInArgs = true;
      let val = item;
      for (const [k, v] of Object.entries(replacements)) {
        if (val.includes(k)) {
          if (k === '{mcpConfig}' && !v) { val = ''; break; }
          val = val.split(k).join(v);
        }
      }
      if (val !== '') finalArgs.push(val);
    }
    if (!injectedPromptInArgs && promptMode === 'arg') finalArgs.push(combinedPrompt);

    const resolvedBin = resolveCliExecutable(bin);
    let openCodeConfigEnv = {};
    if (mcpEnv && mcpSupport !== 'none' && /opencode/i.test(path.basename(resolvedBin))) {
      const serverScript = path.join(__dirname, 'workbench-mcp-server.cjs').replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
      const mcpCommand = nodePath || process.execPath;
      const runAsNode = /electron(\.exe)?$|pi[\s-]*workbench/i.test(path.basename(mcpCommand));
      let baseOc = {};
      try { if (process.env.OPENCODE_CONFIG_CONTENT) baseOc = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); } catch {}
      openCodeConfigEnv = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...baseOc,
          mcp: {
            ...(baseOc.mcp || {}),
            'pi-workbench': {
              type: 'local',
              command: [mcpCommand, serverScript],
              enabled: true,
              environment: { ...mcpEnv, ...(runAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
            }
          }
        })
      };
    }

    const run = resolveCommand(resolvedBin, finalArgs);
    const childEnv = {
      ...process.env,
      ...extraEnv,
      ...(mcpEnv || {}),
      ...openCodeConfigEnv,
      ...(mcpConfigFile ? { PI_WORKBENCH_MCP_CONFIG: mcpConfigFile } : {}),
      ...(model ? { PI_EXTERNAL_AGENT_MODEL: String(model) } : {})
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    return await new Promise((resolve, reject) => {
      let settled = false;
      let stdoutAll = '';
      let jsonText = '';
      let jsonFinal = '';
      let sawStructuredJson = false;
      let lineBuf = '';
      let stderrTail = '';
      let timer = null;

      const child = spawn(run.file, run.args, {
        cwd: cwd || process.cwd(),
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: run.windowsVerbatimArguments
      });

      const killChild = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          try { child.kill('SIGKILL'); } catch {}
        }
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

      const onAbort = () => {
        killChild();
        finish(reject, Object.assign(new Error('已停止'), { name: 'AbortError' }));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        killChild();
        finish(reject, new Error('外部 CLI Agent 执行超时'));
      }, Math.max(3000, Number(timeoutMs) || 60000));

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutAll += chunk;
        lineBuf += chunk;
        let idx;
        while ((idx = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, idx);
          lineBuf = lineBuf.slice(idx + 1);
          try {
            const parsed = parseCliStreamChunk(line);
            if (!parsed) continue;
            if (parsed.json) {
              sawStructuredJson = true;
              if (parsed.delta) { jsonText += parsed.delta; onDelta?.(parsed.delta); }
              if (parsed.final) jsonFinal = parsed.final;
            } else if (parsed.delta) {
              onDelta?.(parsed.delta);
            }
          } catch (err) {
            killChild();
            finish(reject, err);
            return;
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-3000); });
      child.once('error', err => finish(reject, new Error('无法启动外部 CLI：' + err.message)));
      child.once('close', code => {
        if (lineBuf.trim()) {
          try {
            const parsed = parseCliStreamChunk(lineBuf);
            if (parsed?.json) {
              sawStructuredJson = true;
              if (parsed.delta) { jsonText += parsed.delta; onDelta?.(parsed.delta); }
              if (parsed.final) jsonFinal = parsed.final;
            } else if (parsed?.delta) {
              onDelta?.(parsed.delta);
            }
          } catch (err) {
            finish(reject, err);
            return;
          }
        }
        if (code !== 0) {
          finish(reject, new Error(`外部 CLI 退出异常 (code ${code})${stderrTail ? '：' + stderrTail.trim().slice(-400) : ''}`));
          return;
        }
        const text = (sawStructuredJson ? (jsonFinal || jsonText) : stdoutAll).trim();
        finish(resolve, { text, usage: null });
      });

      if (!injectedPromptInArgs && promptMode !== 'arg') {
        child.stdin.write(combinedPrompt);
      }
      child.stdin.end();
    });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function exchange(cfg, { system = '', user = '', sessionKey, thinking, maxTokens = 2000, timeoutMs = 60000, signal, onDelta, mcpEnv, cwd, approval = 'ask', mode = 'chat', relayDispatch } = {}) {
  const transport = cfg?.agentTransport || cfg?.provider;
  const fullPrompt = system ? `${system}\n\n${user}` : String(user || '');
  if (transport === 'mcp-relay') {
    if (typeof relayDispatch !== 'function') throw new Error('MCP 在线接力调度器未就绪');
    const out = await relayDispatch(cfg.profileId || cfg.id, { system, user, model: cfg.model || '', mode, timeoutMs, signal });
    if (out?.text && onDelta) onDelta(out.text);
    return out;
  }
  if (transport === 'openclaw-gateway') {
    const runOnce = () => {
      let emitted = false;
      return openClawExchange({
        gatewayUrl: cfg.baseUrl,
        token: cfg.apiKey || '',
        agentId: cfg.model || 'main',
        sessionKey: sessionKey || `agent:${cfg.model || 'main'}:main`,
        prompt: fullPrompt,
        thinking: thinking || cfg.effort || 'off',
        timeoutMs,
        signal,
        onDelta: d => { emitted = true; onDelta?.(d); }
      }).catch(err => { err._emittedDelta = emitted; throw err; });
    };
    try {
      return await runOnce();
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' || err?._emittedDelta) throw err;
      await new Promise(r => setTimeout(r, 300));
      if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      return runOnce();
    }
  }
  if (transport === 'external-cli') {
    return cliExchange({
      command: cfg.command,
      args: cfg.args,
      promptMode: cfg.promptMode || 'stdin',
      mcpSupport: cfg.mcpSupport || 'mcp-config',
      mcpEnv,
      cwd,
      system,
      user,
      model: cfg.model || '',
      approval,
      timeoutMs,
      signal,
      onDelta
    });
  }
  throw new Error('不支持的外部 Agent 协议：' + String(transport || '未知'));
}

async function startProbeCallbackServer() {
  const token = crypto.randomBytes(16).toString('hex');
  const hits = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/probe-ping') {
      res.writeHead(404); res.end('not found'); return;
    }
    let raw = ''; for await (const c of req) raw += c;
    try {
      const body = JSON.parse(raw || '{}');
      if (body.token !== token) { res.writeHead(403); res.end('forbidden'); return; }
      hits.add(String(body.nonce || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, nonce: body.nonce }));
    } catch {
      res.writeHead(400); res.end('bad request');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    token,
    hasNonce: nonce => hits.has(String(nonce)),
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

async function probeApiToolCalling(cfg, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const nonce = 'wbp_' + crypto.randomBytes(4).toString('hex');
  const reqSpec = buildCall(cfg, {
    system: 'You must call the workbench_probe_ping tool with the exact nonce from the user message. Do not answer only with plain text.',
    user: `Call workbench_probe_ping with nonce="${nonce}".`,
    maxTokens: 256,
    json: false,
    temperature: 0
  });
  const body = { ...reqSpec.body };
  const kind = cfg.provider;
  if (kind === 'anthropic') {
    body.tools = [{ name: 'workbench_probe_ping', description: 'Capability probe ping', input_schema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } }];
    body.tool_choice = { type: 'auto' };
  } else if (kind === 'gemini') {
    body.tools = [{ functionDeclarations: [{ name: 'workbench_probe_ping', description: 'Capability probe ping', parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } }] }];
  } else if (kind === 'openai-responses') {
    body.tools = [{ type: 'function', name: 'workbench_probe_ping', description: 'Capability probe ping', parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } }];
  } else {
    body.tools = [{ type: 'function', function: { name: 'workbench_probe_ping', description: 'Capability probe ping', parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } } }];
  }

  const res = await fetchImpl(reqSpec.url, { method: 'POST', headers: reqSpec.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { ok: false, reason: `工具调用请求被拒绝 (HTTP ${res.status})` };
  const payload = await res.json().catch(() => ({}));

  if (kind === 'anthropic') {
    const called = Array.isArray(payload?.content) && payload.content.some(b => b?.type === 'tool_use' && b?.name === 'workbench_probe_ping');
    return called ? { ok: true, reason: '模型正确返回 tool_use 工具调用' } : { ok: false, reason: '模型仅返回文本，未触发 tool_use 工具调用' };
  }
  if (kind === 'gemini') {
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    const called = parts.some(p => p?.functionCall?.name === 'workbench_probe_ping');
    return called ? { ok: true, reason: '模型正确返回 Gemini functionCall' } : { ok: false, reason: '模型未触发 Gemini functionCall' };
  }
  if (kind === 'openai-responses') {
    const called = Array.isArray(payload?.output) && payload.output.some(i => i?.type === 'function_call' && i?.name === 'workbench_probe_ping');
    return called ? { ok: true, reason: '模型正确返回 Responses function_call' } : { ok: false, reason: '模型未触发 Responses function_call' };
  }
  if (kind === 'ollama') {
    const called = Array.isArray(payload?.message?.tool_calls) && payload.message.tool_calls.some(t => t?.function?.name === 'workbench_probe_ping');
    return called ? { ok: true, reason: '模型支持 Ollama tool_calls' } : { ok: false, reason: '模型未返回 Ollama tool_calls' };
  }
  const tc = payload?.choices?.[0]?.message?.tool_calls;
  const called = Array.isArray(tc) && tc.some(t => t?.function?.name === 'workbench_probe_ping');
  return called ? { ok: true, reason: '模型支持 OpenAI tool_calls，可执行工作台动作' } : { ok: false, reason: '未返回 tool_calls，可能不支持工作台工具调用' };
}

async function probeApiVision(cfg, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    const reqSpec = buildCall(cfg, {
      system: 'Reply briefly with OK.',
      user: 'Confirm you can see the image by replying OK.',
      maxTokens: 64,
      json: false,
      temperature: 0,
      images: [{ mime: 'image/png', base64: TINY_PNG_BASE64 }]
    });
    const res = await fetchImpl(reqSpec.url, { method: 'POST', headers: reqSpec.headers, body: JSON.stringify(reqSpec.body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, reason: `接口不支持传图 (HTTP ${res.status})` };
    return { ok: true, reason: '支持多模态图片输入' };
  } catch (err) {
    return { ok: false, reason: '传图探测失败：' + err.message };
  }
}

async function probeCapabilities(cfg, { callModelImpl, probeImpl, relayOnline, timeoutMs = 25000 } = {}) {
  const checks = {};
  const external = isExternalAgent(cfg);

  if (cfg?.agentTransport === 'mcp-relay') {
    const online = typeof relayOnline === 'function' ? Boolean(relayOnline(cfg.profileId || cfg.id)) : Boolean(cfg?.capabilities?.chat);
    checks.chat = online ? '源 Agent 已通过本地 MCP 在线接力接入' : '源 Agent 当前处于离线待连接状态';
    checks.workflow = 'MCP 在线接力模式支持工作流串行调度（并发上限 1）';
    checks.workbench = '源 Agent 通过同一 MCP 会话即可访问 workbench_action 工作台工具';
    checks.vision = '外部 MCP 接力默认按文本上下文处理';
    return {
      ok: online,
      ...(online ? {} : { error: 'MCP 在线接力当前未检测到源 Agent 活跃轮询，请先在源 Agent 中启动轮询' }),
      capabilities: normalizeCapabilities({
        chat: true,
        workflow: true,
        workbench: true,
        vision: false,
        maxConcurrency: 1,
        mode: 'probed',
        checkedAt: Date.now(),
        checks
      }, cfg)
    };
  }

  if (!external) {
    // 1. 普通 API：流式基础通信
    const basic = await (probeImpl || require('./provider-probe.cjs').probe)(cfg, { timeoutMs });
    checks.chat = basic.ok ? '流式对话通信正常' : (basic.error || '连接测试失败');
    if (!basic.ok) {
      return {
        ok: false,
        capabilities: normalizeCapabilities({ chat: false, workflow: false, workbench: false, vision: false, maxConcurrency: 1, mode: 'probed', checkedAt: Date.now(), checks }, cfg),
        error: basic.error
      };
    }

    // 2. 工作流隔离与并发测试
    let workflowOk = true;
    let maxConcurrency = 3;
    const callFn = callModelImpl || require('./provider-call.cjs').callModel;
    try {
      const [r1, r2] = await Promise.all([
        callFn(cfg, { system: 'Reply briefly.', user: 'Reply with P1.', maxTokens: 32, json: false, temperature: 0 }, { timeoutMs }),
        callFn(cfg, { system: 'Reply briefly.', user: 'Reply with P2.', maxTokens: 32, json: false, temperature: 0 }, { timeoutMs })
      ]);
      if (!r1.text && !r2.text) workflowOk = false;
      checks.workflow = '支持并行节点调用（上限 3）';
    } catch {
      maxConcurrency = 1;
      try {
        await callFn(cfg, { system: 'Reply briefly.', user: 'Reply with OK.', maxTokens: 32, json: false, temperature: 0 }, { timeoutMs });
        checks.workflow = '支持工作流（建议串行运行，并发限制 1）';
      } catch (err) {
        workflowOk = false;
        checks.workflow = '工作流单次非流式调用失败：' + err.message;
      }
    }

    // 3. 工具调用测试（工作台必须支持 Function Calling / tool_calls）
    let workbenchOk = false;
    try {
      const toolRes = await probeApiToolCalling(cfg, { timeoutMs });
      workbenchOk = toolRes.ok;
      checks.workbench = toolRes.reason;
    } catch (err) {
      checks.workbench = '工具调用探测失败：' + err.message;
    }

    // 4. 识图测试
    const visionRes = await probeApiVision(cfg, { timeoutMs: Math.min(15000, timeoutMs) });
    checks.vision = visionRes.reason;

    const capabilities = normalizeCapabilities({
      chat: true,
      workflow: workflowOk,
      workbench: workbenchOk,
      vision: visionRes.ok,
      maxConcurrency,
      mode: 'probed',
      checkedAt: Date.now(),
      checks
    }, cfg);
    return { ok: true, capabilities };
  }

  // ---- 外部 Agent 4 级实测探针 ----
  const modelId = cfg.model || (Array.isArray(cfg.models) ? cfg.models[0] : '') || 'main';
  const extCfg = { ...cfg, model: modelId };

  // 第 1 级：连通性 & 基础问答
  try {
    const r = await exchange(extCfg, {
      system: 'Reply concisely.',
      user: 'Reply with OK.',
      sessionKey: `agent:${modelId}:probe-chat-${crypto.randomBytes(4).toString('hex')}`,
      timeoutMs
    });
    if (!String(r?.text || '').trim()) throw new Error('外部 Agent 返回空内容');
    checks.chat = '外部 Agent 连接与对话正常';
  } catch (err) {
    checks.chat = err.message;
    return {
      ok: false,
      error: err.message,
      capabilities: normalizeCapabilities({ chat: false, workflow: false, workbench: false, vision: false, maxConcurrency: 1, mode: 'probed', checkedAt: Date.now(), checks }, cfg)
    };
  }

  // 第 2 级：工作流多轮隔离 + 并发测试
  let workflowOk = false;
  let maxConcurrency = 1;
  const secretA = 'SEC_' + crypto.randomBytes(4).toString('hex');
  try {
    const sessA = `agent:${modelId}:probe-wfa-${crypto.randomBytes(4).toString('hex')}`;
    const sessB = `agent:${modelId}:probe-wfb-${crypto.randomBytes(4).toString('hex')}`;
    await exchange(extCfg, { system: 'Remember the user code and reply OK.', user: `Code is ${secretA}. Reply OK.`, sessionKey: sessA, timeoutMs });
    const checkB = await exchange(extCfg, { system: 'Only answer from the current session.', user: 'If no secret code was given in this session, reply NONE.', sessionKey: sessB, timeoutMs });
    if (String(checkB?.text || '').includes(secretA)) {
      workflowOk = false;
      checks.workflow = '检测到跨会话记忆泄漏，工作流节点会串台（已禁用工作流）';
    } else {
      workflowOk = true;
      try {
        await Promise.all([
          exchange(extCfg, { system: 'Reply briefly.', user: 'Reply P1.', sessionKey: `agent:${modelId}:probe-c1-${crypto.randomBytes(3).toString('hex')}`, timeoutMs }),
          exchange(extCfg, { system: 'Reply briefly.', user: 'Reply P2.', sessionKey: `agent:${modelId}:probe-c2-${crypto.randomBytes(3).toString('hex')}`, timeoutMs })
        ]);
        maxConcurrency = 3;
        checks.workflow = '会话可隔离且支持并发调度（并发上限 3）';
      } catch {
        maxConcurrency = 1;
        checks.workflow = '会话可隔离但并发受限，工作流将按串行排队（并发 1）';
      }
    }
  } catch (err) {
    checks.workflow = '工作流隔离测试失败：' + err.message;
  }

  // 第 3 级：工作台工具 / MCP 回环回调测试
  let workbenchOk = false;
  const probeServer = await startProbeCallbackServer();
  try {
    const nonce = 'wb_' + crypto.randomBytes(5).toString('hex');
    const mcpEnv = { PI_WORKBENCH_PROBE_PORT: String(probeServer.port), PI_WORKBENCH_PROBE_TOKEN: probeServer.token };
    await exchange(extCfg, {
      system: 'Use tool workbench_probe_ping with the given nonce.',
      user: `Call workbench_probe_ping with {"nonce":"${nonce}"} and reply DONE.`,
      sessionKey: `agent:${modelId}:probe-wb-${crypto.randomBytes(4).toString('hex')}`,
      mcpEnv,
      timeoutMs
    }).catch(() => {});
    if (probeServer.hasNonce(nonce)) {
      workbenchOk = true;
      checks.workbench = '已实测收到本地工作台 MCP 工具回环回调';
    } else {
      checks.workbench = '未触发本地工作台工具回环（仅支持纯对话与工作流，无法操作工作台）';
    }
  } finally {
    await probeServer.close();
  }

  // 第 4 级：识图能力（当前 OpenClaw chat.send / 纯 CLI 文本通道默认标记未测）
  checks.vision = '外部通道默认仅按文本处理（如需识图请确认客户端支持多模态传参）';

  const capabilities = normalizeCapabilities({
    chat: true,
    workflow: workflowOk,
    workbench: workbenchOk,
    vision: false,
    maxConcurrency,
    mode: 'probed',
    checkedAt: Date.now(),
    checks
  }, cfg);
  return { ok: true, capabilities };
}

async function parseAgentImportText({ rawText, callerCfg, callModelImpl }) {
  const source = String(rawText || '').trim().slice(0, 12000);
  if (!source) throw new Error('请先粘贴外部 Agent 的启动命令、帮助信息或网关说明');
  if (!callerCfg?.model) throw new Error('请先配置一个主模型后再使用 AI 辅助识别');
  const callFn = callModelImpl || require('./provider-call.cjs').callModel;
  const system = '你是配置提取器。根据用户粘贴的外部 Agent 文档或命令行帮助信息，提取结构化导入配置。只输出 JSON：{"name":"显示名称","agentTransport":"openclaw-gateway|external-cli","gatewayUrl":"ws://...或空","command":"CLI命令名或空","args":["参数1"],"promptMode":"stdin|arg","mcpSupport":"mcp-config|none","models":["agentId或模型名"]}。未知字段留空或给保守默认。';
  const res = await callFn(callerCfg, { system, user: `DATA_BEGIN\n${source}\nDATA_END`, maxTokens: 800, json: true, temperature: 0 }, { timeoutMs: 30000 });
  const raw = String(res?.text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) parsed = JSON.parse(raw.slice(s, e + 1));
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('模型未能解析出有效 JSON 配置');
  return {
    name: String(parsed.name || '外部 Agent').trim().slice(0, 60),
    agentTransport: parsed.agentTransport === 'openclaw-gateway' ? 'openclaw-gateway' : 'external-cli',
    gatewayUrl: String(parsed.gatewayUrl || '').trim().slice(0, 300),
    command: String(parsed.command || '').trim().slice(0, 200),
    args: Array.isArray(parsed.args) ? parsed.args.map(x => String(x).slice(0, 200)).slice(0, 24) : [],
    promptMode: parsed.promptMode === 'arg' ? 'arg' : 'stdin',
    mcpSupport: parsed.mcpSupport === 'none' ? 'none' : 'mcp-config',
    models: Array.isArray(parsed.models) ? parsed.models.map(x => String(x).trim()).filter(Boolean).slice(0, 4) : []
  };
}

function splitCommandLine(text) {
  const out = [];
  let cur = '', quote = '';
  for (const ch of String(text || '').trim()) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// 从命令输出或 Agent 回复里提取模型 ID：优先 JSON 数组 / {models:[]}，否则按行取首个 token。
function parseModelIds(text) {
  const raw = String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  const uniq = list => [...new Set(list.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 200);
  const fromJson = value => {
    const arr = Array.isArray(value) ? value : (Array.isArray(value?.models) ? value.models : (Array.isArray(value?.data) ? value.data : null));
    return arr ? uniq(arr.map(x => typeof x === 'string' ? x : (x && (x.id || x.name || x.model)))) : null;
  };
  try { const found = fromJson(JSON.parse(raw)); if (found) return found; } catch {}
  const block = raw.match(/\[[\s\S]*\]/);
  if (block) { try { const found = fromJson(JSON.parse(block[0])); if (found && found.length) return found; } catch {} }
  const ids = [];
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    // Only accept an entire ID line; prose, tables and diagnostics are not models.
    if (/^[A-Za-z0-9][\w.:/@+-]{0,99}$/.test(token) && /[/.:-]/.test(token)) ids.push(token);
  }
  return uniq(ids);
}

// 自动获取外部 Agent 的真实模型列表：CLI 走“模型列表命令”（如 opencode models），MCP 接力让源 Agent 自己枚举；其余返回 null。
async function listAgentModels(cfg, { relayDispatch, timeoutMs = 20000, signal } = {}) {
  const transport = cfg?.agentTransport || cfg?.provider;
  if (transport === 'mcp-relay') {
    if (typeof relayDispatch !== 'function') return null;
    const out = await relayDispatch(cfg.profileId || cfg.id, {
      system: '',
      user: '请列出你当前真实可用于对话的全部模型 ID（以你自己的模型选择列表、配置或当前会话正在使用的模型为准，不要编造）。如果无法枚举完整列表，至少把你当前正在使用的真实模型 ID 放进数组里。只回复一个 JSON 字符串数组，例如 ["model-a","model-b"]，不要任何其他文字。',
      mode: 'chat',
      timeoutMs,
      signal
    });
    return parseModelIds(out?.text);
  }
  if (transport === 'external-cli' && String(cfg.modelsCommand || '').trim()) {
    const parts = splitCommandLine(cfg.modelsCommand);
    if (!parts.length) return null;
    const run = resolveCommand(resolveCliExecutable(parts[0]), parts.slice(1));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const text = await new Promise((resolve, reject) => {
      const child = spawn(run.file, run.args, { env, cwd: cfg.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: run.windowsVerbatimArguments });
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('模型列表命令执行超时')); }, Math.max(3000, timeoutMs));
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err = (err + c).slice(-1000); });
      child.once('error', e => { clearTimeout(timer); reject(new Error('无法执行模型列表命令：' + e.message)); });
      child.once('close', code => { clearTimeout(timer); if (code === 0 || out.trim()) resolve(out); else reject(new Error(err.trim() || '模型列表命令退出码 ' + code)); });
    });
    return parseModelIds(text);
  }
  return null;
}

async function isEndpointReachable(rawUrl, timeoutMs = 800) {
  const input = String(rawUrl || '').trim();
  if (!input) return false;
  let uri;
  try { uri = new URL(input); } catch { return false; }
  const port = Number(uri.port) || (uri.protocol === 'https:' || uri.protocol === 'wss:' ? 443 : 80);
  const host = uri.hostname || '127.0.0.1';
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(Math.max(200, timeoutMs), () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function launchAgentProcess(cfg, { spawnImpl = spawn, isReachableImpl = isEndpointReachable } = {}) {
  const cmd = String(cfg?.launchCommand || '').trim();
  if (!cmd) return { launched: false, reason: 'no-launch-command' };
  if (cfg?.baseUrl && await isReachableImpl(cfg.baseUrl)) {
    return { launched: false, reason: 'already-reachable' };
  }
  const args = parseArgsList(cfg?.launchArgs);
  const run = resolveCommand(resolveCliExecutable(cmd), args);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnImpl(run.file, run.args, {
    env,
    cwd: cfg?.cwd || process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: !/\.exe$/i.test(run.file),
    windowsVerbatimArguments: run.windowsVerbatimArguments
  });
  if (typeof child?.unref === 'function') child.unref();
  return { launched: true, pid: child?.pid || 0 };
}

module.exports = {
  normalizeWsUrl,
  openClawExchange,
  cliExchange,
  exchange,
  probeCapabilities,
  probeApiToolCalling,
  parseAgentImportText,
  parseArgsList,
  splitCommandLine,
  parseModelIds,
  listAgentModels,
  isEndpointReachable,
  launchAgentProcess
};
