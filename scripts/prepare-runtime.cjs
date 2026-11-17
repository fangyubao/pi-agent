'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
async function main() {
  const root = path.resolve(__dirname, '..');
  const installed = path.join(root, 'packaging/pi-runtime/node_modules/@earendil-works/pi-coding-agent');
  const pkg = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
  const pin = JSON.parse(await fs.readFile(path.join(root, 'packaging/pi-runtime/package.json'), 'utf8'));
  if (pkg.version !== pin.dependencies[pkg.name]) throw new Error('Pi 版本与锁定版本不一致，请运行 npm run setup:runtime');
  const node = process.env.PI_WORKBENCH_BUILD_NODE || process.execPath;
  const version = (await exec(node, ['--version'], { windowsHide: true })).stdout.trim();
  if (version !== 'v24.19.0') throw new Error('构建需要 Node v24.19.0；使用 PI_WORKBENCH_BUILD_NODE 指定该版本');
  const destination = path.join(root, 'packaging/node-runtime');
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(node, path.join(destination, 'node.exe'));
  const license = path.join(path.dirname(node), 'LICENSE');
  try{await fs.copyFile(license, path.join(destination, 'LICENSE'));}catch(error){
    if(error.code!=='ENOENT')throw error;
    if(await fs.stat(path.join(destination,'LICENSE')).catch(()=>null)){}else{
    const response=await fetch('https://raw.githubusercontent.com/nodejs/node/v24.19.0/LICENSE',{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('无法取得 Node 许可证：HTTP '+response.status);
    await fs.writeFile(path.join(destination,'LICENSE'),await response.text());
    }
  }
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(node)).digest('hex');
  await fs.writeFile(path.join(destination, 'runtime.json'), JSON.stringify({ node: version, pi: pkg.version, sha256 }, null, 2));
  await exec(node, [path.join(installed, 'dist/cli.js'), '--version'], { windowsHide: true, timeout: 20000 });
  console.log(JSON.stringify({ node: version, pi: pkg.version, sha256 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
