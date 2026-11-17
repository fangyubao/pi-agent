'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { actionAccess, actionNames, clone, response, validateManifest } = require('./workbench-protocol.cjs');
const {resolveServerEntry}=require('./workbench-package.cjs');

const definitionCache = new Map();

function within(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function loadDefinitionAt(root, id) {
  root = path.resolve(root);
  const cacheKey = root.toLowerCase();
  if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);
  const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')), root);
  id ||= manifest.id;
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(String(id))) throw new Error('工作台标识无效：' + id);
  const serverEntry=await resolveServerEntry(root,manifest);
  if(!serverEntry)throw new Error('找不到导出 dispatch 的后端入口，请检查 server/index.cjs');
  manifest.server.entry=serverEntry;
  const uiFile = path.resolve(root, 'ui', manifest.ui.entry);
  if (!within(path.join(root, 'ui'), uiFile)) throw new Error('工作台 ui.entry 路径越界：' + id);
  if (!(await fs.stat(uiFile).catch(() => null))?.isFile()) throw new Error('工作台 UI 入口不存在：' + uiFile);
  const serverFile = path.resolve(root, 'server', manifest.server.entry);
  if (!within(path.join(root, 'server'), serverFile)) throw new Error('工作台 server.entry 路径越界：' + id);
  const serverModule = require(serverFile);
  const server = typeof serverModule.createServer === 'function' ? await serverModule.createServer({ manifest, root }) : serverModule;
  if (!server || typeof server.dispatch !== 'function') throw new Error('工作台后端缺少 dispatch：' + id);
  const definition = Object.freeze({ id: String(id), root, manifest, server, actions: actionNames(manifest) });
  definitionCache.set(cacheKey, definition);
  return definition;
}

async function loadDefinition(workbenchesRoot, key) {
  const id = String(key || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(id)) throw new Error('工作台标识无效：' + id);
  const root = path.resolve(workbenchesRoot, id);
  if (!within(workbenchesRoot, root)) throw new Error('工作台路径越界');
  return loadDefinitionAt(root, id);
}

async function inspect(workbenchesRoot, key) {
  const definition = await loadDefinition(workbenchesRoot, key);
  const health = typeof definition.server.health === 'function'
    ? await definition.server.health()
    : { status: 'healthy', issues: [] };
  return {
    id: definition.id,
    manifest: definition.manifest,
    health: {
      status: ['healthy', 'warning', 'error'].includes(health?.status) ? health.status : 'warning',
      issues: Array.isArray(health?.issues) ? health.issues.map(String) : [],
      checkedAt: Date.now()
    }
  };
}

async function inspectPath(root) {
  const definition = await loadDefinitionAt(root);
  const health = typeof definition.server.health === 'function'
    ? await definition.server.health()
    : { status: 'healthy', issues: [] };
  return {
    id: definition.id,
    manifest: definition.manifest,
    health: {
      status: ['healthy', 'warning', 'error'].includes(health?.status) ? health.status : 'warning',
      issues: Array.isArray(health?.issues) ? health.issues.map(String) : [],
      checkedAt: Date.now()
    }
  };
}

async function dispatchDefinition(definition, input = {}) {
  const action = String(input.action || '').trim();
  const access = actionAccess(definition.manifest, action);
  if (!access && !(action === 'saveUIState' && input.source === 'ui')) return response({ ok: false, error: '工作台未声明该后端动作：' + action, requestId: input.requestId });
  const payload = clone(input.payload || {});
  const currentState = clone(input.state || {});
  try {
    if (payload.baseRevision !== undefined && Number(payload.baseRevision) !== Number(currentState.revision || 0)) throw Object.assign(new Error('状态版本冲突，请重新读取当前状态后再修改'), { code: 'REVISION_CONFLICT' });
    if (action === 'saveUIState') {
      const state = definition.server.normalize({ ...currentState, ...payload.state });
      state.revision = Number(currentState.revision || 0) + 1;
      state._layout = currentState._layout || payload.state?._layout;
      return response({ requestId: input.requestId, state, result: { revision: state.revision }, events: [{ type: 'state.updated', source: 'ui', time: Date.now(), payload: {} }] });
    }
    const result = await definition.server.dispatch({ action, payload, state: currentState, mode: String(input.mode || 'use'), taskId: String(input.taskId || ''), source: String(input.source || 'ui'), requestId: String(input.requestId || ''), signal: input.signal, progress: input.progress });
    if(result?.ok===false){
      const error=result.error;
      return {...response({ok:false,requestId:input.requestId,error:typeof error==='string'?error:error?.message||'工作台后端操作失败'}),failure:{code:error?.code||result.failure?.code||'',details:error?.details||result.failure?.details||null}};
    }
    const nextState = result?.state === undefined ? currentState : { ...currentState, ...result.state };
    return response({ ok: true, requestId: input.requestId, state: nextState, result: result?.result === undefined ? result : result.result, events: result?.events || [] });
  } catch (error) {
    return {...response({ ok: false, requestId: input.requestId, error: error?.message || String(error) }),failure:{code:error?.code||'',details:error?.details||null}};
  }
}

async function dispatchPath(root, input = {}) { return dispatchDefinition(await loadDefinitionAt(root), input); }

// One backend session per open workbench. Device streams outlive an individual
// action, so they must share the same instance as UI and Agent requests.
async function createSessionAt(root, input = {}, onEvent = () => {}) {
  const definition = await loadDefinitionAt(root);
  const backend = typeof definition.server.createSession === 'function'
    ? await definition.server.createSession({ state: clone(input.state || {}), taskId: input.taskId, manifest: definition.manifest, root })
    : definition.server;
  if (!backend || (typeof backend.call !== 'function' && typeof backend.dispatch !== 'function')) throw new Error('工作台会话缺少 call 或 dispatch');
  let closed = false, currentState=clone(input.state||{});
  const unsubscribe = backend.onEvent?.(event => {
    if (!closed && event && typeof event.type === 'string') onEvent(clone(event));
  });
  const adapter = {
    normalize: definition.server.normalize,
    dispatch: request => typeof backend.call === 'function' ? backend.call(request.action, request.payload, request) : backend.dispatch(request)
  };
  return {
    async dispatch(request) {
      if (closed) return response({ ok: false, error: '工作台已关闭' });
      const state = typeof backend.readState === 'function' ? clone(await backend.readState()) : (Number(request.state?.revision||0)>=Number(currentState?.revision||0)?request.state||currentState:currentState);
      const result = await dispatchDefinition({ ...definition, server: adapter }, { ...request, state });
      if(result.ok&&result.state!==undefined)currentState=clone(result.state);
      if (result.ok && request.action === 'saveUIState') await backend.setState?.(clone(result.state));
      return result;
    },
    async close() { if (closed) return; closed = true; if (typeof unsubscribe === 'function') unsubscribe(); await backend.close?.(); }
  };
}

async function dispatch(workbenchesRoot, input = {}) {
  return dispatchDefinition(await loadDefinition(workbenchesRoot, input.key), input);
}

function clearCache() {
  for (const definition of definitionCache.values()) for (const file of Object.keys(require.cache)) if (within(definition.root, file)) delete require.cache[file];
  definitionCache.clear();
}

module.exports = { loadDefinition, loadDefinitionAt, inspect, inspectPath, dispatch, dispatchPath, createSessionAt, clearCache };
