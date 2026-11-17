'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scaffold } = require('./workbench-scaffold.cjs');
const { createVerifier } = require('./workbench-lifecycle-verification.cjs');

test('宿主完整生命周期验证实际运行工作台测试，并检查打开、读取、关闭、重开', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lifecycle-verify-'));
  try {
    const workbench = await scaffold(base, { name: '完整生命周期' });
    require('../tests/fixtures/workbench-ui.cjs').counter(workbench.path);
    const verifier = createVerifier();
    const result = await verifier.verify(workbench.path);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.scope, 'workbench-full-lifecycle');
    assert.equal(result.counts.fail, 0);
    assert.equal(result.counts.skipped, 0);
    assert.ok(result.counts.actualPass >= 9);
    assert.equal(result.frontend.ok,true);
    assert.equal(result.frontend.cases[0].lifecycle.uiRestored,true);
    assert.deepEqual(result.lifecycle, {
      opened: true, readAction: 'readState', firstRead: true, closed: true,
      reopened: true, secondRead: true, eventCount: 0
    });
    const trusted = await verifier.requireVerified(workbench.path);
    assert.equal(trusted.fingerprint, result.fingerprint);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('完整生命周期门禁拒绝没有测试、没有动作覆盖和跳过测试', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lifecycle-contract-'));
  try {
    const workbench = await scaffold(base, { name: '不完整验证' });
    const testFile = path.join(workbench.path, 'tests', 'state.test.cjs');
    await fs.writeFile(testFile, "require('node:test').skip('没有验证');\n", 'utf8');
    const verifier = createVerifier();
    const result = await verifier.verify(workbench.path);
    assert.equal(result.ok, false);
    assert.match(result.message, /缺少|未完整通过/);
    await assert.rejects(() => verifier.requireVerified(workbench.path), error => error.code === 'WORKBENCH_VERIFICATION_REQUIRED');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('完整生命周期验证绑定最后源码指纹，源码变化后必须重新执行', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-lifecycle-fingerprint-'));
  try {
    const workbench = await scaffold(base, { name: '指纹验证' });
    require('../tests/fixtures/workbench-ui.cjs').counter(workbench.path);
    const verifier = createVerifier();
    const result = await verifier.verify(workbench.path);
    assert.equal(result.ok, true, JSON.stringify(result));
    await fs.appendFile(path.join(workbench.path, 'ui', 'index.html'), '\n<!-- changed after verification -->\n');
    await assert.rejects(() => verifier.requireVerified(workbench.path), error => error.code === 'WORKBENCH_VERIFICATION_STALE');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('测试不能修改隔离副本的页面后声称原始源码验收通过', async () => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'pi-lifecycle-mutation-'));
  try {
    const p=await scaffold(base,{name:'防止自改测试对象'});require('../tests/fixtures/workbench-ui.cjs').counter(p.path);
    await fs.writeFile(path.join(p.path,'tests/modify.test.cjs'),"require('node:test')('change source',()=>require('node:fs').appendFileSync(require('node:path').join(__dirname,'../ui/index.html'),'<!-- modified -->'));");
    const r=await createVerifier().verify(p.path);assert.equal(r.ok,false);assert.equal(r.reason,'WORKBENCH_TEST_CHANGED_SOURCE');assert.match(r.message,/ui\/index.html/);
  } finally {if(path.dirname(base)!==os.tmpdir())throw new Error('清理路径越界');await fs.rm(base,{recursive:true,force:true});}
});
