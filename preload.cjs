'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('piDesktop', Object.freeze({
  isDesktop: true,
  storage: Object.freeze({load:()=>ipcRenderer.invoke('storage:load'),save:input=>ipcRenderer.invoke('storage:save',input),saveSync:input=>ipcRenderer.sendSync('storage:save-sync',input),flush:()=>ipcRenderer.invoke('storage:flush')}),
  vault: Object.freeze({
    record: input=>ipcRenderer.invoke('vault:record',input),
    list: input=>ipcRenderer.invoke('vault:list',input),
    get: input=>ipcRenderer.invoke('vault:get',input),
    backup: input=>ipcRenderer.invoke('vault:backup',input),
    backupSaved: ()=>ipcRenderer.invoke('vault:backup-saved'),
    backups: input=>ipcRenderer.invoke('vault:backups',input),
    restore: input=>ipcRenderer.invoke('vault:restore',input),
    usage: ()=>ipcRenderer.invoke('vault:usage'),
    exportProject: input=>ipcRenderer.invoke('project:export',input),
    importProject: input=>ipcRenderer.invoke('project:import',input)
  }),
  workflow: Object.freeze({
    plan: input => ipcRenderer.invoke('workflow:plan', input),
    cancel: input => ipcRenderer.invoke('workflow:cancel', input),
    runNode: input => ipcRenderer.invoke('workflow:run-node', input),
    saveFiles: input => ipcRenderer.invoke('workflow:save-files', input),
    pickInputs: input => ipcRenderer.invoke('workflow:pick-inputs', input),
    removeInput: input => ipcRenderer.invoke('workflow:remove-input', input),
    revealNode: input => ipcRenderer.invoke('workflow:reveal-node', input),
    openHtml: input => ipcRenderer.invoke('workflow:open-html', input),
    models: () => ipcRenderer.invoke('workflow:models')
  }),
  mcp: Object.freeze({
    list: () => ipcRenderer.invoke('mcp:list'),
    save: input => ipcRenderer.invoke('mcp:save', input),
    setEnabled: input => ipcRenderer.invoke('mcp:set-enabled', input),
    remove: input => ipcRenderer.invoke('mcp:remove', input),
    test: input => ipcRenderer.invoke('mcp:test', input)
  }),
  window: Object.freeze({
    control: action => ipcRenderer.invoke('window:control', action),
    onPrepareClose: callback => { const listener = (_event,id) => {Promise.resolve().then(callback).then(()=>ipcRenderer.send('window:close-ready',{id,ok:true}),error=>ipcRenderer.send('window:close-ready',{id,ok:false,error:String(error.message||error)}));};ipcRenderer.on('window:prepare-close',listener);ipcRenderer.send('window:close-listener-ready');return ()=>ipcRenderer.removeListener('window:prepare-close',listener); },
    state: () => ipcRenderer.invoke('window:state'),
    onState: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('window:state', listener); return () => ipcRenderer.removeListener('window:state', listener); }
  }),
  ui: Object.freeze({ setZoom: factor => { const n = Number(factor); if (n >= 0.5 && n <= 2) webFrame.setZoomFactor(n); } }),
  platform: process.platform,
  appVersion: process.versions.electron,
  navigation: Object.freeze({onOpen: callback=>{const listener=(_event,hash)=>callback(hash);ipcRenderer.on('navigation:local',listener);return()=>ipcRenderer.removeListener('navigation:local',listener);},onSource:callback=>{const listener=()=>callback();ipcRenderer.on('navigation:source',listener);return()=>ipcRenderer.removeListener('navigation:source',listener);}}),
  knowledge: Object.freeze({
    pick: kind => ipcRenderer.invoke('knowledge:pick', kind),
    import: paths => ipcRenderer.invoke('knowledge:import', paths),
    search: input=>ipcRenderer.invoke('knowledge:search',input),
    read: input=>ipcRenderer.invoke('knowledge:read',input)
  }),
  provider: Object.freeze({
    getConfig: () => ipcRenderer.invoke('provider:get-config'),
    revealKey: profileId => ipcRenderer.invoke('provider:reveal-key', { profileId }),
    saveConfig: config => ipcRenderer.invoke('provider:save-config', config),
    activate: profileId => ipcRenderer.invoke('provider:activate', { profileId }),
    delete: profileId => ipcRenderer.invoke('provider:delete', { profileId }),
    deleteMany: profileIds => ipcRenderer.invoke('provider:delete-many', { profileIds }),
    listModels: config => ipcRenderer.invoke('provider:list-models', config),
    test: config => ipcRenderer.invoke('provider:test', config),
    probeCapabilities: config => ipcRenderer.invoke('provider:probe-capabilities', config),
    parseAgentImport: input => ipcRenderer.invoke('provider:parse-agent-import', input),
    startPairing: input => ipcRenderer.invoke('provider:pairing-start', input),
    pairingStatus: () => ipcRenderer.invoke('provider:pairing-status'),
    openConnectDir: () => ipcRenderer.invoke('provider:open-connect-dir'),
    launchAgent: input => ipcRenderer.invoke('provider:launch-agent', input),
    onUpdated: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('provider:updated', listener);
      return () => ipcRenderer.removeListener('provider:updated', listener);
    },
    saveTiers: tiers => ipcRenderer.invoke('provider:save-tiers', { tiers }),
    refreshRankings: () => ipcRenderer.invoke('provider:refresh-rankings'),
    saveRankingSettings: input => ipcRenderer.invoke('provider:save-ranking-settings', input)
  }),
  clipboard: Object.freeze({ writeText: text => ipcRenderer.invoke('clipboard:write', text) }),
  files: Object.freeze({ exportText: input => ipcRenderer.invoke('file:export-text', input) }),
  review: Object.freeze({ read: input => ipcRenderer.invoke('review:read', input) }),
  paths: Object.freeze({ act: input => ipcRenderer.invoke('path:act', input), documents: () => ipcRenderer.invoke('path:documents'), pick: input => ipcRenderer.invoke('path:pick', input), ensure: input => ipcRenderer.invoke('path:ensure', input), folders: input => ipcRenderer.invoke('path:folders', input), recover: input => ipcRenderer.invoke('path:recover', input), open: input => ipcRenderer.invoke('path:open', input), entity: input => ipcRenderer.invoke('path:entity', input), workspace: () => ipcRenderer.invoke('path:workspace') }),
  references: Object.freeze({ open: input => ipcRenderer.invoke('reference:open', input) }),
  agent: Object.freeze({
    send: input => ipcRenderer.invoke('agent:send', input),
    abort: () => ipcRenderer.invoke('agent:abort'),
    terminate:()=>ipcRenderer.invoke('agent:terminate'),
    respond: input => ipcRenderer.invoke('agent:respond', input),
    getState: () => ipcRenderer.invoke('agent:get-state'),
    getEnvironment: () => ipcRenderer.invoke('agent:environment'),
    getDiagnostics: () => ipcRenderer.invoke('agent:diagnostics'),
    switchEnvironment: input => ipcRenderer.invoke('agent:switch-environment', input),
    command: input => ipcRenderer.invoke('agent:command', input),
    generateMemory: input => ipcRenderer.invoke('agent:generate-memory', input),
    translate: input => ipcRenderer.invoke('agent:translate', input),
    stop: () => ipcRenderer.invoke('agent:stop'),
    onEvent: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    }
  }),
  workbench: Object.freeze({
    scaffold: input=>ipcRenderer.invoke('workbench:scaffold',input),
    preview: input=>ipcRenderer.invoke('workbench:preview',input),
    saveLayout: input=>ipcRenderer.invoke('workbench:save-layout',input),
    publish: input=>ipcRenderer.invoke('workbench:publish',input),
    verify: input=>ipcRenderer.invoke('workbench:verify',input),
    ui: input=>ipcRenderer.invoke('workbench:ui',input),
    cancelVerification: input=>ipcRenderer.invoke('workbench:cancel-verification',input),
    list: ()=>ipcRenderer.invoke('workbench:list'),
    manage: input=>ipcRenderer.invoke('workbench:manage',input),
    fork: input=>ipcRenderer.invoke('workbench:fork',input),
    runtimeUrl: input=>ipcRenderer.invoke('workbench:runtime-url',input),
    describePath: input=>ipcRenderer.invoke('workbench:describe-path',input),
    resolve: input => ipcRenderer.invoke('workbench:resolve', input),
    manifest: input => ipcRenderer.invoke('workbench:manifest', input),
    health: input => ipcRenderer.invoke('workbench:health', input),
    server: input => ipcRenderer.invoke('workbench:server', input),
    serverPath: input => ipcRenderer.invoke('workbench:server-path', input),
    closeRuntime: input => ipcRenderer.invoke('workbench:close-runtime', input),
    onEvent: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('workbench:event', listener);
      return () => ipcRenderer.removeListener('workbench:event', listener);
    },
    source: input => ipcRenderer.invoke('workbench:source', input),
    onRequest: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('agent:workbench-request', listener);
      return () => ipcRenderer.removeListener('agent:workbench-request', listener);
    }
  })
}));
