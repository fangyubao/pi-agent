'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareAgentLaunch, waitForRpcReady, findGitBash, inspectAgentEnvironments, configureAgentShell, isLegacyWslBash } = require('./agent-launch.cjs');

test('RPC readiness retries only read-only ACK timeouts on a healthy process', async () => {
  let calls = 0;
  const client = { process: { exitCode: null, stdin: { writable: true, destroyed: false } }, async getState() { if (++calls < 3) throw new Error('Timeout waiting for response to get_state. Stderr:'); return { ready: true }; } };
  for (const attempts of [0, -1, Infinity, 4, 1.5]) await assert.rejects(waitForRpcReady(client, { attempts }), /integer from 1 to 3/);
  assert.equal(calls, 0);
  assert.deepEqual(await waitForRpcReady(client), { ready: true });
  assert.equal(calls, 3);
  calls = 0; client.getState = async () => { calls++; throw new Error('Timeout waiting for response to get_state. Stderr:'); };
  await assert.rejects(waitForRpcReady(client), /Timeout/); assert.equal(calls, 3);
  calls = 0; client.process.exitCode = 1;
  await assert.rejects(waitForRpcReady(client), /Timeout/); assert.equal(calls, 1);
  calls = 0; client.process.exitCode = null; client.getState = async () => { calls++; throw new Error('Access denied'); };
  await assert.rejects(waitForRpcReady(client), /Access denied/); assert.equal(calls, 1);
});

test('packaged launch uses a real workspace, even with no Node on PATH', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-launch-test-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const appPath = path.join(fixture, 'app.asar');
  const cliPath = path.join(fixture, 'cli.js');
  await fs.writeFile(appPath, 'archive fixture');
  await fs.writeFile(cliPath, '');
  const env = { ...process.env, PI_WORKBENCH_NODE: process.execPath };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = '';
  const launch = await prepareAgentLaunch({ isPackaged: true, appPath, cliPath, userDataPath: fixture, env });
  assert.equal(launch.cwd, path.join(fixture, 'workspace'));
  assert.ok((await fs.stat(launch.cwd)).isDirectory());
  assert.equal(Object.keys(launch.env).filter(k => k.toLowerCase() === 'path').length, 1);
  const result = await promisify(execFile)('node', ['--version'], { cwd: launch.cwd, env: launch.env, windowsHide: true });
  assert.match(result.stdout, /^v\d+/);
});

test('directory overrides work and invalid cwd/CLI fail before spawn', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-launch-test-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const cliPath = path.join(fixture, 'cli.js');
  await fs.writeFile(cliPath, '');
  const options = { isPackaged: false, appPath: fixture, cliPath, env: { ...process.env, PI_WORKBENCH_NODE: path.dirname(process.execPath) } };
  assert.equal((await prepareAgentLaunch(options)).nodePath, process.execPath);
  await assert.rejects(prepareAgentLaunch({ ...options, appPath: path.join(fixture, 'app.asar') }), /app\.asar/);
  await assert.rejects(prepareAgentLaunch({ ...options, appPath: path.join(fixture, 'missing') }), /工作目录不存在/);
  await assert.rejects(prepareAgentLaunch({ ...options, cliPath: path.join(fixture, 'missing.js') }), /找不到 Pi Agent 入口/);
});

test('Windows environment discovery separates Git Bash, WSL and CMD', async () => {
  assert.equal(isLegacyWslBash('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isLegacyWslBash('D:\\Program Files\\Git\\bin\\bash.exe'), false);
  const shell = await findGitBash({ env: { ...process.env }, platform: 'win32' });
  assert.ok(shell, 'Git Bash should be discoverable on this machine');
  assert.match(shell.toLowerCase(), /git[\\/]bin[\\/]bash\.exe$/);
});

test('configureAgentShell preserves settings and writes a verified shellPath', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-shell-test-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const settingsPath = path.join(fixture, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify({ enabledModels: ['keep-me'] }), 'utf8');
  const result = await configureAgentShell({ agentDir: fixture, env: { ...process.env }, platform: 'win32' });
  assert.ok(result.shellPath);
  const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(settings.enabledModels, ['keep-me']);
  assert.equal(settings.shellPath, result.shellPath);
});

test('environment inspection exposes supported and unsafe Windows choices', async () => {
  const result = await inspectAgentEnvironments({ env: { ...process.env }, platform: 'win32' });
  const git = result.profiles.find(item => item.id === 'git-bash');
  const wsl = result.profiles.find(item => item.id === 'wsl');
  const cmd = result.profiles.find(item => item.id === 'cmd');
  assert.ok(git);
  assert.equal(git.supported, true);
  assert.ok(wsl);
  assert.equal(wsl.supported, true);
  assert.ok(cmd);
  assert.equal(cmd.supported, true);
});

test('unsupported shell choices fail before changing the Agent settings', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-shell-choice-test-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await assert.rejects(configureAgentShell({ agentDir: fixture, preference: 'powershell', env: { ...process.env }, platform: 'win32' }), /不支持的 Agent 运行环境/);
  assert.equal(await fs.stat(path.join(fixture, 'settings.json')).catch(() => null), null);
});

test('CMD environment selects the native cmd tool without a bash shellPath', async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-cmd-choice-test-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const result = await configureAgentShell({ agentDir: fixture, preference: 'cmd', env: { ...process.env }, platform: 'win32' });
  assert.equal(result.profile, 'cmd');
  assert.equal(result.commandTool, 'cmd');
  const settings = JSON.parse(await fs.readFile(path.join(fixture, 'settings.json'), 'utf8'));
  assert.equal(settings.shellPath, undefined);
  assert.ok(settings.defaultTools.includes('cmd'));
  assert.equal(settings.piWorkbenchEnvironment, 'cmd');
});
