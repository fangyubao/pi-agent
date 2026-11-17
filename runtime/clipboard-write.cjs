'use strict';

// Electron can return from writeText without writing (locked clipboard or an
// unavailable Windows desktop). Never show success until the value is readable.
function createWriter(clipboard,{attempts=4,delay=60,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let pending=Promise.resolve();
  return function writeText(value){
    const text=String(value??'');
    const result=pending.then(async()=>{
      for(let attempt=0;attempt<attempts;attempt++){
        try{clipboard.writeText(text);if(clipboard.readText()===text)return {ok:true};}catch{}
        if(attempt+1<attempts)await sleep(delay);
      }
      throw new Error('无法访问系统剪贴板，内容未复制。请解锁桌面或关闭占用剪贴板的程序后重试。');
    });
    pending=result.catch(()=>{});
    return result;
  };
}
module.exports={createWriter};
