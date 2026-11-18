'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

function safeTokenMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是有效的 JSON')); }
    });
    req.on('error', reject);
  });
}

function buildOnboardingArtifacts({ port, token, nodePath, mcpScriptPath, bundleDir = '' }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const registerUrl = `${baseUrl}/pair/register`;
  const mcpUrl = `${baseUrl}/mcp?token=${encodeURIComponent(token)}`;
  const serverCmd = nodePath || process.execPath;
  const targetScript = bundleDir
    ? path.join(bundleDir, 'mcp-server.cjs')
    : String(mcpScriptPath || path.join(__dirname, 'workbench-mcp-server.cjs')).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  const runAsNode = /electron(\.exe)?$|pi[\s-]*workbench/i.test(path.basename(serverCmd));
  const stdioConfig = {
    mcpServers: {
      'pi-workbench-connect': {
        command: serverCmd,
        args: [targetScript, '--connect-url', mcpUrl],
        ...(runAsNode ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {})
      }
    }
  };
  const connectDocPath = bundleDir ? path.join(bundleDir, 'CONNECT.md') : '';
  const pairingFilePath = bundleDir ? path.join(bundleDir, 'pairing.json') : '';
  const mcpConfigPath = bundleDir ? path.join(bundleDir, 'mcp-config.json') : '';

  const guideMarkdown = [
    '# Pi Workbench Connect (Agent 自助接入协议与内置 MCP 包)',
    '',
    '本目录是 **Pi Workbench** 自动维护的自包含接入包（包含说明文档、当前配对凭证与可直接部署运行的本地 MCP Server）。',
    '',
    '## 一、前置过滤（不满足请立刻停止）',
    '请先判断你当前所属的 Agent 运行环境是否满足以下条件之一：',
    '1. 你可以挂载或连接本目录下的本地 MCP Server（见 `mcp-config.json` 或 `pairing.json` 中的 `mcpUrl`）；或者',
    '2. 你能执行本地终端命令 / 发送 HTTP POST 到本机 `http://127.0.0.1`（见 `pairing.json` 中的 `registerUrl`）。',
    '- **若两项均不具备**（例如纯封闭网页对话框，无法挂载本机 MCP、也无法访问 127.0.0.1），请直接向用户说明无法接入并停止，禁止伪造接入成功。',
    '',
    '## 二、当前接入包文件清单',
    `- 配对凭证文件：\`${pairingFilePath || 'pairing.json'}\``,
    `- 可部署 MCP 配置：\`${mcpConfigPath || 'mcp-config.json'}\`（指向内置零依赖服务器 \`${targetScript}\`）`,
    `- Streamable HTTP MCP 入口：\`${mcpUrl}\``,
    `- HTTP 自注册接口：\`${registerUrl}\`（Bearer Token: \`${token}\`）`,
    '',
    '## 三、部署与自主接入步骤',
    '### 路径 A（推荐，可脱离原窗口长期使用）：自检自身入口并上报配置',
    '若你具备本地非交互 CLI、网关或可用模型 API（哪怕协议不完全标准，也可先写一个轻量本地适配器脚本包装成标准 CLI 或 `127.0.0.1` OpenAI 兼容服务），**请优先走路径 A**，不要走路径 B 轮询；严禁通过模拟键鼠或抓取客户端私有登录态去强行驱动桌面界面。',
    '若你明确知道自己的网关服务或客户端可执行文件路径（例如 `openclaw` 或本机桌面端 `.exe`），可在注册 JSON 中额外附上 `"launchCommand"` 与 `"launchArgs"`（供用户在 Pi Workbench 设置里一键开启“随 Pi 启动自动拉起”）。',
    '请按你自身的实际形态选择最合适的一种配置提交：',
    '1. **OpenClaw 网关**：读取本机 OpenClaw 配置获取 WebSocket 地址与 Token，提交：',
    '```json',
    '{"name":"OpenClaw Agent","agentTransport":"openclaw-gateway","baseUrl":"ws://127.0.0.1:18789","apiKey":"你的网关Token","models":["main"]}',
    '```',
    '2. **命令行 CLI Agent**（如 `opencode`、`claude`、`codex` 等支持非交互模式的 CLI）：请填你真实的启动命令、非交互参数及当前可用模型（如果是 `opencode` 无付费 Key 时可用 `opencode/glm-5.3-flash-free` 等免费模型）。注意：只要你的 CLI 程序本身支持 MCP（例如 OpenCode 支持通过环境变量 `OPENCODE_CONFIG_CONTENT` 自动挂载、Claude/Codex 支持 `--mcp-config` / `PI_WORKBENCH_MCP_CONFIG`），即使当前会话尚未提前加载 MCP，**也请填写 `"mcpSupport":"mcp-config"`**——Pi Workbench 在调用与四级实测时会自动把工作台 MCP 注入给子进程，并由 `workbench_probe_ping` 实测决定工作台是否可用：',
    '```json',
    '{"name":"OpenCode Free","agentTransport":"external-cli","command":"opencode","args":["run","--format","json","--auto","--pure","-m","{model}"],"promptMode":"stdin","mcpSupport":"mcp-config","modelsCommand":"opencode models","models":["opencode/glm-5.3-flash-free","opencode/big-pickle"]}',
    '```',
    '*(如果是 OpenCode 需要主动连入本目录 MCP，使用 `OPENCODE_CONFIG_CONTENT` 或 `opencode.json` 的 `{"mcp":{"pi-workbench-connect":{"type":"remote","url":"' + mcpUrl + '","enabled":true}}}`)*',
    '3. **本地兼容 OpenAI HTTP 服务**：',
    '```json',
    '{"name":"本地模型","kind":"api","provider":"openai-compatible","baseUrl":"http://127.0.0.1:端口/v1","apiKey":"密钥或local","models":["模型ID"]}',
    '```',
    '',
    '### 路径 B（适合本身是 MCP Client、无独立网关/CLI 入口的 Agent）：MCP 在线接力',
    '1. 加载或连接 `mcp-config.json`（或使用 `mcpUrl`），调用 `pi_workbench_check_compatibility` 完成前置校验；',
    '2. 调用 `pi_workbench_register_agent` 提交（`models` 至少填入你当前正在使用的真实模型 ID）：',
    '```json',
    '{"name":"当前 MCP Agent","agentTransport":"mcp-relay","models":["你当前正在使用的真实模型ID"]}',
    '```',
    '3. **关键：拿到返回的 `profileId` 后不要结束本轮回复！** 请立刻进入持续接单循环（否则 Pi Workbench 超过宽限期无轮询会判定离线并请求失败）：',
    '   - 调用 `pi_workbench_await_task(profileId, timeoutMs: 55000)` 挂起等待任务；',
    '   - 若返回 `idle: true`（暂无任务），**不要向用户回复并结束对话**，立即再次调用 `pi_workbench_await_task` 保持在线；',
    '   - 若返回 `idle: false` 接到 `task`：按 `task.system` 与 `task.user` 执行（工作台模式可直接调用 `workbench_action`；若 `task.model` 非空且与你当前模型不同而你无法切换，必须以 `isError: true` 回传原因），完成后调用 `pi_workbench_submit_result`，随后**继续调用 `pi_workbench_await_task`** 接下一单；',
    '   - 仅当用户明确叫停或宿主工具调用次数达到上限被迫暂停时，才向用户说明“已暂停接力轮询，如需继续派单请回复让我继续接单”。',
    '',
    '### 发送方式二选一',
    '- **MCP 工具调用**：挂载本目录 `mcp-config.json` 后调用 `pi_workbench_register_agent`；若通过 HTTP 客户端直连 MCP，**必须使用 `POST /mcp` 发送 JSON-RPC，禁止对 `/mcp` 发 `GET`（`GET /mcp` 为 SSE 长连接，会一直挂起）**；',
    `- **HTTP POST**：携带 \`Authorization: Bearer ${token}\` 与 \`Content-Type: application/json\` POST 到 \`${registerUrl}\`。`,
    '',
    '## 三点五、模型列表（必须如实上报，否则用户在 Pi Workbench 里选不到模型）',
    '- 注册时的 `models` 必须是你**当前真实可用于对话的全部模型 ID**（不要只写默认值，更不要编造）；请先从你自己的模型选择列表、配置文件或自带命令（例如 `opencode models`）里枚举。',
    '- 若无法枚举全量内置模型列表（例如桌面端仅暴露当前会话模型），**至少把你当前会话正在使用的真实模型 ID 放进 `models`**（只有在连当前模型 ID 都无法确定时才用 `relay-main` 占位）。',
    '- 若是命令行 Agent 且有列出模型的命令，请额外提交 `"modelsCommand":"opencode models"`（Pi Workbench 之后可自动刷新模型列表）。',
    `- 之后模型有变动，可随时调用 MCP 工具 \`pi_workbench_update_models\`，或 POST \`${baseUrl}/pair/update-models\`（同样带 Bearer Token）提交 \`{"profileId":"注册回执里的 profileId","models":["模型A","模型B"]}\`。`,
    '- 模型列表仅代表源 Agent 上报的目录，不等于已验证每个模型的可用性或切换能力。接力任务含 `model` 字段；若无法使用指定模型，必须以 `isError:true` 回传原因，不能静默使用其他模型。',
    '- 连全量列表和当前模型 ID 都无法确定时，才返回空数组并说明原因；不要把记忆中的厂商型号当作当前可用列表。',
    '',
    '## 四、能力实测与界面状态刷新',
    'Pi Workbench 收到注册后会立即返回 `{"ok":true,...}` 登记回执，并立刻在桌面端后台执行**四级能力实测**（普通聊天、工作流会话隔离与并发、**工作台工具 workbench 是否可用**），桌面端客户端界面会自动实时刷新结果与工作台可用标识。',
    '- **路径 A（网关 / CLI / HTTP 服务）**：拿到 `ok: true` 后直接简洁告知用户即可，无需等待后台探测完成。',
    '- **路径 B（`mcp-relay` 在线接力）**：拿到 `profileId` 后**不要结束回复**，必须按路径 B 第 3 步持续循环调用 `pi_workbench_await_task` 挂起接单，保持在线状态。',
    ''
  ].join('\n');

  const prompt = connectDocPath
    ? [
        `请先读取本地接入说明文件：${connectDocPath}`,
        '按其中的前置过滤规则自行判断当前环境是否满足接入条件（不满足请直接告知用户并停止，不要编造成功）；',
        '若符合条件，请直接使用同目录下的 MCP（mcp-config.json / mcp-server.cjs）或配对凭证（pairing.json）自主完成连接与注册（务必上报真实模型列表或至少当前在用模型 ID）。',
        '若是网关/CLI/API 方式，完成后向用户汇报即可；若是 mcp-relay（MCP 在线接力），拿到 profileId 后请勿结束回复，立即持续循环调用 pi_workbench_await_task 挂起接单（idle 时继续 await）并用 pi_workbench_submit_result 回传结果。'
      ].join('\n')
    : [
        `请读取本次 Pi Workbench 接入端点与 MCP Server：${mcpUrl}（或 HTTP 注册地址 ${registerUrl}，Token: ${token}）。`,
        '先判断是否具备连接本地 MCP 或访问 127.0.0.1 的能力，不符合请直接停止；符合则通过 `pi_workbench_register_agent` 或 POST 注册（务必上报真实模型列表或至少当前在用模型 ID）。',
        '若是 mcp-relay（MCP 在线接力），拿到 profileId 后请勿结束回复，立即持续循环调用 pi_workbench_await_task 挂起接单并用 pi_workbench_submit_result 回传结果。'
      ].join('\n');

  return {
    port,
    token,
    baseUrl,
    registerUrl,
    mcpUrl,
    bundleDir,
    connectDocPath,
    pairingFilePath,
    mcpConfigPath,
    mcpServerPath: targetScript,
    stdioConfig,
    guideMarkdown,
    prompt
  };
}

