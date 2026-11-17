'use strict';
// 交互选项卡的“超时自动选择推荐项”逻辑。纯函数，便于测试；界面只负责计时与展示。
// 目的：Agent 提问后用户没来得及选，任务不能一直卡着——到时间就按推荐项继续，并在聊天里明确说“已自动选择”。
(function (root, factory) { const api = factory(); if (typeof module === 'object' && module.exports) module.exports = api; else root.PiInteractionTimeout = api; })(typeof window === 'object' ? window : globalThis, () => {
  const CHOICES = [0, 30, 60, 120, 300];            // 秒；0 = 永不自动选择
  const DEFAULT_SECONDS = 0;                          // 默认不自动选：替用户做决定必须是他主动开启的
  const normalizeSeconds = v => { const n = Number(v); return CHOICES.includes(n) ? n : DEFAULT_SECONDS; };

  // 这次提问要不要自动应答：只有“有明确推荐项”的选择题才自动选。
  //   选择题：选推荐项（Agent 用 recommended 指定；没指定就取第一项——约定第一项是推荐）。
  //   确认题：只有 Agent 明确给了 recommended（true/false）才自动答；没给就不自动，因为“确认/取消”没有天然的默认。
  //   输入题/编辑题：没有推荐项，不自动。
  function autoAnswer(request, seconds) {
    const s = normalizeSeconds(seconds);
    if (!s || !request) return null;
    const method = request.method || 'confirm';
    if (method === 'select') {
      const options = Array.isArray(request.options) ? request.options.filter(x => typeof x === 'string' && x) : [];
      if (!options.length) return null;
      const rec = recommendedIndex(request, options);
      if(rec===customIndex(request))return null;
      return { seconds: s, response: { value: options[rec] }, label: options[rec] };
    }
    if (method === 'confirm' && typeof request.recommended === 'boolean') {
      return { seconds: s, response: { confirmed: request.recommended }, label: request.recommended ? '确认' : '取消' };
    }
    return null;
  }
  function recommendedIndex(request, options) {
    const r = request.recommended;
    if (Number.isInteger(r) && r >= 0 && r < options.length) return r;
    if (typeof r === 'string') { const i = options.indexOf(r); if (i >= 0) return i; }
    return 0;
  }
  // 展示用：哪个选项是推荐的（-1 = 没有）。确认题不涉及。
  const recommendedOf = request => {
    if (!request || request.method !== 'select') return -1;
    const options = Array.isArray(request.options) ? request.options : [];
    return options.length ? recommendedIndex(request, options) : -1;
  };

  // 扩展把推荐项编在 title/message 末尾的不可见标记里（⁣REC:<json>⁣）。取出后返回干净的请求，界面永远看不到标记。
  const MARK = /⁣REC:([^⁣]*)⁣/;
  function extract(request) {
    if (!request || typeof request !== 'object') return request;
    let recommended;
    const clean = {};
    for (const [k, v] of Object.entries(request)) {
      if (typeof v === 'string' && MARK.test(v)) { try { recommended = JSON.parse(MARK.exec(v)[1]); } catch { /* 坏标记：忽略，只是没有推荐项 */ } clean[k] = v.replace(MARK, ''); }
      else clean[k] = v;
    }
    return recommended === undefined ? clean : { ...clean, recommended };
  }

  function customIndex(request){
    const options=request?.options||[],i=options.length-1;
    const label=String(options[i]||'').trim();
    return /^(其他|其它|自定义(?:需求|答案|内容|选项)?|自己填写|自行填写|other|custom)(?:\s*[（(:：,，—-]\s*(?:请|自行|自己|直接)?(?:填写|输入|说明|补充|specify)[^\n]{0,30}[）)]?)?$/i.test(label)?i:-1;
  }

  return { customIndex, extract, CHOICES, DEFAULT_SECONDS, normalizeSeconds, autoAnswer, recommendedOf };
});
