'use strict';

(() => {
  const instances = new WeakMap();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function normalize(value) {
    return String(value ?? '').trim().toLocaleLowerCase('zh-CN');
  }

  function searchable(item) {
    return normalize([item.name, item.title, item.description, ...(item.keywords || [])].join(' '));
  }

  function triggerAt(textarea) {
    const value = textarea.value;
    const caret = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : value.length;
    const before = value.slice(0, caret);
    const slash = before.match(/^\s*\/([^\s/]*)$/);
    if (slash) return { type: 'command', query: slash[1], start: before.lastIndexOf('/'), end: caret };
    const mention = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (mention) return { type: 'mention', query: mention[1], start: before.lastIndexOf('@'), end: caret };
    return null;
  }

  function attach(options) {
    const textarea = options?.textarea;
    const host = options?.host || textarea?.closest('form');
    if (!textarea || !host) throw new Error('Composer palette requires a textarea and host');
    instances.get(textarea)?.destroy();

    const panel = document.createElement('div');
    panel.id = `composer-palette-${Math.random().toString(36).slice(2, 9)}`;
    panel.className = 'composer-palette';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', '输入建议');
    panel.hidden = true;
    host.append(panel);

    let trigger = null;
    let items = [];
    let activeIndex = 0;

    textarea.setAttribute('aria-autocomplete', 'list');
    textarea.setAttribute('aria-controls', panel.id);
    textarea.setAttribute('aria-expanded', 'false');

    const source = type => {
      const value = type === 'command' ? options.commands : options.mentions;
      return typeof value === 'function' ? value() : value || [];
    };

    function close() {
      trigger = null;
      items = [];
      activeIndex = 0;
      panel.hidden = true;
      panel.replaceChildren();
      textarea.setAttribute('aria-expanded', 'false');
      textarea.removeAttribute('aria-activedescendant');
    }

    function itemId(index) {
      return `${panel.id}-option-${index}`;
    }

    function render() {
      if (!trigger || !items.length) {
        close();
        return;
      }
      const commandMode = trigger.type === 'command';
      const title = commandMode ? 'Pi 指令' : '使用插件或工作台';
      const hint = commandMode ? '输入以筛选 · Enter 选择' : '选择后在当前对话中启用';
      panel.innerHTML = `<div class="composer-palette-head"><strong>${title}</strong><span>${hint}</span></div><div class="composer-palette-list">${items.map((item, index) => {
        const command = commandMode ? `/${item.name}${item.args ? ` ${item.args}` : ''}` : item.name;
        const badge = commandMode ? (item.sourceLabel || 'Pi') : (item.kind === 'plugin' ? '插件' : '工作台');
        const active = index === activeIndex;
        return `<button type="button" id="${itemId(index)}" class="composer-palette-option${active ? ' active' : ''}" role="option" aria-selected="${active}" data-index="${index}"><span class="composer-palette-main"><span class="composer-palette-name">${escapeHtml(command)}</span>${item.active ? '<span class="composer-palette-live">使用中</span>' : ''}</span><span class="composer-palette-description">${escapeHtml(item.description || item.title || '')}</span><span class="composer-palette-badge">${escapeHtml(badge)}</span></button>`;
      }).join('')}</div><div class="composer-palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 浏览</span><span><kbd>Enter</kbd> 选择</span><span><kbd>Esc</kbd> 关闭</span></div>`;
      panel.hidden = false;
      textarea.setAttribute('aria-expanded', 'true');
      textarea.setAttribute('aria-activedescendant', itemId(activeIndex));
      panel.querySelector('.composer-palette-option.active')?.scrollIntoView({ block: 'nearest' });
    }

    function refresh() {
      trigger = triggerAt(textarea);
      if (!trigger) {
        close();
        return;
      }
      const query = normalize(trigger.query);
      items = source(trigger.type).filter(item => !query || searchable(item).includes(query));
      activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
      render();
    }

    function replaceTrigger(replacement) {
      if (!trigger) return;
      const value = textarea.value;
      const next = value.slice(0, trigger.start) + replacement + value.slice(trigger.end);
      const caret = trigger.start + replacement.length;
      textarea.value = next;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function choose(index = activeIndex) {
      const item = items[index];
      if (!item || !trigger) return;
      const selectedTrigger = { ...trigger };
      if (selectedTrigger.type === 'command') {
        const command = `/${item.name}${item.args ? ' ' : ''}`;
        replaceTrigger(command);
        close();
        if (item.args) options.onCommand?.(item, command);
        else host.requestSubmit();
      } else {
        replaceTrigger('');
        close();
        options.onMention?.(item);
      }
    }

    function move(delta) {
      if (!items.length) return;
      activeIndex = (activeIndex + delta + items.length) % items.length;
      render();
    }

    function onKeydown(event) {
      if (panel.hidden) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopImmediatePropagation();
        move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
        choose();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      }
    }

    function onPointerdown(event) {
      const option = event.target.closest('.composer-palette-option');
      if (!option) return;
      event.preventDefault();
      choose(Number(option.dataset.index));
      textarea.focus();
    }

    textarea.addEventListener('input', refresh);
    textarea.addEventListener('click', refresh);
    textarea.addEventListener('keyup', event => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) refresh();
    });
    textarea.addEventListener('keydown', onKeydown, true);
    panel.addEventListener('pointerdown', onPointerdown);

    const api = {
      close,
      refresh,
      isOpen: () => !panel.hidden,
      destroy() {
        close();
        panel.remove();
        textarea.removeAttribute('aria-autocomplete');
        textarea.removeAttribute('aria-controls');
        textarea.removeAttribute('aria-expanded');
        textarea.removeAttribute('aria-activedescendant');
        instances.delete(textarea);
      }
    };
    instances.set(textarea, api);
    return api;
  }

  window.PiComposerPalette = Object.freeze({
    attach,
    isOpen: textarea => Boolean(instances.get(textarea)?.isOpen())
  });
})();