async function writeConnectBundle(artifacts, sourceMcpScriptPath) {
  if (!artifacts.bundleDir) return;
  await fs.mkdir(artifacts.bundleDir, { recursive: true });
  const srcScript = String(sourceMcpScriptPath || path.join(__dirname, 'workbench-mcp-server.cjs')).replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  const scriptContent = await fs.readFile(srcScript, 'utf8');
  await fs.writeFile(artifacts.mcpServerPath, scriptContent, 'utf8');
  await fs.writeFile(artifacts.mcpConfigPath, JSON.stringify(artifacts.stdioConfig, null, 2), 'utf8');
  await fs.writeFile(artifacts.pairingFilePath, JSON.stringify({
    version: 1,
    port: artifacts.port,
    baseUrl: artifacts.baseUrl,
    registerUrl: artifacts.registerUrl,
    mcpUrl: artifacts.mcpUrl,
    token: artifacts.token,
    mcpServerPath: artifacts.mcpServerPath,
    mcpConfigPath: artifacts.mcpConfigPath,
    connectDocPath: artifacts.connectDocPath,
    updatedAt: new Date().toISOString()
  }, null, 2), 'utf8');
  await fs.writeFile(artifacts.connectDocPath, artifacts.guideMarkdown, 'utf8');
}

