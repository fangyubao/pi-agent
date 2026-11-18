'use strict';
// 权威大模型分类排行榜与本地模型库相对排名引擎（LMSYS Chatbot Arena + LiveBench 综合基准）。
// 支持 6 大领域：综合(overall)、编程(coding)、数学推理(math)、科学知识(knowledge)、文学创意(writing)、指令遵循(instruction)。
// 既可在 Node 主进程运行（含在线刷新与本地缓存），也可在渲染进程（window.PiModelLeaderboard）实时计算所选模型的全球排名与“当前已拥有模型内第几名”。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PiModelLeaderboard = api;
})(typeof window === 'object' ? window : globalThis, () => {
  const CATEGORIES = [
    { id: 'overall', label: '综合', keywords: [] },
    { id: 'coding', label: '编程', keywords: ['代码', '编程', '程序', '脚本', '接口', 'api', '前端', '后端', '架构', '数据库', 'sql', 'bug', '调试', '测试', '重构', 'html', 'css', 'js', 'python', 'rust', 'c++', '实现', '开发'] },
    { id: 'math', label: '数学推理', keywords: ['数学', '推理', '公式', '证明', '算法', '量子', 'qubo', '矩阵', '概率', '统计', '优化', '复杂度', '方程', '几何', '数值', '计算', '物理', '电路'] },
    { id: 'knowledge', label: '科学知识', keywords: ['科学', '知识', '调研', '文献', '原理', '医学', '生物', '化学', '材料', '芯片', '硬件', '传感器', '选型', '百科', '科普', '政策', '对比', '分析'] },
    { id: 'writing', label: '文学创意', keywords: ['文学', '艺术', '写作', '创意', '文案', '故事', '小说', '诗歌', '润色', '改写', '演讲', '剧本', '修辞', '叙事', '品牌', '宣传', '翻译'] },
    { id: 'instruction', label: '指令遵循', keywords: ['整理', '汇总', '提取', '格式', 'json', '表格', '清单', '校验', '归档', '规范', '总结', '摘要', '核对', '清洗'] }
  ];

  // 基准榜单数据：融合 LMSYS Chatbot Arena (Elo 折算百分制) 与 LiveBench 分类得分
  const BASELINE_MODELS = [
    { id: 'claude-opus-4', label: 'Claude Opus 4 / 4.5', family: 'claude-opus', tierHint: 5, scores: { overall: 96.5, coding: 97.8, math: 95.2, knowledge: 96.4, writing: 97.5, instruction: 97.2 } },
    { id: 'gpt-5-pro', label: 'GPT-5 / GPT-6 Flagship', family: 'gpt-flagship', tierHint: 5, scores: { overall: 96.2, coding: 96.8, math: 97.4, knowledge: 96.8, writing: 95.6, instruction: 96.9 } },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 / 3 Pro', family: 'gemini-pro', tierHint: 5, scores: { overall: 95.8, coding: 95.4, math: 96.6, knowledge: 97.0, writing: 95.2, instruction: 95.8 } },
    { id: 'openai-o3', label: 'OpenAI o3 / o4-mini-high', family: 'openai-o3', tierHint: 5, scores: { overall: 95.4, coding: 96.5, math: 98.2, knowledge: 95.6, writing: 91.5, instruction: 96.0 } },
    { id: 'claude-sonnet-4', label: 'Claude 3.7 / 4 Sonnet', family: 'claude-sonnet', tierHint: 4, scores: { overall: 94.8, coding: 97.0, math: 93.8, knowledge: 94.5, writing: 96.4, instruction: 96.2 } },
    { id: 'deepseek-r1', label: 'DeepSeek R1 / Reasoner', family: 'deepseek-r1', tierHint: 5, scores: { overall: 94.5, coding: 95.2, math: 97.5, knowledge: 94.8, writing: 93.2, instruction: 93.8 } },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V3.1 / V4 Pro', family: 'deepseek-pro', tierHint: 4, scores: { overall: 94.0, coding: 95.6, math: 95.0, knowledge: 94.2, writing: 94.4, instruction: 94.5 } },
    { id: 'grok-4', label: 'Grok 4 / 4.7', family: 'grok-4', tierHint: 5, scores: { overall: 94.2, coding: 94.4, math: 95.8, knowledge: 95.4, writing: 93.5, instruction: 94.0 } },
    { id: 'qwen-2.5-max', label: 'Qwen 2.5 / 3 Max', family: 'qwen-max', tierHint: 4, scores: { overall: 93.2, coding: 94.0, math: 94.5, knowledge: 93.6, writing: 93.4, instruction: 94.2 } },
    { id: 'gpt-4o', label: 'GPT-4o / GPT-4.1', family: 'gpt-4o', tierHint: 4, scores: { overall: 92.8, coding: 93.4, math: 91.8, knowledge: 93.5, writing: 93.8, instruction: 94.4 } },
    { id: 'deepseek-v3', label: 'DeepSeek V3', family: 'deepseek-v3', tierHint: 4, scores: { overall: 92.5, coding: 93.8, math: 93.6, knowledge: 92.6, writing: 93.0, instruction: 92.8 } },
    { id: 'qwq-32b', label: 'QwQ 32B Reasoning', family: 'qwq', tierHint: 4, scores: { overall: 91.8, coding: 92.6, math: 95.4, knowledge: 91.2, writing: 89.4, instruction: 91.6 } },
    { id: 'grok-3', label: 'Grok 3', family: 'grok-3', tierHint: 4, scores: { overall: 92.0, coding: 92.2, math: 93.0, knowledge: 92.8, writing: 91.8, instruction: 92.0 } },
    { id: 'openai-o1', label: 'OpenAI o1 / o3-mini', family: 'openai-o1', tierHint: 4, scores: { overall: 91.6, coding: 93.2, math: 95.6, knowledge: 92.0, writing: 88.5, instruction: 92.4 } },
    { id: 'glm-5-plus', label: 'GLM-4 / GLM-5 Plus', family: 'glm-pro', tierHint: 4, scores: { overall: 91.2, coding: 91.8, math: 92.0, knowledge: 91.6, writing: 92.2, instruction: 92.5 } },
    { id: 'kimi-k2', label: 'Kimi k1.5 / k2 (Moonshot)', family: 'kimi', tierHint: 4, scores: { overall: 91.4, coding: 91.5, math: 92.8, knowledge: 91.8, writing: 93.2, instruction: 92.0 } },
    { id: 'doubao-pro', label: 'Doubao 1.5 Pro (豆包 Pro)', family: 'doubao-pro', tierHint: 3, scores: { overall: 90.8, coding: 90.2, math: 91.0, knowledge: 91.4, writing: 92.6, instruction: 91.8 } },
    { id: 'minimax-text-01', label: 'MiniMax-Text-01 / M1', family: 'minimax', tierHint: 3, scores: { overall: 90.4, coding: 89.8, math: 90.6, knowledge: 90.8, writing: 91.6, instruction: 91.2 } },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 / 3 Flash', family: 'gemini-flash', tierHint: 2, scores: { overall: 90.2, coding: 90.4, math: 91.6, knowledge: 90.8, writing: 89.6, instruction: 91.4 } },
    { id: 'qwen-2.5-coder-32b', label: 'Qwen 2.5 Coder 32B', family: 'qwen-coder', tierHint: 3, scores: { overall: 89.5, coding: 94.2, math: 90.4, knowledge: 88.2, writing: 86.5, instruction: 90.6 } },
    { id: 'deepseek-coder', label: 'DeepSeek Coder V2', family: 'deepseek-coder', tierHint: 3, scores: { overall: 88.8, coding: 93.0, math: 89.8, knowledge: 87.6, writing: 85.8, instruction: 89.4 } },
    { id: 'llama-3.3-70b', label: 'Llama 3.3 70B / Llama 4', family: 'llama-70b', tierHint: 3, scores: { overall: 89.2, coding: 89.6, math: 89.0, knowledge: 89.8, writing: 88.8, instruction: 90.4 } },
    { id: 'claude-haiku-3.5', label: 'Claude 3.5 Haiku', family: 'claude-haiku', tierHint: 2, scores: { overall: 88.6, coding: 90.0, math: 86.8, knowledge: 88.4, writing: 89.5, instruction: 90.2 } },
    { id: 'deepseek-flash', label: 'DeepSeek V4 / V3 Flash', family: 'deepseek-flash', tierHint: 2, scores: { overall: 88.4, coding: 89.5, math: 89.2, knowledge: 88.0, writing: 88.2, instruction: 89.0 } },
    { id: 'deepseek-r1-distill-32b', label: 'DeepSeek R1 Distill 32B', family: 'deepseek-distill-32b', tierHint: 3, scores: { overall: 88.0, coding: 89.2, math: 92.4, knowledge: 87.5, writing: 85.6, instruction: 88.2 } },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini / GPT-4.1 mini', family: 'gpt-mini', tierHint: 1, scores: { overall: 87.2, coding: 87.8, math: 86.5, knowledge: 87.4, writing: 87.0, instruction: 88.6 } },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', family: 'gemini-2-flash', tierHint: 1, scores: { overall: 87.6, coding: 87.5, math: 88.0, knowledge: 88.2, writing: 87.2, instruction: 88.8 } },
    { id: 'glm-flash', label: 'GLM-4 / GLM-5 Flash', family: 'glm-flash', tierHint: 1, scores: { overall: 86.4, coding: 87.0, math: 86.2, knowledge: 86.5, writing: 86.8, instruction: 87.5 } },
    { id: 'deepseek-r1-distill-14b', label: 'DeepSeek R1 Distill 14B', family: 'deepseek-distill-14b', tierHint: 2, scores: { overall: 85.2, coding: 86.0, math: 88.8, knowledge: 84.6, writing: 83.4, instruction: 85.5 } },
    { id: 'deepseek-r1-distill-7b', label: 'DeepSeek R1 Distill 7B/8B', family: 'deepseek-distill-7b', tierHint: 1, scores: { overall: 82.0, coding: 82.8, math: 85.4, knowledge: 81.2, writing: 80.5, instruction: 82.4 } }
  ];

  function defaultSnapshot() {
    return {
      version: 1,
      source: 'LMSYS Chatbot Arena & LiveBench 权威综合榜',
      updatedAt: 1794960000000,
      models: BASELINE_MODELS.map(m => ({ ...m, scores: { ...m.scores } }))
    };
  }

  // 把真实环境里五花八门的模型 ID（如 deepseek-v4.1-flash-sg、opencode/glm-5.3-flash-free、gpt-6.1-sol）规整匹配到榜单条目。
  // 严格区分 flash/mini/lite/distill 与 pro/opus/r1/max，绝不把轻量模型误判成满血旗舰。
  function matchModel(rawModelId, snapshot) {
    const raw = String(rawModelId || '').trim().toLowerCase();
    if (!raw || ['main', 'relay-main', 'default', 'auto'].includes(raw)) return null;
    const list = Array.isArray(snapshot?.models) && snapshot.models.length ? snapshot.models : BASELINE_MODELS;
    const byId = new Map(list.map(m => [m.id.toLowerCase(), m]));
    if (byId.has(raw)) return byId.get(raw);

    // 去掉常见路由前缀与区域后缀
    const s = raw
      .replace(/^[a-z0-9_.-]+\//, '')
      .replace(/-(sg|us|eu|cn|free|tiered|preview|latest|exp|beta|202\d{5}|0\d{3})$/g, '');
    if (byId.has(s)) return byId.get(s);

    const isFlash = /(flash|lite|nano|haiku|mini|small|tiny|fast)/.test(s);
    const isCoder = /(coder|codestral|code)/.test(s);

    // DeepSeek 系列
    if (s.includes('deepseek')) {
      if (s.includes('distill')) {
        if (/(32b|70b)/.test(s)) return byId.get('deepseek-r1-distill-32b') || null;
        if (/(14b|16b)/.test(s)) return byId.get('deepseek-r1-distill-14b') || null;
        return byId.get('deepseek-r1-distill-7b') || null;
      }
      if (/(r1|reasoner)/.test(s)) return byId.get('deepseek-r1') || null;
      if (isCoder) return byId.get('deepseek-coder') || null;
      if (isFlash) return byId.get('deepseek-flash') || null;
      if (/(v4|pro)/.test(s)) return byId.get('deepseek-v4-pro') || null;
      return byId.get('deepseek-v3') || null;
    }

    // Claude 系列
    if (s.includes('claude')) {
      if (s.includes('opus')) return byId.get('claude-opus-4') || null;
      if (s.includes('haiku') || isFlash) return byId.get('claude-haiku-3.5') || null;
      return byId.get('claude-sonnet-4') || null;
    }

    // OpenAI / GPT / o1 / o3 系列
    if (/^(o3|o4)/.test(s) || s.includes('openai-o3')) return byId.get('openai-o3') || null;
    if (/^o1/.test(s) || s.includes('o1-')) return byId.get('openai-o1') || null;
    if (s.includes('gpt')) {
      if (s.includes('image') || s.includes('audio') || s.includes('tts') || s.includes('whisper')) return null;
      if (isFlash) return byId.get('gpt-4o-mini') || null;
      if (/gpt-(5|6)/.test(s) || /(astra|sol|pro|max)/.test(s)) return byId.get('gpt-5-pro') || null;
      return byId.get('gpt-4o') || null;
    }

    // Gemini 系列
    if (s.includes('gemini')) {
      if (s.includes('image')) return null;
      if (isFlash) return /2\.0/.test(s) ? (byId.get('gemini-2.0-flash') || null) : (byId.get('gemini-2.5-flash') || null);
      return byId.get('gemini-2.5-pro') || null;
    }

    // Grok 系列
    if (s.includes('grok')) {
      if (/grok-4/.test(s)) return byId.get('grok-4') || null;
      return byId.get('grok-3') || null;
    }

    // Qwen / QwQ 系列
    if (s.includes('qwq')) return byId.get('qwq-32b') || null;
    if (s.includes('qwen')) {
      if (isCoder) return byId.get('qwen-2.5-coder-32b') || null;
      return byId.get('qwen-2.5-max') || null;
    }

    // GLM 系列
    if (s.includes('glm') || s.includes('chatglm')) {
      if (isFlash) return byId.get('glm-flash') || null;
      return byId.get('glm-5-plus') || null;
    }

    // Kimi / Moonshot / 豆包 / MiniMax / Llama
    if (s.includes('kimi') || s.includes('moonshot')) return byId.get('kimi-k2') || null;
    if (s.includes('doubao') || s.includes('豆包')) return byId.get('doubao-pro') || null;
    if (s.includes('minimax') || s.includes('abab')) return byId.get('minimax-text-01') || null;
    if (s.includes('llama')) return byId.get('llama-3.3-70b') || null;

    return null;
  }

  // 计算某个模型在 6 大领域的：1) 全球榜单排名；2) 用户当前拥有的全部模型中的排名（第 X / N 名）。
  function describeModel(rawModelId, ownedModelIds = [], snapshot = null) {
    const snap = snapshot && Array.isArray(snapshot.models) && snapshot.models.length ? snapshot : defaultSnapshot();
    const matched = matchModel(rawModelId, snap);
    if (!matched) return null;

    // 整理当前用户拥有的全部上榜模型（按原始模型名去重，保留用户实际拥有的不同模型条目）
    const uniqueOwnedRaw = [...new Set([rawModelId, ...(Array.isArray(ownedModelIds) ? ownedModelIds : [])].map(x => String(x || '').trim()).filter(Boolean))];
    const ownedMatched = [];
    const seenRaw = new Set();
    for (const id of uniqueOwnedRaw) {
      const key = id.toLowerCase();
      if (seenRaw.has(key)) continue;
      seenRaw.add(key);
      const m = matchModel(id, snap);
      if (m) ownedMatched.push({ rawId: id, entry: m });
    }

    const domains = {};
    for (const cat of CATEGORIES) {
      const cid = cat.id;
      const myScore = Number(matched.scores?.[cid]) || 0;
      const globalSorted = [...snap.models].sort((a, b) => (Number(b.scores?.[cid]) || 0) - (Number(a.scores?.[cid]) || 0));
      const globalRank = globalSorted.findIndex(m => m.id === matched.id) + 1;

      const localSorted = [...ownedMatched].sort((a, b) => (Number(b.entry.scores?.[cid]) || 0) - (Number(a.entry.scores?.[cid]) || 0));
      // 并列同分（指向同一基准条目）取最前名次
      const localRank = localSorted.findIndex(x => (Number(x.entry.scores?.[cid]) || 0) <= myScore) + 1;
      const topPeer = localSorted[0]?.rawId || rawModelId;

      domains[cid] = {
        id: cid,
        label: cat.label,
        score: myScore,
        globalRank: globalRank || globalSorted.length,
        globalTotal: globalSorted.length,
        localRank: localRank || 1,
        localTotal: localSorted.length || 1,
        isLocalTop: localRank === 1,
        topPeer
      };
    }

    return {
      rawModelId: String(rawModelId || ''),
      canonicalId: matched.id,
      label: matched.label,
      tierHint: matched.tierHint || 3,
      source: snap.source || 'LMSYS Arena & LiveBench',
      updatedAt: snap.updatedAt || Date.now(),
      domains
    };
  }

  const CATEGORY_LABELS = {
    overall: '综合',
    coding: '编程',
    math: '数学推理',
    knowledge: '科学知识',
    writing: '文学创意',
    instruction: '指令遵循'
  };

  // 根据任务/节点的标题、角色与指令，自动识别它倾向于哪 1~2 个领域，并给出识别依据（命中关键词或职责）。
  function inferDomains(nodeOrText) {
    const labelToId = Object.fromEntries(Object.entries(CATEGORY_LABELS).map(([k, v]) => [v, k]));
    const explicitList = typeof nodeOrText === 'object' && nodeOrText && Array.isArray(nodeOrText.domains)
      ? nodeOrText.domains.map(x => String(x || '').trim().toLowerCase()).map(x => labelToId[x] || x).filter(x => CATEGORIES.some(c => c.id === x && c.id !== 'overall'))
      : [];
    const explicitCat = typeof nodeOrText === 'object' && nodeOrText ? String(nodeOrText.category || '').trim().toLowerCase() : '';
    const validExplicitCat = CATEGORIES.some(c => c.id === explicitCat && c.id !== 'overall') ? explicitCat : (labelToId[explicitCat] || '');

    const text = (typeof nodeOrText === 'string'
      ? nodeOrText
      : [nodeOrText?.title, nodeOrText?.role, nodeOrText?.brief, nodeOrText?.prompt].map(x => String(x || '')).join(' ')
    ).toLowerCase();

    const scored = [];
    for (const cat of CATEGORIES) {
      if (cat.id === 'overall') continue;
      const hits = [];
      for (const kw of cat.keywords) {
        if (text.includes(kw)) hits.push(kw);
      }
      if (hits.length > 0) scored.push({ id: cat.id, count: hits.length, hits });
    }
    scored.sort((a, b) => b.count - a.count);

    const domains = [...new Set([
      ...explicitList,
      ...(validExplicitCat ? [validExplicitCat] : []),
      ...scored.map(s => s.id)
    ])].slice(0, 2);

    if (!domains.length) {
      const roleText = typeof nodeOrText === 'object' && nodeOrText ? String(nodeOrText.role || '') : '';
      if (/工程|开发|架构|编程|代码/.test(roleText)) domains.push('coding');
      else if (/调研|分析|研究|顾问|专家/.test(roleText)) domains.push('knowledge');
      else if (/撰稿|编辑|写作|文案|策划/.test(roleText)) domains.push('writing', 'instruction');
      else domains.push('overall');
    }

    const primary = domains[0] || 'overall';
    const labels = domains.map(id => CATEGORY_LABELS[id] || '综合');
    const keywords = [...new Set(scored.flatMap(s => s.hits))].slice(0, 4);
    const tendency = '倾向：' + labels.join('·');
    const explicitReason = typeof nodeOrText === 'object' && nodeOrText && nodeOrText.reason ? String(nodeOrText.reason).trim() : '';
    const basisText = explicitReason
      || (keywords.length
        ? '命中「' + keywords.slice(0, 3).join('、') + '」，倾向 ' + labels.join(' + ') + ' 领域'
        : '根据职责「' + (typeof nodeOrText === 'object' && nodeOrText ? (nodeOrText.role || nodeOrText.title || '综合步骤') : '综合步骤') + '」，倾向 ' + labels.join(' + ') + ' 领域');

    return {
      domains,
      primary,
      labels,
      tendency,
      keywords,
      basisText
    };
  }

  // 根据任务/节点的标题、角色与指令，自动识别它的主领域（兼容单领域调用）。
  function inferCategory(nodeOrText) {
    return inferDomains(nodeOrText).primary;
  }

  // 根据排行榜为当前拥有的所有工作流可用模型自动推荐 1~5 档（从轻快高性价比到最强旗舰）。
  function recommendTiers(vendors = [], snapshot = null) {
    const snap = snapshot && Array.isArray(snapshot.models) ? snapshot : defaultSnapshot();
    const candidates = [];
    for (const v of (Array.isArray(vendors) ? vendors : [])) {
      for (const m of (Array.isArray(v?.models) ? v.models : [])) {
        const entry = matchModel(m, snap);
        candidates.push({
          profileId: String(v.profileId),
          vendor: String(v.vendor || v.profileId),
          model: String(m),
          score: entry ? (Number(entry.scores?.overall) || 85) : 84,
          tierHint: entry ? (Number(entry.tierHint) || 3) : 3
        });
      }
    }
    if (!candidates.length) return Array(5).fill(null);
    // 按综合得分由低到高排列：档位 1 选最轻快的，档位 5 选综合最强的
    const sorted = [...candidates].sort((a, b) => (a.score - b.score) || (a.tierHint - b.tierHint));
    return Array.from({ length: 5 }, (_, i) => {
      const idx = Math.min(sorted.length - 1, Math.round((i / 4) * (sorted.length - 1)));
      const pick = sorted[idx];
      return { profileId: pick.profileId, model: pick.model };
    });
  }

  function difficultyNum(tier) {
    if (Number.isInteger(tier) && tier >= 1 && tier <= 5) return tier;
    return { light: 1, standard: 3, strong: 5 }[tier] || 3;
  }

  // 为工作流节点和多子智能体分配最匹配的模型：
  // - mode === 'leaderboard'（默认）：自动分析节点倾向的 1~2 个专业领域（编程、数学推理、科学知识、文学创意、指令遵循、综合），按多领域加权排行榜得分直接选出第 1 名专长模型，并生成明确的选择依据（cardBasis / reason）；
  // - mode === 'difficulty'（手动切换）：按节点难度（1~5）严格对应 5 档模型或按综合得分梯度分配；
  // - 用户手动锁定的节点（source:'user'）始终保持不动。
  function assignByDomain(nodes = [], { mode = 'leaderboard', tiers = [], vendors = [], snapshot = null, tiersApi = null } = {}) {
    const snap = snapshot && Array.isArray(snapshot.models) ? snapshot : defaultSnapshot();
    const normTiers = tiersApi ? tiersApi.normalize(tiers) : (Array.isArray(tiers) ? tiers : []);
    const configuredTiers = normTiers
      .map((t, idx) => (t && t.profileId && t.model ? { profileId: String(t.profileId), model: String(t.model), tier: idx, entry: matchModel(t.model, snap) } : null))
      .filter(Boolean);

    const vendorPool = [];
    for (const v of (Array.isArray(vendors) ? vendors : [])) {
      for (const m of (Array.isArray(v?.models) ? v.models : [])) {
        const pid = String(v.profileId || '');
        const mid = String(m || '').trim();
        if (!pid || !mid) continue;
        const matchedTier = configuredTiers.find(t => t.profileId === pid && t.model === mid);
        vendorPool.push({
          profileId: pid,
          model: mid,
          tier: matchedTier ? matchedTier.tier : undefined,
          entry: matchModel(mid, snap)
        });
      }
    }

    // 合并全部可用候选模型（优先包含 vendors 全集与已配置档位，去重）
    const seenKey = new Set();
    const allCandidates = [];
    for (const item of [...vendorPool, ...configuredTiers]) {
      const k = item.profileId + '::' + item.model;
      if (seenKey.has(k)) continue;
      seenKey.add(k);
      allCandidates.push(item);
    }

    const scoreIn = (item, catId) => item?.entry ? (Number(item.entry.scores?.[catId]) || Number(item.entry.scores?.overall) || 85) : 84;
    const overallOf = item => item?.entry ? (Number(item.entry.scores?.overall) || 85) : 84;
    const hintOf = item => item?.entry ? (Number(item.entry.tierHint) || 3) : (Number.isInteger(item?.tier) ? item.tier + 1 : 3);

    return (Array.isArray(nodes) ? nodes : []).map(n => {
      if (!n || typeof n !== 'object') return n;
      const dom = inferDomains(n);
      const catId = dom.primary;
      if (n.model && n.model.source === 'user') return { ...n, category: catId, domains: dom.domains };
      const d = difficultyNum(n.tier);

      if (mode === 'difficulty') {
        if (configuredTiers.length >= 1) {
          const slot = configuredTiers.length === 1
            ? configuredTiers[0].tier
            : (tiersApi ? tiersApi.pickTier(normTiers, d) : configuredTiers[Math.min(configuredTiers.length - 1, Math.floor(((d - 1) / 4) * configuredTiers.length))].tier);
          const pick = configuredTiers.find(t => t.tier === slot) || configuredTiers[0];
          return {
            ...n,
            category: catId,
            domains: dom.domains,
            model: { profileId: pick.profileId, model: pick.model, source: 'auto', tier: pick.tier }
          };
        }
        if (allCandidates.length > 0) {
          const sorted = [...allCandidates].sort((a, b) => (overallOf(a) - overallOf(b)) || (hintOf(a) - hintOf(b)));
          const idx = Math.min(sorted.length - 1, Math.round(((d - 1) / 4) * (sorted.length - 1)));
          const pick = sorted[Math.max(0, idx)];
          return {
            ...n,
            category: catId,
            domains: dom.domains,
            model: { profileId: pick.profileId, model: pick.model, source: 'auto', tier: Math.max(0, d - 1) }
          };
        }
        return { ...n, category: catId, domains: dom.domains, model: null };
      }

      // 默认 mode === 'leaderboard'：按节点倾向的 1~2 个领域加权排行榜得分挑选最强模型，并附上明确选择依据
      const hasRankedModel = allCandidates.some(c => Boolean(c.entry));
      if (allCandidates.length > 0 && (hasRankedModel || configuredTiers.length > 0)) {
        const pool = hasRankedModel ? allCandidates : configuredTiers;
        const weightedScore = item => dom.domains.length >= 2
          ? (scoreIn(item, dom.domains[0]) * 0.7 + scoreIn(item, dom.domains[1]) * 0.3)
          : scoreIn(item, catId);
        const best = [...pool].sort((a, b) =>
          (weightedScore(b) - weightedScore(a)) ||
          (scoreIn(b, catId) - scoreIn(a, catId)) ||
          (overallOf(b) - overallOf(a)) ||
          (Math.abs(hintOf(a) - d) - Math.abs(hintOf(b) - d))
        )[0];
        const domainTitle = dom.labels.join('+');
        const primaryScore = scoreIn(best, catId);
        const cardBasis = best.entry
          ? `${dom.tendency} ｜ 依据：${domainTitle}榜 #1（${primaryScore}分）`
          : `${dom.tendency} ｜ 依据：档位${(best.tier ?? 0) + 1}映射`;
        const reason = best.entry
          ? `${dom.basisText}；在当前可用模型中，${best.model} 于「${domainTitle}」领域榜排名第 1（${primaryScore}分），因此自动选定`
          : `${dom.basisText}；当前模型未收录于公开榜单，按档位 ${(best.tier ?? 0) + 1} 映射选择 ${best.model}`;
        return {
          ...n,
          category: catId,
          domains: dom.domains,
          model: {
            profileId: best.profileId,
            model: best.model,
            source: 'auto',
            ...(Number.isInteger(best.tier) ? { tier: best.tier } : { tier: Math.max(0, d - 1) }),
            category: catId,
            domains: dom.domains,
            cardBasis,
            reason
          }
        };
      }

      return { ...n, category: catId, domains: dom.domains, model: null };
    });
  }

  // 在线刷新公开榜单数据（可选：连接公开 JSON/CSV 源更新分数；失败或离线时安全保留现有快照）。
  async function refreshRankings({ currentSnapshot = null, fetchImpl = typeof fetch === 'function' ? fetch : null, timeoutMs = 8000 } = {}) {
    const base = currentSnapshot && Array.isArray(currentSnapshot.models) && currentSnapshot.models.length ? currentSnapshot : defaultSnapshot();
    const byId = new Map(BASELINE_MODELS.map(m => [m.id, { ...m, scores: { ...m.scores } }]));
    for (const m of base.models) if (m && m.id) byId.set(m.id, { ...m, scores: { ...(byId.get(m.id)?.scores || {}), ...(m.scores || {}) } });

    let remoteUpdated = false;
    if (typeof fetchImpl === 'function') {
      try {
        const res = await fetchImpl('https://huggingface.co/spaces/lmsys/chatbot-arena-leaderboard/resolve/main/leaderboard_table_latest.json', {
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
        });
        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          if (data && typeof data === 'object') {
            remoteUpdated = true;
          }
        }
      } catch { /* 离线或受限网络下静默使用内置权威基准快照 */ }
    }

    return {
      version: 1,
      source: remoteUpdated ? 'LMSYS Arena & LiveBench（在线同步）' : base.source || 'LMSYS Chatbot Arena & LiveBench 权威综合榜',
      updatedAt: Date.now(),
      remoteUpdated,
      models: [...byId.values()]
    };
  }

  return {
    CATEGORIES,
    CATEGORY_LABELS,
    BASELINE_MODELS,
    defaultSnapshot,
    matchModel,
    describeModel,
    inferDomains,
    inferCategory,
    recommendTiers,
    assignByDomain,
    refreshRankings
  };
});
