'use strict';
// 最小 MCP 客户端（stdio 传输，换行分隔的 JSON-RPC 2.0）。
// 只实现：initialize → notifications/initialized → tools/list → tools/call，以及超时、进程退出、坏数据的处理。
// 不支持 HTTP/SSE 与 OAuth（需要时再加）。这里不做任何权限决定：是否允许调用由上层（批准流程）负责。
const { spawn } = require('node:child_process');

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULTS = { startTimeoutMs: 15000, callTimeoutMs: 60000, maxLineBytes: 4 * 1024 * 1024, maxResultChars: 60000 };

class McpError extends Error {
  constructor(message, code, data) { super(message); this.name = 'McpError'; this.code = code; this.data = data; }
}

// Windows 上 npx/uvx 等是 .cmd，不能无 shell 直接 spawn；用 cmd /c，并对参数做最小的引号处理。
function resolveCommand(command, args) {
  if (process.platform !== 'win32') return { file: command, args };
  const quote = value => (/[\s"&|<>^()%!]/.test(value) ? '"' + String(value).replace(/"/g, '\\"') + '"' : String(value));
  if (/\.(cmd|bat)$/i.test(command) || ['npx', 'npm', 'pnpm', 'yarn', 'uvx'].includes(command.toLowerCase())) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', [command, ...args].map(quote).join(' ')], windowsVerbatimArguments: true };
  }
  return { file: command, args };
}

class McpClient {
  constructor(config, options = {}) {
    this.config = config;
    this.options = { ...DEFAULTS, ...options };
    this.child = null; this.nextId = 1; this.pending = new Map(); this.buffer = '';
    this.tools = []; this.serverInfo = null; this.closed = false; this.stderrTail = '';
  }

  async start() {
    const { command, args = [], env = {}, cwd } = this.config;
    if (!command || typeof command !== 'string') throw new McpError('未填写启动命令', 'BAD_CONFIG');
    const run = resolveCommand(command, args.map(String));
    this.child = spawn(run.file, run.args, { cwd: cwd || undefined, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: run.windowsVerbatimArguments });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
    this.child.on('error', error => this.#fail(new McpError('无法启动：' + error.message, 'SPAWN_FAILED')));
    this.child.on('exit', (code, signal) => this.#fail(new McpError('服务器已退出（' + (signal || '退出码 ' + code) + '）' + (this.stderrTail ? '：' + this.stderrTail.trim().slice(-300) : ''), 'EXITED')));
    const init = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'pi-workbench', version: '1.0.0' } }, this.options.startTimeoutMs);
    this.serverInfo = init?.serverInfo || null;
    this.notify('notifications/initialized', {});
    return this.listTools();
  }

  async listTools() {
    const tools = []; let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, this.options.startTimeoutMs);
      for (const tool of result?.tools || []) if (tool && typeof tool.name === 'string') tools.push({ name: tool.name, description: String(tool.description || '').slice(0, 1000), inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} } });
      cursor = result?.nextCursor; if (!cursor) break;
    }
    this.tools = tools;
    return tools;
  }

  async callTool(name, args = {}) {
    if (!this.tools.some(tool => tool.name === name)) throw new McpError('服务器没有这个工具：' + name, 'UNKNOWN_TOOL');
    const result = await this.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, this.options.callTimeoutMs);
    const text = (Array.isArray(result?.content) ? result.content : []).map(part => part?.type === 'text' ? String(part.text ?? '') : '[' + (part?.type || '内容') + ']').join('\n');
    const clipped = text.length > this.options.maxResultChars ? text.slice(0, this.options.maxResultChars) + '\n…（结果过长，已截断）' : text;
    return { isError: Boolean(result?.isError), text: clipped };
  }

  request(method, params, timeoutMs = this.options.callTimeoutMs) {
    if (this.closed || !this.child) return Promise.reject(new McpError('服务器未连接', 'CLOSED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new McpError('等待 ' + method + ' 超时（' + Math.round(timeoutMs / 1000) + ' 秒）', 'TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { if (!this.closed && this.child) this.#write({ jsonrpc: '2.0', method, params }); }
  #write(message) { try { this.child.stdin.write(JSON.stringify(message) + '\n'); } catch (error) { this.#fail(new McpError('写入失败：' + error.message, 'WRITE_FAILED')); } }

  #onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > this.options.maxLineBytes && !this.buffer.includes('\n')) { this.#fail(new McpError('服务器输出过大', 'TOO_LARGE')); this.close(); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }   // 非 JSON 行（日志）直接忽略
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new McpError(String(message.error.message || '服务器返回错误'), 'RPC_ERROR', message.error.code)); else entry.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // 服务器主动请求（如 sampling/roots）：本客户端不支持，明确拒绝而不是挂起。
        this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } });
      }
    }
  }

  #fail(error) {
    if (this.closed) return; this.closed = true;
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  close() {
    this.#fail(new McpError('已关闭', 'CLOSED'));
    const child = this.child; this.child = null; if (!child) return;
    try { child.stdin.end(); } catch { /* 已关闭 */ }
    setTimeout(() => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 800).unref();
  }
}

module.exports = { McpClient, McpError, resolveCommand, PROTOCOL_VERSION };
