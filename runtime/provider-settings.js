'use strict';
window.PiProviderSettings = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function mount(root, { onChange, notify }) {
    let config = await window.PiProviderManager.getConfig();
    let selectedId = config.profileId || config.profiles?.[0]?.id;
    let profiles = config.profiles || [];
    let available = new Map();
    let status = '';
    let draft = null;
    let displayed = null;
    function selected() { return draft || profiles.find(p => p.id === selectedId) || { id:'default', name:'默认 API', provider:'openai-compatible', baseUrl:'https://api.openai.com/v1', models:[] }; }
    function readForm() {
      const current=displayed||selected();
      const models=[...root.querySelectorAll('[data-model-slot]')].map(x=>x.value).filter(Boolean);
      const modelEfforts={},modelLimits={...(current.modelLimits||{})};
      for(const slot of root.querySelectorAll('[data-model-slot]'))if(slot.value){
        modelEfforts[slot.value]=root.querySelector('[data-effort-slot="'+slot.dataset.modelSlot+'"]').value;
        const limits={...(modelLimits[slot.value]||{})};
        for(const [field,attribute] of [['contextWindow','data-limit-slot'],['maxOutputTokens','data-output-slot']]){
          const value=Number(root.querySelector('['+attribute+'="'+slot.dataset.modelSlot+'"]')?.value);
          if(Number.isFinite(value)&&value>=1)limits[field]=Math.floor(value);
          else delete limits[field];
        }
        if((limits.contextWindow||limits.maxOutputTokens)&&!('source' in limits))limits.source='manual';
        if(Object.keys(limits).length)modelLimits[slot.value]=limits;
        else delete modelLimits[slot.value];
      }
      const advanced={quirks:{},extraHeaders:{},extraBody:{}};
      for(const box of root.querySelectorAll('[data-quirk]'))if(box.checked)advanced.quirks[box.dataset.quirk]=true;
      for(const line of (root.querySelector('#provider-extra-headers')?.value||'').split(/\r?\n/)){const t=line.trim();if(!t)continue;const i=t.indexOf(':');if(i<1)throw new Error('附加请求头格式应为“名称: 值”：'+t.slice(0,40));advanced.extraHeaders[t.slice(0,i).trim()]=t.slice(i+1).trim();}
      const bodyText=(root.querySelector('#provider-extra-body')?.value||'').trim();
      if(bodyText){let v;try{v=JSON.parse(bodyText);}catch{throw new Error('附加请求字段不是有效的 JSON');}if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('附加请求字段需要是 JSON 对象，例如 {"top_p":0.9}');advanced.extraBody=v;}
      return { profileId:current.id, advanced, name:root.querySelector('#provider-name').value.trim() || 'API', provider:root.querySelector('#provider-kind').value, baseUrl:root.querySelector('#provider-url').value.trim(), apiKey:root.querySelector('#provider-key').value.trim(), models:[...new Set(models)].slice(0,4), modelEfforts, modelLimits, modelMetadata:current.modelMetadata||{}, model:models.includes(current.model)?current.model:models[0]||'', makeActive:root.querySelector('#provider-active').checked };
    }
    // ---- 模型档位：五档，每档先选厂商、再选该厂商的模型。工作流节点按难度自动用这五档里的模型；一个都不配就全部用主模型。
    const vendorsOf = () => profiles.map(x => ({ profileId: x.id, vendor: x.name, models: [...new Set([...(x.models || []), ...(x.model ? [x.model] : [])])] })).filter(v => v.models.length);
    function tiersHtml() {
      const tiers = window.PiModelTiers.normalize(config.modelTiers), vendors = vendorsOf(), labels = window.PiModelTiers.LABELS;
      const rows = tiers.map((t, i) => {
        const vendor = vendors.find(v => v.profileId === (t && t.profileId)) || null;
        return '<div class="tier-row" data-tier="' + i + '"><span class="tier-name">' + labels[i] + '</span>' +
          '<select class="dialog-input" data-tier-vendor="' + i + '" aria-label="' + labels[i] + ' 厂商"><option value="">不使用</option>' + vendors.map(v => '<option value="' + esc(v.profileId) + '"' + (vendor && vendor.profileId === v.profileId ? ' selected' : '') + '>' + esc(v.vendor) + '</option>').join('') + '</select>' +
          '<select class="dialog-input" data-tier-model="' + i + '" aria-label="' + labels[i] + ' 模型"' + (vendor ? '' : ' disabled') + '>' + (vendor ? vendor.models.map(m => '<option value="' + esc(m) + '"' + (t.model === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('') : '<option value="">先选厂商</option>') + '</select></div>';
      }).join('');
      return '<section class="provider-tiers" id="provider-tiers"><div class="provider-model-heading"><strong>模型档位 · 最多 5 档</strong></div><p class="settings-note">档位 1 最轻最便宜，档位 5 最强。工作流里每个节点按难度自动用这些档位的模型；只配一档，所有节点都用它；两档就分成轻重两段；一档都不配则全部用主模型。每档可以来自不同厂商。手动给节点换模型时不受档位限制。</p>' + rows + '<p class="provider-status" id="tier-status" role="status"></p></section>';
    }
    function wireTiers() {
      const box = root.querySelector('#provider-tiers'); if (!box) return;
      const vendors = vendorsOf();
      const save = async () => {
        const tiers = [...Array(5).keys()].map(i => { const pid = box.querySelector('[data-tier-vendor="' + i + '"]').value, m = box.querySelector('[data-tier-model="' + i + '"]').value; return pid && m ? { profileId: pid, model: m } : null; });
        const r = await window.piDesktop.provider.saveTiers(tiers), label = box.querySelector('#tier-status');
        if (r && r.ok) { config = r.config; onChange(config); label.textContent = '已保存 ' + window.PiModelTiers.configured(config.modelTiers).length + ' 档'; } else label.textContent = (r && r.error) || '保存失败';
      };
      box.querySelectorAll('[data-tier-vendor]').forEach(sel => sel.addEventListener('change', () => {
        const i = sel.dataset.tierVendor, model = box.querySelector('[data-tier-model="' + i + '"]'), v = vendors.find(x => x.profileId === sel.value);
        model.innerHTML = v ? v.models.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('') : '<option value="">先选厂商</option>';
        model.disabled = !v; save();
      }));
      box.querySelectorAll('[data-tier-model]').forEach(sel => sel.addEventListener('change', save));
    }
    function draw(preserve = null) {
      if(!root.isConnected)return;
      const p=preserve||selected();
      displayed=p;
      const found=available.get(p.id)||p.models||[];
      const all=[...new Set([...found,...(p.models||[]),...(p.model?[p.model]:[])])];
      const chosen=(p.models?.length?p.models:[p.model].filter(Boolean)).slice(0,4);
      root.innerHTML='<div class="setting-section-heading"><div><h2>API 与模型 '+(window.PiHelp?.button('context-capacity')||'')+'</h2><p>先配置模型；上下文容量等细节收在“高级选项”里，思考强度在聊天框切换。</p></div></div>';
      const formHtml='<form id="provider-form"><div class="provider-grid"><label class="dialog-label">显示名称<input class="dialog-input" id="provider-name" value="'+esc(p.name)+'" required maxlength="60"></label><label class="dialog-label">接口协议<select class="dialog-input" id="provider-kind">'+window.PiProviderProtocols.PROTOCOLS.map(x=>'<option value="'+x.id+'">'+esc(x.label)+'</option>').join('')+'</select><small class="settings-note" id="provider-kind-hint"></small></label><label class="dialog-label">API 地址<input class="dialog-input" id="provider-url" type="url" value="'+esc(p.baseUrl)+'" required></label><label class="dialog-label">API Key<div class="provider-key-control"><input class="dialog-input" id="provider-key" type="password" autocomplete="new-password" placeholder="'+(p.hasApiKey?'已安全保存；留空不修改':'填写 API Key')+'"><button type="button" class="provider-key-toggle" id="provider-key-toggle" aria-pressed="false" aria-label="显示 API Key" title="显示 API Key"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg></button></div></label></div>'+ 
        '<div class="provider-model-heading"><strong>常用模型 · 最多 4 个</strong><button type="button" class="button" id="refresh-models">刷新厂商模型</button></div><p class="provider-status" id="provider-status" role="status">'+esc(status||('已选 '+chosen.length+' / 4 个模型'))+'</p><div class="provider-slots">'+Array.from({length:4},(_,i)=>{
          const selectedModel=chosen[i];
          return '<label class="dialog-label">模型 '+(i+1)+'<select class="dialog-input" data-model-slot="'+i+'" aria-label="常用模型 '+(i+1)+'"><option value="">不启用</option>'+all.map(x=>'<option value="'+esc(x)+'" '+(selectedModel===x?'selected':'')+'>'+esc(x)+'</option>').join('')+'</select></label>';
        }).join('')+'</div><details class="provider-advanced" id="provider-compat"><summary>兼容设置（接口不完全标准时再改）</summary><p class="settings-note">OpenAI 官方的 gpt-5 / o 系列会自动处理，不用勾。其他服务如果报“不认识 max_tokens / temperature / response_format”，在这里打开对应开关；需要额外请求头（如 Azure 的 api-key）或额外字段时填在下面。</p>'+[['maxCompletionTokens','用 max_completion_tokens 代替 max_tokens'],['noTemperature','不发送 temperature'],['noJsonMode','不要求 JSON 输出模式（拆解/导读改用提示词约束）']].map(([k,l])=>'<label class="provider-active"><input type="checkbox" data-quirk="'+k+'" '+(p.advanced?.quirks?.[k]?'checked':'')+'> '+l+'</label>').join('')+'<label class="dialog-label">附加请求头（每行 名称: 值）<textarea class="dialog-input" id="provider-extra-headers" rows="2" placeholder="api-key: xxx">'+esc(Object.entries(p.advanced?.extraHeaders||{}).map(([k,v])=>k+': '+v).join('\n'))+'</textarea></label><label class="dialog-label">附加请求字段（JSON 对象）<textarea class="dialog-input" id="provider-extra-body" rows="2" placeholder="{&quot;top_p&quot;: 0.9}">'+esc(Object.keys(p.advanced?.extraBody||{}).length?JSON.stringify(p.advanced.extraBody):'')+'</textarea></label></details><details class="provider-advanced" id="provider-advanced"><summary>高级选项（上下文容量、输出预算、默认思考强度）</summary><p class="settings-note">一般不需要改。留空就用厂商或运行时默认值；输出预算不等于输入窗口，无元数据时运行时默认 32768，不代表模型上限。思考强度平时直接在聊天框里切换。</p><div class="provider-slots">'+Array.from({length:4},(_,i)=>{
          const selectedModel=chosen[i],known=p.modelMetadata?.[selectedModel]?.contextWindow,manual=p.modelLimits?.[selectedModel]?.contextWindow;
          const knownOutput=p.modelMetadata?.[selectedModel]?.maxOutputTokens,manualOutput=p.modelLimits?.[selectedModel]?.maxOutputTokens;
          return '<div class="dialog-label adv-slot"><strong data-adv-name="'+i+'">'+esc(selectedModel||'模型 '+(i+1)+'（未启用）')+'</strong><select class="dialog-input effort-slot" data-effort-slot="'+i+'" aria-label="模型 '+(i+1)+' 默认思考强度">'+[['off','默认 / 不启用思考'],['minimal','最小'],['low','低'],['medium','中'],['high','高']].map(([v,label])=>'<option value="'+v+'" '+((p.modelEfforts?.[selectedModel]||'off')===v?'selected':'')+'>'+label+'</option>').join('')+'</select><span>上下文容量（tokens）</span><input class="dialog-input model-limit" data-limit-slot="'+i+'" data-limit-model="'+esc(selectedModel||'')+'" type="number" min="1024" step="1" value="'+esc(manual??'')+'" placeholder="'+esc(known?'厂商：'+known:'未知 · 可手动填写')+'" aria-label="模型 '+(i+1)+' 上下文容量"><span>每次生成输出预算（tokens）</span><input class="dialog-input model-limit" data-output-slot="'+i+'" type="number" min="1" step="1" value="'+esc(manualOutput??'')+'" placeholder="'+esc(knownOutput?'厂商：'+knownOutput:'32768 · 运行时默认')+'" aria-label="模型 '+(i+1)+' 每次生成输出预算"></div>';
        }).join('')+'</div></details>'+ 
        '<label class="dialog-label">手动添加模型 ID（接口不提供列表时）<div class="provider-manual"><input class="dialog-input" id="provider-manual-model" placeholder="例如 model-id"><button type="button" class="button" id="provider-import">加入可选列表</button></div></label><label class="provider-active"><input type="checkbox" id="provider-active" '+(config.profileId===p.id||!profiles.length||Boolean(draft&&draft.id===p.id)?'checked':'')+'> 保存后设为当前 API</label><div class="provider-actions"><button class="button primary" type="submit">保存配置</button><button class="button" id="provider-test" type="button">测试 API 通信</button><button class="button danger" id="provider-delete" type="button" '+(draft||profiles.length<2?'disabled':'')+'>删除此 API</button></div><p class="settings-note">API Key 由系统安全存储加密，不进入对话和提示词。测试使用当前表单和所选模型发送一条小型流式请求，可能产生少量 API 费用；不会自动保存配置。</p></form>';
      // 每个 API 是一个折叠项：点标题展开（同时只展开一个），表单只出现在展开的那一项里；新增按钮在列表底部。
      const rows=[...profiles,...(draft?[draft]:[])];if(!rows.some(x=>x.id===p.id))rows.push(p);
      const items=rows.map(x=>{const open=x.id===p.id;const sub=(x.models?.length?x.models.length+' 个模型':'未选模型');
        return '<details class="provider-item" data-profile="'+esc(x.id)+'"'+(open?' open':'')+'><summary><span class="provider-item-name">'+esc(draft&&x.id===draft.id?'新 API（未保存）':x.name)+'</span>'+(x.id===config.profileId?'<span class="provider-item-badge">当前</span>':'')+'<span class="provider-item-sub">'+esc(sub)+'</span></summary>'+(open?formHtml:'')+'</details>';}).join('');
      root.innerHTML+='<div class="provider-list">'+items+'</div><button type="button" class="button provider-add-bottom" id="provider-add">＋ 新增 API</button>'+tiersHtml();
      root.querySelector('#provider-kind').value=p.provider||'openai-compatible';
      {
        const kind=root.querySelector('#provider-kind'),hint=root.querySelector('#provider-kind-hint'),url=root.querySelector('#provider-url');
        const showHint=()=>{hint.textContent=window.PiProviderProtocols.byId(kind.value).hint;};
        let last=kind.value;showHint();
        kind.onchange=()=>{
          const from=window.PiProviderProtocols.byId(last),to=window.PiProviderProtocols.byId(kind.value);
          if(!url.value.trim()||url.value.replace(/\/+$/,'')===from.defaultBase.replace(/\/+$/,''))url.value=to.defaultBase;     // 地址还是旧协议的默认值（或没填）就跟着换；用户自己改过的不动
          last=kind.value;showHint();
        };
      }
      wireTiers();
      {
        const keyInput=root.querySelector('#provider-key'),toggle=root.querySelector('#provider-key-toggle');
        const setVisible=visible=>{keyInput.type=visible?'text':'password';toggle.setAttribute('aria-pressed',String(visible));toggle.setAttribute('aria-label',visible?'隐藏 API Key':'显示 API Key');toggle.title=visible?'隐藏 API Key':'显示 API Key';};
        toggle.onclick=async()=>{
          if(keyInput.type==='password'&&!keyInput.value&&p.hasApiKey&&!keyInput.dataset.revealed){
            toggle.disabled=true;
            try{
              const result=await window.piDesktop.provider.revealKey(p.id);
              if(!result?.ok)throw new Error(result?.error||'API Key 读取失败');
              keyInput.value=result.key||'';keyInput.dataset.revealed='true';
            }catch(error){notify(error.message);return;}
            finally{toggle.disabled=false;}
          }
          setVisible(keyInput.type==='password');
        };
      }
      for(const select of root.querySelectorAll('[data-model-slot]'))select.addEventListener('change',()=>{
        const slot=select.dataset.modelSlot,limits=p.modelLimits?.[select.value],metadata=p.modelMetadata?.[select.value];
        root.querySelector('[data-effort-slot="'+slot+'"]').value=p.modelEfforts?.[select.value]||'off';
        const nm=root.querySelector('[data-adv-name="'+slot+'"]');if(nm)nm.textContent=select.value||'模型 '+(Number(slot)+1)+'（未启用）';
        const context=root.querySelector('[data-limit-slot="'+slot+'"]'),output=root.querySelector('[data-output-slot="'+slot+'"]');
        context.dataset.limitModel=select.value;
        context.value=limits?.contextWindow??'';
        context.placeholder=metadata?.contextWindow?'厂商：'+metadata.contextWindow:'未知 · 可手动填写';
        output.value=limits?.maxOutputTokens??'';
        output.placeholder=metadata?.maxOutputTokens?'厂商：'+metadata.maxOutputTokens:'32768 · 运行时默认';
      });
      root.querySelectorAll('.provider-item').forEach(d=>d.querySelector('summary').addEventListener('click',e=>{
        if(d.dataset.profile===p.id)return;               // 当前展开项：保持原生折叠/展开
        e.preventDefault();selectedId=d.dataset.profile;draft=null;status='';draw();
      }));
      root.querySelector('#provider-add').onclick=()=>{draft={id:'profile-'+Date.now().toString(36),name:'新 API',provider:'openai-compatible',baseUrl:window.PiProviderProtocols.byId('openai-compatible').defaultBase,models:[]};selectedId=draft.id;status='填写连接信息后刷新模型';draw();};
      root.querySelector('#refresh-models').onclick=async()=>{
        const form=readForm(),key=root.querySelector('#provider-key').value;
        root.querySelector('#provider-status').textContent='正在读取厂商模型…';
        const result=await window.PiProviderManager.listModels(form);
        if(!result.ok){root.querySelector('#provider-status').textContent=result.error;return;}
        available.set(p.id,result.models||[]);
        status=result.manualOnly?'接口未提供模型列表，请手动添加模型 ID':'已读取 '+(result.models||[]).length+' 个模型，请在四个模型槽中选择';
        const next={...p,...form,id:p.id,models:form.models.length?form.models:(result.models||[]).slice(0,4),modelMetadata:{...(p.modelMetadata||{}),...(result.modelMetadata||{})}};
        draw(next);root.querySelector('#provider-key').value=key;
      };
      root.querySelector('#provider-import').onclick=()=>{const id=root.querySelector('#provider-manual-model').value.trim();if(!id)return;const form=readForm(),key=root.querySelector('#provider-key').value;available.set(p.id,[...new Set([...all,id])]);draw({...p,...form,id:p.id,models:form.models.length<4?[...form.models,id]:form.models});root.querySelector('#provider-key').value=key;};
      root.querySelector('#provider-test').onclick=async()=>{
        const button=root.querySelector('#provider-test'),label=root.querySelector('#provider-status');
        button.disabled=true;label.textContent='正在测试当前表单中的模型流式通信（最长 30 秒）…';
        try {
          const result=await window.PiProviderManager.test(readForm());
          if(!root.isConnected||root.querySelector('#provider-test')!==button)return;
          label.textContent=(result.ok?'测试成功：'+result.message:'测试失败：'+result.error)+(result.elapsedMs!=null?' · '+(result.elapsedMs/1000).toFixed(1)+' 秒':'')+(result.httpStatus?' · HTTP '+result.httpStatus:'');
        }catch(error){if(label.isConnected)label.textContent='测试失败：'+error.message;}
        finally{button.disabled=false;}
      };
      root.querySelector('#provider-form').onsubmit=async e=>{
        e.preventDefault();
        try{
          const form=readForm(),refreshEmpty=!form.models.length&&(!p.hasApiKey||Boolean(draft));
          let result=await window.PiProviderManager.saveConfig(form);if(!result.ok)throw new Error(result.error);
          config=result.config;profiles=config.profiles||[];selectedId=p.id;draft=null;
          status='配置已保存，聊天框已同步';
          if(refreshEmpty){
            const catalog=await window.PiProviderManager.listModels({profileId:p.id});
            if(catalog.ok){
              available.set(p.id,catalog.models||[]);
              const models=(catalog.models||[]).slice(0,4);
              result=await window.PiProviderManager.saveConfig({profileId:p.id,models,model:models[0]||'',modelMetadata:catalog.modelMetadata||{},makeActive:form.makeActive});
              if(!result.ok)throw new Error(result.error);
              config=result.config;profiles=config.profiles||[];
              status='已读取 '+(catalog.models||[]).length+' 个模型，已导入 '+models.length+' 个，可在下方调整';
            }else status='API 已保存；模型刷新失败：'+catalog.error;
          }
          onChange(config);draw();notify('API 配置已保存');
        }catch(error){root.querySelector('#provider-status').textContent=error.message;}
      };
      root.querySelector('#provider-delete').onclick=async()=>{if(!confirm('删除 API 配置“'+p.name+'”？不会删除对话。'))return;const result=await window.piDesktop.provider.delete(p.id);if(result.ok){config=result.config;profiles=config.profiles;selectedId=config.profileId;onChange(config);draw();}else notify(result.error);};
    }
    draw();
  }
  return Object.freeze({ mount });
})();
