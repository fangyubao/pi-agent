'use strict';
window.PiProviderSettings = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const capsApi = () => window.PiProviderCapabilities;

  function parseArgsInput(raw) {
    if (Array.isArray(raw)) return raw.map(x => String(x || '')).filter(Boolean).slice(0, 24);
    const out = [], s = String(raw || '').trim();
    let cur = '', quote = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
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
    return out.slice(0, 24);
  }

  function formatArgsInput(args) {
    if (!Array.isArray(args)) return String(args || '');
    return args.map(x => /\s/.test(String(x)) ? JSON.stringify(String(x)) : String(x)).join(' ');
  }

  async function mount(root, { onChange, notify }) {
    let config = await window.PiProviderManager.getConfig();
    let selectedId = config.profileId || config.profiles?.[0]?.id;
    let profiles = config.profiles || [];
    let available = new Map();
    let status = '';
    let draft = null;
    let displayed = null;

    function selected() {
      return draft || profiles.find(p => p.id === selectedId) || { id: 'default', name: '默认 API', kind: 'api', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', models: [] };
    }

    function readForm() {
      const current = displayed || selected();
      const external = capsApi().isExternalAgent(current);
      const models = [...root.querySelectorAll('[data-model-slot]')].map(x => x.value).filter(Boolean);
      const modelEfforts = {}, modelLimits = { ...(current.modelLimits || {}) };
      for (const slot of root.querySelectorAll('[data-model-slot]')) if (slot.value) {
        modelEfforts[slot.value] = root.querySelector('[data-effort-slot="' + slot.dataset.modelSlot + '"]')?.value || 'off';
        const limits = { ...(modelLimits[slot.value] || {}) };
        for (const [field, attribute] of [['contextWindow', 'data-limit-slot'], ['maxOutputTokens', 'data-output-slot']]) {
          const el = root.querySelector('[' + attribute + '="' + slot.dataset.modelSlot + '"]');
          const value = Number(el?.value);
          if (Number.isFinite(value) && value >= 1) limits[field] = Math.floor(value);
          else delete limits[field];
        }
        if ((limits.contextWindow || limits.maxOutputTokens) && !('source' in limits)) limits.source = 'manual';
        if (Object.keys(limits).length) modelLimits[slot.value] = limits;
        else delete modelLimits[slot.value];
      }

      const apiKey = root.querySelector('#provider-key')?.value.trim() || '';
      const makeActive = Boolean(root.querySelector('#provider-active')?.checked);
      const name = root.querySelector('#provider-name')?.value.trim() || (external ? '外部 Agent' : 'API');
      const uniqueModels = [...new Set(models)].slice(0, 4);
      const chosenModel = uniqueModels.includes(current.model) ? current.model : (uniqueModels[0] || '');

      if (external) {
        const transport = root.querySelector('#provider-agent-transport')?.value || current.agentTransport || 'openclaw-gateway';
        const urlEl = root.querySelector('#provider-url');
        const cmdEl = root.querySelector('#provider-cli-command');
        const argsEl = root.querySelector('#provider-cli-args');
        const promptEl = root.querySelector('#provider-cli-prompt-mode');
        const mcpEl = root.querySelector('#provider-cli-mcp-support');
        const endpointChanged = transport !== (current.agentTransport || '')
          || (transport === 'openclaw-gateway' && (urlEl?.value.trim() || '') !== String(current.baseUrl || ''))
          || (transport === 'external-cli' && ((cmdEl?.value.trim() || '') !== String(current.command || '') || (mcpEl?.value || 'mcp-config') !== (current.mcpSupport || 'mcp-config')));
        const nextCapabilities = endpointChanged
          ? capsApi().defaultCapabilities({ kind: 'external-agent', agentTransport: transport })
          : capsApi().normalizeCapabilities(current.capabilities, { kind: 'external-agent', agentTransport: transport });
        return {
          profileId: current.id,
          kind: 'external-agent',
          agentTransport: transport,
          provider: transport,
          name,
          baseUrl: transport === 'openclaw-gateway' ? (urlEl?.value.trim() || '') : '',
          command: transport === 'external-cli' ? (cmdEl?.value.trim() || '') : '',
          args: transport === 'external-cli' ? parseArgsInput(argsEl?.value || '') : [],
          promptMode: promptEl?.value === 'arg' ? 'arg' : 'stdin',
          mcpSupport: transport === 'openclaw-gateway' ? 'none' : (mcpEl?.value === 'none' ? 'none' : 'mcp-config'),
          capabilities: nextCapabilities,
          apiKey,
          models: uniqueModels,
          model: chosenModel,
          modelEfforts,
          modelLimits,
          modelMetadata: current.modelMetadata || {},
          makeActive
        };
      }

      const advanced = { quirks: {}, extraHeaders: {}, extraBody: {} };
      for (const box of root.querySelectorAll('[data-quirk]')) if (box.checked) advanced.quirks[box.dataset.quirk] = true;
      for (const line of (root.querySelector('#provider-extra-headers')?.value || '').split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue;
        const i = t.indexOf(':');
        if (i < 1) throw new Error('附加请求头格式应为“名称: 值”：' + t.slice(0, 40));
        advanced.extraHeaders[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      const bodyText = (root.querySelector('#provider-extra-body')?.value || '').trim();
      if (bodyText) {
        let v; try { v = JSON.parse(bodyText); } catch { throw new Error('附加请求字段不是有效的 JSON'); }
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('附加请求字段需要是 JSON 对象，例如 {"top_p":0.9}');
        advanced.extraBody = v;
      }
      return {
        profileId: current.id,
        kind: 'api',
        advanced,
        capabilities: current.capabilities ? capsApi().normalizeCapabilities(current.capabilities, current) : undefined,
        name,
        provider: root.querySelector('#provider-kind').value,
        baseUrl: root.querySelector('#provider-url').value.trim(),
        apiKey,
        models: uniqueModels,
        modelEfforts,
        modelLimits,
        modelMetadata: current.modelMetadata || {},
        model: chosenModel,
        makeActive
      };
    }

    // ---- 模型档位：仅列出具备工作流能力的配置
    const vendorsOf = () => profiles
      .filter(x => capsApi().supportsMode(x, 'workflow'))
      .map(x => ({ profileId: x.id, vendor: x.name, models: [...new Set([...(x.models || []), ...(x.model ? [x.model] : [])])] }))
      .filter(v => v.models.length);

    function tiersHtml() {
      const tiers = window.PiModelTiers.normalize(config.modelTiers), vendors = vendorsOf(), labels = window.PiModelTiers.LABELS;
      const rows = tiers.map((t, i) => {
        const vendor = vendors.find(v => v.profileId === (t && t.profileId)) || null;
        return '<div class="tier-row" data-tier="' + i + '"><span class="tier-name">' + labels[i] + '</span>' +
          '<select class="dialog-input" data-tier-vendor="' + i + '" aria-label="' + labels[i] + ' 厂商"><option value="">不使用</option>' + vendors.map(v => '<option value="' + esc(v.profileId) + '"' + (vendor && vendor.profileId === v.profileId ? ' selected' : '') + '>' + esc(v.vendor) + '</option>').join('') + '</select>' +
          '<select class="dialog-input" data-tier-model="' + i + '" aria-label="' + labels[i] + ' 模型"' + (vendor ? '' : ' disabled') + '>' + (vendor ? vendor.models.map(m => '<option value="' + esc(m) + '"' + (t.model === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('') : '<option value="">先选厂商</option>') + '</select></div>';
      }).join('');
      return '<section class="provider-tiers" id="provider-tiers"><div class="provider-model-heading"><strong>模型档位 · 最多 5 档</strong></div><p class="settings-note">档位 1 最轻最便宜，档位 5 最强。工作流里每个节点按难度自动用这些档位的模型；只配一档，所有节点都用它；两档就分成轻重两段；一档都不配则全部用主模型。仅展示支持工作流的 API 与外部 Agent。</p>' + rows + '<p class="provider-status" id="tier-status" role="status"></p></section>';
    }

    function wireTiers() {
      const box = root.querySelector('#provider-tiers'); if (!box) return;
      const vendors = vendorsOf();
      const save = async () => {
        const tiers = [...Array(5).keys()].map(i => { const pid = box.querySelector('[data-tier-vendor="' + i + '"]').value, m = box.querySelector('[data-tier-model="' + i + '"]').value; return pid && m ? { profileId: pid, model: m } : null; });
        const r = await window.piDesktop.provider.saveTiers(tiers), label = box.querySelector('#tier-status');
        if (r && r.ok) { config = r.config; onChange(config); label.textContent = '已保存 ' + window.PiModelTiers.configured(config.modelTiers).length + ' 档'; } else label.textContent = (r && r.error) || '保存失败';
      };
      box.querySelectorAll('[data-tier-vendor]').forEach(sel => sel.addEventListener('change', () => {
        const i = sel.dataset.tierVendor, model = box.querySelector('[data-tier-model="' + i + '"]'), v = vendors.find(x => x.profileId === sel.value);
        model.innerHTML = v ? v.models.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('') : '<option value="">先选厂商</option>';
        model.disabled = !v; save();
      }));
      box.querySelectorAll('[data-tier-model]').forEach(sel => sel.addEventListener('change', save));
    }

    function capabilityPanelHtml(p) {
      const caps = capsApi().normalizeCapabilities(p.capabilities, p);
      const badges = capsApi().badgeItems(caps, p);
      const modeTag = caps.mode === 'probed' ? '已实测' : (caps.mode === 'assumed' ? '默认假设（可点右侧实测）' : '尚未探测（保存或测试时自动实测）');
      const details = Object.entries(caps.checks || {}).map(([k, v]) => '<div>' + esc(k + ': ' + v) + '</div>').join('');
      return '<div class="cap-panel" id="provider-capability-panel">' +
        '<div class="cap-panel-head"><strong>能力矩阵 · ' + esc(modeTag) + '</strong><button type="button" class="button" id="provider-probe-caps">自动检测能力</button></div>' +
        '<div class="cap-badges">' + badges.map(b => '<span class="cap-badge ' + b.state + '" data-cap-key="' + esc(b.key) + '" title="' + esc(b.detail) + '">' + (b.state === 'unprobed' ? '○' : b.ok ? '✓' : '✕') + ' ' + esc(b.label) + '</span>').join('') + '</div>' +
        (details ? '<div class="cap-details">' + details + '</div>' : '') +
        '</div>';
    }

    function modelSlotsHtml(p, all, chosen, heading) {
      const isExt = capsApi().isExternalAgent(p);
      return '<div class="provider-model-heading"><strong>' + heading + '</strong>' +
        (isExt ? '' : '<button type="button" class="button" id="refresh-models">刷新厂商模型</button>') +
        '</div><p class="provider-status" id="provider-status" role="status">' + esc(status || ('已选 ' + chosen.length + ' / 4 个')) + '</p>' +
        '<div class="provider-slots">' + Array.from({ length: 4 }, (_, i) => {
          const selectedModel = chosen[i];
          return '<label class="dialog-label">' + (isExt ? 'Agent / 模型 ' : '模型 ') + (i + 1) + '<select class="dialog-input" data-model-slot="' + i + '" aria-label="常用模型 ' + (i + 1) + '"><option value="">不启用</option>' + all.map(x => '<option value="' + esc(x) + '" ' + (selectedModel === x ? 'selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>';
        }).join('') + '</div>';
    }

    function apiFormHtml(p, all, chosen) {
      return '<form id="provider-form"><div class="provider-grid">' +
        '<label class="dialog-label">显示名称<input class="dialog-input" id="provider-name" value="' + esc(p.name) + '" required maxlength="60"></label>' +
        '<label class="dialog-label">接口协议<select class="dialog-input" id="provider-kind">' + window.PiProviderProtocols.PROTOCOLS.map(x => '<option value="' + x.id + '">' + esc(x.label) + '</option>').join('') + '</select><small class="settings-note" id="provider-kind-hint"></small></label>' +
        '<label class="dialog-label">API 地址<input class="dialog-input" id="provider-url" type="url" value="' + esc(p.baseUrl) + '" required></label>' +
        '<label class="dialog-label">API Key<div class="provider-key-control"><input class="dialog-input" id="provider-key" type="password" autocomplete="new-password" placeholder="' + (p.hasApiKey ? '已安全保存；留空不修改' : '填写 API Key') + '"><button type="button" class="provider-key-toggle" id="provider-key-toggle" aria-pressed="false" aria-label="显示 API Key" title="显示 API Key"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button></div></label></div>' +
        modelSlotsHtml(p, all, chosen, '常用模型 · 最多 4 个') +
        capabilityPanelHtml(p) +
        '<details class="provider-advanced" id="provider-compat"><summary>兼容设置（接口不完全标准时再改）</summary><p class="settings-note">OpenAI 官方的 gpt-5 / o 系列会自动处理，不用勾。其他服务如果报“不认识 max_tokens / temperature / response_format”，在这里打开对应开关；需要额外请求头（如 Azure 的 api-key）或额外字段时填在下面。</p>' + [['maxCompletionTokens', '用 max_completion_tokens 代替 max_tokens'], ['noTemperature', '不发送 temperature'], ['noJsonMode', '不要求 JSON 输出模式（拆解/导读改用提示词约束）']].map(([k, l]) => '<label class="provider-active"><input type="checkbox" data-quirk="' + k + '" ' + (p.advanced?.quirks?.[k] ? 'checked' : '') + '> ' + l + '</label>').join('') + '<label class="dialog-label">附加请求头（每行 名称: 值）<textarea class="dialog-input" id="provider-extra-headers" rows="2" placeholder="api-key: xxx">' + esc(Object.entries(p.advanced?.extraHeaders || {}).map(([k, v]) => k + ': ' + v).join('\n')) + '</textarea></label><label class="dialog-label">附加请求字段（JSON 对象）<textarea class="dialog-input" id="provider-extra-body" rows="2" placeholder="{&quot;top_p&quot;: 0.9}">' + esc(Object.keys(p.advanced?.extraBody || {}).length ? JSON.stringify(p.advanced.extraBody) : '') + '</textarea></label></details>' +
        '<details class="provider-advanced" id="provider-advanced"><summary>高级选项（上下文容量、输出预算、默认思考强度）</summary><p class="settings-note">一般不需要改。留空就用厂商或运行时默认值；输出预算不等于输入窗口，无元数据时运行时默认 32768，不代表模型上限。思考强度平时直接在聊天框里切换。</p><div class="provider-slots">' + Array.from({ length: 4 }, (_, i) => {
          const selectedModel = chosen[i], known = p.modelMetadata?.[selectedModel]?.contextWindow, manual = p.modelLimits?.[selectedModel]?.contextWindow;
          const knownOutput = p.modelMetadata?.[selectedModel]?.maxOutputTokens, manualOutput = p.modelLimits?.[selectedModel]?.maxOutputTokens;
          return '<div class="dialog-label adv-slot"><strong data-adv-name="' + i + '">' + esc(selectedModel || '模型 ' + (i + 1) + '（未启用）') + '</strong><select class="dialog-input effort-slot" data-effort-slot="' + i + '" aria-label="模型 ' + (i + 1) + ' 默认思考强度">' + [['off', '默认 / 不启用思考'], ['minimal', '最小'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([v, label]) => '<option value="' + v + '" ' + ((p.modelEfforts?.[selectedModel] || 'off') === v ? 'selected' : '') + '>' + label + '</option>').join('') + '</select><span>上下文容量（tokens）</span><input class="dialog-input model-limit" data-limit-slot="' + i + '" data-limit-model="' + esc(selectedModel || '') + '" type="number" min="1024" step="1" value="' + esc(manual ?? '') + '" placeholder="' + esc(known ? '厂商：' + known : '未知 · 可手动填写') + '" aria-label="模型 ' + (i + 1) + ' 上下文容量"><span>每次生成输出预算（tokens）</span><input class="dialog-input model-limit" data-output-slot="' + i + '" type="number" min="1" step="1" value="' + esc(manualOutput ?? '') + '" placeholder="' + esc(knownOutput ? '厂商：' + knownOutput : '32768 · 运行时默认') + '" aria-label="模型 ' + (i + 1) + ' 每次生成输出预算"></div>';
        }).join('') + '</div></details>' +
        '<label class="dialog-label">手动添加模型 ID（接口不提供列表时）<div class="provider-manual"><input class="dialog-input" id="provider-manual-model" placeholder="例如 model-id"><button type="button" class="button" id="provider-import">加入可选列表</button></div></label>' +
        '<label class="provider-active"><input type="checkbox" id="provider-active" ' + (config.profileId === p.id || !profiles.length || Boolean(draft && draft.id === p.id) ? 'checked' : '') + '> 保存后设为当前 API</label>' +
        '<div class="provider-actions"><button class="button primary" type="submit">保存配置</button><button class="button" id="provider-test" type="button">测试 API 通信</button><button class="button danger" id="provider-delete" type="button" ' + (draft || profiles.length < 2 ? 'disabled' : '') + '>删除此 API</button></div>' +
        '<p class="settings-note">API Key 由系统安全存储加密，不进入对话和提示词。测试使用当前表单和所选模型发送一条小型流式请求，可能产生少量 API 费用；不会自动保存配置。</p></form>';
    }

    function externalFormHtml(p, all, chosen) {
      const transport = p.agentTransport === 'external-cli' ? 'external-cli' : 'openclaw-gateway';
      const tMeta = capsApi().transportById(transport);
      const endpointFields = transport === 'openclaw-gateway'
        ? '<label class="dialog-label">Gateway WebSocket 地址<input class="dialog-input" id="provider-url" type="text" value="' + esc(p.baseUrl || tMeta.defaultBase) + '" placeholder="ws://127.0.0.1:18789" required></label>' +
          '<label class="dialog-label">Gateway Token（可选）<div class="provider-key-control"><input class="dialog-input" id="provider-key" type="password" autocomplete="new-password" placeholder="' + (p.hasApiKey ? '已安全保存；留空不修改' : '填写网关 Token') + '"><button type="button" class="provider-key-toggle" id="provider-key-toggle" aria-pressed="false" aria-label="显示 Token" title="显示 Token"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button></div></label>'
        : '<label class="dialog-label">CLI 启动命令<input class="dialog-input" id="provider-cli-command" value="' + esc(p.command || '') + '" placeholder="例如 claude、codex、node 或可执行文件路径" required></label>' +
          '<label class="dialog-label">固定命令行参数（空格分隔）<input class="dialog-input" id="provider-cli-args" value="' + esc(formatArgsInput(p.args)) + '" placeholder="例如 --print --output-format stream-json"></label>' +
          '<label class="dialog-label">指令传入方式<select class="dialog-input" id="provider-cli-prompt-mode"><option value="stdin"' + (p.promptMode !== 'arg' ? ' selected' : '') + '>标准输入（stdin，推荐长上下文）</option><option value="arg"' + (p.promptMode === 'arg' ? ' selected' : '') + '>追加在命令行末尾</option></select></label>' +
          '<label class="dialog-label">工作台 MCP 桥接<select class="dialog-input" id="provider-cli-mcp-support"><option value="mcp-config"' + (p.mcpSupport !== 'none' ? ' selected' : '') + '>自动挂载工作台 MCP（PI_WORKBENCH_MCP_CONFIG）</option><option value="none"' + (p.mcpSupport === 'none' ? ' selected' : '') + '>不挂载 MCP（纯对话 / 工作流）</option></select></label>' +
          '<label class="dialog-label">Agent 令牌 / 密钥（可选，注入 PI_EXTERNAL_AGENT_TOKEN）<div class="provider-key-control"><input class="dialog-input" id="provider-key" type="password" autocomplete="new-password" placeholder="' + (p.hasApiKey ? '已安全保存；留空不修改' : '不需要可留空') + '"><button type="button" class="provider-key-toggle" id="provider-key-toggle" aria-pressed="false" aria-label="显示令牌" title="显示令牌"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button></div></label>';
      const effortHiddenSlots = Array.from({ length: 4 }, (_, i) => '<input type="hidden" data-effort-slot="' + i + '" value="off">').join('');
      return '<form id="provider-form">' +
        '<details class="provider-advanced" id="provider-ai-parse"><summary>AI 辅助解析外部 Agent 说明（可选）</summary><p class="settings-note">把任意 CLI Agent 的 --help、README 或网关说明粘进来，由当前已配置模型提取命令和参数填入表单（真实能力仍由下方实测探针决定）。</p><textarea class="dialog-input" id="provider-parse-text" rows="3" placeholder="例如：claude -p --mcp-config ... 或 OpenClaw Gateway ws://127.0.0.1:18789 token=..."></textarea><div class="provider-actions"><button type="button" class="button" id="provider-parse-btn">AI 识别并填充</button></div></details>' +
        '<div class="provider-grid">' +
        '<label class="dialog-label">显示名称<input class="dialog-input" id="provider-name" value="' + esc(p.name) + '" required maxlength="60"></label>' +
        '<label class="dialog-label">接入协议<select class="dialog-input" id="provider-agent-transport">' + capsApi().AGENT_TRANSPORTS.map(x => '<option value="' + x.id + '"' + (transport === x.id ? ' selected' : '') + '>' + esc(x.label) + '</option>').join('') + '</select><small class="settings-note" id="provider-kind-hint">' + esc(tMeta.hint) + '</small></label>' +
        endpointFields + '</div>' +
        modelSlotsHtml(p, all, chosen, '目标 Agent ID / 路由名 · 最多 4 个') +
        effortHiddenSlots +
        capabilityPanelHtml(p) +
        '<label class="dialog-label">添加 Agent ID / 模型名（例如 OpenClaw agentId 或 CLI 模型名）<div class="provider-manual"><input class="dialog-input" id="provider-manual-model" placeholder="例如 main 或 coder"><button type="button" class="button" id="provider-import">加入可选列表</button></div></label>' +
        '<label class="provider-active"><input type="checkbox" id="provider-active" ' + (config.profileId === p.id || !profiles.length || Boolean(draft && draft.id === p.id) ? 'checked' : '') + '> 保存后设为当前使用</label>' +
        '<div class="provider-actions"><button class="button primary" type="submit">检测并保存</button><button class="button" id="provider-test" type="button">实测全部能力</button><button class="button danger" id="provider-delete" type="button" ' + (draft || profiles.length < 2 ? 'disabled' : '') + '>删除此 Agent</button></div>' +
        '<p class="settings-note">外部 Agent 接入后会进行 4 级实测（对话连通、会话隔离与工作流并发、本地工作台 MCP 回环回调）；未通过某项能力的 Agent 会自动从对应模式的聊天框下拉菜单中隐藏。</p></form>';
    }

    function draw(preserve = null) {
      if (!root.isConnected) return;
      const p = preserve || selected();
      displayed = p;
      const isExt = capsApi().isExternalAgent(p);
      const found = available.get(p.id) || p.models || (isExt ? ['main'] : []);
      const all = [...new Set([...found, ...(p.models || []), ...(p.model ? [p.model] : [])])];
      const chosen = (p.models?.length ? p.models : [p.model].filter(Boolean)).slice(0, 4);

      root.innerHTML = '<div class="setting-section-heading"><div><h2>API 与外部 Agent ' + (window.PiHelp?.button('context-capacity') || '') + '</h2><p>可配置标准 LLM API，也可导入本地 CLI 或 OpenClaw Gateway 等外部 Agent；系统会按实测能力自动匹配可用模式。</p></div></div>';
      const formHtml = isExt ? externalFormHtml(p, all, chosen) : apiFormHtml(p, all, chosen);

      const rows = [...profiles, ...(draft ? [draft] : [])];
      if (!rows.some(x => x.id === p.id)) rows.push(p);
      const items = rows.map(x => {
        const open = x.id === p.id;
        const extRow = capsApi().isExternalAgent(x);
        const caps = capsApi().normalizeCapabilities(x.capabilities, x);
        const sub = extRow
          ? (caps.mode === 'unprobed' ? '未检测能力' : [!caps.workbench && '无工作台', !caps.workflow && '无工作流'].filter(Boolean).join(' · ') || '全模式可用')
          : (x.models?.length ? x.models.length + ' 个模型' : '未选模型');
        return '<details class="provider-item" data-profile="' + esc(x.id) + '"' + (open ? ' open' : '') + '><summary><span class="provider-item-name">' + esc(draft && x.id === draft.id ? (extRow ? '新外部 Agent（未保存）' : '新 API（未保存）') : x.name) + '</span>' + (extRow ? '<span class="provider-item-kind">外部 Agent</span>' : '') + (x.id === config.profileId ? '<span class="provider-item-badge">当前</span>' : '') + '<span class="provider-item-sub">' + esc(sub) + '</span></summary>' + (open ? formHtml : '') + '</details>';
      }).join('');

      root.innerHTML += '<div class="provider-list">' + items + '</div><div class="provider-add-row"><button type="button" class="button provider-add-bottom" id="provider-add">＋ 新增 API</button><button type="button" class="button provider-add-bottom" id="provider-import-agent">＋ 导入外部 Agent</button></div>' + tiersHtml();

      if (!isExt) {
        root.querySelector('#provider-kind').value = p.provider || 'openai-compatible';
        const kind = root.querySelector('#provider-kind'), hint = root.querySelector('#provider-kind-hint'), url = root.querySelector('#provider-url');
        const showHint = () => { hint.textContent = window.PiProviderProtocols.byId(kind.value).hint; };
        let last = kind.value; showHint();
        kind.onchange = () => {
          const from = window.PiProviderProtocols.byId(last), to = window.PiProviderProtocols.byId(kind.value);
          if (!url.value.trim() || url.value.replace(/\/+$/, '') === from.defaultBase.replace(/\/+$/, '')) url.value = to.defaultBase;
          last = kind.value; showHint();
        };
      } else {
        const transportSel = root.querySelector('#provider-agent-transport');
        transportSel.onchange = () => {
          const form = readForm(), key = root.querySelector('#provider-key')?.value || '';
          const tMeta = capsApi().transportById(transportSel.value);
          draw({ ...p, ...form, id: p.id, agentTransport: transportSel.value, baseUrl: tMeta.defaultBase, capabilities: capsApi().defaultCapabilities({ kind: 'external-agent', agentTransport: transportSel.value }) });
          const kEl = root.querySelector('#provider-key'); if (kEl) kEl.value = key;
        };
        const parseBtn = root.querySelector('#provider-parse-btn');
        if (parseBtn) {
          parseBtn.onclick = async () => {
            const rawText = root.querySelector('#provider-parse-text')?.value.trim() || '';
            const label = root.querySelector('#provider-status');
            if (!rawText) { label.textContent = '请先粘贴外部 Agent 的命令帮助或接入说明'; return; }
            parseBtn.disabled = true; label.textContent = '正在用模型识别配置…';
            try {
              const r = await window.PiProviderManager.parseAgentImport({ rawText });
              if (!r?.ok) throw new Error(r?.error || '识别失败');
              const extracted = r.config, key = root.querySelector('#provider-key')?.value || '';
              available.set(p.id, extracted.models?.length ? extracted.models : ['main']);
              status = '已根据说明填充表单；请核对参数后点击“检测并保存”';
              draw({
                ...p,
                name: extracted.name || p.name,
                agentTransport: extracted.agentTransport,
                baseUrl: extracted.gatewayUrl || (extracted.agentTransport === 'openclaw-gateway' ? 'ws://127.0.0.1:18789' : ''),
                command: extracted.command || '',
                args: extracted.args || [],
                promptMode: extracted.promptMode || 'stdin',
                mcpSupport: extracted.mcpSupport || 'mcp-config',
                models: extracted.models?.length ? extracted.models : ['main'],
                model: extracted.models?.[0] || 'main',
                capabilities: capsApi().defaultCapabilities({ kind: 'external-agent', agentTransport: extracted.agentTransport })
              });
              const kEl = root.querySelector('#provider-key'); if (kEl) kEl.value = key;
            } catch (err) {
              if (label.isConnected) label.textContent = 'AI 解析失败：' + err.message;
            } finally {
              parseBtn.disabled = false;
            }
          };
        }
      }

      wireTiers();

      {
        const keyInput = root.querySelector('#provider-key'), toggle = root.querySelector('#provider-key-toggle');
        if (keyInput && toggle) {
          const labelName = isExt ? 'Token' : 'API Key';
          const setVisible = visible => {
            keyInput.type = visible ? 'text' : 'password';
            toggle.setAttribute('aria-pressed', String(visible));
            toggle.setAttribute('aria-label', (visible ? '隐藏 ' : '显示 ') + labelName);
            toggle.title = (visible ? '隐藏 ' : '显示 ') + labelName;
          };
          toggle.onclick = async () => {
            if (keyInput.type === 'password' && !keyInput.value && p.hasApiKey && !keyInput.dataset.revealed) {
              toggle.disabled = true;
              try {
                const result = await window.piDesktop.provider.revealKey(p.id);
                if (!result?.ok) throw new Error(result?.error || labelName + ' 读取失败');
                keyInput.value = result.key || ''; keyInput.dataset.revealed = 'true';
              } catch (error) { notify(error.message); return; }
              finally { toggle.disabled = false; }
            }
            setVisible(keyInput.type === 'password');
          };
        }
      }

      if (!isExt) {
        for (const select of root.querySelectorAll('[data-model-slot]')) select.addEventListener('change', () => {
          const slot = select.dataset.modelSlot, limits = p.modelLimits?.[select.value], metadata = p.modelMetadata?.[select.value];
          root.querySelector('[data-effort-slot="' + slot + '"]').value = p.modelEfforts?.[select.value] || 'off';
          const nm = root.querySelector('[data-adv-name="' + slot + '"]'); if (nm) nm.textContent = select.value || '模型 ' + (Number(slot) + 1) + '（未启用）';
          const context = root.querySelector('[data-limit-slot="' + slot + '"]'), output = root.querySelector('[data-output-slot="' + slot + '"]');
          context.dataset.limitModel = select.value;
          context.value = limits?.contextWindow ?? '';
          context.placeholder = metadata?.contextWindow ? '厂商：' + metadata.contextWindow : '未知 · 可手动填写';
          output.value = limits?.maxOutputTokens ?? '';
          output.placeholder = metadata?.maxOutputTokens ? '厂商：' + metadata.maxOutputTokens : '32768 · 运行时默认';
        });
      }

      root.querySelectorAll('.provider-item').forEach(d => d.querySelector('summary').addEventListener('click', e => {
        if (d.dataset.profile === p.id) return;
        e.preventDefault(); selectedId = d.dataset.profile; draft = null; status = ''; draw();
      }));

      root.querySelector('#provider-add').onclick = () => {
        draft = { id: 'profile-' + Date.now().toString(36), name: '新 API', kind: 'api', provider: 'openai-compatible', baseUrl: window.PiProviderProtocols.byId('openai-compatible').defaultBase, models: [] };
        selectedId = draft.id; status = '填写连接信息后刷新模型'; draw();
      };

      root.querySelector('#provider-import-agent').onclick = () => {
        draft = {
          id: 'agent-' + Date.now().toString(36),
          name: '外部 Agent',
          kind: 'external-agent',
          agentTransport: 'openclaw-gateway',
          provider: 'openclaw-gateway',
          baseUrl: 'ws://127.0.0.1:18789',
          command: '',
          args: [],
          promptMode: 'stdin',
          mcpSupport: 'mcp-config',
          capabilities: capsApi().defaultCapabilities({ kind: 'external-agent', agentTransport: 'openclaw-gateway' }),
          models: ['main'],
          model: 'main'
        };
        selectedId = draft.id; status = '配置 OpenClaw 网关或本地 CLI 后可自动检测支持模式'; draw();
      };

      const refreshBtn = root.querySelector('#refresh-models');
      if (refreshBtn) {
        refreshBtn.onclick = async () => {
          const form = readForm(), key = root.querySelector('#provider-key').value;
          root.querySelector('#provider-status').textContent = '正在读取厂商模型…';
          const result = await window.PiProviderManager.listModels(form);
          if (!result.ok) { root.querySelector('#provider-status').textContent = result.error; return; }
          available.set(p.id, result.models || []);
          status = result.manualOnly ? '接口未提供模型列表，请手动添加模型 ID' : '已读取 ' + (result.models || []).length + ' 个模型，请在四个模型槽中选择';
          const next = { ...p, ...form, id: p.id, models: form.models.length ? form.models : (result.models || []).slice(0, 4), modelMetadata: { ...(p.modelMetadata || {}), ...(result.modelMetadata || {}) } };
          draw(next); root.querySelector('#provider-key').value = key;
        };
      }

      root.querySelector('#provider-import').onclick = () => {
        const id = root.querySelector('#provider-manual-model').value.trim(); if (!id) return;
        const form = readForm(), key = root.querySelector('#provider-key')?.value || '';
        available.set(p.id, [...new Set([...all, id])]);
        draw({ ...p, ...form, id: p.id, models: form.models.length < 4 ? [...new Set([...form.models, id])] : form.models });
        const kEl = root.querySelector('#provider-key'); if (kEl) kEl.value = key;
      };

      const runCapabilityProbe = async ({ keepKey = true } = {}) => {
        const form = readForm(), key = root.querySelector('#provider-key')?.value || '';
        const btn = root.querySelector('#provider-probe-caps'), testBtn = root.querySelector('#provider-test'), label = root.querySelector('#provider-status');
        if (btn) btn.disabled = true; if (testBtn) testBtn.disabled = true;
        label.textContent = '正在实测能力（对话 / 工作流并发隔离 / 工作台工具）…';
        try {
          const res = await window.PiProviderManager.probeCapabilities(form);
          if (!root.isConnected) return null;
          if (res?.capabilities) {
            status = res.ok ? '能力检测完成：支持范围已更新' : ('能力检测完成（存在受限项）：' + (res.error || ''));
            const next = { ...p, ...form, id: p.id, capabilities: res.capabilities };
            draw(next);
            const kEl = root.querySelector('#provider-key'); if (keepKey && kEl) kEl.value = key;
            return res;
          }
          label.textContent = '能力检测失败：' + (res?.error || '未知错误');
          return res;
        } catch (err) {
          if (label.isConnected) label.textContent = '能力检测失败：' + err.message;
          return { ok: false, error: err.message };
        } finally {
          if (btn && btn.isConnected) btn.disabled = false;
          if (testBtn && testBtn.isConnected) testBtn.disabled = false;
        }
      };

      const probeBtn = root.querySelector('#provider-probe-caps');
      if (probeBtn) probeBtn.onclick = () => { void runCapabilityProbe(); };

      root.querySelector('#provider-test').onclick = async () => {
        if (isExt) { void runCapabilityProbe(); return; }
        const button = root.querySelector('#provider-test'), label = root.querySelector('#provider-status');
        button.disabled = true; label.textContent = '正在测试当前表单中的模型流式通信（最长 30 秒）…';
        try {
          const result = await window.PiProviderManager.test(readForm());
          if (!root.isConnected || root.querySelector('#provider-test') !== button) return;
          label.textContent = (result.ok ? '测试成功：' + result.message : '测试失败：' + result.error) + (result.elapsedMs != null ? ' · ' + (result.elapsedMs / 1000).toFixed(1) + ' 秒' : '') + (result.httpStatus ? ' · HTTP ' + result.httpStatus : '');
        } catch (error) { if (label.isConnected) label.textContent = '测试失败：' + error.message; }
        finally { button.disabled = false; }
      };

      root.querySelector('#provider-form').onsubmit = async e => {
        e.preventDefault();
        try {
          const form = readForm();
          if (isExt && form.capabilities?.mode === 'unprobed') {
            const label = root.querySelector('#provider-status');
            label.textContent = '首次保存外部 Agent，正在自动实测可用能力…';
            const probeRes = await window.PiProviderManager.probeCapabilities(form).catch(err => ({ ok: false, error: err.message }));
            if (probeRes?.capabilities) form.capabilities = probeRes.capabilities;
          }
          const refreshEmpty = !isExt && !form.models.length && (!p.hasApiKey || Boolean(draft));
          let result = await window.PiProviderManager.saveConfig(form);
          if (!result.ok) throw new Error(result.error);
          config = result.config; profiles = config.profiles || []; selectedId = p.id; draft = null;
          status = '配置已保存，聊天框已同步';
          if (refreshEmpty) {
            const catalog = await window.PiProviderManager.listModels({ profileId: p.id });
            if (catalog.ok) {
              available.set(p.id, catalog.models || []);
              const models = (catalog.models || []).slice(0, 4);
              result = await window.PiProviderManager.saveConfig({ profileId: p.id, models, model: models[0] || '', modelMetadata: catalog.modelMetadata || {}, makeActive: form.makeActive });
              if (!result.ok) throw new Error(result.error);
              config = result.config; profiles = config.profiles || [];
              status = '已读取 ' + (catalog.models || []).length + ' 个模型，已导入 ' + models.length + ' 个，可在下方调整';
            } else status = 'API 已保存；模型刷新失败：' + catalog.error;
          }
          onChange(config); draw(); notify(isExt ? '外部 Agent 配置已保存' : 'API 配置已保存');
        } catch (error) { root.querySelector('#provider-status').textContent = error.message; }
      };

      root.querySelector('#provider-delete').onclick = async () => {
        if (!confirm('删除配置“' + p.name + '”？不会删除对话。')) return;
        const result = await window.piDesktop.provider.delete(p.id);
        if (result.ok) { config = result.config; profiles = config.profiles; selectedId = config.profileId; onChange(config); draw(); }
        else notify(result.error);
      };
    }
    draw();
  }
  return Object.freeze({ mount });
})();
