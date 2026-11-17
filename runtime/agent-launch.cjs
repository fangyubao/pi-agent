'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function isLegacyWslBash(candidate) {
  const normalized = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative|windowsapps)\\bash\.exe$/.test(normalized);
}

function existingFile(candidate) {
  if (!candidate || isLegacyWslBash(candidate)) return null;
  try { return fsSync.statSync(candidate).isFile() ? path.resolve(candidate) : null; } catch { return null; }
}

function existingFileIncludingWsl(candidate) {
  if (!candidate) return null;
  try { return fsSync.statSync(candidate).isFile() ? path.resolve(candidate) : null; } catch { return null; }
}

async function findGitBash({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const candidates = [];
  if (env.PI_WORKBENCH_SHELL) candidates.push(env.PI_WORKBENCH_SHELL);
  if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));

  // Git may be installed outside the usual C: locations. Resolve Git itself,
  // then derive the matching bash.exe instead of accepting WSL's bash launcher.
  try {
    const result = await execFileAsync('where.exe', ['git.exe'], { env, windowsHide: true, timeout: 5000 });
    for (const gitPath of String(result.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
      const git = existingFile(gitPath);
      if (!git) continue;
      candidates.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'));
    }
  } catch { /* Git may be absent; the final diagnostic explains that clearly. */ }

  for (const candidate of candidates) {
    const resolved = existingFile(candidate);
    if (resolved) return resolved;
  }
  return null;
}

