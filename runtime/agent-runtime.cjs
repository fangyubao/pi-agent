'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { globalPaths } = require('node:module');

// Resolution is local and deterministic. Never run npm from the UI process.
function resolveRuntime({ appRoot, resourcesPath, env = process.env } = {}) {
  const packageName = path.join('@earendil-works', 'pi-coding-agent');
  const roots = [env.PI_WORKBENCH_PI_ROOT,
    resourcesPath && path.join(resourcesPath, 'pi-runtime', 'node_modules', packageName),
    resourcesPath && path.join(resourcesPath, 'pi-runtime'),
    path.join(appRoot, 'packaging', 'pi-runtime', 'node_modules', packageName),
    path.join(appRoot, 'node_modules', packageName),
    env.npm_config_prefix && path.join(env.npm_config_prefix, 'node_modules', packageName),
    ...(globalPaths || []).map(dir => path.join(dir, packageName))].filter(Boolean);
  const root = roots.find(dir => fs.existsSync(path.join(dir, 'dist', 'index.js')));
  if (!root && !env.PI_WORKBENCH_PI_CLI) throw new Error('Pi 运行环境不完整，请重新安装应用，或在源码目录运行 npm run setup:runtime。');
  const packageRoot = root || path.dirname(path.dirname(env.PI_WORKBENCH_PI_CLI));
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return { packageRoot, cliPath: env.PI_WORKBENCH_PI_CLI || path.join(packageRoot, 'dist', 'cli.js'), version: metadata.version };
}
module.exports = { resolveRuntime };
