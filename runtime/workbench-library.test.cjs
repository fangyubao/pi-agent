'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('./workbench-library.js');
const T = (id, extra = {}) => ({ id, name: id, updated: 1, messages: [], workbenches: {}, ...extra });
const names = { qubo: 'QUBO 求解器', circuit: '量子门电路' };
const labelOf = key => names[key] || key;

test('创建任务的已发布使用会话安全迁回草稿，保留历史和运行数据且幂等', () => {
  const task=T('draft',{design:{kind:'create',workbenchId:'builder',target:'builder',workspacePath:'C:/draft',publishedPath:'C:/published'},
    workbenchSession:{key:'local-123',mode:'use',sourcePath:'C:/published',open:true},
    messages:[{text:'用户记录'}],workbenches:{'local-123':{revision:8,result:42}}});
  const business=JSON.stringify({design:task.design,messages:task.messages,workbenches:task.workbenches}),old={...task.workbenchSession};
  assert.equal(lib.migrate([{tasks:[task]}]),1);
  assert.deepEqual(task.workbenchSessionHistory[0].session,old);
  assert.equal(task.workbenchSession.key,'builder');assert.equal(task.workbenchSession.mode,'design');assert.equal(task.workbenchSession.open,true);
  assert.equal(task.workbenchSession.sourcePath,undefined);
  assert.equal(JSON.stringify({design:task.design,messages:task.messages,workbenches:task.workbenches}),business);
  assert.equal(lib.migrate([{tasks:[task]}]),0);assert.equal(task.workbenchSessionHistory.length,1);
});

test('修改保持 edit，明确关闭保持关闭；没有旧会话的设计默认打开',()=>{
  const task=T('d',{design:{kind:'modify',workbenchId:'builder',target:'builder',sourceWorkbenchId:'local-a'},workbenchSession:{key:'local-a',mode:'use',sourcePath:'C:/pub',open:false}});
  lib.normalizeDesignSession(task);assert.equal(lib.sessionFor(task).open,false);assert.equal(lib.sessionFor(task).mode,'edit');
  assert.equal(lib.entryKey(task),'local-a');
  assert.equal(lib.sessionFor(T('new',{design:{kind:'create'}})).open,true);
});

test('使用位置只接受普通任务和同工作台使用任务，拒绝设计、其他工作台及工作流任务',()=>{
  assert.equal(lib.canUse(T('chat'),'a'),true);
  assert.equal(lib.canUse(T('use',{use:{workbenchId:'a'}}),'a'),true);
  for(const t of [null,T('draft',{design:{kind:'create'}}),T('edit',{design:{kind:'modify'}}),T('other',{use:{workbenchId:'b'}}),T('workflow',{workflowOn:true}),T('archived',{archived:true})])assert.equal(lib.canUse(t,'a'),false);
});

test('关闭工作流模式后的旧画布会话不能在重启时被当成正式工作台打开',()=>{
  const task=T('chat',{workflowOn:false,workbenchSession:{key:'workflow',mode:'use',open:true,asMode:true}});
  assert.equal(lib.sessionFor(task),null);task.workflowOn=true;assert.equal(lib.sessionFor(task).open,true);
});

test('只收集 使用/创建/修改 类任务，普通聊天任务不进入工作台栏目', () => {
  const projects = [{ id: 'p', tasks: [T('chat'), T('u1', { use: { workbenchId: 'qubo' } }), T('d1', { design: { kind: 'create', workbenchId: 'builder', workspacePath: 'C:/x/w1' } })] }];
  const groups = lib.collect(projects, labelOf);
  assert.equal(groups.length, 2);
  assert.ok(!groups.some(g => g.tasks.some(t => t.task.id === 'chat')));
});

test('同一个工作台的 使用 / 修改 / 创建 归在同一组，且按 创建→修改→使用 排序', () => {
  const projects = [
    { id: 'a', tasks: [T('use', { updated: 5, use: { workbenchId: 'qubo' } })] },
    { id: 'b', tasks: [T('mod', { updated: 3, design: { kind: 'modify', workbenchId: 'qubo', target: 'qubo' } })] }
  ];
  const [group] = lib.collect(projects, labelOf);
  assert.equal(group.name, 'QUBO 求解器');
  assert.deepEqual(group.tasks.map(t => t.kind), ['modify', 'use']);        // 跨项目也归到一起
  assert.deepEqual(group.tasks.map(t => t.project.id), ['b', 'a']);
});

test('新建工作台按 workspacePath 成组；builder 的名称优先作为显示名', () => {
  const projects = [{ id: 'p', tasks: [T('d', { design: { kind: 'create', workbenchId: 'builder', workspacePath: 'C:/x/ssh' }, workbenches: { builder: { name: 'SSH 终端' } } })] }];
  const [group] = lib.collect(projects, labelOf);
  assert.equal(group.name, 'SSH 终端');
  assert.equal(group.key, 'new:C:/x/ssh');
});

test('还没有工程路径的新建任务各自成组，不会互相合并', () => {
  const projects = [{ id: 'p', tasks: [T('d1', { design: { kind: 'create', workbenchId: 'builder' } }), T('d2', { design: { kind: 'create', workbenchId: 'builder' } })] }];
  assert.equal(lib.collect(projects, labelOf).length, 2);
});

