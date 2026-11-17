'use strict';
(() => {
  const ESC = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const CONTENT = {
    'memory-type': ['记忆类型', '类型用于说明这条记忆在任务中的作用，例如偏好、约束、事实或纠错。它不会改变原文，只帮助 Agent 进行筛选和整理。'],
    'memory-lifespan': ['记忆时效', '长期记忆会持续参与后续相关任务；短期记忆会带有失效时间。只有“全部记忆”会显示每条短期记忆的具体失效时间。'],
    'memory-source': ['记忆来源', '用户写入的内容不会被自动拆分；Agent 生成的内容会先进入待确认状态。只有你确认后，候选记忆才会参与后续上下文。'],
    'memory-review': ['待确认记忆', '这是 Agent 根据对话整理出的候选内容。你可以逐条编辑、确认、停用、合并或拆分，确认前不会写入下一轮 Agent 上下文。'],
    'context-preview': ['上下文内容', '这里展示本任务下一轮实际可能载入的内容和来源。系统规则、权限与工具协议是只读的；任务目标、记忆和最近对话可以由你控制。'],
    'context-edit': ['上下文编辑', '编辑会保存为任务级覆盖项，不会改写原始聊天记录。保存后下一轮 Agent 会使用新内容；你可以从历史中恢复之前的版本。'],
    'context-compress': ['上下文压缩', '压缩会让 Pi Agent 生成一份摘要并保留原始任务记录。压缩摘要也可以查看、修改或从历史版本恢复。'],
    'context-capacity': ['上下文容量', '容量来自当前模型的已知元数据或你的手动设置。若提供商没有返回规格，会明确显示“未知”，不会伪造一个固定容量。底部比例是本地估算值。'],
    'execution-graph': ['执行导图', '导图只根据 Agent 已产生的事件、工具调用和子任务关系绘制。它显示状态、依赖和实际并行分支，不展示隐藏的思维过程。'],
    'token-rate': ['Token 速率', '速率使用模型返回的输出 token 和可测运行时间计算；流式过程中是估算值，工具等待时间会单独标记，不会伪装成模型生成速度。'],
    'run-metrics': ['运行指标', '输入、输出和缓存数量优先使用模型实际返回的 usage；没有 usage 时会明确标出估算。生成时长会排除工具和确认等待。'],
    'interactive': ['需求确认', '开启后，当 Agent 判断目标、范围或下一步不明确时，会弹出选项卡让你确认。它是 Agent 的通用能力，不属于某个工作台。']
  };
  let active = null, restoreFocus = null;
  function button(key, label='帮助') {
    const item = CONTENT[key] || ['帮助', '这里暂时没有更多说明。'];
    return `<button type="button" class="help-button" data-help-key="${ESC(key)}" aria-label="${ESC(item[0])}：${ESC(label)}" title="${ESC(item[0])}">?</button>`;
  }
  function close() {
    if (!active) return;
    active.remove(); active = null;
    if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
    restoreFocus = null;
  }
  function open(key, source) {
    const item = CONTENT[key] || ['帮助', '这里暂时没有更多说明。'];
    close(); restoreFocus = source;
    const el = document.createElement('div');
    el.className = 'help-popover'; el.setAttribute('role','dialog'); el.setAttribute('aria-modal','false');
    el.innerHTML = `<div class="help-popover-head"><strong>${ESC(item[0])}</strong><button type="button" class="help-close" aria-label="关闭帮助">×</button></div><p>${ESC(item[1])}</p>`;
    document.body.append(el); active = el;
    const rect=source?.getBoundingClientRect();if(rect){el.style.right='auto';el.style.left=Math.max(12,Math.min(window.innerWidth-el.offsetWidth-12,rect.left))+'px';el.style.top=Math.max(12,Math.min(window.innerHeight-el.offsetHeight-12,rect.bottom+8))+'px';}
    el.querySelector('.help-close').focus();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-help-key]');
    if (button) { event.preventDefault(); event.stopPropagation(); open(button.dataset.helpKey, button); return; }
    if (event.target.closest('.help-close')) { close(); return; }
    if (active && !event.target.closest('.help-popover')) close();
  },true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) { event.preventDefault(); close(); } });
  window.PiHelp = { button, open, close, keys: () => Object.keys(CONTENT) };
})();
