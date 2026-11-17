'use strict';
// Fixed, bounded operations only. Agent input is data, never executable code.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const MUTATIONS = new Set(['click', 'fill', 'select', 'check', 'press', 'drag']);
function pageOperation(input) {
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const selector = el => el.id ? '#' + CSS.escape(el.id) : el.getAttribute('data-testid') ? '[data-testid="' + CSS.escape(el.getAttribute('data-testid')) + '"]' : (() => { const parts = []; for (let n = el; n && n !== document.body; n = n.parentElement) { parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + ([...n.parentElement.children].indexOf(n) + 1) + ')'); } return 'body > ' + parts.join(' > '); })();
  const item = el => ({ selector: selector(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.getAttribute('title') || '').slice(0, 240), value: el.type === 'password' ? '[已隐藏]' : String(el.value ?? '').slice(0, 2000), disabled: Boolean(el.disabled || el.closest('[inert]') || el.getAttribute('aria-disabled') === 'true'), visible: visible(el), checked: Boolean(el.checked), rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() });
  if (input.operation === 'inspect') {
    const controls = [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea,a[href],[role=button],[role=tab],[role=checkbox],[role=slider],[contenteditable=true],canvas,[data-pi-control],[onclick],[draggable=true]')].filter(visible);
    const offset = Math.max(0, Number(input.offset) || 0), limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
    return { ready: document.documentElement.dataset.piRuntimeReady === 'true', title: document.title, text: (document.body?.innerText || '').slice(0, 12000), controls: controls.slice(offset, offset + limit).map(item), total: controls.length, next: offset + limit < controls.length ? offset + limit : null, errors: (window.__piRuntimeDiagnostics || []).slice(-40), pending: Number(window.__piRuntimePending || 0) };
  }
  const matches = [...document.querySelectorAll(String(input.selector || ''))];
  if (input.operation === 'read' && !matches.length) return { exists: false, visible: false };
  if (matches.length !== 1) throw new Error('控件必须唯一：' + input.selector + '，匹配 ' + matches.length + ' 个');
  const el = matches[0];
  if (input.operation === 'read') return { exists: true, ...item(el), text: (el.innerText ?? el.textContent ?? '').slice(0, 12000) };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (!visible(el) || el.disabled || el.closest('[inert]') || el.getAttribute('aria-disabled') === 'true') throw new Error('控件不可操作：' + input.selector);
  if (input.operation === 'select') {
    if (el.tagName !== 'SELECT' || ![...el.options].some(o => o.value === String(input.value) && !o.disabled)) throw new Error('下拉选项不存在或不可用：' + input.value);
    el.value = String(input.value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (input.operation === 'focus') {
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) throw new Error('控件不是可输入文本框：' + input.selector);
    if (el.readOnly || el.type === 'file') throw new Error('文本框不可输入：' + input.selector);
    el.focus(); if (typeof el.select === 'function') el.select(); else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  if (input.operation === 'keyFocus') el.focus();
  const result = item(el), r = result.rect;
  const point = input.point || { x: .5, y: .5 };
  if (![point.x, point.y].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('控件坐标必须为 0 到 1 的相对位置');
  result.point = { x: r.x + r.width * point.x, y: r.y + r.height * point.y };
  const hit = document.elementFromPoint(result.point.x, result.point.y);
  if (!hit || !(el === hit || el.contains(hit))) throw new Error('控件被遮挡：' + input.selector);
  return result;
}
function createDriver({ contents, frame, bounds = async () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1 }) }) {
  async function bounded(work) {let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('页面无响应，操作已超时；请检查脚本循环')),8000);})]);}finally{clearTimeout(timer);}}
  const evaluate = async input => bounded((await frame()).executeJavaScript('(' + pageOperation.toString() + ')(' + JSON.stringify(input) + ')'));
  const command = async (name, params) => { await frame(); if (contents.isDestroyed()) throw new Error('工作台页面已关闭'); if (!contents.debugger.isAttached()) contents.debugger.attach('1.3'); return bounded(contents.debugger.sendCommand(name, params)); };
  const point = async p => { const b = await bounds(); return { x: b.x + p.x * (b.scaleX || 1), y: b.y + p.y * (b.scaleY || 1) }; };
  async function mouse(type, p, extra = {}) { return command('Input.dispatchMouseEvent', { type, ...p, ...extra }); }
  async function act(input = {}) {
    if (!MUTATIONS.has(input.operation)) throw new Error('不支持的页面操作：' + input.operation);
    if (typeof input.selector !== 'string' || input.selector.length > 1000) throw new Error('需要有效的控件选择器');
    if (String(input.value || '').length > 16000) throw new Error('输入内容过长');
    const el = await evaluate({ ...input, operation: input.operation === 'fill' ? 'focus' : input.operation === 'press' ? 'keyFocus' : input.operation === 'select' ? 'select' : 'locate', point: input.from || input.point });
    const p = await point(el.point);
    if (input.operation === 'fill') {
      if (String(input.value ?? '') === '') { await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 }); }
      else await command('Input.insertText', { text: String(input.value) });
    } else if (input.operation === 'press') {
      const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32 };
      if (!(input.key in keys)) throw new Error('不支持的按键：' + input.key);
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, windowsVirtualKeyCode: keys[input.key], ...(input.key === 'Enter' ? { text: '\r' } : {}) });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, windowsVirtualKeyCode: keys[input.key] });
    } else if (input.operation === 'drag') {
      const end = await evaluate({ operation: 'locate', selector: input.toSelector || input.selector, point: input.to || { x: .8, y: .8 } });
      const q = await point(end.point);
      await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
      try { for (let i = 1; i <= 12; i++) await mouse('mouseMoved', { x: p.x + (q.x - p.x) * i / 12, y: p.y + (q.y - p.y) * i / 12 }, { button: 'left', buttons: 1 }); }
      finally { await mouse('mouseReleased', q, { button: 'left', clickCount: 1 }); }
    } else if (input.operation === 'click' || input.operation === 'check' && el.checked !== Boolean(input.checked)) {
      await mouse('mouseMoved', p); await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 }); await mouse('mouseReleased', p, { button: 'left', clickCount: 1 });
    }
    return { ok: true, operation: input.operation, selector: input.selector, inputMethod: input.operation === 'select' ? 'DOM select/input/change' : 'Chromium Input', after: await evaluate({ operation: 'read', selector: input.selector }) };
  }
  async function screenshot(directory, includeImage = false) {
    await frame();
    await fs.mkdir(directory, { recursive: true });
    const b = await bounds(), rect = b.width ? { x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) } : undefined;
    const image = await bounded(contents.capturePage(rect)), file = path.join(directory, crypto.randomUUID() + '.png');
    const png = image.toPNG(); await fs.writeFile(file, png);
    return { path: file, ...(includeImage ? { image: { data: png.toString('base64'), mimeType: 'image/png' } } : {}) };
  }
  return { inspect: input => evaluate({ ...input, operation: 'inspect' }), read: selector => evaluate({ operation: 'read', selector }), act, screenshot };
}
module.exports = { createDriver, MUTATIONS };