test('已归档任务默认不显示；坏数据（缺 tasks / null）不会抛错', () => {
  const projects = [{ id: 'p', tasks: [T('x', { archived: true, use: { workbenchId: 'qubo' } })] }, { id: 'q' }, null];
  assert.equal(lib.collect(projects, labelOf).length, 0);
  assert.equal(lib.collect(projects, labelOf, { includeArchived: true }).length, 1);
  assert.deepEqual(lib.collect(undefined, labelOf), []);
});

test('项目栏默认隐藏工作台任务，开启“在项目里也显示”后才显示', () => {
  const useTask = T('u', { use: { workbenchId: 'qubo' } }), chat = T('c');
  assert.equal(lib.visibleInProject(useTask, false), false);
  assert.equal(lib.visibleInProject(useTask, true), true);
  assert.equal(lib.visibleInProject(chat, false), true);
});

test('分组按最近更新排序', () => {
  const projects = [{ id: 'p', tasks: [T('old', { updated: 1, use: { workbenchId: 'qubo' } }), T('new', { updated: 9, use: { workbenchId: 'circuit' } })] }];
  assert.deepEqual(lib.collect(projects, labelOf).map(g => g.key), ['circuit', 'qubo']);
});

test('就地转换：普通聊天任务被打上“使用”标记，历史消息原样保留；已是工作台任务则不动', () => {
  const chat = T('c', { messages: [{ id: 'm1', role: 'user', text: '你好' }, { id: 'm2', role: 'assistant', text: '嗨' }] });
  assert.equal(lib.adoptAsWorkbenchTask(chat, { key: 'qubo', now: 5 }), true);
  assert.deepEqual(chat.use, { workbenchId: 'qubo', createdAt: 5, converted: true });
  assert.equal(chat.messages.length, 2);                                   // 对话完整保留
  const [group] = lib.collect([{ id: 'p', tasks: [chat] }], labelOf); assert.equal(group.key, 'qubo');   // 转换后进入工作台栏目
  assert.equal(lib.adoptAsWorkbenchTask(chat, { key: 'circuit' }), false); assert.equal(chat.use.workbenchId, 'qubo');   // 不会被二次覆盖
  const design = T('d', { design: { kind: 'create', workbenchId: 'builder' } });
  assert.equal(lib.adoptAsWorkbenchTask(design, { key: 'qubo' }), false); assert.equal(design.use, undefined);
});

test('就地转换：参数不合法或模式不是 use 时不做任何改动', () => {
  for (const [t, o] of [[null, { key: 'qubo' }], [T('a'), {}], [T('b'), { key: 'qubo', mode: 'design' }], [T('c'), { key: 'qubo', mode: 'edit' }]]) assert.equal(lib.adoptAsWorkbenchTask(t, o), false);
});

test('旧数据迁移：只有 workbenchSession 的任务被补上标记；builder 与无效工作台不迁移；重复执行结果不变', () => {
  const projects = [{ id: 'p', tasks: [
    T('old', { workbenchSession: { key: 'qubo', updatedAt: 9 } }),
    T('builderOnly', { workbenchSession: { key: 'builder' } }),
    T('ghost', { workbenchSession: { key: 'deleted-one' } }),
    T('plain'), T('already', { use: { workbenchId: 'circuit' } })
  ] }];
  assert.equal(lib.migrate(projects, k => k !== 'deleted-one'), 1);
  assert.deepEqual(projects[0].tasks[0].use, { workbenchId: 'qubo', createdAt: 9, converted: true });
  assert.equal(projects[0].tasks[1].use, undefined); assert.equal(projects[0].tasks[2].use, undefined); assert.equal(projects[0].tasks[3].use, undefined);
  assert.equal(projects[0].tasks[4].use.workbenchId, 'circuit');           // 已有标记的不动
  assert.equal(lib.migrate(projects, k => k !== 'deleted-one'), 0);        // 幂等
  assert.equal(lib.migrate(null), 0); assert.equal(lib.migrate([null, {}, { tasks: [null] }]), 0);
});

test('迁移不会误伤工作流模式：有 workflowOn 或 asMode 标记的项目聊天留在项目里', () => {
  const projects = [{ id: 'p', tasks: [
    T('wf', { workflowOn: true, workbenchSession: { key: 'workflow', mode: 'use', open: true } }),
    T('asMode', { workbenchSession: { key: 'qubo', asMode: true } }),
    T('workflowKeyOnly', { workbenchSession: { key: 'workflow' } }),
    T('real', { workbenchSession: { key: 'qubo' } })
  ] }];
  assert.equal(lib.migrate(projects), 1);
  assert.equal(projects[0].tasks[0].use, undefined); assert.equal(projects[0].tasks[1].use, undefined); assert.equal(projects[0].tasks[2].use, undefined);
  assert.equal(projects[0].tasks[3].use.workbenchId, 'qubo');
});

test('工作流开关仅作用于普通聊天，工作台旧标记不影响模式且保留原数据', () => {
  assert.equal(lib.workflowEnabled(T('chat', {workflowOn:true})), true);
  for (const extra of [{use:{workbenchId:'qubo'}}, {design:{workbenchId:'builder'}}, {use:{workbenchId:'workflow'}}]) {
    const task=T('wb', {...extra,workflowOn:true,workbenches:{workflow:{nodes:[{id:'keep'}]}}});
    assert.equal(lib.workflowEnabled(task), false);
    assert.equal(task.workflowOn,true);
    assert.equal(task.workbenches.workflow.nodes[0].id,'keep');
  }
  assert.equal(lib.workflowEnabled(null),false);
});
