'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const ROOT=path.resolve(__dirname,'..');
async function launch(){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-copy-e2e-'));
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT});
  const page=await app.firstWindow();await page.waitForLoadState('load');
  if(await page.locator('#first-launch').isVisible())await page.locator('[data-action="dismiss-first-launch"]').click();
  return {app,page,profile,close:async()=>{await app.close();fs.rmSync(profile,{recursive:true,force:true});}};
}
test('真实系统剪贴板：成功必须可读回，拒绝访问必须向调用方报错',async({},info)=>{
  const fx=await launch();try{
    const text='Pi clipboard verification 中文';
    const result=await fx.page.evaluate(async text=>{try{return await window.piDesktop.clipboard.writeText(text);}catch(error){return {ok:false,error:error.message};}},text);
    const matches=await fx.app.evaluate(({clipboard},text)=>clipboard.readText()===text,text);
    if(matches)expect(result.ok).toBe(true);else{expect(result.ok).toBe(false);expect(result.error).toContain('内容未复制');}
    await info.attach('native-clipboard-result',{body:JSON.stringify({nativeWriteVerified:matches,result},null,2),contentType:'application/json'});
  }finally{await fx.close();}
});
for(const denied of [false,true])test('消息、代码、链接和文件路径复制：'+(denied?'系统失败显示错误':'精确复制全部内容'),async()=>{
  const fx=await launch();const {app,page,profile}=fx;
  try{
    if(denied)await app.evaluate(({clipboard})=>{clipboard.writeText=()=>{};clipboard.readText=()=>'';});
    else await require('./helpers/clipboard.cjs').useClipboardMemory(app);
    const workspace=path.join(profile,'workspace');fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'notes.txt'),'new');
    await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await page.evaluate(async workspace=>{await window.PiPersistence.flush();const s=JSON.parse(localStorage.getItem('pi-workbench-design-v2'));const t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);t.workspacePath=workspace;t.messages=[{id:'copy-u',role:'user',text:'完整复制这条消息，无需选择。',time:Date.now()},{id:'copy-a',role:'assistant',text:'```js\nconst result = 42;\n```',time:Date.now(),run:{status:'complete',hasFinal:true,cwd:workspace,changedFiles:[{path:'notes.txt',cwd:workspace,operation:'修改',before:'old',after:'new'}]}}];localStorage.setItem('pi-workbench-design-v2',JSON.stringify(s));},workspace);
    await page.reload();
    const check=async(value)=>{if(denied){await expect(page.locator('#toast')).toContainText(/复制失败|内容未复制/);await expect(page.locator('#toast')).not.toContainText('已复制');}else await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText())).toBe(value);};
    await page.locator('[data-action="copy-message"][data-id="copy-u"]').click();await check('完整复制这条消息，无需选择。');
    await page.locator('[data-action="copy-code"]').click();await check('const result = 42;\n');
    await page.locator('#projects [data-action="task-menu"][data-id="bell"]').click();await page.locator('#menu [data-action="task-copy-menu"]').hover();await page.locator('#submenu [data-action="copy-task-link"]').click();await check('pi-workbench://task/bell');
    await page.locator('.changed-file-name').click({button:'right'});await page.locator('#path-ctx > [data-ctx="copy"]').click();await check(path.join(workspace,'notes.txt'));
  }finally{await fx.close();}
});