function createPairingServer({
  onRegister,
  onUpdateModels,
  onWorkbenchAction,
  onReadTaskContext,
  onMemoryProposal,
  nodePath = process.execPath,
  mcpScriptPath,
  bundleDir = ''
} = {}) {
  let server = null;
  let port = 0;
  let preferredPort = 0;
  let activeBundleDir = String(bundleDir || '');
  let pairingToken = crypto.randomBytes(16).toString('hex');
  let persistedLoaded = false;
  const sseResponses = new Set();
  let state = {
    status: 'idle',
    startedAt: null,
    connectedAt: null,
    profileId: '',
    name: '',
    agentTransport: '',
    capabilities: null,
    error: ''
  };

  async function loadPersistedPairing() {
    if (persistedLoaded || !activeBundleDir) return;
    persistedLoaded = true;
    try {
      const raw = await fs.readFile(path.join(activeBundleDir, 'pairing.json'), 'utf8');
      const saved = JSON.parse(raw);
      const savedPort = Number(saved?.port);
      if (Number.isInteger(savedPort) && savedPort >= 1024 && savedPort <= 65535) preferredPort = savedPort;
      if (typeof saved?.token === 'string' && saved.token.trim().length >= 16) pairingToken = saved.token.trim();
    } catch { /* 首次启动尚无 pairing.json，使用新令牌与随机端口 */ }
  }

  const relays = new Map();
  function getRelay(profileId) {
    const id = String(profileId || '');
    if (!relays.has(id)) {
      relays.set(id, { lastSeenAt: 0, queue: [], waiters: [], inFlight: new Map() });
    }
    return relays.get(id);
  }

  function touchRelay(profileId) {
    const r = getRelay(profileId);
    r.lastSeenAt = Date.now();
    return r;
  }

  function getRelayState(profileId) {
    const r = relays.get(String(profileId || ''));
    if (!r) return 'RELAY_OFFLINE';
    if (r.waiters.length > 0 || (Date.now() - (r.lastSeenAt || 0) <= 65000)) return 'RELAY_ONLINE';
    if (r.queue.length > 0) return 'RELAY_GRACE_WAIT';
    return 'RELAY_OFFLINE';
  }

  function markTaskPickedUp(task) {
    task.pickedUp = true;
    if (task.graceTimer) { clearTimeout(task.graceTimer); task.graceTimer = null; }
  }

  function flushRelayQueue(profileId) {
    const r = getRelay(profileId);
    while (r.queue.length && r.waiters.length) {
      const task = r.queue.shift();
      markTaskPickedUp(task);
      const waiter = r.waiters.shift();
      waiter(task);
    }
  }

  function awaitRelayTask(profileId, timeoutMs = 50000) {
    const r = touchRelay(profileId);
    if (r.queue.length) {
      const task = r.queue.shift();
      markTaskPickedUp(task);
      return Promise.resolve({ idle: false, task: { requestId: task.requestId, system: task.system, user: task.user, model: task.model || '', mode: task.mode } });
    }
    return new Promise(resolve => {
      let timer = null;
      const onTask = task => {
        clearTimeout(timer);
        markTaskPickedUp(task);
        resolve({ idle: false, task: { requestId: task.requestId, system: task.system, user: task.user, model: task.model || '', mode: task.mode } });
      };
      r.waiters.push(onTask);
      timer = setTimeout(() => {
        const idx = r.waiters.indexOf(onTask);
        if (idx >= 0) r.waiters.splice(idx, 1);
        resolve({ idle: true });
      }, Math.max(1000, Math.min(55000, Number(timeoutMs) || 50000)));
      timer.unref?.();
    });
  }

  function submitRelayResult(profileId, { requestId, text, isError = false, error = '' }) {
    const r = touchRelay(profileId);
    const entry = r.inFlight.get(String(requestId || ''));
    if (!entry) throw new Error('找不到对应的待回传任务，可能已超时或已完成：' + String(requestId || ''));
    r.inFlight.delete(String(requestId || ''));
    clearTimeout(entry.timer);
    if (entry.graceTimer) { clearTimeout(entry.graceTimer); entry.graceTimer = null; }
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (isError) entry.reject(new Error(String(error || text || 'MCP 接力执行失败')));
    else entry.resolve({ text: String(text || ''), usage: null });
    return { ok: true, requestId };
  }

  async function dispatchRelayTask(profileId, { system = '', user = '', model = '', mode = 'chat', timeoutMs = 180000, graceWaitMs = 60000, signal } = {}) {
    const r = getRelay(profileId);
    const onlineNow = r.waiters.length > 0 || (Date.now() - (r.lastSeenAt || 0) <= 65000);
    const requestId = 'rly_' + crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        if (taskObj.graceTimer) { clearTimeout(taskObj.graceTimer); taskObj.graceTimer = null; }
        signal?.removeEventListener('abort', onAbort);
        const qi = r.queue.findIndex(x => x.requestId === requestId);
        if (qi >= 0) r.queue.splice(qi, 1);
        r.inFlight.delete(requestId);
        return true;
      };
      const onAbort = () => {
        if (!cleanup()) return;
        reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });

      const effectiveTimeout = Math.max(5000, Number(timeoutMs) || 180000);
      const timer = setTimeout(() => {
        if (!cleanup()) return;
        reject(new Error('MCP 在线接力响应超时，源 Agent 未及时回传结果'));
      }, effectiveTimeout);

      const taskObj = {
        requestId,
        system: String(system || ''),
        user: String(user || ''),
        model: String(model || ''),
        mode: String(mode || 'chat'),
        pickedUp: false,
        graceTimer: null,
        resolve: val => { if (cleanup()) resolve(val); },
        reject: err => { if (cleanup()) reject(err); },
        timer,
        signal,
        onAbort
      };

      if (!onlineNow) {
        // 状态机 RELAY_GRACE_WAIT：暂离线时先挂起等待源 Agent 重新轮询上线，超时再报错
        const waitLimit = Math.max(50, Math.min(effectiveTimeout, Number(graceWaitMs) || 60000));
        taskObj.graceTimer = setTimeout(() => {
          if (taskObj.pickedUp || !cleanup()) return;
          reject(new Error('MCP 在线接力连接已离线（等待源 Agent 接单超时），请在源窗口回复「继续接单」或确认已连接 Pi Workbench MCP'));
        }, waitLimit);
        taskObj.graceTimer.unref?.();
      }

      r.inFlight.set(requestId, taskObj);
      r.queue.push(taskObj);
      flushRelayQueue(profileId);
    });
  }

  const MCP_TOOLS = [
    {
      name: 'pi_workbench_check_compatibility',
      description: '前置过滤检查：由源 Agent 声明自身真实具备的能力，确认是否符合接入 Pi Workbench 的要求。',
      inputSchema: {
        type: 'object',
        properties: {
          hasMcp: { type: 'boolean', description: '当前是否通过 MCP 连接并可调用工具' },
          hasShellOrHttp: { type: 'boolean', description: '是否具备本地命令行或 HTTP 请求能力' },
          hasDirectEntry: { type: 'boolean', description: '是否有 OpenClaw Gateway / 非交互 CLI / 本地 HTTP API 入口' },
          summary: { type: 'string', description: 'Agent 自身环境简述' }
        }
      }
    },
    {
      name: 'pi_workbench_register_agent',
      description: '向 Pi Workbench 自助注册外部 Agent 或本地引擎，并触发真实能力探测与界面实时刷新。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '显示名称' },
          kind: { type: 'string', enum: ['external-agent', 'api'] },
          agentTransport: { type: 'string', enum: ['openclaw-gateway', 'external-cli', 'mcp-relay'] },
          provider: { type: 'string' },
          baseUrl: { type: 'string' },
          apiKey: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          promptMode: { type: 'string', enum: ['stdin', 'arg'] },
          mcpSupport: { type: 'string', enum: ['mcp-config', 'none'] },
          modelsCommand: { type: 'string', description: '列出本 Agent 可用模型的命令，如 "opencode models"（可选，便于自动刷新）' },
          launchCommand: { type: 'string', description: '可选：用于随 Pi Workbench 链式启动该网关或客户端的可执行文件路径/命令' },
          launchArgs: { type: 'array', items: { type: 'string' }, description: '可选：链式启动参数' },
          models: { type: 'array', items: { type: 'string' }, description: '你当前真实可用的全部模型 ID，必须如实枚举，不要编造' }
        },
        required: ['name']
      }
    },
    {
      name: 'pi_workbench_update_models',
      description: '更新已注册 Agent 的真实可用模型列表（模型有变化或注册时未能枚举时使用）。',
      inputSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string', description: '注册回执返回的 profileId' },
          models: { type: 'array', items: { type: 'string' } }
        },
        required: ['profileId', 'models']
      }
    },
    {
      name: 'pi_workbench_await_task',
      description: '仅 mcp-relay 模式使用：等待并领取 Pi Workbench 派发的对话/工作流/工作台任务。',
      inputSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string' },
          timeoutMs: { type: 'number' }
        },
        required: ['profileId']
      }
    },
    {
      name: 'pi_workbench_submit_result',
      description: '仅 mcp-relay 模式使用：回传任务的最终结果或错误说明。',
      inputSchema: {
        type: 'object',
        properties: {
          profileId: { type: 'string' },
          requestId: { type: 'string' },
          text: { type: 'string' },
          isError: { type: 'boolean' },
          error: { type: 'string' }
        },
        required: ['profileId', 'requestId', 'text']
      }
    },
    {
      name: 'workbench_action',
      description: '读取或操作当前打开的 Pi Workbench 工作台语义动作（仅运行任务启用了对应工作台时有效）。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          payload: { type: 'object' }
        },
        required: ['command']
      }
    },
    {
      name: 'read_task_context',
      description: '读取当前运行任务的只读元数据快照。',
      inputSchema: { type: 'object', properties: { taskId: { type: 'string' } } }
    },
    {
      name: 'memory_proposal',
      description: '提交待用户确认的记忆候选。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          kind: { type: 'string' },
          lifespan: { type: 'string' },
          scope: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['content']
      }
    }
  ];

  async function handleRegistration(payload, viaMcp = false) {
    if (!onRegister) throw new Error('尚未配置注册处理器');
    try {
      const result = await onRegister(payload, { viaMcp });
      if (payload?.agentTransport === 'mcp-relay' && result?.profileId) touchRelay(result.profileId);
      state = {
        status: result?.probing ? 'probing' : 'connected',
        startedAt: state.startedAt || Date.now(),
        connectedAt: Date.now(),
        profileId: result.profileId || '',
        name: result.name || payload?.name || '',
        agentTransport: result.agentTransport || payload?.agentTransport || '',
        capabilities: result.capabilities || null,
        error: ''
      };
      return { ok: true, ...result };
    } catch (err) {
      state = { ...state, error: String(err?.message || err) };
      throw err;
    }
  }

  async function handleMcpCall(name, args = {}) {
    if (name === 'pi_workbench_check_compatibility') {
      const eligible = Boolean(args.hasMcp || args.hasShellOrHttp || args.hasDirectEntry);
      return {
        eligible,
        recommendedTransport: args.hasDirectEntry ? 'openclaw-gateway-or-external-cli' : (args.hasMcp ? 'mcp-relay' : 'none'),
        reason: eligible
          ? '符合接入条件，请继续调用 pi_workbench_register_agent 完成注册。'
          : '不符合接入条件：当前不具备本地 MCP 或回环请求/CLI 能力，请终止接入并告知用户原因。'
      };
    }
    if (name === 'pi_workbench_register_agent') {
      return await handleRegistration(args, true);
    }
    if (name === 'pi_workbench_update_models') {
      if (!onUpdateModels) throw new Error('当前无法更新模型列表');
      return { ok: true, ...(await onUpdateModels(args || {})) };
    }
    if (name === 'pi_workbench_await_task') {
      return await awaitRelayTask(args.profileId, args.timeoutMs);
    }
    if (name === 'pi_workbench_submit_result') {
      return submitRelayResult(args.profileId, args);
    }
    if (name === 'workbench_action') {
      if (!onWorkbenchAction) throw new Error('当前没有活动中的工作台任务');
      return await onWorkbenchAction(String(args.command || ''), args.payload || {});
    }
    if (name === 'read_task_context') {
      if (!onReadTaskContext) throw new Error('当前无法读取任务上下文');
      return await onReadTaskContext(args || {});
    }
    if (name === 'memory_proposal') {
      if (!onMemoryProposal) throw new Error('当前无法提交记忆候选');
      return await onMemoryProposal(args || {});
    }
    throw new Error('未知 MCP 工具：' + name);
  }

  function extractAuthToken(req, urlObj, body) {
    const auth = String(req.headers.authorization || '');
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
    const q = urlObj.searchParams.get('token');
    if (q) return q.trim();
    if (body && typeof body.token === 'string') return body.token.trim();
    return '';
  }

  async function ensureListening() {
    if (server && port) return port;
    server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const sendJson = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && urlObj.pathname === '/mcp') {
        const tok = extractAuthToken(req, urlObj, null);
        if (!safeTokenMatch(tok, pairingToken)) { sendJson(401, { ok: false, error: '无效的配对令牌' }); return; }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
        hb.unref?.();
        sseResponses.add(res);
        req.on('close', () => { clearInterval(hb); sseResponses.delete(res); });
        return;
      }

      if (req.method !== 'POST') { sendJson(405, { ok: false, error: 'Method not allowed' }); return; }

      let body;
      try { body = await readJsonBody(req); } catch (err) { sendJson(400, { ok: false, error: err.message }); return; }

      const tok = extractAuthToken(req, urlObj, body);
      if (!safeTokenMatch(tok, pairingToken)) {
        sendJson(401, { ok: false, error: '无效或已过期的配对令牌' });
        return;
      }

      if (urlObj.pathname === '/pair/update-models') {
        try {
          if (!onUpdateModels) throw new Error('当前无法更新模型列表');
          sendJson(200, { ok: true, ...(await onUpdateModels(body || {})) });
        } catch (err) {
          sendJson(400, { ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (urlObj.pathname === '/pair/register') {
        try {
          const out = await handleRegistration(body, false);
          sendJson(200, out);
        } catch (err) {
          sendJson(400, { ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (urlObj.pathname === '/mcp') {
        const rpc = body;
        if (!rpc || rpc.jsonrpc !== '2.0' || !rpc.method) {
          sendJson(400, { jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
          return;
        }
        const replyRpc = (result, errObj = null) => {
          if (rpc.id === undefined || rpc.id === null) { res.writeHead(202); res.end(); return; }
          sendJson(200, errObj
            ? { jsonrpc: '2.0', id: rpc.id, error: errObj }
            : { jsonrpc: '2.0', id: rpc.id, result });
        };

        try {
          if (rpc.method === 'initialize') {
            replyRpc({
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'pi-workbench-onboarding', version: '1.0.0' }
            });
            return;
          }
          if (rpc.method === 'notifications/initialized') { replyRpc({}); return; }
          if (rpc.method === 'tools/list') { replyRpc({ tools: MCP_TOOLS }); return; }
          if (rpc.method === 'tools/call') {
            const out = await handleMcpCall(rpc.params?.name, rpc.params?.arguments || {});
            replyRpc({ content: [{ type: 'text', text: JSON.stringify(out ?? null) }], isError: false });
            return;
          }
          replyRpc(null, { code: -32601, message: 'Method not found: ' + rpc.method });
        } catch (err) {
          if (rpc.method === 'tools/call') {
            replyRpc({ content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
          } else {
            replyRpc(null, { code: -32000, message: String(err?.message || err) });
          }
        }
        return;
      }

      sendJson(404, { ok: false, error: 'Not found' });
    });

    await loadPersistedPairing();
    if (preferredPort > 0) {
      try {
        await new Promise((resolve, reject) => {
          const onErr = err => reject(err);
          server.once('error', onErr);
          server.listen(preferredPort, '127.0.0.1', () => {
            server.removeListener('error', onErr);
            port = server.address().port;
            resolve();
          });
        });
        return port;
      } catch { /* 上次端口被占用，自动回退到随机空闲端口 */ }
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
    return port;
  }

  async function startSession({ rotateToken = false, bundleDir: overrideDir } = {}) {
    await ensureListening();
    if (rotateToken) pairingToken = crypto.randomBytes(16).toString('hex');
    if (overrideDir) activeBundleDir = String(overrideDir);
    state = { status: 'waiting', startedAt: Date.now(), connectedAt: null, profileId: '', name: '', agentTransport: '', capabilities: null, error: '' };
    const artifacts = buildOnboardingArtifacts({ port, token: pairingToken, nodePath, mcpScriptPath, bundleDir: activeBundleDir });
    if (activeBundleDir) await writeConnectBundle(artifacts, mcpScriptPath);
    return {
      ...artifacts,
      state
    };
  }

  function getInfo() {
    if (!port) return { status: state.status, started: false, state, bundleDir: activeBundleDir };
    return {
      ...buildOnboardingArtifacts({ port, token: pairingToken, nodePath, mcpScriptPath, bundleDir: activeBundleDir }),
      started: true,
      state
    };
  }

  function isRelayOnline(profileId) {
    const r = relays.get(String(profileId || ''));
    if (!r) return false;
    return r.waiters.length > 0 || (Date.now() - (r.lastSeenAt || 0) <= 65000);
  }

  async function close() {
    for (const res of sseResponses) {
      try { res.end(); } catch {}
    }
    sseResponses.clear();
    for (const r of relays.values()) {
      for (const w of r.waiters.splice(0)) w({ idle: true });
      for (const t of r.inFlight.values()) {
        clearTimeout(t.timer);
        if (t.graceTimer) { clearTimeout(t.graceTimer); t.graceTimer = null; }
        t.reject(new Error('服务已关闭，所有外部接力连接已断开'));
      }
      r.inFlight.clear();
      r.queue.length = 0;
    }
    if (server) {
      const s = server; server = null; port = 0;
      s.closeAllConnections?.();
      await new Promise(resolve => s.close(() => resolve()));
    }
  }

  function markProbed(profileId, capabilities) {
    if (String(state.profileId || '') === String(profileId || '')) {
      state = { ...state, status: 'connected', capabilities: capabilities || state.capabilities };
    }
  }

  return {
    startSession,
    getInfo,
    markProbed,
    dispatchRelayTask,
    isRelayOnline,
    getRelayState,
    close
  };
}

module.exports = {
  createPairingServer,
  buildOnboardingArtifacts,
  writeConnectBundle
};
