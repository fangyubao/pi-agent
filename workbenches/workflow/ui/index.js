'use strict';
// 工作流画布：无限画布（平移/缩放）+ 节点卡片 + 连线。纯原生 JS，无依赖。
// 布局规则来自 runtime/workflow-graph.js 的 layout()：层从左到右（串行），同一层上下排（并行）。
// 本文件只负责“画”和“把用户操作变成语义动作”；所有写入都经 api.server(...)，与 Agent 走同一个后端。
window.PiWorkbenchModules.workflow = {
  prompt: '工作流工作台：用 readPlan 读取摘要（不含完整提示词），用 readNode 读取单个节点全文；修改前必须带最新的 baseRevision。',
  mount(host, api) {
    const G = window.PiWorkflowGraph;
    const NODE_W = 240, NODE_H = 176, COL = 300, ROW = 190;
    const TIER_LABEL = { 1: '难度1', 2: '难度2', 3: '难度3', 4: '难度4', 5: '难度5' };
    const CATEGORY_LABEL = { overall: '综合榜', coding: '编程榜', math: '数学推理榜', knowledge: '科学知识榜', writing: '文学创意榜', instruction: '指令遵循榜' };
    const DELIVER_OPTIONS = [['table', '表格（.xlsx）', '一个 CSV 同时另存 Excel 文件'], ['html', '网页（可交互）', '单文件 HTML，图形/交互为主'], ['image', '图（.svg）', '流程图、框图、示意图'], ['file', '其他文件', '.md .json 代码等文本文件']];
    const INPUT_KIND = { text: '文本', table: '表格', image: '图片', binary: '文件' };
    const fmtBytes = n => { const b = Number(n) || 0; return b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? Math.round(b / 1024) + 'KB' : b + 'B'; };
    const EFFORT_LABEL = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高' };
    // 视口（平移/缩放）只是个人浏览习惯，不属于计划内容：存在画布自己的本地存储里。
    // 不能走 saveUIState：宿主运行时会把它当作状态写入并递增 revision，那样每次平移都会让 Agent 手里的 baseRevision 失效。
    const viewKey = 'pi-workflow-view:' + (api.data?.__task || location.search);
    const loadView = () => { try { const v = JSON.parse(localStorage.getItem(viewKey) || 'null'); if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)) return { x: v.x, y: v.y, zoom: Math.min(2, Math.max(0.3, v.zoom)) }; } catch { /* 存储不可用时用默认视口 */ } return null; };
    let savedView = loadView();
    let data = { nodes: [], revision: 0, goal: '', ...(api.data || {}), viewport: savedView || { x: 24, y: 24, zoom: 1 } };
    let planStatus = { phase: 'idle' };   // 由壳层通过 invoke('setPlanStatus') 推送：idle | planning | failed | skipped
    let tiersConfigured = 0;               // 已配置的档位数；0 表示全部节点用主模型
    let assignMode = 'leaderboard';        // 自动分配策略：'leaderboard'（按领域排行榜，默认） | 'difficulty'（按难度档位）
    let mainModel = '', allRunning = false;
    let models = [];                       // 由壳层通过 invoke('setModels') 提供：[{profileId, vendor, models:[…]}]
    let selected = null, editing = null, pendingMove = null, disposed = false, saveTimer = null, busy = false;
    const esc = api.esc;
    const stale = new Set();

    const layout = () => G.layout(data.nodes || [], { colWidth: COL, rowHeight: ROW, nodeWidth: NODE_W });
    const posOf = (node, auto) => node.pos || auto[node.id] || { x: 0, y: 0 };

    // 子智能体颜色：按“首次出现的顺序”取固定色板，所以改节点顺序/编号时颜色不会乱跳。
    const AGENT_COLORS = ['#b5522b', '#3d7a8a', '#6f8a3a', '#8a5ea8'];
    const agentNames = () => G.agentsOf(data.nodes || []);
    const agentColor = name => AGENT_COLORS[Math.max(0, agentNames().indexOf(name)) % AGENT_COLORS.length];
    const agentModel = name => (data.agents && data.agents[name] && data.agents[name].model) || null;

    function nodeHtml(n, auto) {
      const p = posOf(n, auto);
      // 实际用哪个模型及原因，与执行时的选择规则相同（手选 > 子智能体 > 自动分配[领域排行榜/难度档位] > 主模型）
      const pick = window.PiWorkflowRun.modelFor(n, data.agents);
      const modelName = pick.model ? pick.model.model : (mainModel || '主模型');
      const catLabel = n.model && n.model.category && CATEGORY_LABEL[n.model.category] ? CATEGORY_LABEL[n.model.category] : '';
      const tierText = n.model && Number.isInteger(n.model.tier) ? '档位' + (n.model.tier + 1) : '自动';
      const autoHow = assignMode === 'difficulty' ? tierText : (catLabel ? (catLabel + (Number.isInteger(n.model && n.model.tier) ? '·' + tierText : '')) : tierText);
      const how = { node: '手选', agent: '子智能体', tier: autoHow, main: '主模型' }[pick.by];
      const run = n.run || null, running = run && run.status === 'running';
      const runLabel = { running: '运行中…', done: '✓ 已运行', error: '运行失败', stale: '结果已过期' }[run && run.status] || '';
      const tags = [...n.skills.map(s => '技能·' + s), ...n.tools].map(t => '<span class="wf-tag">' + esc(t) + '</span>').join('');
      return '<article class="wf-node' + (running ? ' running' : '') + (selected === n.id ? ' selected' : '') + (stale.has(n.id) ? ' stale' : '') + '" data-node="' + esc(n.id) + '" style="transform:translate(' + p.x + 'px,' + p.y + 'px);width:' + NODE_W + 'px" tabindex="0" aria-label="' + esc(n.title) + '">' +
        '<header><span class="wf-id">' + esc(n.id) + '</span><strong title="' + esc(n.title) + '">' + esc(n.title) + '</strong><button type="button" class="wf-edit" data-act="edit" aria-label="修改 ' + esc(n.title) + '" title="修改">✎</button></header>' +
        '<div class="wf-role">' + (n.agent ? '<span class="wf-agent" style="--agent:' + agentColor(n.agent) + '" title="所属子智能体">' + esc(n.agent) + '</span>' : '') + esc(n.role) + '</div>' +
        '<p class="wf-brief" title="双击查看完整提示词">' + esc(n.brief) + '</p>' +
        '<footer><button type="button" class="wf-model" data-act="model" title="切换模型">' + esc(modelName) + '<small>' + esc(how + ' · ' + (TIER_LABEL[n.tier] || '')) + (n.effort && n.effort !== 'off' ? ' · 思考' + esc(EFFORT_LABEL[n.effort]) : '') + '</small></button>' + (tags ? '<div class="wf-tags">' + tags + '</div>' : '') + '<div class="wf-runrow"><button type="button" class="wf-run" data-act="run"' + (running ? ' disabled' : '') + ' title="单独运行这个节点（依赖的上游节点需要先有结果）">▶ 运行</button>' + (runLabel ? '<button type="button" class="wf-runstate ' + esc(run.status) + '" data-act="result" title="查看结果">' + runLabel + '</button>' : '') + '</div></footer>' +
        (stale.has(n.id) ? '<span class="wf-stale" title="上游已修改，结果已过期">需更新</span>' : '') + '</article>';
    }

    // 连线随运行状态变化：上游已完成且下游正在运行 → 流动（当前所在阶段）；两端都完成 → 实线着色；下游失败 → 红色。
    function edgeState(a, b) {
      const ra = a.run && a.run.status, rb = b.run && b.run.status;
      if (rb === 'running') return ' flow';
      if (rb === 'error') return ' bad';
      if (ra === 'done' && rb === 'done') return ' ok';
      return '';
    }
    function edgesSvg(auto) {
      const byId = new Map((data.nodes || []).map(n => [n.id, n]));
      const paths = G.edges(data.nodes || []).map(({ from, to }) => {
        const a = byId.get(from), b = byId.get(to); if (!a || !b) return '';
        const pa = posOf(a, auto), pb = posOf(b, auto);
        const x1 = pa.x + NODE_W, y1 = pa.y + NODE_H / 2, x2 = pb.x, y2 = pb.y + NODE_H / 2, dx = Math.max(40, (x2 - x1) / 2);
        return '<path d="M' + x1 + ' ' + y1 + ' C' + (x1 + dx) + ' ' + y1 + ',' + (x2 - dx) + ' ' + y2 + ',' + x2 + ' ' + y2 + '" class="wf-edge' + edgeState(a, b) + (selected === from || selected === to ? ' hot' : '') + '"/>';
      }).join('');
      return '<svg class="wf-edges" width="1" height="1" style="overflow:visible"><defs></defs>' + paths + '</svg>';
    }

    function render() {
      if (disposed) return;
      const auto = layout().positions, v = data.viewport || { x: 24, y: 24, zoom: 1 };
      const empty = !(data.nodes || []).length;
      const parallel = layout().parallel;
      host.innerHTML = '<div class="wf-root"><div class="wf-toolbar"><strong>工作流</strong><span class="wf-goal">' + esc(data.goal || '') + '</span><span class="wf-meta">' + (empty ? '' : data.nodes.length + ' 个节点' + (parallel ? ' · ' + parallel + ' 处并行' : '')) + '</span>' +
        '<span class="wf-spacer"></span>' + (empty ? '' : '<button type="button" class="wf-btn" data-act="toggle-assign-mode" title="点击切换工作流模型自动分配策略：按领域排行榜（默认，跨领域选最强专长模型） / 按难度档位">分配：' + (assignMode === 'difficulty' ? '按难度档位' : '按领域榜') + '</button><label class="wf-htmlview" title="在工作文件夹的 workflow 里生成一个可交互、分层阅读的网页，比 .md 好读"><input type="checkbox" data-act="html-view"' + (data.htmlView ? ' checked' : '') + '> HTML 交互</label>' + (data.htmlView ? '<button type="button" class="wf-btn" data-act="open-html" title="用默认浏览器打开">打开</button>' : '')) + (agentNames().length ? '<button type="button" class="wf-btn" data-act="agents" title="按子智能体统一设置模型">子智能体 ' + agentNames().length + '</button>' : '') + (empty ? '' : (allRunning ? '<button type="button" class="wf-btn" data-act="stop">■ 停止</button>' : '<button type="button" class="wf-btn" data-act="run-pending" title="只运行还没有结果的节点（失败、过期、未运行）；已完成的保留，适合中断后继续">▶ 运行未完成</button><button type="button" class="wf-btn primary" data-act="run-all" title="按依赖顺序重新运行全部节点，互不依赖的并行；已有结果会被覆盖">▶ 运行全部</button>')) + '<button type="button" class="wf-btn" data-act="add"' + (empty ? ' disabled' : '') + '>＋ 节点</button><button type="button" class="wf-btn" data-act="reset" title="重新排列">整理</button><button type="button" class="wf-btn" data-act="fit">适应</button></div>' +
        (empty || tiersConfigured ? '' : '<div class="wf-hint">默认按各节点所属领域排行榜分配模型；也可给模型标上档位（设置 → LLM → 模型档位）并在上方切换按排行榜或按难度档位。</div>') + '<div class="wf-canvas" tabindex="0" aria-label="工作流画布"><div class="wf-world" style="transform:translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.zoom + ')">' + edgesSvg(auto) + (data.nodes || []).map(n => nodeHtml(n, auto)).join('') + '</div>' +
        (empty ? emptyHtml() : '') +
        '<div class="wf-zoom"><span>' + Math.round(v.zoom * 100) + '%</span></div></div>' + (editing ? editorHtml() : '') + '<div class="wf-pop" hidden></div></div>';
    }

    // 空画布要说真话：正在拆、拆失败（带原因）、判定无需拆分，而不是永远显示同一句引导。
    function emptyHtml() {
      const p = planStatus || {}, reason = esc(p.reason || '');
      if (p.phase === 'planning') return '<div class="wf-empty" role="status"><p><span class="wf-spin" aria-hidden="true"></span>正在拆分任务…</p><small>通常几秒钟，完成后节点会出现在这里。</small></div>';
      if (p.phase === 'failed') return '<div class="wf-empty warn" role="alert"><p>这次没能拆分</p><small>' + (reason || '请稍后重试') + '。你的问题已按普通对话发送。</small></div>';
      if (p.phase === 'skipped') return '<div class="wf-empty" role="status"><p>这个问题不需要拆分</p><small>' + (reason || '已直接回答') + '。描述一个更复杂、有多个步骤的任务，节点会出现在这里。</small></div>';
      return '<div class="wf-empty"><p>还没有工作流</p><small>在聊天里描述一个有多个步骤的任务，AI 会在这里搭建节点。</small></div>';
    }

    function editorHtml() {
      const n = data.nodes.find(x => x.id === editing.id); if (!n) return '';
      return '<aside class="wf-editor" role="dialog" aria-label="修改节点"><header><strong>' + esc(n.id) + ' · ' + esc(n.title) + '</strong><button type="button" data-act="close-editor" aria-label="关闭">×</button></header>' +
        '<label>角色<input data-f="role" maxlength="20" value="' + esc(n.role) + '"></label>' +
        '<label>任务介绍<input data-f="brief" maxlength="80" value="' + esc(n.brief) + '"></label>' +
        '<label>所属子智能体<input data-f="agent" maxlength="8" list="wf-agent-list" placeholder="例如：研究员（留空 = 不分组）" value="' + esc(n.agent || '') + '"><datalist id="wf-agent-list">' + agentNames().map(a => '<option value="' + esc(a) + '">').join('') + '</datalist></label>' +
        '<label>思考强度<select data-f="effort"><option value="">跟随模型默认</option>' + Object.keys(EFFORT_LABEL).map(k => '<option value="' + k + '"' + (n.effort === k ? ' selected' : '') + '>' + EFFORT_LABEL[k] + '</option>').join('') + '</select></label>' +
        '<fieldset class="wf-deliver"><legend>这一步要产出文件吗？<small>不勾 = 只给文字，最省</small></legend>' + DELIVER_OPTIONS.map(([k, label, tip]) => '<label class="wf-check" title="' + esc(tip) + '"><input type="checkbox" data-deliver="' + k + '"' + ((editing.deliver ?? n.deliver ?? []).includes(k) ? ' checked' : '') + '> ' + esc(label) + '</label>').join('') + '<small class="wf-fieldnote">最多选 2 类。文件会放在这个节点自己的文件夹里。</small></fieldset>' +
        '<div class="wf-inputs"><div class="wf-inputs-head"><strong>附件</strong><span>' + (n.inputs || []).length + ' / 6</span><button type="button" class="wf-btn" data-act="add-input"' + ((n.inputs || []).length >= 6 || busy ? ' disabled' : '') + '>＋ 添加文件</button><button type="button" class="wf-btn" data-act="reveal-node" title="在文件夹中打开这个节点">打开文件夹</button></div>' +
        ((n.inputs || []).length ? '<ul>' + n.inputs.map(i => '<li><span class="wf-inkind">' + esc(INPUT_KIND[i.kind] || '文件') + '</span><span class="wf-inname" title="' + esc(i.name) + '">' + esc(i.name) + '</span><small>' + esc(fmtBytes(i.bytes)) + '</small><button type="button" class="wf-edit" data-act="remove-input" data-input="' + esc(i.name) + '" aria-label="移除 ' + esc(i.name) + '" title="移除">×</button></li>').join('') + '</ul>' : '<p class="wf-fieldnote">BOM、电路图、数据表、说明文档都可以。表格（.xlsx/.csv）和文本会读成文字交给模型；图片需要模型支持看图；PDF 等暂不读取，会明说“没看到”。添加或移除附件会让这个节点的旧结果过期。</p>') +
        '</div>' +
        '<label>完整提示词<textarea data-f="prompt" rows="9" maxlength="1500">' + esc(editing.prompt ?? n.prompt) + '</textarea></label>' +
        (editing.error ? '<p class="wf-error" role="alert">' + esc(editing.error) + '</p>' : '') +
        '<footer><button type="button" class="wf-btn" data-act="close-editor">取消</button><button type="button" class="wf-btn primary" data-act="save-editor"' + (busy ? ' disabled' : '') + '>确定</button></footer></aside>';
    }

    // ---- 动作：全部走语义动作，失败时显示后端给的原因，而不是静默吞掉。
    async function act(action, payload) {
      busy = true;
      try {
        const result = await api.server(action, { baseRevision: data.revision, ...payload });
        return result;
      } finally { busy = false; }
    }
    async function saveEditor() {
      const n = data.nodes.find(x => x.id === editing.id); if (!n) return;
      const get = f => host.querySelector('.wf-editor [data-f="' + f + '"]')?.value ?? '';
      editing.prompt = get('prompt');
      try {
        const result = await act('updateNode', { id: n.id, patch: { agent: get('agent').trim(), role: get('role'), brief: get('brief'), prompt: editing.prompt, effort: get('effort') || null, deliver: [...host.querySelectorAll('.wf-editor [data-deliver]:checked')].map(x => x.dataset.deliver).slice(0, 2) } });
        if (result?.ok === false) throw new Error(result.error || result.message || '节点保存失败');
        (result?.stale || []).forEach(id => stale.add(id));
        editing = null; render();
      } catch (error) { editing.error = error.message; render(); }
    }

    // 壳层推来的“可选模型/档位数/运行状态”只影响卡片文字，不值得打断用户：菜单、结果弹层、编辑面板打开时先不重绘，
    // 否则刚搭好工作流就去点模型，菜单会在眼前被擦掉。弹层关闭后再补一次重绘。
    function popupOpen() { const pop = host.querySelector('.wf-pop'); return Boolean(editing) || Boolean(pop && !pop.hidden); }
    let pendingRender = false;
    function renderUnlessPopupOpen() { if (popupOpen()) { pendingRender = true; return; } render(); }
    host.addEventListener('click', () => { if (pendingRender) setTimeout(() => { if (pendingRender && !popupOpen()) { pendingRender = false; render(); } }, 0); }, true);

    // ---- 模型两级菜单：先厂商，再该厂商下的模型。
    function openModelMenu(nodeId, anchor) {
      const pop = host.querySelector('.wf-pop'), n = data.nodes.find(x => x.id === nodeId); if (!pop || !n) return;
      const r = anchor.getBoundingClientRect(), h = host.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(r.left - h.left, h.width - 230)) + 'px'; pop.style.top = (r.bottom - h.top + 4) + 'px';
      const vendors = models.length ? models : [];
      const autoModeText = assignMode === 'difficulty' ? '按难度档位' : '按领域榜';
      pop.innerHTML = '<div class="wf-menu"><button type="button" data-model="auto">自动分配（' + autoModeText + '）' + (!n.model || n.model.source !== 'user' ? ' ✓' : '') + '</button>' +
        (vendors.length ? vendors.map((v, i) => '<div class="wf-vendor"><button type="button" class="wf-vendor-btn" data-vendor="' + i + '" aria-haspopup="menu">' + esc(v.vendor) + '<span>›</span></button>' +
          '<div class="wf-sub" role="menu">' + v.models.map(m => '<button type="button" role="menuitem" data-model="' + esc(v.profileId) + '::' + esc(m) + '">' + esc(m) + (n.model && n.model.profileId === v.profileId && n.model.model === m ? ' ✓' : '') + '</button>').join('') + '</div></div>').join('') : '<p class="wf-note">还没有可用模型，请先在设置 → LLM 里添加。</p>') + '</div>';
      pop.hidden = false;
      pop.dataset.node = nodeId;
    }
    // 子智能体菜单：列出每个子智能体、它名下的节点数和当前模型；点一行 → 厂商→模型两级菜单，选了就作用于它名下所有没手选模型的节点。
    function openAgentMenu(anchor, only) {
      const pop = host.querySelector('.wf-pop'); if (!pop) return;
      const r = anchor.getBoundingClientRect(), h = host.getBoundingClientRect();
      pop.style.left = Math.max(4, Math.min(r.left - h.left, h.width - 260)) + 'px'; pop.style.top = (r.bottom - h.top + 4) + 'px';
      pop.dataset.node = ''; pop.dataset.agent = only || '';
      const autoLabel = '自动（' + (assignMode === 'difficulty' ? '按难度档位' : '按领域榜') + '）';
      const rows = agentNames().map(name => {
        const count = data.nodes.filter(n => n.agent === name).length, m = agentModel(name);
        const vendors = models.length ? models : [];
        return '<div class="wf-agentrow"><span class="wf-agent" style="--agent:' + agentColor(name) + '">' + esc(name) + '</span><small>' + count + ' 个节点</small>' +
          '<div class="wf-vendor"><button type="button" class="wf-vendor-btn" data-vendor="a' + esc(name) + '" aria-haspopup="menu">' + esc(m ? m.model : autoLabel) + '<span>›</span></button>' +
          '<div class="wf-sub" role="menu"><button type="button" role="menuitem" data-agent-model="' + esc(name) + '|auto">' + autoLabel + (!m ? ' ✓' : '') + '</button>' +
          vendors.map(v => '<div class="wf-subhead">' + esc(v.vendor) + '</div>' + v.models.map(mm => '<button type="button" role="menuitem" data-agent-model="' + esc(name) + '|' + esc(v.profileId) + '::' + esc(mm) + '">' + esc(mm) + (m && m.profileId === v.profileId && m.model === mm ? ' ✓' : '') + '</button>').join('')).join('') +
          '</div></div></div>';
      }).join('');
      pop.innerHTML = '<div class="wf-menu wf-agents"><p class="wf-note">子智能体的模型会用在它名下没有手选模型的节点；节点自己手选的优先。</p>' + rows + '</div>'; pop.hidden = false;
    }
    async function chooseAgentModel(spec) {
      const pop = host.querySelector('.wf-pop'); if (pop) pop.hidden = true;
      const i = spec.indexOf('|'), name = spec.slice(0, i), value = spec.slice(i + 1);
      try {
        if (value === 'auto') { await act('setAgentModel', { name, model: null }); try { await api.request('wf-run', { reassignAuto: true }); } catch {} }
        else { const [profileId, ...rest] = value.split('::'); await act('setAgentModel', { name, model: { profileId, model: rest.join('::') } }); }
      } catch (error) { api.notify(error.message); }
    }
    async function chooseModel(nodeId, value) {
      const pop = host.querySelector('.wf-pop'); if (pop) pop.hidden = true;
      try {
        if (value === 'auto') { await act('setNodeModel', { id: nodeId, model: null }); try { await api.request('wf-run', { reassignAuto: true }); } catch {} }
        else { const [profileId, ...rest] = value.split('::'); await act('setNodeModel', { id: nodeId, model: { profileId, model: rest.join('::') } }); }
      } catch (error) { api.notify(error.message); }
    }

    // 单独运行被拒绝时（上游没结果等）把原因直接显示在节点旁，不只是一闪而过的通知。
    function showError(nodeId, message) {
      const n = data.nodes.find(x => x.id === nodeId), pop = host.querySelector('.wf-pop'); if (!n || !pop) return;
      pop.dataset.node = nodeId; pop.style.left = '12px'; pop.style.top = '48px';
      pop.innerHTML = '<div class="wf-full" role="alert"><header><strong>' + esc(n.title) + ' · 不能运行</strong><button type="button" data-act="close-pop" aria-label="关闭">×</button></header><pre>' + esc(message) + '</pre></div>'; pop.hidden = false;
    }
    function showResult(nodeId) {
      const n = data.nodes.find(x => x.id === nodeId), pop = host.querySelector('.wf-pop'); if (!n || !n.run || !pop) return;
      const r = n.run, meta = [r.model, r.usage ? r.usage.input + ' 入 / ' + r.usage.output + ' 出 tokens' : '', r.status === 'stale' ? '上游已修改，这是旧结果' : ''].filter(Boolean).join(' · ');
      pop.dataset.node = nodeId; pop.style.left = '12px'; pop.style.top = '48px';
      pop.innerHTML = '<div class="wf-full" role="dialog" aria-label="运行结果"><header><strong>' + esc(n.title) + ' · ' + (r.status === 'error' ? '运行失败' : '运行结果') + '</strong><button type="button" data-act="close-pop" aria-label="关闭">×</button></header>' + (meta ? '<p class="wf-note">' + esc(meta) + '</p>' : '') + '<pre>' + esc(r.status === 'error' ? r.error : r.output) + '</pre></div>'; pop.hidden = false;
    }

    // ---- 双击：完整提示词（只读弹层）
    function showPrompt(nodeId) {
      const n = data.nodes.find(x => x.id === nodeId); if (!n) return;
      const pop = host.querySelector('.wf-pop'); pop.dataset.node = nodeId;
      pop.style.left = '12px'; pop.style.top = '48px';
      pop.innerHTML = '<div class="wf-full" role="dialog" aria-label="完整提示词"><header><strong>' + esc(n.title) + ' · 完整提示词</strong><button type="button" data-act="close-pop" aria-label="关闭">×</button></header><pre>' + esc(n.prompt) + '</pre></div>';
      pop.hidden = false;
    }

    // ---- 画布交互：平移、滚轮缩放、拖动节点
    function persistView() { savedView = data.viewport; clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(viewKey, JSON.stringify(data.viewport)); } catch { /* 存储不可用：本次打开内仍然有效 */ } }, 300); }
    function applyView() { const w = host.querySelector('.wf-world'); if (w) { const v = data.viewport; w.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.zoom + ')'; const z = host.querySelector('.wf-zoom span'); if (z) z.textContent = Math.round(v.zoom * 100) + '%'; } }
    function fit() {
      const canvas = host.querySelector('.wf-canvas'); if (!canvas || !(data.nodes || []).length) return;
      const L = layout(), cw = canvas.clientWidth - 48, ch = canvas.clientHeight - 48;
      const zoom = Math.min(1, Math.max(0.3, Math.min(cw / (L.width || 1), ch / ((L.height - (ROW - NODE_H)) || 1))));
      data.viewport = { x: 24, y: 24 + Math.max(0, (ch - (L.height - (ROW - NODE_H)) * zoom) / 2), zoom }; applyView(); persistView();
    }

    host.addEventListener('click', async event => {
      const b = event.target.closest('[data-act],[data-model],[data-vendor],[data-agent-model]');
      const pop = host.querySelector('.wf-pop');
      if (!b) { if (pop && !pop.hidden && !event.target.closest('.wf-pop')) pop.hidden = true; return; }
      if (b.dataset.agentModel) { await chooseAgentModel(b.dataset.agentModel); return; }
      if (b.dataset.model) { await chooseModel(pop.dataset.node, b.dataset.model); return; }
      if (b.dataset.vendor !== undefined) { b.parentElement.classList.toggle('open'); return; }
      const isCtx = String(b.dataset.act).startsWith('ctx-') || (b.dataset.act === 'fit' && b.closest('.wf-ctx-menu'));
      const nodeEl = b.closest('.wf-node'), id = isCtx ? pop?.dataset.node : nodeEl?.dataset.node;
      if (isCtx && pop) pop.hidden = true;   // 菜单项被点中就收起；需要弹层的动作会自己再打开
      switch (b.dataset.act) {
        case 'delete-node': {
          const delId = editing?.id; if (!delId) break;
          const delNode = data.nodes.find(x => x.id === delId);
          if (!delNode) break;
          const deps = data.nodes.filter(n => (n.dependsOn||[]).includes(delId)).map(n => n.title);
          const msg = deps.length ? '删除「' + delNode.title + '」会同时断开它与「' + deps.join('、') + '」的连线，确定删除？' : '确定删除「' + delNode.title + '」？';
          if (!confirm(msg)) break;
          try { editing = null; await act('removeNode', { id: delId }); selected = null; } catch (e) { api.notify(e.message); }
          break;
        }
        case 'ctx-run': try { await api.request('wf-run', { id }); } catch (e) { api.notify(e.message); showError(id, e.message); } break;
        case 'ctx-result': showResult(id); break;
        case 'ctx-prompt': showPrompt(id); break;
        case 'ctx-edit': editing = { id }; selected = id; render(); break;
        case 'ctx-delete': {
          if (!id) break;
          const delNode = data.nodes.find(x => x.id === id); if (!delNode) break;
          const deps = data.nodes.filter(n => (n.dependsOn||[]).includes(id)).map(n => n.title);
          const msg = deps.length ? '删除「' + delNode.title + '」会同时断开与「' + deps.join('、') + '」的连线，确定？' : '确定删除「' + delNode.title + '」？';
          if (!confirm(msg)) break;
          try { if (editing?.id === id) editing = null; await act('removeNode', { id }); if (selected === id) selected = null; } catch (e) { api.notify(e.message); }
          break;
        }
        case 'ctx-add-after': try { await act('addNode', { node: { title: '新步骤', role: '执行者', prompt: '在这里写这一步要做什么。', dependsOn: id ? [id] : [] } }); } catch (e) { api.notify(e.message); } break;
        case 'ctx-add': try { await act('addNode', { node: { title: '新步骤', role: '执行者', prompt: '在这里写这一步要做什么。', dependsOn: [] } }); } catch (e) { api.notify(e.message); } break;
        case 'ctx-reset': try { for (const n of data.nodes.filter(x => x.pos)) await act('updateNode', { id: n.id, patch: { pos: null } }); } catch (e) { api.notify(e.message); } break;
        case 'edit': editing = { id }; selected = id; render(); break;
        case 'model': event.stopPropagation(); openModelMenu(id, b); break;
        case 'agents': event.stopPropagation(); openAgentMenu(b); break;
        case 'toggle-assign-mode': {
          const nextMode = assignMode === 'difficulty' ? 'leaderboard' : 'difficulty';
          assignMode = nextMode;
          try { await api.request('wf-run', { switchAssignMode: nextMode }); } catch (e) { api.notify(e.message); }
          render();
          break;
        }
        case 'open-html': try { await api.request('wf-run', { openHtml: true }); } catch (e) { api.notify(e.message); } break;
        case 'run': try { await api.request('wf-run', { id }); } catch (e) { api.notify(e.message); showError(id, e.message); } break;
        case 'run-all': try { allRunning = true; render(); await api.request('wf-run', { all: true }); } catch (e) { allRunning = false; render(); api.notify(e.message); } break;
        case 'run-pending': try { allRunning = true; render(); await api.request('wf-run', { all: true, pendingOnly: true }); } catch (e) { allRunning = false; render(); api.notify(e.message); } break;
        case 'stop': try { await api.request('wf-run', { stop: true }); } catch (e) { api.notify(e.message); } break;
        case 'result': showResult(id); break;
        case 'add-input': {
          const eid = editing?.id; if (!eid) break;
          editing.prompt = host.querySelector('.wf-editor [data-f="prompt"]')?.value ?? editing.prompt;
          editing.deliver = [...host.querySelectorAll('.wf-editor [data-deliver]:checked')].map(x => x.dataset.deliver);        // 先把没保存的勾选记住：弹窗/重绘后不丢
          try { const r = await api.request('wf-run', { pickInputs: true, id: eid }); if (r?.skipped?.length) api.notify('有文件没加进来：' + r.skipped.join('；')); } catch (e) { api.notify(e.message); }
          break;
        }
        case 'remove-input': {
          const eid = editing?.id; if (!eid) break;
          if (!confirm('移除附件「' + b.dataset.input + '」？文件会从节点文件夹里删除，这一步的旧结果会过期。')) break;
          editing.prompt = host.querySelector('.wf-editor [data-f="prompt"]')?.value ?? editing.prompt;
          editing.deliver = [...host.querySelectorAll('.wf-editor [data-deliver]:checked')].map(x => x.dataset.deliver);
          try { await api.request('wf-run', { removeInput: true, id: eid, name: b.dataset.input }); } catch (e) { api.notify(e.message); }
          break;
        }
        case 'reveal-node': { const eid = editing?.id || id; if (!eid) break; try { await api.request('wf-run', { revealNode: true, id: eid }); } catch (e) { api.notify(e.message); } break; }
        case 'close-editor': editing = null; render(); break;
        case 'save-editor': await saveEditor(); break;
        case 'close-pop': pop.hidden = true; break;
        case 'fit': fit(); break;
        case 'reset': try { for (const n of data.nodes.filter(x => x.pos)) await act('updateNode', { id: n.id, patch: { pos: null } }); } catch (e) { api.notify(e.message); } break;
        case 'add': try { await act('addNode', { node: { title: '新步骤', role: '执行者', prompt: '在这里写这一步要做什么。', dependsOn: selected ? [selected] : [] } }); } catch (e) { api.notify(e.message); } break;
      }
    });
    // 指针被画布捕获后，dblclick 的 target 会变成画布本身，所以按坐标找节点，而不是看 event.target。
    host.addEventListener('change', async event => {
      const dv = event.target.closest('[data-deliver]');
      if (dv) { const on = host.querySelectorAll('.wf-editor [data-deliver]:checked'); if (on.length > 2) { dv.checked = false; api.notify('一个节点最多选 2 类文件'); } if (editing) editing.deliver = [...host.querySelectorAll('.wf-editor [data-deliver]:checked')].map(x => x.dataset.deliver); return; }
      const box = event.target.closest('[data-act="html-view"]'); if (!box) return;
      try { await act('setHtmlView', { enabled: box.checked }); } catch (e) { box.checked = !box.checked; api.notify(e.message); }
    });
    host.addEventListener('dblclick', event => {
      const hit = document.elementsFromPoint(event.clientX, event.clientY);
      if (hit.some(e => e.matches?.('button,input,textarea,.wf-editor,.wf-pop'))) return;
      const n = hit.find(e => e.classList?.contains('wf-node')); if (n) showPrompt(n.dataset.node);
    });
    host.addEventListener('keydown', event => { if (event.key === 'Escape') { const pop = host.querySelector('.wf-pop'); if (pop && !pop.hidden) pop.hidden = true; else if (editing) { editing = null; render(); } } });

    // 右键菜单：节点上弹节点操作，空白处弹画布操作（ComfyUI 风格）。
    function openCtxMenu(items, x, y) {
      const pop = host.querySelector('.wf-pop'); if (!pop) return;
      const h = host.getBoundingClientRect();
      const sep = () => '<hr class="wf-ctx-sep">';
      pop.innerHTML = '<div class="wf-ctx-menu" role="menu">' + items.map(it => it === '---' ? sep() : '<button type="button" class="wf-ctx-item' + (it.danger ? ' danger' : '') + '" data-act="' + it.act + '" role="menuitem"' + (it.disabled ? ' disabled' : '') + '>' + (it.icon ? '<span class="wf-ctx-icon" aria-hidden="true">' + it.icon + '</span>' : '') + '<span>' + esc(it.label) + '</span>' + (it.hint ? '<span class="wf-ctx-hint">' + esc(it.hint) + '</span>' : '') + '</button>').join('') + '</div>';
      // 定位：默认在指针右下，靠近边缘时翻转。
      pop.hidden = false;
      const pw = pop.firstChild.offsetWidth || 180, ph = pop.firstChild.offsetHeight || 40 * items.length;
      const lx = x - h.left, ly = y - h.top;
      pop.style.left = (lx + pw > h.width - 8 ? Math.max(4, lx - pw) : lx) + 'px';
      pop.style.top  = (ly + ph > h.height - 8 ? Math.max(4, ly - ph) : ly) + 'px';
      pop.dataset.node = '';
    }
    host.addEventListener('contextmenu', event => {
      const canvas = event.target.closest('.wf-canvas'); if (!canvas) return;
      event.preventDefault();
      if (event.target.closest('button,input,textarea,.wf-editor')) return;
      const pop = host.querySelector('.wf-pop'); if (pop) pop.hidden = true;
      // 按坐标找节点（画布用 pointer capture，target 不可靠）
      const hit = document.elementsFromPoint(event.clientX, event.clientY);
      const nodeEl = hit.find(e => e.classList?.contains('wf-node'));
      if (nodeEl) {
        const id = nodeEl.dataset.node, n = data.nodes.find(x => x.id === id); if (!n) return;
        selected = id; host.querySelectorAll('.wf-node').forEach(e => e.classList.toggle('selected', e === nodeEl));
        const run = n.run, status = run?.status;
        const hasResult = status === 'done' || status === 'stale' || status === 'error';
        const isRunning = status === 'running';
        openCtxMenu([
          { act: 'ctx-run',    icon: '▶', label: '运行这个节点', disabled: isRunning },
          { act: 'ctx-result', icon: '◉', label: '查看结果', disabled: !hasResult },
          { act: 'ctx-prompt', icon: '≡', label: '查看完整提示词' },
          '---',
          { act: 'ctx-edit',        icon: '✎', label: '编辑节点…' },
          { act: 'ctx-add-after',   icon: '＋', label: '在此之后新增节点', hint: '依赖当前节点' },
          '---',
          { act: 'ctx-delete', icon: '✕', label: '删除节点', danger: true },
        ], event.clientX, event.clientY);
        host.querySelector('.wf-pop').dataset.node = id;
      } else {
        // 画布空白处
        openCtxMenu([
          { act: 'ctx-add',   icon: '＋', label: '新增节点' },
          '---',
          { act: 'ctx-reset', icon: '⊞', label: '重新排列节点' },
          { act: 'fit',       icon: '⤢', label: '适应屏幕' },
        ], event.clientX, event.clientY);
      }
    });

    // 指针：拖空白处平移；拖节点移动（松手时保存一次）；滚轮缩放（以指针为中心）
    let drag = null;
    host.addEventListener('pointerdown', event => {
      const canvas = event.target.closest('.wf-canvas'); if (!canvas || event.button !== 0 || event.target.closest('button,input,textarea,.wf-editor,.wf-pop')) return;
      const nodeEl = event.target.closest('.wf-node');
      if (nodeEl) {
        selected = nodeEl.dataset.node; host.querySelectorAll('.wf-node').forEach(e => e.classList.toggle('selected', e === nodeEl));
        const n = data.nodes.find(x => x.id === selected), p = posOf(n, layout().positions);
        drag = { kind: 'node', id: selected, sx: event.clientX, sy: event.clientY, ox: p.x, oy: p.y, el: nodeEl, moved: false };
      } else { selected = null; drag = { kind: 'pan', sx: event.clientX, sy: event.clientY, ox: data.viewport.x, oy: data.viewport.y }; }
      canvas.setPointerCapture(event.pointerId);
    });
    host.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.sx, dy = event.clientY - drag.sy, z = data.viewport.zoom;
      if (drag.kind === 'pan') { data.viewport = { ...data.viewport, x: drag.ox + dx, y: drag.oy + dy }; applyView(); return; }
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; const x = Math.round(drag.ox + dx / z), y = Math.round(drag.oy + dy / z);
      drag.el.style.transform = 'translate(' + x + 'px,' + y + 'px)'; drag.pos = { x, y };
      const n = data.nodes.find(q => q.id === drag.id); n.pos = drag.pos;            // 连线跟随
      host.querySelector('.wf-edges')?.replaceWith(Object.assign(document.createElement('div'), { innerHTML: edgesSvg(layout().positions) }).firstChild);
    });
    host.addEventListener('pointerup', async () => {
      const d = drag; drag = null; if (!d) return;
      if (d.kind === 'pan') { persistView(); return; }
      if (d.moved && d.pos) { try { await act('updateNode', { id: d.id, patch: { pos: d.pos } }); } catch (e) { api.notify(e.message); } }
    });
    host.addEventListener('wheel', event => {
      const canvas = event.target.closest('.wf-canvas'); if (!canvas || event.target.closest('.wf-editor,.wf-pop')) return; event.preventDefault();
      const v = data.viewport, r = canvas.getBoundingClientRect(), mx = event.clientX - r.left, my = event.clientY - r.top;
      const zoom = Math.min(2, Math.max(0.3, v.zoom * Math.exp(-event.deltaY * 0.0015)));
      data.viewport = { x: mx - (mx - v.x) * zoom / v.zoom, y: my - (my - v.y) * zoom / v.zoom, zoom }; applyView(); persistView();
    }, { passive: false });

    render();
    if ((data.nodes || []).length && !savedView) requestAnimationFrame(() => fit());

    return {
      // 外部（Agent / 拆解器）修改后，壳层把新状态推过来。保持视口与选中，只重画内容，所以聊天里搭建时画布不会跳。
      sync(next) {
        const keepView = data.viewport; data = { nodes: [], revision: 0, goal: '', ...next, viewport: keepView };
        if (editing && !data.nodes.some(n => n.id === editing.id)) editing = null;
        const first = !host.querySelector('.wf-node'); if (editing) editing.error = null; render(); if (first && data.nodes.length && !savedView) fit();
      },
      invoke(command, payload = {}) {
        if (command === 'setModels') { models = Array.isArray(payload.models) ? payload.models : []; tiersConfigured = Number(payload.tiersConfigured) || 0; if (payload.assignMode === 'difficulty' || payload.assignMode === 'leaderboard') assignMode = payload.assignMode; mainModel = String(payload.mainModel || ''); allRunning = payload.running === true; if ((data.nodes || []).length) renderUnlessPopupOpen(); return '已更新可选模型'; }
        if (command === 'setPlanStatus') { planStatus = payload && typeof payload === 'object' ? payload : { phase: 'idle' }; if (!(data.nodes || []).length) render(); return '已更新拆分状态'; }
        return api.server(command, payload);
      },
      dispose() { disposed = true; clearTimeout(saveTimer); }
    };
  }
};
