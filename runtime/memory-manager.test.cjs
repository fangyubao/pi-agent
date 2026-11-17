'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, 'memory-manager.js'), 'utf8');

function loadManager() {
  const window = {PiHelp:{button:key=>`<button data-help="${key}">?</button>`}};
  const context = {
    window,
    Intl,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Set,
    FormData: class FormDataStub {
      constructor(form) { this.form = form; }
      get(name) { return this.form.fields?.[name] ?? null; }
    }
  };
  vm.runInNewContext(source, context, {filename:'memory-manager.js'});
  return window.PiMemoryManager;
}

function owner() { return {name:'测试任务'}; }

test('agent and user entries retain explicit source, pending status and provenance', () => {
  const manager = loadManager();
  const target = owner();
  const user = manager.create(target, {content:'用户写入的约束', kind:'constraint'});
  const agent = manager.create(target, {content:'Agent 提议的偏好', source:'agent', kind:'preference'});

  assert.equal(user.source, 'user');
  assert.equal(user.status, 'confirmed');
  assert.equal(agent.source, 'agent');
  assert.equal(agent.status, 'pending');
  assert.equal(JSON.stringify(agent.provenance), JSON.stringify({operation:'create', actor:'agent', parents:[]}));
});

test('merge and split are atomic and one undo restores all cards and order', () => {
  const manager = loadManager();
  const target = owner();
  const first = manager.create(target, {content:'第一条'});
  const second = manager.create(target, {content:'第二条'});
  const untouched = manager.create(target, {content:'保留顺序'});
  const beforeMerge = target.memory.entries.map(entry => entry.id);

  const merged = manager.merge(target, [first.id, second.id]);
  assert.equal(target.memory.entries.length, 2);
  assert.equal(merged.provenance.operation, 'merge');
  assert.equal(merged.provenance.parents.length, 2);
  manager.undo(target);
  assert.deepEqual(target.memory.entries.map(entry => entry.id), beforeMerge);

  const split = manager.split(target, untouched.id, ['保留顺序 A', '保留顺序 B']);
  assert.equal(split.length, 2);
  assert.ok(split.every(entry => entry.provenance.operation === 'split'));
  manager.undo(target);
  assert.deepEqual(target.memory.entries.map(entry => entry.id), beforeMerge);
  assert.equal(target.memory.entries.find(entry => entry.id === untouched.id).content, '保留顺序');
});

test('blank edits fail before changing the entry or its history', () => {
  const manager = loadManager();
  const target = owner();
  const entry = manager.create(target, {content:'保留内容'});
  const before = JSON.stringify(entry);
  assert.throws(() => manager.update(target, entry.id, {content:'   '}), /记忆内容不能为空/);
  assert.equal(JSON.stringify(entry), before);
  assert.equal(entry.history.length, 0);
});

test('generate callback receives full input and creates separate pending candidates', async () => {
  const manager = loadManager();
  const target = owner();
  const container = {innerHTML:'', querySelector(){return null;}, querySelectorAll(){return [];}};
  const received = [];
  const messages = [];
  manager.mount(container, {
    owner:target,
    scope:'task',
    filter:'all',
    ui:{},
    onChange:message => messages.push(message),
    onGenerate:async text => {
      received.push(text);
      return {candidates:[{content:'候选一',kind:'fact'},{content:'候选二',kind:'decision'}]};
    }
  });
  container.onclick({target:{closest:()=>({dataset:{memoryAction:'generate'}})}});
  const fullInput = '第一句。\n第二句：不要在模块里自动拆分。';
  await container.onsubmit({preventDefault(){},target:{id:'memory-generate-form',fields:{text:fullInput}}});

  assert.deepEqual(received, [fullInput]);
  assert.deepEqual(Array.from(target.memory.entries, entry => entry.content), ['候选一','候选二']);
  assert.ok(target.memory.entries.every(entry => entry.status === 'pending' && entry.source === 'agent'));
  assert.match(messages.at(-1), /2 条待确认候选/);
});

test('context mode asks Agent to use the current context instead of manual text', async () => {
  const manager = loadManager();
  const target = owner();
  const container = {innerHTML:'', querySelector(){return null;}, querySelectorAll(){return [];}};
  const received = [];
  manager.mount(container, {
    owner:target,
    scope:'task',
    filter:'all',
    ui:{},
    contextSummary:{label:'项目 · 当前任务',detail:'读取当前 Agent 可见上下文'},
    onGenerate:async request => {
      received.push(request);
      return {candidates:[{content:'从上下文提取的候选',kind:'decision'}]};
    }
  });
  container.onclick({target:{closest:()=>({dataset:{memoryAction:'generate'}})}});
  await container.onsubmit({preventDefault(){},target:{id:'memory-generate-form',fields:{sourceMode:'context',text:''}}});

  assert.equal(received.length, 1);
  assert.equal(received[0].mode, 'context');
  assert.equal(target.memory.entries[0].content, '从上下文提取的候选');
  assert.equal(target.memory.entries[0].status, 'pending');
});

test('card footer always shows type and only shows lifespan in all filter', () => {
  const manager = loadManager();
  const target = owner();
  manager.create(target, {content:'长期事实', kind:'fact', lifespan:'long'});
  const short = manager.create(target, {content:'短期事实', kind:'fact', lifespan:'short'});
  const all = {innerHTML:'', querySelector(){return null;}, querySelectorAll(){return [];}};
  manager.mount(all, {owner:target, scope:'task', filter:'all', ui:{}});
  assert.match(all.innerHTML, /类型：事实/);
  assert.match(all.innerHTML, /长期记忆/);
  const shortOnly = {innerHTML:'', querySelector(){return null;}, querySelectorAll(){return [];}};
  manager.mount(shortOnly, {owner:target, scope:'task', filter:'short', ui:{status:'all'}});
  assert.match(shortOnly.innerHTML, /类型：事实/);
  assert.doesNotMatch(shortOnly.innerHTML, /data-help="memory-lifespan"/);
  assert.doesNotMatch(shortOnly.innerHTML, /到期：/);
  assert.ok(short.id);
});
