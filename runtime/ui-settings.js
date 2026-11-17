'use strict';
// 界面设置：字体缩放、快捷键、发送方式。设置保存在 state.settings 中，由 app.js 注入读写接口。
window.PiUiSettings = (() => {
  const ACTIONS = [
    { id: 'search', label: '搜索对话', hint: '跳转到搜索页', key: 'Ctrl+K' },
    { id: 'settings', label: '打开设置', hint: '跳转到设置页', key: 'Ctrl+,' },
    { id: 'new-task', label: '新建任务', hint: '在当前项目中新建任务', key: 'Ctrl+N' },
    { id: 'focus-input', label: '聚焦输入框', hint: '回到对话并聚焦输入框', key: 'Ctrl+L' },
    { id: 'stop-agent', label: '停止 Agent', hint: '停止当前正在运行的 Agent', key: 'Ctrl+.' },
    { id: 'toggle-sidebar', label: '折叠 / 展开侧栏', hint: '收起左侧项目栏，给对话更多空间', key: 'Ctrl+B' },
    { id: 'nav-back', label: '后退', hint: '回到上一个页面或任务', key: 'Alt+ArrowLeft' },
    { id: 'nav-forward', label: '前进', hint: '回到后退之前的页面或任务', key: 'Alt+ArrowRight' },
    { id: 'toggle-approval', label: '切换批准模式', hint: '在请求批准与完全批准之间切换', key: 'Ctrl+Shift+A' }
  ];
  // 聊天框功能开关。defaultOn 为精简默认值；用户在 设置 → 开关 里逐项开启或关闭。
  const COMPOSER_FEATURES = [
    { id: 'attach', label: '添加附件', hint: '输入框左下角的回形针按钮', defaultOn: true },
    { id: 'model', label: '模型选择', hint: '在聊天框里切换当前模型', defaultOn: true },
    { id: 'approval', label: '批准模式', hint: '切换“请求批准 / 完全批准”', defaultOn: true },
    { id: 'provider', label: 'API 选择', hint: '多个 API 时在聊天框里切换', defaultOn: false },
    { id: 'effort', label: '思考强度', hint: '在聊天框里调节模型的思考强度', defaultOn: true },
    { id: 'capacity', label: '上下文容量', hint: '显示已用上下文并可打开管理', defaultOn: false },
    { id: 'interactive', label: '交互式确认', hint: '需求不明确时弹出选项卡', defaultOn: false },
    { id: 'rate', label: '输出速率', hint: '显示本轮每秒输出的 token 数', defaultOn: false },
    { id: 'mode', label: '当前模式标签', hint: '显示基础模式或正在使用的工作台', defaultOn: true },
    { id: 'caption', label: '底部提示语', hint: '输入框下方的模型与说明文字', defaultOn: false },
    { id: 'workflow', label: '工作流拆分', hint: '把复杂问题拆成串行/并行的小任务，在右侧画布里查看与调整。开启后每次发送前会额外调用一次模型（短问题会自动跳过）', defaultOn: false }
  ];
  const composerOn = (settings, id) => {
    const f = COMPOSER_FEATURES.find(x => x.id === id);
    if (!f) return true;
    const v = settings?.composer?.[id];
    return typeof v === 'boolean' ? v : f.defaultOn;
  };
  const SCALES = [[90, '小'], [100, '标准'], [115, '大'], [130, '特大'], [150, '超大']];
  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'];
  let host = null, recording = null, recordButton = null, listening = false;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const settings = () => host.settings();
  const bindings = () => ({ ...Object.fromEntries(ACTIONS.map(a => [a.id, a.key])), ...(settings().shortcuts || {}) });
  const scaleOf = () => SCALES.some(([v]) => v === settings().fontScale) ? settings().fontScale : 100;

  function combo(e) {
    if (MODIFIER_KEYS.includes(e.key)) return '';
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }
  const valid = c => /^(Ctrl|Alt)\+/.test(c) || /^(Ctrl\+|Alt\+|Shift\+)*F([1-9]|1[0-2])$/.test(c);
  const KEY_LABEL = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: '回车' };
  const label = k => KEY_LABEL[k] || k;
  const kbd = c => c.split(/\+(?=.)/).map(k => '<kbd>' + esc(label(k)) + '</kbd>').join('');

  function applyFontScale() {
    const factor = scaleOf() / 100;
    try {
      if (window.piDesktop?.ui?.setZoom) window.piDesktop.ui.setZoom(factor);
      else document.documentElement.style.zoom = factor === 1 ? '' : String(factor);
    } catch { /* 缩放失败时保持当前显示 */ }
  }

  function stopRecording() {
    if (recordButton?.isConnected) recordButton.textContent = '更改';
    recording = null; recordButton = null;
  }

  function onRecordKey(e) {
    if (!recording) return;
    if (!recordButton?.isConnected) { stopRecording(); return; }
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopRecording(); return; }
    const c = combo(e);
    if (!c) return;
    if (!valid(c)) { host.notify('快捷键需要包含 Ctrl 或 Alt，或使用 F1 到 F12'); return; }
    const owner = ACTIONS.find(a => a.id !== recording && bindings()[a.id] === c);
    if (owner) { host.notify(c + ' 已被「' + owner.label + '」使用'); return; }
    const id = recording, def = ACTIONS.find(a => a.id === id).key, shortcuts = { ...(settings().shortcuts || {}) };
    if (c === def) delete shortcuts[id]; else shortcuts[id] = c;
    settings().shortcuts = shortcuts;
    host.save(); stopRecording(); syncHints(); host.rerender();
  }

  function handleKeydown(e) {
    if (e.isComposing || recording) return false;
    const c = combo(e);
    if (!c) return false;
    const hit = ACTIONS.find(a => bindings()[a.id] === c);
    if (!hit) return false;
    e.preventDefault();
    host.run(hit.id);
    return true;
  }

  // 输入框按键是否应当发送：Enter 模式下 Enter 发送，Shift+Enter 换行；Ctrl+Enter 模式下只有 Ctrl+Enter 发送。
  function isSendKey(e) {
    if (e.key !== 'Enter' || e.isComposing) return false;
    return settings().sendKey === 'ctrl-enter' ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
  }

  function mountAppearance(root) {
    const current = scaleOf(), sendKey = settings().sendKey === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
    root.innerHTML =
      '<div class="setting-row"><div><h3>字体大小</h3><p>缩放整个界面的文字与控件，立即生效。</p></div>' +
      '<div class="segmented" role="group" aria-label="字体大小">' +
      SCALES.map(([v, name]) => '<button type="button" class="' + (v === current ? 'active' : '') + '" data-font-scale="' + v + '" aria-pressed="' + (v === current) + '">' + name + '<small>' + v + '%</small></button>').join('') +
      '</div></div>' +
      '<div class="setting-row"><div><h3>发送消息</h3><p>选择用哪个按键发送消息，另一种组合用于换行。</p></div>' +
      '<select class="compact-select" id="send-key-setting" aria-label="发送消息按键"><option value="enter"' + (sendKey === 'enter' ? ' selected' : '') + '>Enter 发送，Shift+Enter 换行</option><option value="ctrl-enter"' + (sendKey === 'ctrl-enter' ? ' selected' : '') + '>Ctrl+Enter 发送，Enter 换行</option></select></div>';
    root.insertAdjacentHTML('beforeend','<div class="setting-row"><div><h3>Agent 显示语言</h3><p>回复、过程说明和需求提问优先使用所选语言。</p></div><select class="compact-select" id="response-language-setting" aria-label="Agent 显示语言"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="auto">跟随系统</option></select></div><div class="setting-row"><div><h3>自动翻译外语回复</h3><p>保留原文，在下方显示译文。使用当前 API 和模型，译文会缓存，不加入任务上下文；翻译会消耗少量 token。</p></div><label class="toggle"><input id="auto-translate-setting" aria-label="自动翻译外语回复" type="checkbox"><span></span></label></div>');
    root.querySelector('#response-language-setting').value=settings().language||'zh-CN';
    root.querySelector('#response-language-setting').addEventListener('change',e=>{settings().language=e.target.value;host.save();host.rerenderChat?.();window.PiResponseLanguage.schedule();});
    root.querySelector('#auto-translate-setting').checked=settings().autoTranslate!==false;
    root.querySelector('#auto-translate-setting').addEventListener('change',e=>{settings().autoTranslate=e.target.checked;host.save();host.rerenderChat?.();window.PiResponseLanguage.schedule();});
    const auto = window.PiInteractionTimeout ? window.PiInteractionTimeout.normalizeSeconds(settings().autoChooseSeconds) : 0;
    root.insertAdjacentHTML('beforeend', '<div class="setting-row"><div><h3>提问后自动选择推荐项</h3><p>Agent 弹出选项卡后，如果你一直没选，到时间就按推荐项继续，避免任务卡住。只对有推荐项的选择题生效，聊天里会写明是自动选的。默认关闭。</p></div>' +
      '<select class="compact-select" id="auto-choose-setting" aria-label="自动选择推荐项的等待时间">' + [[0, '不自动选择'], [30, '30 秒后'], [60, '1 分钟后'], [120, '2 分钟后'], [300, '5 分钟后']].map(([v, name]) => '<option value="' + v + '"' + (v === auto ? ' selected' : '') + '>' + name + '</option>').join('') + '</select></div>');
    root.querySelector('#auto-choose-setting').addEventListener('change', e => { settings().autoChooseSeconds = window.PiInteractionTimeout ? window.PiInteractionTimeout.normalizeSeconds(e.target.value) : 0; host.save(); host.notify(settings().autoChooseSeconds ? '提问后 ' + settings().autoChooseSeconds + ' 秒未选择，将自动选推荐项' : '已关闭自动选择'); });
    root.querySelectorAll('[data-font-scale]').forEach(b => b.addEventListener('click', () => {
      settings().fontScale = Number(b.dataset.fontScale);
      host.save(); applyFontScale(); mountAppearance(root);
    }));
    root.querySelector('#send-key-setting').addEventListener('change', e => {
      settings().sendKey = e.target.value === 'ctrl-enter' ? 'ctrl-enter' : 'enter';
      host.save(); host.notify(settings().sendKey === 'ctrl-enter' ? '现在使用 Ctrl+Enter 发送' : '现在使用 Enter 发送');
    });
  }

  function mountShortcuts(root) {
    stopRecording();
    if (!listening) { document.addEventListener('keydown', onRecordKey, true); listening = true; }
    const map = bindings();
    root.innerHTML = ACTIONS.map(a => {
      const changed = map[a.id] !== a.key;
      return '<div class="setting-row shortcut-row"><div><h3>' + esc(a.label) + '</h3><p>' + esc(a.hint) + '</p></div>' +
        '<div class="shortcut-control"><span class="keys" data-keys="' + a.id + '">' + kbd(map[a.id]) + '</span>' +
        '<button type="button" class="button" data-record="' + a.id + '">更改</button>' +
        '<button type="button" class="button" data-reset="' + a.id + '"' + (changed ? '' : ' disabled') + '>默认</button></div></div>';
    }).join('');
    root.querySelectorAll('[data-record]').forEach(b => b.addEventListener('click', () => {
      const same = recording === b.dataset.record;
      stopRecording();
      if (same) return;
      recording = b.dataset.record; recordButton = b; b.textContent = '请按下新快捷键…';
    }));
    root.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => {
      const shortcuts = { ...(settings().shortcuts || {}) };
      delete shortcuts[b.dataset.reset];
      settings().shortcuts = shortcuts; host.save(); syncHints(); mountShortcuts(root);
    }));
  }

  function syncHints() {
    const el = document.querySelector('[data-route="search"] kbd');
    if (el) el.textContent = bindings().search.split('+').map(label).join(' ');
  }

  function mountToggles(root) {
    root.innerHTML = COMPOSER_FEATURES.map(f => {
      const on = composerOn(settings(), f.id);
      return '<div class="setting-row"><div><h3>' + esc(f.label) + '</h3><p>' + esc(f.hint) + '</p></div>' +
        '<label class="toggle"><input type="checkbox" data-composer-toggle="' + f.id + '" aria-label="' + esc(f.label) + '"' + (on ? ' checked' : '') + '><span></span></label></div>';
    }).join('');
    root.querySelectorAll('[data-composer-toggle]').forEach(input => input.addEventListener('change', () => {
      const composer = { ...(settings().composer || {}) };
      composer[input.dataset.composerToggle] = input.checked;
      settings().composer = composer;
      host.save(); host.rerenderChat?.();
    }));
    root.insertAdjacentHTML('beforeend', '<div class="setting-row"><div><h3>在项目里也显示工作台任务</h3><p>默认只在左侧「工作台」栏目里显示使用、创建、修改工作台的任务；打开后项目里也会显示。</p></div><label class="toggle"><input type="checkbox" data-wb-in-projects aria-label="在项目里也显示工作台任务"'+(settings().workbenchInProjects===true?' checked':'')+'><span></span></label></div>');
    root.querySelector('[data-wb-in-projects]').addEventListener('change', e => { settings().workbenchInProjects = e.target.checked; host.save(); host.rerenderSidebar?.(); });
    root.insertAdjacentHTML('beforeend', '<div class="setting-row"><div><h3>恢复默认</h3><p>回到精简默认：只保留附件、模型、批准模式和当前模式标签。</p></div><button type="button" class="button" data-composer-reset>恢复</button></div>');
    root.querySelector('[data-composer-reset]').addEventListener('click', () => { settings().composer = {}; host.save(); host.rerenderChat?.(); mountToggles(root); host.notify('聊天框已恢复精简默认'); });
  }

  function init(options) { host = options; applyFontScale(); syncHints(); }

  return Object.freeze({ init, handleKeydown, isSendKey, mountAppearance, mountShortcuts, applyFontScale, combo, ACTIONS, COMPOSER_FEATURES, composerOn, mountToggles });
})();
