'use strict';
// 五档模型：档位 1（最轻、最便宜）到 5（最强）。每档指向一个具体模型 {profileId, model}，可跨厂商。
// 这里全是纯函数：校验、按难度选档、缺档时的回退，以及“可选的全部模型”列表。
// 规则是用户定的：只配了 1 个档位 → 所有节点都用它；配了 2 个 → 难度分成两段；以此类推；一个都没配 → 用主模型。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiModelTiers = api; })(typeof window === 'object' ? window : globalThis, () => {
  const COUNT = 5;
  const LABELS = ['档位 1 · 最轻', '档位 2 · 轻', '档位 3 · 标准', '档位 4 · 强', '档位 5 · 最强'];
  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

  // 规范化存储：恒为长度 5 的数组，每项 null 或 { profileId, model }。非法输入一律当作“未配置”，不抛错。
  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : [];
    return Array.from({ length: COUNT }, (_, i) => {
      const x = list[i];
      return x && typeof x === 'object' && text(x.profileId, 80) && text(x.model, 120) ? { profileId: text(x.profileId, 80), model: text(x.model, 120) } : null;
    });
  }

  // 去掉已经不存在的模型（厂商被删、模型被移出列表）。返回 { tiers, dropped }，dropped 是被清掉的档位序号（0 起）。
  function prune(tiers, vendors) {
    const known = new Set((vendors || []).flatMap(v => (v.models || []).map(m => v.profileId + '::' + m)));
    const dropped = [];
    const out = normalize(tiers).map((t, i) => (t && !known.has(t.profileId + '::' + t.model) ? (dropped.push(i), null) : t));
    return { tiers: out, dropped };
  }

  const configured = tiers => normalize(tiers).map((t, i) => (t ? i : -1)).filter(i => i >= 0);

  // 把节点的难度（light/standard/strong 或 1-5）映射到“真实可用档位”。
  //   n = 已配置的档位数。把难度均分到这 n 个档位上：n=1 全用它；n=2 轻的一半用低档、重的一半用高档；n=5 一一对应。
  function difficultyOf(tier) {
    if (Number.isInteger(tier) && tier >= 1 && tier <= COUNT) return tier;
    return { light: 1, standard: 3, strong: 5 }[tier] || 3;
  }
  function pickTier(tiers, difficulty) {
    const have = configured(tiers);
    if (!have.length) return null;
    const d = difficultyOf(difficulty);                                   // 1..5
    // 难度 d 落在 [0,1) 区间的位置，再按已配置档位数分段
    const position = (d - 1) / (COUNT - 1);                               // 0..1
    const slot = Math.min(have.length - 1, Math.floor(position * have.length - 1e-9 + (position === 1 ? 1e-9 : 0)));
    return have[Math.max(0, slot)];
  }

  // 为一个节点自动选模型。返回 { profileId, model, tier(0起), reason }；没配任何档位则返回 null（调用方用主模型）。
  function assign(tiers, difficulty) {
    const index = pickTier(tiers, difficulty);
    if (index === null) return null;
    const t = normalize(tiers)[index];
    return { profileId: t.profileId, model: t.model, tier: index, reason: '难度「' + labelOfDifficulty(difficulty) + '」→ ' + LABELS[index] };
  }
  const labelOfDifficulty = d => ({ light: '轻', standard: '标准', strong: '强' }[d] || (Number.isInteger(d) ? '第 ' + d + ' 级' : '标准'));

  // 拆解本身用最便宜的已配置档位；一个都没配则返回 null（用主模型）。
  const plannerModel = tiers => { const have = configured(tiers); if (!have.length) return null; const t = normalize(tiers)[have[0]]; return { profileId: t.profileId, model: t.model, tier: have[0] }; };

  // 给所有“未被用户锁定”的节点重新分配模型；用户锁定（source:'user'）的永远不动。返回新的节点数组（不修改入参）。
  function assignAll(nodes, tiers) {
    return (nodes || []).map(n => {
      if (n && n.model && n.model.source === 'user') return n;
      const a = assign(tiers, n && n.tier);
      return { ...n, model: a ? { profileId: a.profileId, model: a.model, source: 'auto', tier: a.tier } : null };
    });
  }

  // 用户手动选择时可以选“所有厂商的所有模型”（不限于五档）。输出两级结构：厂商 → 模型。
  function menu(vendors) {
    return (vendors || []).filter(v => v && Array.isArray(v.models) && v.models.length).map(v => ({ profileId: String(v.profileId), vendor: String(v.vendor || v.profileId), models: [...new Set(v.models.map(String))] }));
  }

  return { COUNT, LABELS, normalize, prune, configured, difficultyOf, pickTier, assign, assignAll, plannerModel, menu };
});
