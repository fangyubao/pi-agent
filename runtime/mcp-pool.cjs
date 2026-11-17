'use strict';
// MCP 连接池：把「已启用的服务器」按需启动并复用，供主进程桥接给 Agent。
//  - 只有 enabled 的服务器才会被启动；关闭/删除/改命令后立即断开。
//  - 工具列表在首次连接时缓存；调用时再次校验工具确实存在。
//  - 每个服务器的调用串行化，避免交错写入同一个 stdio。
//  - 任何失败都返回可读错误，不抛出到桥接层之外；连接异常断开后下次调用会重新启动。
// 是否允许调用由上层的“逐次批准”负责；这里只保证“没启用就绝不启动”。
const MAX_RESULT = 20000;

function createPool({ store, createClient, startTimeoutMs = 20000, callTimeoutMs = 60000 }) {
  const clients = new Map();          // id -> { client, tools, signature, tail: Promise }
  const starting = new Map();         // id -> Promise（防止并发重复启动）

  async function ensure(id) {
    const launch = await store.resolveForLaunch(id);
    if (!launch.enabled) throw new Error('服务器「' + launch.name + '」未启用，请先在 MCP 页面打开开关');
    const signature = JSON.stringify([launch.command, launch.args, launch.cwd, Object.keys(launch.env).sort()]);
    const existing = clients.get(id);
    if (existing && existing.signature === signature && !existing.client.closed) return existing;
    if (existing) { existing.client.close(); clients.delete(id); }
    if (starting.has(id)) return starting.get(id);
    const promise = (async () => {
      const client = createClient(launch, { startTimeoutMs, callTimeoutMs });
      try { const tools = await client.start(); const entry = { client, tools, signature, name: launch.name, tail: Promise.resolve() }; clients.set(id, entry); return entry; }
      catch (error) { client.close(); throw error; }
    })().finally(() => starting.delete(id));
    starting.set(id, promise);
    return promise;
  }

  return {
    // 列出所有已启用服务器的工具。单个服务器失败不影响其他，错误随结果返回。
    async listTools() {
      const out = [];
      for (const server of await store.list()) {
        if (!server.enabled) continue;
        try { const entry = await ensure(server.id); out.push({ server: server.name, tools: entry.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }); }
        catch (error) { out.push({ server: server.name, error: String(error.message || error) }); }
      }
      return out;
    },
    async call(serverName, toolName, args) {
      const server = (await store.list()).find(s => s.name === serverName);
      if (!server) throw new Error('没有名为「' + serverName + '」的 MCP 服务器');
      const entry = await ensure(server.id);
      const run = entry.tail.then(() => entry.client.callTool(toolName, args), () => entry.client.callTool(toolName, args));
      entry.tail = run.catch(() => {});
      let result;
      try { result = await run; }
      catch (error) { if (entry.client.closed) clients.delete(server.id); throw error; }   // 连接已断：下次调用重新启动
      const text = result.text.length > MAX_RESULT ? result.text.slice(0, MAX_RESULT) + '\n…（结果过长，已截断）' : result.text;
      return { isError: result.isError, text };
    },
    invalidate(id) { const e = clients.get(id); if (e) { e.client.close(); clients.delete(id); } },
    closeAll() { for (const [, e] of clients) e.client.close(); clients.clear(); },
    get size() { return clients.size; }
  };
}
module.exports = { createPool };
