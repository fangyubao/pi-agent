'use strict';
(() => {
  const LIFE = [
    {id:'long', label:'长期记忆'},
    {id:'short', label:'短期记忆'}
  ];
  const KINDS = [
    {id:'core', label:'核心规则'},
    {id:'continuation', label:'续接点'},
    {id:'decision', label:'决策'},
    {id:'experience', label:'经验'},
    {id:'correction', label:'纠错'},
    {id:'preference', label:'偏好'},
    {id:'constraint', label:'约束'},
    {id:'fact', label:'事实'}
  ];
  const STATUS = {confirmed:'已确认', pending:'待确认', disabled:'已停用'};
  const SOURCES = {user:'用户写入', agent:'Agent 生成', mixed:'用户与 Agent 合并'};
  const enc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const id = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const now = () => Date.now();
  const shortExpiry = () => now() + 7 * 24 * 60 * 60 * 1000;
  const help = key => window.PiHelp?.button(key) || '';
  const sourceOf = entry => Object.hasOwn(SOURCES, entry.source) ? entry.source : 'user';
  const contentOf = value => {
    const content = String(value ?? '').trim();
    if (!content) throw new Error('记忆内容不能为空');
    return content;
  };
  const dateText = value => value ? new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '—';
  const inputDate = value => {
    if (!value) return '';
    const d = new Date(value), pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function ensure(owner) {
    if (!owner || typeof owner !== 'object') return {schema:1,entries:[],activity:[]};
    if (!owner.memory || typeof owner.memory !== 'object') owner.memory = {schema:1,entries:[],activity:[]};
    if (!Array.isArray(owner.memory.entries)) owner.memory.entries = [];
    if (!Array.isArray(owner.memory.activity)) owner.memory.activity = [];
    owner.memory.schema = 1;
    owner.memory.entries.forEach(entry => {
      entry.lifespan = ['long','short'].includes(entry.lifespan) ? entry.lifespan : 'long';
      entry.kind = KINDS.some(kind => kind.id === entry.kind) ? entry.kind : 'fact';
      entry.status = ['confirmed','pending','disabled'].includes(entry.status) ? entry.status : 'confirmed';
      entry.version = Number(entry.version) || 1;
      entry.createdAt = Number(entry.createdAt) || now();
      entry.updatedAt = Number(entry.updatedAt) || entry.createdAt;
      entry.history = Array.isArray(entry.history) ? entry.history : [];
      entry.source = sourceOf(entry);
      entry.provenance = entry.provenance && typeof entry.provenance === 'object' ? entry.provenance : {operation:'legacy',actor:entry.source,parents:[]};
      entry.pinned = Boolean(entry.pinned);
      entry.expiresAt = entry.lifespan === 'short' ? (Number(entry.expiresAt) || shortExpiry()) : null;
    });
    return owner.memory;
  }

  function snapshot(entry) {
    const {history, ...plain} = entry;
    return copy(plain);
  }

  function record(store, type, label, before, after, entryId, undoable=true, changes) {
    const index = store.entries.findIndex(entry => entry.id === entryId);
    const change = {id:id('memory-change'),entryId,type,label,before:copy(before),after:copy(after),time:now(),undoable,undone:false,
      changes:copy(changes || [{before,after,beforeIndex:index,afterIndex:index}])};
    store.activity.push(change);
    if (store.activity.length > 100) store.activity.splice(0,store.activity.length-100);
    return change;
  }

  function makeEntry(values={}) {
    const time = now();
    const lifespan = values.lifespan === 'short' ? 'short' : 'long';
    const entry = {
      id:id('memory'),
      content:contentOf(values.content),
      lifespan,
      kind:KINDS.some(kind => kind.id === values.kind) ? values.kind : 'fact',
      status:values.source === 'agent' ? 'pending' : 'confirmed',
      pinned:Boolean(values.pinned),
      expiresAt:lifespan === 'short' ? (Number(values.expiresAt) || shortExpiry()) : null,
      createdAt:time,
      updatedAt:time,
      version:1,
      source:sourceOf(values),
      reason:String(values.reason || '').trim().slice(0,500),
      provenance:{operation:'create',actor:values.source === 'agent' ? 'agent' : 'user',parents:[]},
      history:[]
    };
    return entry;
  }

  function create(owner, values={}) {
    const entry = makeEntry(values), store = ensure(owner);
    store.entries.unshift(entry);
    record(store,'create','新增记忆',null,entry,entry.id);
    return entry;
  }

  function update(owner, entryId, values={}, label='修改记忆') {
    const store = ensure(owner), entry = store.entries.find(item => item.id === entryId);
    if (!entry) return null;
    const content = values.content != null ? contentOf(values.content) : entry.content;
    const before = copy(entry);
    entry.history.push(snapshot(entry));
    if (entry.history.length > 40) entry.history.splice(0,entry.history.length-40);
    entry.content = content;
    if (values.lifespan != null) entry.lifespan = values.lifespan === 'short' ? 'short' : 'long';
    if (values.kind != null && KINDS.some(kind => kind.id === values.kind)) entry.kind = values.kind;
    if (values.status != null && ['confirmed','pending','disabled'].includes(values.status)) entry.status = values.status;
    if (values.pinned != null) entry.pinned = Boolean(values.pinned);
    entry.expiresAt = entry.lifespan === 'short' ? (Number(values.expiresAt) || entry.expiresAt || shortExpiry()) : null;
    if (values.confirmUserEdit !== false && entry.status === 'pending') entry.status = 'confirmed';
    entry.provenance = lineage('update',[before]);
    entry.updatedAt = now();
    entry.version = (Number(entry.version) || 1) + 1;
    record(store,'update',label,before,entry,entry.id);
    return entry;
  }

  function remove(owner, entryId) {
    const store = ensure(owner), index = store.entries.findIndex(item => item.id === entryId);
    if (index < 0) return false;
    const [entry] = store.entries.splice(index,1);
    record(store,'delete','删除记忆',entry,null,entry.id,true,[{before:entry,after:null,beforeIndex:index,afterIndex:-1}]);
    return true;
  }

  // A compound operation commits only after every result is validated. Record only
  // affected entries and their positions so one undo also restores ordering/history.
  function replaceEntries(store, originals, replacements, type, label) {
    const changes = originals.map(entry => ({before:entry,after:null,beforeIndex:store.entries.indexOf(entry),afterIndex:-1}));
    const at = changes.length ? Math.min(...changes.map(change => change.beforeIndex)) : 0;
    const ids = new Set(originals.map(entry => entry.id));
    const next = store.entries.filter(entry => !ids.has(entry.id));
    next.splice(at,0,...replacements);
    replacements.forEach((entry,index) => changes.push({before:null,after:entry,beforeIndex:-1,afterIndex:at+index}));
    store.entries.splice(0,store.entries.length,...next);
    record(store,type,label,originals,replacements,replacements[0]?.id || originals[0]?.id,true,changes);
    return replacements;
  }

  function lineage(operation, parents) {
    return {operation,actor:'user',parents:parents.map(entry => ({id:entry.id,version:entry.version,source:entry.source}))};
  }

  function merge(owner, entryIds, values={}) {
    const store = ensure(owner);
    if (!Array.isArray(entryIds) || entryIds.length < 2 || new Set(entryIds).size !== entryIds.length) throw new Error('请选择至少两条不同的记忆');
    const parents = entryIds.map(entryId => store.entries.find(entry => entry.id === entryId));
    if (parents.some(entry => !entry)) throw new Error('要合并的记忆已不存在');
    const short = parents.filter(entry => entry.lifespan === 'short');
    const source = parents.every(entry => entry.source === parents[0].source) ? parents[0].source : 'mixed';
    const entry = makeEntry({content:values.content ?? parents.map(item => item.content).join('\n\n'),kind:values.kind || parents[0].kind,
      lifespan:short.length ? 'short' : 'long',expiresAt:short.length ? Math.min(...short.map(item => item.expiresAt)) : null,
      source,pinned:parents.some(item => item.pinned),reason:parents.map(item => item.reason).filter(Boolean).join('\n')});
    entry.status = parents.some(item => item.status === 'pending') ? 'pending' : parents.some(item => item.status === 'disabled') ? 'disabled' : 'confirmed';
    entry.provenance = lineage('merge',parents);
    replaceEntries(store,parents,[entry],'merge',`合并 ${parents.length} 条记忆`);
    return entry;
  }

  function split(owner, entryId, parts) {
    const store = ensure(owner), original = store.entries.find(entry => entry.id === entryId);
    if (!original) throw new Error('要拆分的记忆已不存在');
    if (!Array.isArray(parts) || parts.length < 2) throw new Error('请明确填写至少两条拆分内容');
    const entries = parts.map(content => {
      const entry = makeEntry({...original,content});
      entry.status = original.status;
      entry.provenance = lineage('split',[original]);
      return entry;
    });
    return replaceEntries(store,[original],entries,'split',`拆分为 ${entries.length} 条记忆`);
  }

  function addCandidates(owner, candidates) {
    if (!Array.isArray(candidates)) throw new Error('Agent 应返回候选记忆数组');
    const entries = candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('候选记忆格式无效');
      return makeEntry({...candidate,source:'agent'});
    });
    if (!entries.length) return [];
    return replaceEntries(ensure(owner),[],entries,'generate',`Agent 生成 ${entries.length} 条候选记忆`);
  }

  function restoreVersion(owner, entryId, version) {
    const store = ensure(owner), entry = store.entries.find(item => item.id === entryId);
    if (!entry) return null;
    const target = entry.history.find(item => Number(item.version) === Number(version));
    if (!target) return null;
    const before = copy(entry), oldHistory = [...entry.history, snapshot(entry)].slice(-40);
    Object.assign(entry, copy(target), {id:entry.id,history:oldHistory,version:(Number(entry.version)||1)+1,updatedAt:now(),status:'confirmed'});
    record(store,'restore',`恢复到 v${version}`,before,entry,entry.id);
    return entry;
  }

  function restorePrevious(owner, entryId) {
    const store = ensure(owner), entry = store.entries.find(item => item.id === entryId);
    if (!entry?.history?.length) return null;
    return restoreVersion(owner,entryId,entry.history[entry.history.length-1].version);
  }

  function undo(owner) {
    const store = ensure(owner);
    const change = [...store.activity].reverse().find(item => item.undoable !== false && !item.undone);
    if (!change) return null;
    const currentIndex = store.entries.findIndex(item => item.id === change.entryId);
    // Fallback supports activity persisted before compound transactions existed.
    const changes = change.changes || [{before:change.before,after:change.after,beforeIndex:Math.max(0,currentIndex),afterIndex:currentIndex}];
    const affected = new Set(changes.flatMap(item => [item.before?.id,item.after?.id]).filter(Boolean));
    const next = store.entries.filter(entry => !affected.has(entry.id));
    changes.filter(item => item.before).sort((a,b) => a.beforeIndex-b.beforeIndex).forEach(item => next.splice(Math.max(0,item.beforeIndex),0,copy(item.before)));
    store.entries.splice(0,store.entries.length,...next);
    change.undone = true;
    record(store,'undo',`撤销：${change.label}`,change.after,change.before,change.entryId,false,
      changes.map(item => ({before:item.after,after:item.before,beforeIndex:item.afterIndex,afterIndex:item.beforeIndex})));
    return change;
  }

  const expired = entry => entry.lifespan === 'short' && entry.expiresAt && entry.expiresAt <= now();
  const kindLabel = value => KINDS.find(item => item.id === value)?.label || '事实';
  const lifeLabel = value => LIFE.find(item => item.id === value)?.label || '长期记忆';

  function statusMatch(entry, value) {
    if (value === 'all') return true;
    if (value === 'active') return entry.status === 'confirmed' && !expired(entry);
    if (value === 'pending') return entry.status === 'pending';
    if (value === 'pinned') return entry.pinned;
    if (value === 'disabled') return entry.status === 'disabled';
    if (value === 'expired') return expired(entry);
    return true;
  }

  function provenanceLabel(entry) {
    const operation = entry.provenance?.operation;
    return operation === 'merge' ? '合并来源' : operation === 'split' ? '拆分来源' : operation === 'update' ? '用户编辑' : '';
  }

  function card(entry, inherited=false, filter='all', selected=false, showLifespan=filter==='all') {
    const state = expired(entry) ? '已过期' : STATUS[entry.status] || '已确认';
    const actions = inherited ? '' : `<div class="memory-card-actions">
      <button data-memory-action="merge" data-id="${enc(entry.id)}">${selected?'取消合并':'合并'}</button>
      <button data-memory-action="split" data-id="${enc(entry.id)}">拆分</button>
      ${entry.status === 'pending' ? `<button data-memory-action="confirm" data-id="${enc(entry.id)}">确认采用</button>` : ''}
      <button data-memory-action="edit" data-id="${enc(entry.id)}">编辑</button>
      ${entry.history.length ? `<button data-memory-action="restore-previous" data-id="${enc(entry.id)}">复原上版</button>` : ''}
      <button data-memory-action="versions" data-id="${enc(entry.id)}">版本 ${entry.version}</button>
      <button data-memory-action="pin" data-id="${enc(entry.id)}">${entry.pinned?'取消固定':'固定'}</button>
      <button data-memory-action="disable" data-id="${enc(entry.id)}">${entry.status==='disabled'?'启用':'停用'}</button>
      <button class="danger" data-memory-action="delete" data-id="${enc(entry.id)}">删除</button>
    </div>`;
    const search = `${entry.content} ${kindLabel(entry.kind)} ${lifeLabel(entry.lifespan)} ${state}`.toLowerCase();
    return `<article class="memory-card source-${enc(sourceOf(entry))} ${inherited?'inherited':''} ${selected?'selected':''}" data-memory-card data-search="${enc(search)}">
      <div class="memory-card-head"><div class="memory-badges"><span class="memory-status ${entry.status}">${enc(state)}</span>${entry.pinned?'<span class="pinned">已固定</span>':''}</div><small>v${entry.version} · ${enc(dateText(entry.updatedAt))}</small></div>
      <p>${enc(entry.content)}</p>
      ${entry.status === 'pending' && entry.reason ? `<div class="memory-reason">Agent 提议原因：${enc(entry.reason)}</div>` : ''}
      ${showLifespan && entry.lifespan === 'short' && entry.expiresAt ? `<div class="memory-expiry">到期：${enc(dateText(entry.expiresAt))}</div>` : ''}
      ${actions}
      <footer class="memory-card-footer"><span class="memory-source source-${enc(sourceOf(entry))}">${enc(SOURCES[sourceOf(entry)])}${help('memory-source')}</span><span>${help('memory-type')}类型：${enc(kindLabel(entry.kind))}</span>${showLifespan?`<span>${help('memory-lifespan')}${enc(lifeLabel(entry.lifespan))}</span>`:''}${provenanceLabel(entry)?`<span class="memory-provenance">${enc(provenanceLabel(entry))}</span>`:''}${help('memory-review')}</footer>
    </article>`;
  }

  function editor(owner, ui, filter) {
    const store = ensure(owner), existing = ui.editing && ui.editing !== 'new' ? store.entries.find(item => item.id === ui.editing) : null;
    const lifespan = existing?.lifespan || (filter === 'short' ? 'short' : 'long');
    const expiry = lifespan === 'short' ? inputDate(existing?.expiresAt || shortExpiry()) : '';
    return `<form class="memory-editor" id="memory-editor">
      <div class="memory-editor-title"><strong>${existing?'编辑记忆':'新增记忆'}</strong><button type="button" data-memory-action="cancel-editor" aria-label="关闭编辑器">×</button></div>
      <label>内容${help('memory-review')}<textarea name="content" rows="5" required placeholder="写入可验证、可复用的事实、偏好、决策或约束…">${enc(existing?.content || '')}</textarea></label>
      <div class="memory-editor-grid">
        <label>${help('memory-lifespan')}时效<select name="lifespan">${LIFE.map(item=>`<option value="${item.id}" ${item.id===lifespan?'selected':''}>${item.label}</option>`).join('')}</select></label>
        <label>${help('memory-type')}类型<select name="kind">${KINDS.map(item=>`<option value="${item.id}" ${item.id===(existing?.kind||'fact')?'selected':''}>${item.label}</option>`).join('')}</select></label>
      </div>
      <label class="memory-expiry-field" ${lifespan==='short'?'':'hidden'}>到期时间<input type="datetime-local" name="expiresAt" value="${enc(expiry)}"></label>
      <label class="memory-check"><input type="checkbox" name="pinned" ${existing?.pinned?'checked':''}> 固定记忆（提高检索优先级）</label>
      <div class="memory-editor-actions"><button type="button" data-memory-action="cancel-editor">取消</button><button class="primary" type="submit">保存为已确认记忆</button></div>
    </form>`;
  }

  function splitEditor(owner, entryId) {
    const entry = ensure(owner).entries.find(item => item.id === entryId);
    if (!entry) return '';
    return `<form class="memory-editor" id="memory-split-editor" data-id="${enc(entry.id)}">
      <div class="memory-editor-title"><strong>拆分记忆</strong><button type="button" data-memory-action="cancel-split" aria-label="关闭拆分编辑器">×</button></div>
      <p class="memory-editor-note">每行保存为一张独立的待确认或已确认卡片，原卡片可通过撤销恢复。</p>
      <label>拆分内容${help('memory-review')}<textarea name="parts" rows="6" required>${enc(entry.content)}</textarea></label>
      <div class="memory-editor-actions"><button type="button" data-memory-action="cancel-split">取消</button><button class="primary" type="submit">保存拆分</button></div>
    </form>`;
  }

  function generateEditor(ui, options = {}) {
    if (!ui.generating) return '';
    const summary = options.contextSummary || {};
    const label = summary.label || '当前任务可见上下文';
    const detail = summary.detail || '将读取当前任务目标、最近对话、已确认记忆、工作台状态和文件/工具记录。系统规则与权限不会被整理成记忆。';
    return `<form class="memory-generate" id="memory-generate-form">
      <div><strong>让 Agent 整理记忆</strong>${help('memory-review')}<p>Agent 会先整理成互相独立的候选卡片；生成后由你逐条确认，原始对话不变。</p></div>
      <fieldset class="memory-generate-source"><legend>整理来源</legend>
        <label><input type="radio" name="sourceMode" value="context" checked> 当前上下文</label>
        <label><input type="radio" name="sourceMode" value="manual"> 手动输入</label>
      </fieldset>
      <div class="memory-context-source" data-memory-context-source><strong>${enc(label)}</strong><span>${enc(detail)}</span></div>
      <textarea name="text" rows="4" hidden placeholder="粘贴要整理的用户输入或对话片段…"></textarea>
      <div class="memory-editor-actions"><button type="button" data-memory-action="cancel-generate">取消</button><button class="primary" type="submit" data-memory-generate-submit>从当前上下文整理</button></div>
    </form>`;
  }

  function activityView(store) {
    const items = [...store.activity].reverse();
    return `<section class="memory-history-view"><div class="memory-view-heading"><button data-memory-action="back">← 返回记忆</button><strong>修改历史</strong></div>
      ${items.length ? `<ol>${items.map(item=>`<li class="${item.undone?'undone':''}"><div><strong>${enc(item.label)}</strong><small>${enc(dateText(item.time))}${item.undone?' · 已撤销':''}</small></div><p>${enc(item.after?.content || item.before?.content || '结构变更')}</p></li>`).join('')}</ol>` : '<div class="memory-empty">还没有记忆修改记录。</div>'}
    </section>`;
  }

  function versionsView(store, entryId) {
    const entry = store.entries.find(item => item.id === entryId);
    if (!entry) return '<div class="memory-empty">这条记忆已不存在。</div>';
    const versions = [...entry.history].reverse();
    return `<section class="memory-history-view"><div class="memory-view-heading"><button data-memory-action="back">← 返回记忆</button><strong>版本历史</strong></div>
      <article class="memory-version current"><div><strong>当前 v${entry.version}</strong><small>${enc(dateText(entry.updatedAt))}</small></div><p>${enc(entry.content)}</p></article>
      ${versions.length ? versions.map(item=>`<article class="memory-version"><div><strong>v${item.version}</strong><small>${enc(dateText(item.updatedAt))}</small></div><p>${enc(item.content)}</p><button data-memory-action="restore-version" data-id="${enc(entry.id)}" data-version="${item.version}">恢复此版本</button></article>`).join('') : '<div class="memory-empty">尚无更早版本。</div>'}
    </section>`;
  }

  function mount(container, options) {
    const owner = options.owner, project = options.project, store = ensure(owner), ui = options.ui || (options.ui={});
    ui.status ||= 'active';
    ui.kind ||= 'all';
    ui.mode ||= 'list';
    ui.selected ||= [];
    ui.selected = ui.selected.filter(entryId => store.entries.some(entry => entry.id === entryId));
    const filter = ['long','short'].includes(options.filter) ? options.filter : 'all', showLifespan = filter === 'all';
    const title = options.scope === 'project' ? '项目记忆' : '任务记忆';
    const subtitle = `${options.scope === 'project' ? '项目' : '任务'} · ${owner.name}`;
    const ownEntries = store.entries.filter(entry => (filter === 'all' || entry.lifespan === filter) && statusMatch(entry,ui.status) && (ui.kind === 'all' || entry.kind === ui.kind));
    const pendingHidden = store.entries.some(entry => entry.status === 'pending' && !ownEntries.includes(entry));
    const projectStore = options.scope === 'task' && project ? ensure(project) : null;
    const inherited = projectStore ? projectStore.entries.filter(entry => entry.status === 'confirmed' && !expired(entry) && (ui.kind === 'all' || entry.kind === ui.kind)) : [];
    const undoable = [...store.activity].reverse().some(item=>item.undoable !== false && !item.undone);
    const emptyState = `<div class="memory-empty"><strong>此筛选条件下还没有记忆</strong><p>${pendingHidden?'当前筛选隐藏了待确认候选；请在上方状态筛选中选择“待确认”逐条审核。':'空状态是正常的：记忆不会自动把整段对话写入，以免污染后续上下文。你可以手动新增，或让 Agent 提交候选后再确认。'}</p><div class="memory-empty-actions"><button class="memory-empty-action" data-memory-action="generate">✦ Agent 整理记忆</button></div></div>`;
    const mergeLabel = ui.selected.length > 1 ? `合并所选（${ui.selected.length}）` : '合并所选';
    let body = '';
    if (ui.mode === 'activity') body = activityView(store);
    else if (ui.mode === 'versions') body = versionsView(store,ui.versionEntry);
    else body = `${ui.editing ? editor(owner,ui,filter) : ''}${ui.splitEntry ? splitEditor(owner,ui.splitEntry) : ''}
      <div class="memory-list-heading"><strong>${ui.status==='active'?'当前生效':({all:'全部',pending:'待确认',pinned:'已固定',disabled:'已停用',expired:'已过期'}[ui.status]||'记忆')}</strong><span>${ownEntries.length} 条</span></div>
      <div class="memory-list">${ownEntries.length ? ownEntries.map(entry=>card(entry,false,filter,ui.selected.includes(entry.id),showLifespan)).join('') : emptyState}</div>
      ${projectStore ? `<section class="memory-inherited"><div class="memory-list-heading"><strong>继承自项目 · 只读</strong><button data-memory-action="open-project">打开项目记忆</button></div>${inherited.length?inherited.map(entry=>card(entry,true,filter,false,showLifespan)).join(''):'<div class="memory-empty"><strong>当前没有可继承的项目记忆</strong><p>项目记忆为空时，任务不会凭空生成继承内容。</p><button class="memory-empty-action" data-memory-action="open-project">打开项目记忆</button></div>'}</section>` : ''}`;
    container.innerHTML = `<div class="memory-page">
      <header class="memory-page-head"><div><span class="memory-kicker">${enc(subtitle)}</span><h2>${enc(title)}${filter==='all'?'':` · ${enc(lifeLabel(filter))}`}</h2><p>仅把已确认、未过期且与当前请求相关的当前版本按需提供给 Agent。</p></div><div class="memory-count"><strong>${store.entries.length}</strong><span>本地条目</span></div></header>
      <div class="memory-toolbar"><button class="primary" data-memory-action="new">＋ 新增记忆</button><button data-memory-action="generate">✦ Agent 整理记忆</button><button data-memory-action="merge-selected" ${ui.selected.length>1?'':'disabled'}>${mergeLabel}</button><button data-memory-action="undo" ${undoable?'':'disabled'}>↶ 撤销最近变更</button><button data-memory-action="activity">历史记录</button></div>
      <div class="memory-filters" role="group" aria-label="记忆状态筛选">${[['active','生效'],['all','全部'],['pending','待确认'],['pinned','固定'],['disabled','停用'],['expired','过期']].map(([value,label])=>`<button data-memory-action="status" data-value="${value}" class="${ui.status===value?'active':''}">${label}</button>`).join('')}</div>
      <div class="memory-query"><input id="memory-search" type="search" placeholder="搜索当前页面记忆"><select id="memory-kind"><option value="all">全部内容类型</option>${KINDS.map(item=>`<option value="${item.id}" ${ui.kind===item.id?'selected':''}>${item.label}</option>`).join('')}</select></div>
      <div class="memory-content">${generateEditor(ui, options)}${body}</div>
    </div>`;

    const changed = message => {
      options.onChange?.(message);
    };
    container.onclick = event => {
      const button = event.target.closest('[data-memory-action]');
      if (!button) return;
      const action = button.dataset.memoryAction, entryId = button.dataset.id;
      try {
        if (action === 'new') { ui.mode='list'; ui.editing='new'; changed(); }
        else if (action === 'generate') { ui.mode='list'; ui.editing=null; ui.splitEntry=null; ui.generating=true; changed(); }
        else if (action === 'cancel-generate') { ui.generating=false; changed(); }
        else if (action === 'cancel-editor') { ui.editing=null; changed(); }
        else if (action === 'cancel-split') { ui.splitEntry=null; changed(); }
        else if (action === 'status') { ui.status=button.dataset.value; ui.mode='list'; ui.editing=null; changed(); }
        else if (action === 'activity') { ui.mode='activity'; ui.editing=null; changed(); }
        else if (action === 'back') { ui.mode='list'; ui.versionEntry=null; changed(); }
        else if (action === 'versions') { ui.mode='versions'; ui.versionEntry=entryId; ui.editing=null; changed(); }
        else if (action === 'edit') { ui.mode='list'; ui.editing=entryId; changed(); }
        else if (action === 'split') { ui.mode='list'; ui.editing=null; ui.splitEntry=entryId; changed(); }
        else if (action === 'merge') {
          ui.selected = ui.selected.includes(entryId) ? ui.selected.filter(id => id !== entryId) : [...ui.selected,entryId];
          changed();
        }
        else if (action === 'merge-selected') {
          if (ui.selected.length < 2) throw new Error('请选择至少两条记忆后再合并');
          merge(owner,ui.selected); ui.selected=[]; changed('记忆已合并，可用“撤销最近变更”恢复');
        }
        else if (action === 'confirm') { update(owner,entryId,{status:'confirmed'},'确认记忆'); changed('记忆已确认并可参与检索'); }
        else if (action === 'pin') { const entry=store.entries.find(item=>item.id===entryId); if(entry) update(owner,entryId,{pinned:!entry.pinned,confirmUserEdit:false},entry.pinned?'取消固定':'固定记忆'); changed(); }
        else if (action === 'disable') { const entry=store.entries.find(item=>item.id===entryId); if(entry) update(owner,entryId,{status:entry.status==='disabled'?'confirmed':'disabled',confirmUserEdit:false},entry.status==='disabled'?'启用记忆':'停用记忆'); changed(); }
        else if (action === 'restore-previous') { restorePrevious(owner,entryId); changed('已复原到最近一次版本'); }
        else if (action === 'restore-version') { restoreVersion(owner,entryId,Number(button.dataset.version)); ui.mode='list'; changed(`已恢复到 v${button.dataset.version}`); }
        else if (action === 'delete') { remove(owner,entryId); changed('记忆已删除，可用“撤销最近变更”恢复'); }
        else if (action === 'undo') { const result=undo(owner); changed(result?`已${result.label}`:'没有可撤销的记忆变更'); }
        else if (action === 'open-project') options.onOpenProject?.();
      } catch (error) { options.onError?.(error.message); }
    };
    container.onchange = event => {
      if (event.target.id === 'memory-kind') { ui.kind=event.target.value; changed(); }
      if (event.target.name === 'lifespan') {
        const field=container.querySelector('.memory-expiry-field');
        if(field) field.hidden=event.target.value!=='short';
      }
      if (event.target.name === 'sourceMode') {
        const manual = event.target.value === 'manual';
        const textarea = container.querySelector('#memory-generate-form textarea[name="text"]');
        const submit = container.querySelector('[data-memory-generate-submit]');
        if (textarea) { textarea.hidden = !manual; textarea.required = manual; }
        if (submit) submit.textContent = manual ? '生成待确认候选' : '从当前上下文整理';
      }
    };
    container.oninput = event => {
      if (event.target.id !== 'memory-search') return;
      const query=event.target.value.trim().toLowerCase();
      container.querySelectorAll('[data-memory-card]').forEach(node=>node.hidden=query&&!node.dataset.search.includes(query));
    };
    container.onsubmit = async event => {
      if (event.target.id === 'memory-generate-form') {
        event.preventDefault();
        const formData = new FormData(event.target);
        const sourceMode = String(formData.get('sourceMode') || 'manual');
        const text = String(formData.get('text') ?? '');
        const request = sourceMode === 'context' ? {mode:'context'} : text;
        const submit=event.target.querySelector?.('[type="submit"]');
        if(ui.generationBusy)return;
        ui.generationBusy=true;if(submit){submit.disabled=true;submit.textContent='正在整理…';}
        try {
          if (typeof options.onGenerate !== 'function') throw new Error('当前未连接 Agent 记忆整理回调');
          const result = await options.onGenerate(request);
          const candidates = Array.isArray(result) ? result : result?.candidates;
          if (candidates) addCandidates(owner,candidates);
          ui.generating=false;
          ui.status='pending';
          changed(candidates?.length ? `Agent 生成了 ${candidates.length} 条待确认候选` : 'Agent 已收到整理请求');
        } catch (error) { options.onError?.(error.message); }
        finally {ui.generationBusy=false;if(submit){submit.disabled=false;submit.textContent='生成待确认候选';}}
        return;
      }
      if (event.target.id === 'memory-split-editor') {
        event.preventDefault();
        try {
          const parts = String(new FormData(event.target).get('parts') || '').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
          split(owner,event.target.dataset.id,parts); ui.splitEntry=null; changed(`已拆分为 ${parts.length} 条记忆`);
        } catch (error) { options.onError?.(error.message); }
        return;
      }
      if (event.target.id !== 'memory-editor') return;
      event.preventDefault();
      const form = new FormData(event.target), lifespan=form.get('lifespan'), expiry=form.get('expiresAt');
      const values={content:form.get('content'),lifespan,kind:form.get('kind'),pinned:form.get('pinned')==='on',expiresAt:lifespan==='short'?(expiry?new Date(String(expiry)).getTime():shortExpiry()):null};
      try {
        if (ui.editing && ui.editing !== 'new') update(owner,ui.editing,values,'编辑记忆');
        else create(owner,values);
        ui.editing=null;
        changed('记忆已保存为已确认状态');
      } catch (error) { options.onError?.(error.message); }
    };
  }

  function words(text) {
    const value=String(text||'').toLowerCase(), found=new Set(value.match(/[a-z0-9_\-.]{2,}|[\u4e00-\u9fff]{2,}/g)||[]);
    for (const sequence of value.match(/[\u4e00-\u9fff]{2,}/g)||[]) for(let index=0;index<sequence.length-1;index++) found.add(sequence.slice(index,index+2));
    return found;
  }

  function buildCapsule(project, task, input, limits={}) {
    const query=words(input), maxItems=Math.max(1,Number(limits.maxItems)||6), maxChars=Math.max(400,Number(limits.maxChars)||2400);
    const candidates=[];
    const collect=(owner,scope)=>ensure(owner).entries.forEach(entry=>{
      if(entry.status!=='confirmed'||expired(entry))return;
      const tokens=words(entry.content);let overlap=0;for(const token of tokens)if(query.has(token))overlap++;
      let score=overlap*12+(scope==='task'?5:0)+(entry.pinned?60:0)+({core:50,correction:32,continuation:28,preference:10,decision:8,constraint:14}[entry.kind]||0)+(entry.lifespan==='long'?2:0);
      score+=Math.max(0,3-(now()-entry.updatedAt)/(30*24*60*60*1000));
      const always=entry.pinned||entry.kind==='core'||(scope==='task'&&entry.kind==='continuation');
      if(always||overlap>0)candidates.push({entry,scope,score});
    });
    if(project)collect(project,'project');
    if(task)collect(task,'task');
    candidates.sort((a,b)=>b.score-a.score||b.entry.updatedAt-a.entry.updatedAt);
    const items=[];let used=0;
    for(const {entry,scope} of candidates){
      if(items.length>=maxItems)break;
      const remaining=maxChars-used;if(remaining<80)break;
      const content=entry.content.slice(0,Math.min(700,remaining));
      items.push({id:entry.id,scope,kind:entry.kind,lifespan:entry.lifespan,content,version:entry.version});
      used+=content.length;
    }
    const totalEligible=[...(project?ensure(project).entries:[]),...(task?ensure(task).entries:[])].filter(entry=>entry.status==='confirmed'&&!expired(entry)).length;
    return {items,totalEligible,selected:items.length,truncated:candidates.length>items.length,charBudget:maxChars};
  }

  window.PiMemoryManager = {LIFE,KINDS,SOURCES,ensure,create,update,remove,merge,split,addCandidates,restorePrevious,restoreVersion,undo,mount,buildCapsule,isExpired:expired};
})();