async function findOnPath(executable, { env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  try {
    const result = await execFileAsync('where.exe', [executable], { env, windowsHide: true, timeout: 5000 });
    return String(result.stdout || '').split(/\r?\n/).map(x => x.trim()).map(existingFile).find(Boolean) || null;
  } catch { return null; }
}

async function findWslBash({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'bash.exe'),
    path.join(systemRoot, 'Sysnative', 'bash.exe')
  ];
  try {
    const result = await execFileAsync('where.exe', ['bash.exe'], { env, windowsHide: true, timeout: 5000 });
    candidates.push(...String(result.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  } catch { /* WSL may be installed without bash.exe on PATH. */ }
  return candidates.map(existingFileIncludingWsl).find(candidate => candidate && isLegacyWslBash(candidate)) || null;
}

async function findCmd({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'cmd.exe'),
    env.ComSpec,
    await findOnPath('cmd.exe', { env, platform })
  ];
  return candidates.map(existingFile).find(Boolean) || null;
}

async function inspectAgentEnvironments({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return { platform, recommended: 'auto', profiles: [{ id: 'auto', label: '自动检测', available: true, supported: true, path: '/bin/bash', detail: '使用系统 Shell' }] };
  const gitBash = await findGitBash({ env, platform });
  const wslBash = await findWslBash({ env, platform });
  const cmd = await findCmd({ env, platform });
  const powershell = await findOnPath('pwsh.exe', { env, platform }) || await findOnPath('powershell.exe', { env, platform });
  const recommended = gitBash ? 'git-bash' : wslBash ? 'wsl' : cmd ? 'cmd' : 'auto';
  return {
    platform,
    recommended,
    profiles: [
      { id: 'auto', label: '自动检测', available: Boolean(gitBash), supported: Boolean(gitBash), path: gitBash, detail: gitBash ? '自动使用可验证的原生 Git Bash' : '未找到可用的 Git Bash' },
      { id: 'git-bash', label: 'Git Bash（推荐）', available: Boolean(gitBash), supported: Boolean(gitBash), path: gitBash, detail: gitBash ? '原生 Windows 路径兼容' : '未安装或无法定位 Git for Windows' },
      { id: 'wsl', label: 'WSL Bash', available: Boolean(wslBash), supported: Boolean(wslBash), path: wslBash, detail: wslBash ? '通过 WSL Bash 执行，工作目录自动映射到 /mnt' : '未检测到 WSL Bash' },
      { id: 'cmd', label: 'Windows CMD', available: Boolean(cmd), supported: Boolean(cmd), path: cmd, detail: cmd ? '通过 cmd 工具执行 Windows 命令' : '未检测到 cmd.exe' },
      { id: 'powershell', label: 'PowerShell', available: Boolean(powershell), supported: false, path: powershell, detail: powershell ? '检测到，但当前工作台环境列表使用 CMD；PowerShell 将在后续单独配置' : '未检测到 PowerShell' }
    ]
  };
}

async function configureAgentShell({ agentDir, env = process.env, platform = process.platform, preference = 'auto' } = {}) {
  if (platform !== 'win32') return { shellPath: null, settingsPath: null, changed: false };
  if (!agentDir) throw new Error('缺少 Pi Agent 配置目录，无法配置 Shell。');
  if (!['auto', 'git-bash', 'wsl', 'cmd'].includes(preference)) throw new Error('不支持的 Agent 运行环境：' + preference);

  const settingsPath = path.join(agentDir, 'settings.json');
  let settings = {};
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Pi Agent 设置文件无法读取：${settingsPath}（${error.message}）`);
  }

  const environments = await inspectAgentEnvironments({ env, platform });
  let selected = preference === 'auto'
    ? (environments.profiles.find(profile => profile.id === settings.piWorkbenchEnvironment && profile.available && profile.supported)
      || environments.profiles.find(profile => profile.id === environments.recommended))
    : environments.profiles.find(profile => profile.id === preference);
  if (!selected?.available || !selected?.supported) {
    throw new Error(`未找到可用的 ${selected?.label || preference}。请先检查该环境是否安装并可被系统定位。`);
  }

  const previousDefaultTools = Array.isArray(settings.defaultTools) ? settings.defaultTools : null;
  const nextDefaultTools = selected.id === 'cmd'
    ? ['read', 'cmd', 'edit', 'write', 'grep', 'find', 'ls']
    : ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
  const shellPath = selected.id === 'cmd' ? null : selected.path;
  const changed = settings.shellPath !== shellPath
    || settings.piWorkbenchEnvironment !== selected.id
    || JSON.stringify(previousDefaultTools) !== JSON.stringify(nextDefaultTools);
  if (changed) {
    await fs.mkdir(agentDir, { recursive: true });
    if (shellPath) settings.shellPath = shellPath;
    else delete settings.shellPath;
    settings.piWorkbenchEnvironment = selected.id;
    settings.defaultTools = nextDefaultTools;
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return { shellPath, settingsPath, changed, profile: selected.id, label: selected.label, commandTool: selected.id === 'cmd' ? 'cmd' : 'bash' };
}

// An ASAR path is readable by Electron's fs shim, but is not an OS directory
// and cannot be used as the cwd of a native child process.
async function prepareAgentLaunch({ isPackaged, appPath, userDataPath, resourcesPath, cliPath, env = process.env }) {
  const cwd = env.PI_WORKBENCH_WORKSPACE ? path.resolve(env.PI_WORKBENCH_WORKSPACE) : isPackaged ? path.join(userDataPath, 'workspace') : appPath;
  if (/\.asar(?:[\\/]|$)/i.test(cwd)) throw new Error('Agent 工作目录不能位于 app.asar 内：' + cwd);
  if (isPackaged) await fs.mkdir(cwd, { recursive: true });
  if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw new Error('Agent 工作目录不存在或不是目录：' + cwd);
  if (!(await fs.stat(cliPath).catch(() => null))?.isFile()) throw new Error('找不到 Pi Agent 入口：' + cliPath + '。请检查 Pi 安装或 PI_WORKBENCH_PI_CLI 配置。');

  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const searchDirs = String(pathValue).split(path.delimiter).filter(Boolean);
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (env.PI_WORKBENCH_NODE) {
    const override = path.resolve(env.PI_WORKBENCH_NODE);
    candidates.push((await fs.stat(override).catch(() => null))?.isDirectory() ? path.join(override, nodeName) : override);
  }
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'runtime', nodeName));
  candidates.push(...searchDirs.map(dir => path.join(dir.replace(/^"|"$/g, ''), nodeName)));
  if (process.platform === 'win32') candidates.push('D:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\node.exe');
  let nodePath;
  for (const candidate of candidates) {
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) { nodePath = path.resolve(candidate); break; }
  }
  if (!nodePath) throw new Error('未找到 Node.js 运行时。请安装 Node.js，或将 PI_WORKBENCH_NODE 指向 node.exe。');

  // RpcClient invokes "node". Give it a single, unambiguous PATH with the
  // verified runtime first; do not mutate the desktop process environment.
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH') delete childEnv[key];
  }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  childEnv[pathKey] = [path.dirname(nodePath), ...searchDirs].join(path.delimiter);
  try {
    await execFileAsync(nodePath, ['--version'], { cwd, env: childEnv, windowsHide: true, timeout: 10000 });
  } catch (error) {
    throw new Error(`Node.js 启动检查失败（${error.code || error.message}）。运行时：${nodePath}；工作目录：${cwd}`);
  }
  return { cwd, env: childEnv, nodePath, cliPath };
}

// RpcClient.start() only waits 100 ms, not for the RPC command loop.
// Probe with a read-only command; retry only its ACK timeout, never a prompt.
async function waitForRpcReady(client, { attempts = 3 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('RPC readiness attempts must be an integer from 1 to 3');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await client.getState(); }
    catch (error) {
      const child = client.process;
      const healthy = child?.exitCode === null && child?.stdin?.writable && !child.stdin.destroyed;
      if (!healthy || !/Timeout waiting for response to get_state/.test(String(error?.message)) || attempt === attempts) throw error;
    }
  }
}

module.exports = { prepareAgentLaunch, waitForRpcReady, findGitBash, findWslBash, findCmd, findOnPath, inspectAgentEnvironments, configureAgentShell, isLegacyWslBash };
