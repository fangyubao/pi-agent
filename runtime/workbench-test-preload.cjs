'use strict';
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const frame = document.getElementById('workbench');
  ipcRenderer.on('verification:mount', (_event, url) => { frame.src = url; });
  ipcRenderer.on('verification:reply', (_event, data) => frame.contentWindow?.postMessage({ source: 'pi-workbench-shell', ...data }, '*'));
  window.addEventListener('message', event => { if (event.source === frame.contentWindow && event.data?.source === 'pi-workbench-runtime') ipcRenderer.send('verification:message', event.data); });
});
