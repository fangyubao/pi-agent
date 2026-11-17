'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const lang=require('./response-language');const {createTranslator}=require('./response-translation.cjs');
test('显示语言选择、英文过程检测和中文提示规则',()=>{
  assert.equal(lang.language({language:'auto'},'en-US'),'en');assert.equal(lang.language({},'en-US'),'zh-CN');
  assert.equal(lang.needsTranslation('Let me verify CSS validity and run the tests.','zh-CN'),true);
  assert.equal(lang.needsTranslation('已运行测试，全部通过。 `npm test`','zh-CN'),false);
  assert.equal(lang.needsTranslation('```js\nconst x = 1; console.log(x)\n```','zh-CN'),false);
  assert.match(lang.rule('zh-CN'),/进度说明/);
});
test('翻译只接收原文、不带任务上下文或工具，并缓存成功结果',async()=>{
  let calls=0;const translate=createTranslator(async(cfg,request)=>{calls++;assert.equal(request.json,true);assert.equal(request.tools,undefined);const data=JSON.parse(request.user);assert.deepEqual(Object.keys(data),['items']);return {text:JSON.stringify({items:data.items.map(i=>({id:i.id,text:'让我检查 CSS 是否有效，并运行测试。'}))})};});
  const input={language:'zh-CN',items:[{id:'x',text:'Let me verify CSS validity and run the tests.'}]};
  const cfg={profileId:'a',model:'m'};assert.equal((await translate(cfg,input))[0].text,'让我检查 CSS 是否有效，并运行测试。');await translate(cfg,input);assert.equal(calls,1);
  await translate({...cfg,model:'other'},input);assert.equal(calls,2);
});
test('翻译不完整和过量输入会报错，失败不写缓存',async()=>{
  let calls=0;const translate=createTranslator(async()=>{calls++;return {text:'{"items":[]}'};});
  const input={items:[{id:'a',text:'Hello world'}]};await assert.rejects(translate({},input),/不完整/);await assert.rejects(translate({},input),/不完整/);assert.equal(calls,2);
  await assert.rejects(translate({},{items:[{id:'a',text:'x'.repeat(10001)}]}),/10000/);
});
