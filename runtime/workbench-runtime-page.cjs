'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { safeJson } = require('./preview-layout.cjs');
async function runtimePage(root, manifest) {
  const asset = name => './' + String(name).split(/[\\/]/).map(encodeURIComponent).join('/');
  const entry = path.resolve(root, manifest.ui.entry);
  if (!entry.startsWith(path.resolve(root) + path.sep)) throw new Error('工作台页面路径越界');
  const raw = /\.html?$/i.test(entry) ? await fs.readFile(entry, 'utf8') : '<!doctype html><html><head><meta charset="utf-8">' + (manifest.ui.style ? '<link rel="stylesheet" href="' + asset(manifest.ui.style) + '">' : '') + '</head><body><main id="app"></main><script src="' + asset(manifest.ui.entry) + '"></script></body></html>';
  const bridge = await fs.readFile(path.join(__dirname, '../workbenches/runtime-bridge.js'), 'utf8');
  const script = '<script data-pi-runtime>window.__piRuntime=' + safeJson({ id: manifest.id, name: manifest.name }) + ';' + bridge.replace(/<\/script/gi, '<\\/script') + '</script>';
  return /<head\b[^>]*>/i.test(raw) ? raw.replace(/<head\b[^>]*>/i, head => head + script) : script + raw;
}
module.exports = { runtimePage };
