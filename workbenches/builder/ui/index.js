'use strict';
(() => {
  const fallbackStages=['需求确认','结构设计','布局调整','交互验证','预览','发布准备'];
  window.PiWorkbenchModules.builder={
    mount(host,{data,save,notify,request,esc,server}) {
      const d={name:'未命名工作台',principles:'',knowledgePaths:[],stage:0,revision:0,knowledge:null,promptDraft:'',appliedPrompt:'',promptMethod:'',promptVersion:0,...data};
      let busy=false,disposed=false,workflow=null;
      const commit=()=>{d.revision++;save(structuredClone(d));};
      function capture() {
        if(!host.querySelector('#wb-kb'))return;
        d.name=host.querySelector('#wb-name').value.trim()||'未命名工作台';
        d.principles=host.querySelector('#wb-principles').value;
        d.knowledgePaths=[...new Set(host.querySelector('#wb-kb').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean))];
        d.promptDraft=host.querySelector('#wb-prompt').value;
      }
      function pathChanged() {
        if(JSON.stringify(d.knowledgePaths)===JSON.stringify(d.knowledge?.roots||[]))return false;
        d.knowledge=null;d.promptDraft='';d.appliedPrompt='';d.promptMethod='';d.promptVersion++;
        return true;
      }
      const getDraft=()=>({name:d.name,principles:d.principles,knowledgePaths:d.knowledgePaths,stage:d.stage,revision:d.revision,promptDraft:d.promptDraft,appliedPrompt:d.appliedPrompt,promptVersion:d.promptVersion,files:(d.knowledge?.files||[]).map(({content,...meta})=>meta)});
      function renderProgress() {
        const box=host.querySelector('#wb-progress');if(!box)return;
        const names=workflow?.stages||fallbackStages,cur=Number.isInteger(workflow?.stage)?workflow.stage:Math.min(d.stage||0,names.length-1);
        const status=workflow?.status||'idle',done=status==='complete';
        const state=i=>done||i<cur?'done':i===cur?'current':'todo';
        const bar=names.map((_,i)=>'<i data-s="'+state(i)+'"></i>').join('');
        const steps=names.map((n,i)=>'<li data-s="'+state(i)+'" data-status="'+esc(status)+'"'+(i===cur&&!done?' aria-current="step"':'')+'><span class="wb-dot">'+(state(i)==='done'?'✓':i+1)+'</span><span>'+esc(n)+'</span>'+(i===cur&&!done?'<em>'+esc(workflow?.label||'待开始')+'</em>':'')+'</li>').join('');
        const next=workflow?.next;
        box.innerHTML='<div class="wb-progress-head"><div><h3>'+(done?'设计流程已完成':esc(names[cur]))+'</h3><small>'+(done?'本地交付已确认':'第 '+(cur+1)+' / '+names.length+' 阶段'+(next?' · 下一步：'+esc(next):''))+'</small></div><span class="wb-pill" data-status="'+esc(done?'complete':status)+'">'+esc(done?'已完成':workflow?.label||'待开始')+'</span></div>'+
          '<div class="wb-bar" aria-hidden="true">'+bar+'</div><ol class="wb-steps">'+steps+'</ol>'+
          (workflow?.error&&!done?'<div class="wb-alert" role="alert"><strong>失败原因：</strong>'+esc(workflow.error)+'</div>':'')+
          (workflow?.work&&!done?'<div class="wb-work"><strong>本阶段要做什么</strong><p>'+esc(workflow.work)+'</p></div>':'')+
          '<p class="wb-hint">'+(workflow?(status==='review'?'<strong>Agent 已提交本阶段交付。</strong>请在中间聊天区查看并确认。':status==='running'?'Agent 正在执行本阶段，进度会实时更新。':'阶段确认入口在中间聊天区。'):'与聊天同步，Agent 提交交付后在聊天区确认进入下一阶段。')+'</p>';
      }
      function render() {
        if(disposed)return;
        const imported=d.knowledge,files=imported?.files||[];
        host.innerHTML='<section class="module builder-module"><div class="module-summary"><div><h2>工作台设计</h2><p>可选知识库 · 支持多个本地目录和文件</p></div><span class="tag">草稿</span></div>'+
          '<section class="module-card wb-progress" id="wb-progress" aria-live="polite" aria-label="设计进度"></section>'+
          '<details class="module-card"><summary>名称与设计偏好（可选）</summary><label class="dialog-label">名称<input id="wb-name" class="dialog-input" value="'+esc(d.name)+'"></label><label class="dialog-label">设计原则与偏好<textarea id="wb-principles" class="free-input" rows="3">'+esc(d.principles)+'</textarea></label></details>'+
          '<section class="module-card"><div class="module-section-title"><h3>独立工作台工程</h3><span class="tag">UI / Server</span></div><p class="module-note">前端只负责交互，后端独立处理状态、设备和计算。生成后可打开源码，后端也可单独运行。</p><button class="button" id="create-project" '+(busy?'disabled':'')+'>'+ (d.workspacePath?'打开工程目录':'创建分层工程')+'</button>'+(d.workspacePath?'<p class="module-note">'+esc(d.workspacePath)+'</p>':'')+'</section>'+
          '<section class="module-card"><div class="module-section-title"><h3>知识库来源</h3><small>本地只读</small></div><label class="dialog-label" for="wb-kb">路径，每行一个</label><textarea id="wb-kb" class="free-input path-input" rows="3" placeholder="粘贴目录或文件的绝对路径">'+esc(d.knowledgePaths.join('\n'))+'</textarea>'+
          '<div class="builder-actions"><button class="button" id="kb-folder">添加目录</button><button class="button" id="kb-files">添加文件</button><button class="button primary" id="kb-import" '+(busy?'disabled':'')+'>'+(busy?'正在读取…':'读取并生成草稿')+'</button></div>'+
          '<p class="module-note">支持文本、代码、PDF 和 Word（.docx）。在本机建立全文索引，Agent 按需检索片段与来源；扫描件需要先识别文字。原始资料不会整份载入对话。</p>'+
          (imported?'<p class="knowledge-summary">已读取 '+imported.readCount+' 份，其中 '+imported.partialCount+' 份仅部分读取；'+files.filter(f=>!['read','partial'].includes(f.status)).length+' 项未导入。</p><details class="source-details"><summary>查看读取清单与来源</summary><ul>'+files.map(f=>'<li><strong>'+esc(f.name||f.path)+'</strong><small>'+esc(f.path)+'</small><span class="'+(['read','partial'].includes(f.status)?'':'error')+'">'+esc(f.status==='read'?'已读取':f.reason||f.status)+'</span></li>').join('')+'</ul><p class="module-note">'+esc(imported.warnings.join('\n'))+'</p></details>':'')+'</section>'+
          '<section class="module-card"><div class="module-section-title"><h3>转化后的提示词</h3><span class="tag">'+(d.appliedPrompt?'已应用 v'+d.promptVersion:'未应用')+'</span></div>'+
          '<p class="module-note" id="prompt-method">'+esc(d.promptMethod||'读取资料后会生成可查看的草稿，也可直接编写。')+'</p>'+
          '<textarea id="wb-prompt" class="free-input prompt-editor" rows="10" maxlength="12000" aria-label="工作台提示词草稿" placeholder="资料整理后的提示词会显示在这里，可查看、编辑后应用。">'+esc(d.promptDraft)+'</textarea>'+
          '<div class="builder-actions"><button class="button" id="kb-refine" '+(!imported?.readCount||busy?'disabled':'')+'>让 Agent 整理</button><button class="button" id="prompt-copy">复制</button><button class="button primary" id="prompt-apply">应用提示词</button><button class="button" id="prompt-disable" '+(!d.appliedPrompt?'disabled':'')+'>停用</button></div>'+
          '<p class="module-note">草稿不会自动生效。应用后只随当前工作台载入；关闭工作台立即卸载。原始资料与整理稿分别保存。</p>'+
          '<details class="applied-prompt"><summary>查看当前实际应用内容</summary><pre>'+esc(d.appliedPrompt||'当前未应用知识库提示词')+'</pre></details></section>'+
          ''+'</section>';
        for(const id of ['wb-name','wb-principles','wb-prompt']) host.querySelector('#'+id).oninput=()=>{capture();commit();};
        renderProgress();
        host.querySelector('#create-project').onclick=async()=>{
          if(d.workspacePath){await request('open-project-path');return;}
          capture();busy=true;render();
          try{const result=await request('scaffold',{name:d.name,prompt:d.appliedPrompt||d.principles});d.workspacePath=result.path;commit();notify('分层工程已创建，Agent 将在该工程目录中开发');}
          catch(error){notify(error.message);}
          finally{busy=false;render();}
        };
        host.querySelector('#wb-kb').oninput=()=>{capture();if(pathChanged())notify('路径已改变，请重新读取；旧提示词已停用');commit();};
        for(const [id,kind] of [['kb-folder','folders'],['kb-files','files']]) host.querySelector('#'+id).onclick=async()=>{
          try { capture();const paths=await request('pick',{kind});if(disposed||!paths.length)return;d.knowledgePaths=[...new Set([...d.knowledgePaths,...paths])];pathChanged();commit();render(); }
          catch(error){notify(error.message);}
        };
        host.querySelector('#kb-import').onclick=async()=>{
          capture();if(!d.knowledgePaths.length){notify('请先添加知识库路径');return;}
          const paths=[...d.knowledgePaths];busy=true;render();
          try {
            const result=await request('import',{paths});
            if(disposed)return;
            if(JSON.stringify(paths)!==JSON.stringify(d.knowledgePaths)){notify('路径已经改变，本次结果未应用');return;}
            if(!result.ok)throw new Error(result.error);
            d.knowledge=result.report;d.promptDraft=result.report.draft;d.promptMethod=result.report.draftMethod;
            d.appliedPrompt='';d.promptVersion++;commit();notify('资料已读取，请查看提示词草稿与来源清单');
          } catch(error){if(!disposed)notify(error.message);}
          finally{busy=false;render();}
        };
        host.querySelector('#kb-refine').onclick=async()=>{
          capture();commit();
          try{await request('refine');notify('已交给当前 Agent 整理，结果会回到提示词草稿');}catch(error){notify(error.message);}
        };
        host.querySelector('#prompt-copy').onclick=async()=>{
          capture();try{await navigator.clipboard.writeText(d.promptDraft);notify('已复制提示词草稿');}catch{notify('复制不可用，可在文本框中全选复制');}
        };
        host.querySelector('#prompt-apply').onclick=()=>{
          capture();if(!d.promptDraft.trim()){notify('请先生成或填写提示词');return;}
          d.appliedPrompt=d.promptDraft;d.promptVersion++;commit();render();notify('提示词已应用到当前工作台');
        };
        host.querySelector('#prompt-disable').onclick=()=>{capture();d.appliedPrompt='';d.promptVersion++;commit();render();notify('知识库提示词已停用');};
      }
      render();
      return {
        sync(next){Object.assign(d,next);render();},
        syncWorkflow(next){workflow=next||null;if(workflow&&Number.isInteger(workflow.stage))d.stage=workflow.stage;renderProgress();},
      invoke(command,payload={}) { return server(command,payload); },
      dispose(){disposed=true;}
      };
    }
  };
})();
