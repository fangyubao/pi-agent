'use strict';
const {test,expect,_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');

test('首次启动说明介绍工作台并可进入工作台目录',async()=>{
  const profile=fs.mkdtempSync(path.join(ROOT,'.playwright-onboarding-'));
  const executablePath=process.env.PI_WORKBENCH_TEST_EXE||path.join(ROOT,'node_modules','electron','dist','electron.exe');
  const app=await electron.launch({executablePath,args:[...(process.env.PI_WORKBENCH_TEST_EXE?[]:[ROOT]),'--user-data-dir='+profile],cwd:process.env.PI_WORKBENCH_TEST_EXE?path.dirname(executablePath):ROOT});
  const page=await app.firstWindow();
  await page.waitForLoadState('load');
  try{
    await expect(page.locator('#first-launch')).toBeVisible();
    await expect(page.locator('#first-launch')).toContainText('工作台可以做什么');
    await page.locator('#first-launch [data-action="first-launch-workbenches"]').click();
    await expect(page.locator('[data-route="workbenches"]')).toHaveClass(/active/);
    await expect(page.locator('.page-heading')).toHaveText('工作台');
  }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
});
