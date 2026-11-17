'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const ROOT=path.resolve(__dirname,'..');
test.use({video:'off'});

test('文件变更独立控件：折叠、键盘、差异审核、路径菜单和长列表',async({},testInfo)=>{
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pi-file-widget-'));
  const workspace=path.join(profile,'workspace');fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace,'notes.txt'),'new line\n');
  const exe=process.env.PI_WORKBENCH_TEST_EXE;
  const app=await electron.launch({executablePath:exe||path.join(ROOT,'node_modules/electron/dist/electron.exe'),args:[...(exe?[]:[ROOT]),'--user-data-dir='+profile],cwd:ROOT,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,PI_WORKBENCH_WORKSPACE:workspace}});
  const page=await app.firstWindow();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.waitForLoadState('load');
    if(await page.locator('#first-launch').isVisible().catch(()=>false))await page.locator('[data-action="dismiss-first-launch"]').click();
    await page.locator('[data-action="select-task"][data-id="bell"]').click();
    await page.waitForFunction(()=>localStorage.getItem('pi-workbench-design-v2'));
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1280,900));
    const files=[
      {path:'notes.txt',operation:'修改',before:'old line\n',after:'new line\n'},
      {path:'ui/components/WorkbenchToolbar.tsx',operation:'新增',before:'',after:'export const Toolbar = true;\n'},
      {path:'server/legacy/old-worker.js',operation:'删除',before:'old worker\n',after:''}
    ];
    async function fixture(changes){
      await page.evaluate(({files,workspace})=>{
        const key='pi-workbench-design-v2',s=JSON.parse(localStorage.getItem(key));
        const t=s.projects.flatMap(p=>p.tasks).find(t=>t.id===s.activeTask);
        t.workspacePath=workspace;
        t.messages=[{id:'file-widget-user',role:'user',text:'请调整工具栏，并清理旧文件。',time:Date.now()-3000},
          {id:'file-widget-answer',role:'assistant',text:'已调整工具栏，移除了旧实现。\n\n你可以点击下方文件查看具体改动。',time:Date.now(),run:{status:'complete',cwd:workspace,steps:[],changedFiles:files.map(f=>({...f,cwd:workspace})),startedAt:Date.now()-2400,finishedAt:Date.now(),label:'本轮已结束',hasFinal:true}}];
        localStorage.setItem(key,JSON.stringify(s));
      },{files:changes,workspace});
      await page.reload();await expect(page.locator('.changed-files')).toBeVisible();
    }
    await fixture(files);
    const widget=page.locator('.changed-files'),header=widget.locator(':scope > summary'),rows=widget.locator('.file-review-link');
    await expect(header).toContainText('3 个文件已更改');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1).locator('.changed-file-name')).toHaveText('WorkbenchToolbar.tsx');
    await expect(rows.nth(1).locator('.changed-file-directory')).toHaveText('ui/components/');
    await expect(rows.nth(2).locator('.changed-file-operation')).toHaveText('删除');
    await header.click();await expect(rows.first()).toBeHidden();
    await header.focus();await page.keyboard.press('Enter');await expect(rows.first()).toBeVisible();
    await widget.screenshot({path:testInfo.outputPath('changed-files-control.png')});
    await page.screenshot({path:testInfo.outputPath('chat-with-file-control.png')});
    await rows.first().focus();await page.keyboard.press('Enter');
    await expect(page.locator('.diff-line.removed')).toContainText('old line');
    await expect(page.locator('.diff-line.added')).toContainText('new line');
    await page.locator('#dialog [data-action="close-dialog"]').first().click();
    await require('./helpers/clipboard.cjs').useClipboardMemory(app);
    await rows.first().locator('.changed-file-name').click({button:'right'});
    await expect(page.locator('#path-ctx')).toBeVisible();
    await page.locator('#path-ctx > [data-ctx="copy"]').click();
    await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText())).toBe(path.join(workspace,'notes.txt'));

    const long='ui/'+('very-long-directory-name/').repeat(8)+'a-long-file-name-with-<markup>&-characters.ts';
    await fixture([...files,{path:long,operation:'修改'},...Array.from({length:16},(_,i)=>({path:'server/workers/job-'+i+'.js',operation:'修改'}))]);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(840,760));
    await expect(header).toContainText('20 个文件已更改');
    expect(await widget.locator('ul').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
    await expect(rows.nth(3)).toHaveAttribute('title',long);
    expect(await widget.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    expect(await rows.nth(3).locator('.changed-file-directory').evaluate(el=>el.scrollWidth>el.clientWidth)).toBe(true);
    await rows.last().scrollIntoViewIfNeeded();await expect(rows.last()).toBeInViewport();
    await page.screenshot({path:testInfo.outputPath('changed-files-narrow.png')});
    expect(await page.evaluate(()=>window.PiTranscript.fileMarkup({run:{status:'running',changedFiles:[{path:'x'}]}}))).toBe('');
    expect(await page.evaluate(()=>window.PiTranscript.fileMarkup({run:{status:'complete',changedFiles:[]}}))).toBe('');
    expect(errors).toEqual([]);
  }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
});
