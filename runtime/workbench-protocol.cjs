'use strict';

const PROTOCOL_VERSION = '1.0';

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function cleanId(value, fallback = '') {
  const id = String(value || '').trim();
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(id) ? id : fallback;
}

function validateManifest(input, root = '') {
  const manifest = input && typeof input === 'object' ? input : {};
  const id = cleanId(manifest.id);
  if(manifest.protocolVersion && manifest.protocolVersion!==PROTOCOL_VERSION)throw new Error('不兼容的工作台协议版本：'+manifest.protocolVersion);
  if (!id) throw new Error('工作台 manifest 缺少有效 id');
  if (!String(manifest.name || '').trim()) throw new Error('工作台 manifest 缺少 name：' + id);
  const ui = manifest.ui && typeof manifest.ui === 'object' ? manifest.ui : {};
  const server = manifest.server && typeof manifest.server === 'object' ? manifest.server : {};
  const state = manifest.state && typeof manifest.state === 'object' ? manifest.state : {};
  if (!String(ui.entry || '').trim()) throw new Error('工作台 manifest 缺少 ui.entry：' + id);
  if (!String(server.entry || '').trim()) throw new Error('工作台 manifest 缺少 server.entry：' + id);
  if (!String(state.schema || '').trim()) throw new Error('工作台 manifest 缺少 state.schema：' + id);
  const actions = Array.isArray(manifest.actions)
    ? manifest.actions.map(action => typeof action === 'string' ? { name: action, access: 'write' } : action).filter(action => action && /^[a-z][a-z0-9._-]{0,63}$/i.test(String(action.name || ''))).map(action => ({ name: String(action.name), access: ['read', 'write', 'compute'].includes(action.access) ? action.access : 'write', description: String(action.description || ''), ...(action.requiresConfirmation===true?{requiresConfirmation:true}:{}), ...(action.inputSchema&&typeof action.inputSchema==='object'?{inputSchema:clone(action.inputSchema)}:{}) }))
    : [];
  const events = Array.isArray(manifest.events) ? manifest.events.map(String).filter(Boolean).slice(0, 128) : [];
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String).filter(Boolean).slice(0, 64) : [];
  return {
    protocolVersion: String(manifest.protocolVersion || PROTOCOL_VERSION),
    id,
    name: String(manifest.name),
    description: String(manifest.description || ''),
    version: String(manifest.version || '0.1.0'),
    ui: { entry: String(ui.entry), style: ui.style ? String(ui.style) : '', sandbox: ui.sandbox !== false },
    server: { entry: String(server.entry), runtime: String(server.runtime || 'node'), external: server.external === true },
    state: { schema: String(state.schema), description: String(state.description || '') },
    actions,
    events,
    capabilities,
    paths: root ? { root } : undefined
  };
}

function actionNames(manifest) {
  return new Set((manifest?.actions || []).map(action => typeof action === 'string' ? action : action.name).filter(Boolean));
}

function actionAccess(manifest, action) {
  const found = (manifest?.actions || []).find(item => (typeof item === 'string' ? item : item.name) === action);
  return typeof found === 'string' ? 'write' : found?.access || null;
}

function event(type, payload = {}, source = 'server') {
  return { type: String(type), source, time: Date.now(), payload: clone(payload) };
}

function response({ ok = true, state, result, events = [], error = '', requestId = '' } = {}) {
  return {
    ok: Boolean(ok),
    protocolVersion: PROTOCOL_VERSION,
    requestId: String(requestId || ''),
    state: clone(state),
    result: clone(result),
    events: Array.isArray(events) ? events.map(clone) : [],
    error: ok ? '' : String(error || '工作台后端操作失败')
  };
}

module.exports = { PROTOCOL_VERSION, clone, validateManifest, actionNames, actionAccess, event, response };
