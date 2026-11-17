'use strict';
(() => {
  const icons = {
    select:'m5 3 14 9-7 1-3 7Z', hand:'M8 12V6a2 2 0 0 1 4 0v5-7 0m3 1V4a2 2 0 0 1 4 0v7m0-4a2 2 0 0 1 4 0v5m0-3a2 2 0 0 1 4 0v7c0 4-3 6-6 6h-2c-2 0-4-1-5-3l-4-6a2 2 0 0 1 3-2l2 2',
    undo:'M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12', redo:'m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12',
    minus:'M5 12h14', plus:'M5 12h14M12 5v14', fit:'M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6', layers:'m12 3 10 5-10 5L2 8Zm-10 10 10 5 10-5M2 18l10 5 10-5', parent:'M5 19V5h14M5 5l8 8', reset:'M4 10a8 8 0 1 1 0 5M4 4v6h6'
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+icons[name]+'"/></svg>';
  const clone = x => structuredClone(x);
  const clamp = (x,min,max) => Math.min(max,Math.max(min,x));
  const round = x => Math.round(x*100)/100;
  const ignored = new Set(['SCRIPT','STYLE','LINK','META','TITLE','HEAD','NOSCRIPT','OPTION','BR']);
  window.PiWorkbenchLayout = ({host,key,mode,data,persist,notify,rootNode=false}) => {
    const editing = mode === 'edit' || mode === 'design';
    let layout = {revision:0,order:[],titles:{},nodes:{},...(data?._layout||{})};
    layout.nodes ||= {};
    let manual=false,tool='select',selected=null,selection=new Set(),gesture=null,space=false,undo=[],redo=[],disposed=false,refreshQueued=false;
    let nodes=new Map(),observers=[],frameListeners=new Map(),originalStyles=new WeakMap(),appliedGeometry=new WeakMap();
    let layersDirty=true,layerButtons=new Map(),layerSelection=new Set(),motionFrame=null,pendingMotion=null;
    const view={x:24,y:24,zoom:1};
    let viewport=null,toolbar=null,shield=null,outline=null,inspector=null,layers=null,selectionMarks=null,marquee=null,menu=null;
    const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.id || el.textContent?.trim().replace(/\s+/g,' ').slice(0,38) || el.tagName.toLowerCase());
    function visible(el) { const r=el.getBoundingClientRect();const s=el.ownerDocument.defaultView.getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; }
    function screenRect(el) {
      let r=el.getBoundingClientRect(), out={left:r.left,top:r.top,width:r.width,height:r.height};
      let doc=el.ownerDocument;
      while(doc!==document) {
        const f=doc.defaultView?.frameElement;if(!f)break;
        const fr=f.getBoundingClientRect(),sx=fr.width/(f.offsetWidth||fr.width),sy=fr.height/(f.offsetHeight||fr.height);
        out={left:fr.left+(f.clientLeft+out.left)*sx,top:fr.top+(f.clientTop+out.top)*sy,width:out.width*sx,height:out.height*sy};doc=f.ownerDocument;
      }
      return out;
    }
    function localSize(el) {const r=screenRect(el);return {width:round(r.width/(editing?view.zoom:1)),height:round(r.height/(editing?view.zoom:1))};}
    function rememberStyle(el) {if(!originalStyles.has(el))originalStyles.set(el,Object.fromEntries(['translate','width','height','box-sizing','min-width','min-height','max-width','max-height','z-index','position','display','margin-left','margin-top'].map(p=>[p,[el.style.getPropertyValue(p),el.style.getPropertyPriority(p)]])));}
    function restoreStyle(el) {const s=originalStyles.get(el);if(!s)return;for(const [p,[v,priority]] of Object.entries(s)){if(v)el.style.setProperty(p,v,priority);else el.style.removeProperty(p);}}
    function applyNode(node,geometry) {
      const el=node.element,signature=geometry?JSON.stringify(geometry):'';
      if((appliedGeometry.get(el)||'')===signature)return;
      rememberStyle(el);restoreStyle(el);appliedGeometry.set(el,signature);
      if(!geometry)return;
      if(node.root){
        // 根节点的 transform 被画布缩放占用，所以位置用 margin、尺寸用 width/height 表达。
        el.style.setProperty('margin-left',(geometry.x||0)+'px','important');el.style.setProperty('margin-top',(geometry.y||0)+'px','important');
        if(geometry.width!==undefined){el.style.setProperty('width',geometry.width+'px','important');el.style.setProperty('box-sizing','border-box','important');}
        if(geometry.height!==undefined){el.style.setProperty('min-height',geometry.height+'px','important');el.style.setProperty('height',geometry.height+'px','important');}
        return;
      }
      if(geometry.x||geometry.y) {
        const base=el.ownerDocument.defaultView.getComputedStyle(el).translate;
        const parts=base==='none'?['0px','0px']:base.split(/\s+/);
        el.style.setProperty('translate',`calc(${parts[0]} + ${geometry.x||0}px) calc(${parts[1]||'0px'} + ${geometry.y||0}px)`,'important');
      }
      if(geometry.width!==undefined||geometry.height!==undefined) {
        if(el.ownerDocument.defaultView.getComputedStyle(el).display==='inline')el.style.setProperty('display','inline-block');
        el.style.setProperty('box-sizing','border-box','important');
        for(const axis of ['width','height'])if(geometry[axis]!==undefined){el.style.setProperty(axis,geometry[axis]+'px','important');el.style.setProperty('min-'+axis,'0px','important');el.style.setProperty('max-'+axis,'none','important');}
      }
      if(geometry.zIndex!==undefined){if(el.ownerDocument.defaultView.getComputedStyle(el).position==='static')el.style.setProperty('position','relative');el.style.setProperty('z-index',String(geometry.zIndex));}
    }
    function queueRefresh() {if(disposed||refreshQueued)return;refreshQueued=true;requestAnimationFrame(()=>{refreshQueued=false;if(!disposed)scan();});}
    function scan() {
      observers.forEach(o=>o.disconnect());observers=[];
      const next=new Map(),seenFrames=new Set();
      function walk(root,prefix,parentId=null,depth=0) {
        [...root.children].forEach((el,index)=>{
          if(ignored.has(el.tagName)||el.dataset.piEditor!==undefined)return;
          const identity=el.getAttribute('data-design-id')||el.id||el.getAttribute('data-cell')||el.getAttribute('data-gate-id');
          const part=identity?el.tagName.toLowerCase()+'#'+encodeURIComponent(identity):el.tagName.toLowerCase()+'['+index+']';
          const id=el.dataset.piNodeId||(prefix+'/'+part);el.dataset.piNodeId=id;
          const node={id,element:el,parentId,depth};next.set(id,node);applyNode(node,layout.nodes[id]);
          if(el.tagName==='IFRAME') {
            seenFrames.add(el);
            if(!frameListeners.has(el)){const listener=()=>queueRefresh();frameListeners.set(el,listener);el.addEventListener('load',listener);}
            try {const body=el.contentDocument?.body;if(body){walk(body,id+'/document',id,depth+1);watch(body);}}catch{/* Cross-origin pages remain an explicit opaque surface. */}
          }
          walk(el,id,id,depth+1);
        });
      }
      function watch(root) {const o=new MutationObserver(queueRefresh);o.observe(root,{childList:true,subtree:true});observers.push(o);}
      // Preserve layouts saved by the previous section-order editor.
      const cards=[...host.querySelectorAll('.module > .module-card')];
      const legacy=new Map(cards.map(el=>[el.dataset.layoutId||key+':'+(el.querySelector('h3')?.textContent.trim()||''),el]));
      for(const id of layout.order||[]) {const el=legacy.get(id);if(el){el.dataset.layoutId=id;el.parentElement.append(el);}}
      for(const [id,title] of Object.entries(layout.titles||{})){const h=legacy.get(id)?.querySelector('h3');if(h)h.textContent=title;}
      // 页面最底层（宿主容器本身）也是可编辑元素：拖动、缩放整个页面背景。
      if(rootNode){const rid=key+'/page';host.dataset.piNodeId=rid;const node={id:rid,element:host,parentId:null,depth:0,root:true};next.set(rid,node);applyNode(node,layout.nodes[rid]);}
      walk(host,key,rootNode?key+'/page':null,rootNode?1:0);watch(host);nodes=next;layersDirty=true;
      for(const [f,listener] of frameListeners)if(!seenFrames.has(f)){f.removeEventListener('load',listener);frameListeners.delete(f);}
      selection=new Set([...selection].filter(id=>nodes.has(id)));
      if(!selection.has(selected))selected=[...selection].at(-1)||null;
      if(editing){updateView();updateUI();}
    }
    function write() {persist({_layout:clone(layout)});}
    function commit(next,record=true) {
      if(record){undo.push(clone(layout));undo=undo.slice(-60);redo=[];}
      const previous=layout;
      layout={...next,revision:layout.revision+1,canvasWidth:layout.canvasWidth||host.offsetWidth};
      // Geometry edits do not change the DOM tree or layer identities.
      if(JSON.stringify(previous.order)!==JSON.stringify(layout.order)||JSON.stringify(previous.titles)!==JSON.stringify(layout.titles))scan();
      else{for(const id of new Set([...Object.keys(previous.nodes),...Object.keys(layout.nodes)])){const node=nodes.get(id);if(node)applyNode(node,layout.nodes[id]);}updateUI();}
      write();
    }
    function geometry(id) {return {...(layout.nodes[id]||{x:0,y:0})};}
    function select(id,additive=false) {
      const next=additive?new Set(selection):new Set();
      if(nodes.has(id)){if(additive&&next.has(id))next.delete(id);else next.add(id);}
      setSelection(next);
    }
    function setSelection(ids) {const next=new Set([...ids].filter(id=>nodes.has(id)));if(next.size===selection.size&&[...next].every(id=>selection.has(id)))return;selection=next;selected=[...selection].at(-1)||null;updateUI();}
    function selectedRoots() {
      return [...selection].map(id=>nodes.get(id)).filter(n=>{
        for(let p=nodes.get(n.parentId);p;p=nodes.get(p.parentId))if(selection.has(p.id))return false;
        return true;
      });
    }
    function bounds(items=selectedRoots()) {
      const rects=items.filter(n=>visible(n.element)).map(n=>screenRect(n.element));if(!rects.length)return null;
      const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top));
      return {left,top,width:Math.max(...rects.map(r=>r.left+r.width))-left,height:Math.max(...rects.map(r=>r.top+r.height))-top};
    }
    function snapshotSelection() {return selectedRoots().filter(node=>visible(node.element)).map(node=>({node,base:geometry(node.id),size:localSize(node.element),rect:screenRect(node.element)}));}
    function applyPatches(patches,save=false) {
      if(save){const next=clone(layout);for(const [id,patch] of patches)next.nodes[id]={...geometry(id),...patch};commit(next);}
      else {for(const [id,patch] of patches){const node=nodes.get(id);if(node)applyNode(node,patch);}updateOutline();}
    }
    function moveSelection(dx,dy) {const patches=new Map(selectedRoots().map(n=>{const g=geometry(n.id);return [n.id,{...g,x:round((g.x||0)+dx),y:round((g.y||0)+dy)}];}));if(patches.size)applyPatches(patches,true);}
    function transformPatches(items,box,target) {
      const sx=target.width/box.width,sy=target.height/box.height;
      return new Map(items.map(({node,base,size,rect})=>[node.id,{...base,
        x:round((base.x||0)+(target.left-box.left+(rect.left-box.left)*(sx-1))/view.zoom),
        y:round((base.y||0)+(target.top-box.top+(rect.top-box.top)*(sy-1))/view.zoom),
        width:round(Math.max(8,size.width*sx)),height:round(Math.max(8,size.height*sy))}]));
    }
    function editSelection(p,value) {
      if(selection.size===1){setGeometry(selected,{[p]:value});return;}
      const items=snapshotSelection(),box=bounds();if(!box)return;
      if(p==='x'||p==='y'){
        const hostRect=screenRect(host),current=(p==='x'?box.left-hostRect.left:box.top-hostRect.top)/view.zoom;
        moveSelection(p==='x'?value-current:0,p==='y'?value-current:0);return;
      }
      applyPatches(transformPatches(items,box,{...box,[p]:value*view.zoom}),true);
    }
    function setGeometry(id,patch) {const next=clone(layout);next.nodes[id]={...geometry(id),...patch};commit(next);}
    function updateView() {
      if(!editing)return;
      host.style.transform=`translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
      toolbar.querySelector('[data-design="zoom-value"]').textContent=Math.round(view.zoom*100)+'%';
      updateOutline();
    }
    function updateOutline() {
      if(!editing)return;
      const box=bounds(),v=viewport.getBoundingClientRect(),rects=manual&&selection.size>1?[...selection].map(id=>nodes.get(id)).filter(n=>n&&visible(n.element)).map(n=>screenRect(n.element)):[];
      outline.hidden=!manual||!box;
      const fragment=document.createDocumentFragment();
      for(const r of rects){const mark=document.createElement('div');mark.className='design-selection-mark';Object.assign(mark.style,{left:r.left-v.left+'px',top:r.top-v.top+'px',width:r.width+'px',height:r.height+'px'});fragment.append(mark);}
      selectionMarks.replaceChildren(fragment);
      if(outline.hidden)return;
      const r=box;
      Object.assign(outline.style,{left:r.left-v.left+'px',top:r.top-v.top+'px',width:r.width+'px',height:r.height+'px'});
      outline.querySelector('.design-selection-label').textContent=selection.size>1?'已选 '+selection.size+' 个控件':label(nodes.get(selected).element);
    }
    function updateUI() {
      if(!editing)return;
      toolbar.querySelector('[role="switch"]').setAttribute('aria-checked',String(manual));
      toolbar.querySelector('[role="switch"]').title=manual?'切换为冻结（禁止修改布局）':'切换为手动（编辑布局）';
      viewport.classList.toggle('design-manual',manual);viewport.classList.toggle('design-hand',tool==='hand'||space);
      shield.style.pointerEvents=manual||tool==='hand'||space?'auto':'none';
      for(const t of ['select','hand'])toolbar.querySelector('[data-design="'+t+'"]').setAttribute('aria-pressed',String(tool===t));
      toolbar.querySelector('[data-design="undo"]').disabled=!manual||!undo.length;
      toolbar.querySelector('[data-design="redo"]').disabled=!manual||!redo.length;
      toolbar.querySelector('[data-design="layers"]').disabled=false;
      // 手动模式预留检查栏，选择数量变化时不挤动画布，否则框选坐标会在拖动途中漂移。
      const n=nodes.get(selected);inspector.hidden=!manual;
      for(const input of inspector.querySelectorAll('input')){input.disabled=!n;if(!n)input.value='';}
      inspector.querySelector('[data-design="parent"]').disabled=!n||selection.size>1;
      inspector.querySelector('[data-design="reset"]').disabled=!n;
      if(!n)inspector.querySelector('.design-selected-name').textContent='选择控件 · 支持 Shift/Ctrl 多选、空白处框选';
      if(n){const b=bounds(),h=screenRect(host),g=selection.size>1&&b?{x:round((b.left-h.left)/view.zoom),y:round((b.top-h.top)/view.zoom),width:round(b.width/view.zoom),height:round(b.height/view.zoom)}:geometry(selected),s=localSize(n.element);for(const p of ['x','y','width','height']){const input=inspector.querySelector('[name="'+p+'"]');if(document.activeElement!==input)input.value=g[p]??(s[p]||0);}inspector.querySelector('.design-selected-name').textContent=selection.size>1?'已选 '+selection.size+' 个控件 · 整体位置与尺寸':label(n.element);}
      toolbar.querySelector('.design-status').textContent=(manual?'Shift/Ctrl 点选 · 空白处框选 · 右键更多':'布局冻结，控件可正常使用')+' · 中键平移 · Shift＋滚轮缩放 · r'+layout.revision;
      toolbar.querySelector('[data-design="layers"]').setAttribute('aria-pressed',String(!layers.hidden));
      if(!layers.hidden)renderLayers();
      updateOutline();
    }
    function renderLayers() {
      if(layersDirty){
        const list=layers.querySelector('.design-layer-list'),scrollTop=list.scrollTop,fragment=document.createDocumentFragment();layerButtons=new Map();
        // Read visibility before attaching the list, avoiding read/write layout loops.
        for(const n of nodes.values()){
          const button=document.createElement('button');button.type='button';button.dataset.node=n.id;button.title=n.id;button.className='design-layer';button.setAttribute('aria-pressed','false');button.style.paddingLeft=12+Math.min(n.depth,12)*12+'px';
          button.textContent=n.element.tagName.toLowerCase()+' · '+label(n.element)+(visible(n.element)?'':'（隐藏）');fragment.append(button);layerButtons.set(n.id,button);
        }
        list.replaceChildren(fragment);list.scrollTop=scrollTop;layersDirty=false;layerSelection=new Set();
      }
      for(const id of new Set([...layerSelection,...selection])){const button=layerButtons.get(id);if(button){button.classList.toggle('selected',selection.has(id));button.setAttribute('aria-pressed',String(selection.has(id)));}}
      layerSelection=new Set(selection);
    }
    function zoom(next,point) {
      const z=clamp(next,.15,4),v=viewport.getBoundingClientRect(),cx=(point?.x??v.left+v.width/2)-v.left,cy=(point?.y??v.top+v.height/2)-v.top;
      view.x=cx-(cx-view.x)*z/view.zoom;view.y=cy-(cy-view.y)*z/view.zoom;view.zoom=z;updateView();
    }
    function hit(doc,x,y) {
      const wasHidden=shield.hidden;shield.hidden=true;
      const all=doc.elementsFromPoint(x,y);
      const el=all.find(e=>e!==shield&&e!==outline&&!e.closest('[data-pi-editor]')&&(e.tagName==='IFRAME'||e.dataset.piNodeId)&&(doc!==document||host.contains(e)||(rootNode&&e===host)));
      shield.hidden=wasHidden;
      if(!el)return null;
      if(el.tagName==='IFRAME')try{if(el.contentDocument?.body){const r=el.getBoundingClientRect(),sx=r.width/el.offsetWidth,sy=r.height/el.offsetHeight;const inner=hit(el.contentDocument,(x-r.left)/sx-el.clientLeft,(y-r.top)/sy-el.clientTop);if(inner)return inner;}}catch{}
      return nodes.get(el.dataset.piNodeId)||null;
    }
    function clearMotion(){if(motionFrame!==null)cancelAnimationFrame(motionFrame);motionFrame=null;pendingMotion=null;}
    function cancelGesture() {clearMotion();if(!gesture)return;const g=gesture;gesture=null;for(const item of g.items||[])applyNode(item.node,layout.nodes[item.node.id]);if(g.marquee)setSelection(g.before);marquee.hidden=true;try{viewport.releasePointerCapture(g.pointerId);}catch{}updateOutline();}
    function freeze() {cancelGesture();manual=false;if(menu)menu.hidden=true;updateUI();}
    function showMenu(x,y) {
      const commands=[['select-all','全选控件','Ctrl+A'],['deselect','取消选择','Esc'],['layers','图层面板',''],['align-left','左对齐',''],['align-center','水平居中',''],['align-right','右对齐',''],['align-top','顶端对齐',''],['align-middle','垂直居中',''],['align-bottom','底端对齐',''],['reset','重置所选布局',''],['undo','撤销','Ctrl+Z'],['redo','重做','Ctrl+Shift+Z']];
      menu.replaceChildren();
      const title=document.createElement('div');title.className='design-menu-heading';title.textContent=selection.size?'已选 '+selection.size+' 个控件':'选择控件';menu.append(title);
      for(const [action,text,shortcut] of commands){const b=document.createElement('button');b.type='button';b.dataset.design=action;b.setAttribute('role','menuitem');const name=document.createElement('span');name.textContent=text;b.append(name);const hint=document.createElement('small');hint.textContent=shortcut;b.append(hint);b.disabled=action.startsWith('align-')?selectedRoots().length<2:action==='reset'||action==='deselect'?!selection.size:action==='undo'?!undo.length:action==='redo'?!redo.length:false;menu.append(b);}
      menu.hidden=false;const v=viewport.getBoundingClientRect();menu.style.left=clamp(x-v.left,0,Math.max(0,v.width-menu.offsetWidth))+'px';menu.style.top=clamp(y-v.top,0,Math.max(0,v.height-menu.offsetHeight))+'px';menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
    }
    function down(event) {
      // Editor overlays own their input; never hit-test the artboard beneath them.
      if(layers.contains(event.target)||menu.contains(event.target))return;
      if(event.button!==0&&event.button!==1&&event.button!==2)return;
      const pan=event.button===1||tool==='hand'||space;
      if(!pan&&!manual)return;
      event.preventDefault();event.stopPropagation();
      menu.hidden=true;viewport.focus({preventScroll:true});
      const additive=event.shiftKey||event.ctrlKey||event.metaKey;
      if(event.button===2){const n=event.target.closest('[data-node]')?nodes.get(event.target.closest('[data-node]').dataset.node):hit(document,event.clientX,event.clientY);if(n&&!selection.has(n.id))select(n.id,additive);showMenu(event.clientX,event.clientY);return;}
      const handle=event.target.closest('[data-handle]')?.dataset.handle;
      const n=handle?nodes.get(selected):hit(document,event.clientX,event.clientY);
      const before=new Set(selection);
      const boxSelect=!pan&&!handle&&(event.altKey||!n||(!selection.has(n.id)&&(n.root||n.element.children.length>0)));
      if(!pan&&!boxSelect&&!handle){
        if(additive){select(n?.id,true);return;}
        if(!selection.has(n?.id))select(n?.id);
      }
      if(boxSelect&&!additive)setSelection([]);
      gesture={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,pan,marquee:boxSelect,additive,before,handle,startView:{...view},items:pan||boxSelect?[]:snapshotSelection(),box:bounds(),patches:null};
      if(boxSelect)gesture.candidates=[...nodes.values()].filter(n=>!n.root&&visible(n.element)).map(n=>({id:n.id,rect:screenRect(n.element)}));
      viewport.setPointerCapture(event.pointerId);
    }
    function queueMove(event){
      if(!gesture||event.pointerId!==gesture.pointerId)return;
      event.preventDefault();pendingMotion=event;
      if(motionFrame===null)motionFrame=requestAnimationFrame(()=>{const next=pendingMotion;motionFrame=null;pendingMotion=null;if(next&&!disposed)move(next);});
    }
    function move(event) {
      const g=gesture;if(!g||event.pointerId!==g.pointerId)return;
      event.preventDefault();const dx=(event.clientX-g.startX)/view.zoom,dy=(event.clientY-g.startY)/view.zoom;
      if(g.pan){view.x=g.startView.x+event.clientX-g.startX;view.y=g.startView.y+event.clientY-g.startY;updateView();return;}
      if(g.marquee){
        const left=Math.min(g.startX,event.clientX),top=Math.min(g.startY,event.clientY),right=Math.max(g.startX,event.clientX),bottom=Math.max(g.startY,event.clientY),v=viewport.getBoundingClientRect();
        marquee.hidden=false;Object.assign(marquee.style,{left:left-v.left+'px',top:top-v.top+'px',width:right-left+'px',height:bottom-top+'px'});
        const next=g.additive?new Set(g.before):new Set();
        if(right-left>3||bottom-top>3)for(const {id,rect:r} of g.candidates){if(r.left>=left&&r.top>=top&&r.left+r.width<=right&&r.top+r.height<=bottom)next.add(id);}
        setSelection(next);return;
      }
      if(!g.box)return;
      if(Math.hypot(event.clientX-g.startX,event.clientY-g.startY)<2&&!g.patches)return;
      if(g.handle){
        const target={...g.box},mx=dx*view.zoom,my=dy*view.zoom,minW=Math.max(...g.items.map(i=>8/i.size.width))*g.box.width,minH=Math.max(...g.items.map(i=>8/i.size.height))*g.box.height;
        const west=g.handle.includes('w'),north=g.handle.includes('n');
        if(g.handle.includes('e'))target.width=Math.max(minW,g.box.width+mx);
        if(g.handle.includes('s'))target.height=Math.max(minH,g.box.height+my);
        if(west)target.width=Math.max(minW,g.box.width-mx);
        if(north)target.height=Math.max(minH,g.box.height-my);
        if(event.shiftKey){const scale=g.handle==='n'||g.handle==='s'?target.height/g.box.height:target.width/g.box.width;const safe=Math.max(scale,minW/g.box.width,minH/g.box.height);target.width=g.box.width*safe;target.height=g.box.height*safe;}
        if(west)target.left=g.box.left+g.box.width-target.width;
        if(north)target.top=g.box.top+g.box.height-target.height;
        g.patches=transformPatches(g.items,g.box,target);
      }else g.patches=new Map(g.items.map(({node,base})=>[node.id,{...base,x:round((base.x||0)+dx),y:round((base.y||0)+dy)}]));
      applyPatches(g.patches);
    }
    function up(event) {const g=gesture;if(!g||event.pointerId!==g.pointerId)return;clearMotion();move(event);gesture=null;marquee.hidden=true;try{viewport.releasePointerCapture(g.pointerId);}catch{}if(g.patches)applyPatches(g.patches,true);else updateUI();}
    function command(action) {
      menu.hidden=true;
      if(action==='toggle'){cancelGesture();manual=!manual;tool='select';updateUI();return;}
      if(action==='select'||action==='hand'){tool=action;updateUI();return;}
      if(action==='zoom-in'||action==='zoom-out'){zoom(view.zoom*(action==='zoom-in'?1.2:1/1.2));return;}
      if(action==='zoom-value'){view.zoom=1;view.x=view.y=24;updateView();return;}
      if(action==='fit'){view.zoom=clamp(Math.min((viewport.clientWidth-48)/host.offsetWidth,(viewport.clientHeight-48)/host.scrollHeight),.15,1);view.x=view.y=24;updateView();return;}
      if(action==='layers'){layers.hidden=!layers.hidden;updateUI();return;}
      if(!manual)return;
      if(action==='select-all'){setSelection([...nodes.values()].filter(n=>!n.root&&visible(n.element)).map(n=>n.id));return;}
      if(action==='deselect'){select(null);return;}
      if(action.startsWith('align-')){
        const box=bounds(),items=snapshotSelection();if(!box||items.length<2)return;
        const patches=new Map(items.map(({node,base,rect})=>{let dx=0,dy=0;
          if(action==='align-left')dx=box.left-rect.left;if(action==='align-right')dx=box.left+box.width-rect.left-rect.width;if(action==='align-center')dx=box.left+(box.width-rect.width)/2-rect.left;
          if(action==='align-top')dy=box.top-rect.top;if(action==='align-bottom')dy=box.top+box.height-rect.top-rect.height;if(action==='align-middle')dy=box.top+(box.height-rect.height)/2-rect.top;
          return [node.id,{...base,x:round((base.x||0)+dx/view.zoom),y:round((base.y||0)+dy/view.zoom)}];}));applyPatches(patches,true);return;
      }
      if(action==='parent'){select(nodes.get(selected)?.parentId);return;}
      if(action==='reset'&&selection.size){const next=clone(layout);for(const id of selection)delete next.nodes[id];commit(next);return;}
      if(action==='undo'&&undo.length){cancelGesture();redo.push(clone(layout));commit(undo.pop(),false);return;}
      if(action==='redo'&&redo.length){cancelGesture();undo.push(clone(layout));commit(redo.pop(),false);}
    }
    const keydown=event=>{
      if(!editing||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.target.isContentEditable)return;
      if(menu&&!menu.hidden&&['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length]?.focus();return;}
      if(event.code==='Space'){space=true;event.preventDefault();updateUI();}
      if(event.key==='Escape'){if(!menu.hidden){menu.hidden=true;viewport.focus();return;}if(gesture){cancelGesture();return;}select(null);layers.hidden=true;updateUI();}
      if(manual&&(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();command('select-all');}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();command(event.shiftKey?'redo':'undo');}
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();command('redo');}
      if(!event.ctrlKey&&!event.metaKey&&event.key.toLowerCase()==='h')command('hand');
      if(!event.ctrlKey&&!event.metaKey&&event.key.toLowerCase()==='v')command('select');
      if(manual&&selection.size&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const d=event.shiftKey?10:1;moveSelection(event.key==='ArrowLeft'?-d:event.key==='ArrowRight'?d:0,event.key==='ArrowUp'?-d:event.key==='ArrowDown'?d:0);}
    };
    const keyup=event=>{if(event.code==='Space'){space=false;updateUI();}};
    if(editing) {
      document.body.classList.add('design-document');
      toolbar=document.createElement('section');toolbar.className='design-toolbar';toolbar.dataset.piEditor='';
      const button=(action,title,symbol)=>'<button type="button" class="design-icon" data-design="'+action+'" title="'+title+'" aria-label="'+title+'">'+icon(symbol)+'</button>';
      toolbar.innerHTML='<div class="design-toolbar-row"><span class="design-title">布局设计</span><button class="design-mode-switch" data-design="toggle" type="button" role="switch" aria-label="手动布局" aria-checked="false"><i></i><span>冻结</span><span>手动</span></button><span class="design-spacer"></span>'+button('undo','撤销 · Ctrl+Z','undo')+button('redo','重做 · Ctrl+Shift+Z','redo')+'</div><div class="design-toolbar-row"><div class="design-tool-group">'+button('select','选择 / 拖动 · V','select')+button('hand','抓手 · H / 按住中键','hand')+button('layers','图层与嵌套元素','layers')+'</div><span class="design-spacer"></span><div class="design-tool-group">'+button('zoom-out','缩小','minus')+'<button class="design-zoom" data-design="zoom-value" title="恢复 100%">100%</button>'+button('zoom-in','放大','plus')+button('fit','适合画布','fit')+'</div></div><div class="design-status"></div>';
      viewport=document.createElement('div');viewport.className='design-viewport';viewport.tabIndex=-1;host.before(toolbar,viewport);viewport.append(host);host.classList.add('design-artboard');
      host.style.width=(layout.canvasWidth||Math.max(360,viewport.clientWidth-48))+'px';
      shield=document.createElement('div');shield.className='design-shield';shield.dataset.piEditor='';
      outline=document.createElement('div');outline.className='design-outline';outline.dataset.piEditor='';outline.hidden=true;
      outline.innerHTML='<span class="design-selection-label"></span>'+['nw','n','ne','e','se','s','sw','w'].map(h=>'<span class="design-handle" data-handle="'+h+'"></span>').join('');viewport.append(shield,outline);
      selectionMarks=document.createElement('div');selectionMarks.className='design-selection-marks';selectionMarks.dataset.piEditor='';viewport.append(selectionMarks);
      marquee=document.createElement('div');marquee.className='design-marquee';marquee.dataset.piEditor='';marquee.hidden=true;viewport.append(marquee);
      menu=document.createElement('div');menu.className='design-context-menu';menu.dataset.piEditor='';menu.setAttribute('role','menu');menu.setAttribute('aria-label','布局选择与对齐');menu.hidden=true;viewport.append(menu);
      menu.addEventListener('click',event=>{const b=event.target.closest('[data-design]');if(b&&!b.disabled){command(b.dataset.design);viewport.focus({preventScroll:true});}});
      inspector=document.createElement('div');inspector.className='design-inspector';inspector.dataset.piEditor='';inspector.hidden=true;
      inspector.innerHTML='<span class="design-selected-name"></span>'+['x','y','width','height'].map(p=>'<label>'+({x:'X',y:'Y',width:'W',height:'H'}[p])+'<input type="number" step="1" name="'+p+'" aria-label="元素 '+p+'"></label>').join('')+button('parent','选择父容器','parent')+button('reset','重置此元素布局','reset');toolbar.append(inspector);
      layers=document.createElement('aside');layers.className='design-layers';layers.dataset.piEditor='';layers.hidden=true;layers.innerHTML='<div class="design-layers-title">图层 · Shift/Ctrl 点击多选<button type="button" data-design="layers" aria-label="关闭图层">×</button></div><div class="design-layer-list"></div>';viewport.append(layers);
      toolbar.addEventListener('click',event=>{const b=event.target.closest('[data-design]');if(b)command(b.dataset.design);});
      inspector.addEventListener('change',event=>{if(!selected||!manual||!event.target.name)return;const p=event.target.name,n=Number(event.target.value);if(Number.isFinite(n)&&Math.abs(n)<=20000&&(p==='x'||p==='y'||n>=8))editSelection(p,n);else updateUI();});
      layers.addEventListener('click',event=>{menu.hidden=true;const b=event.target.closest('[data-node]');if(b){select(b.dataset.node,event.shiftKey||event.ctrlKey||event.metaKey);viewport.focus({preventScroll:true});}if(event.target.closest('[data-design="layers"]'))command('layers');});
      viewport.addEventListener('pointerdown',down,true);viewport.addEventListener('pointermove',queueMove);viewport.addEventListener('pointerup',up);viewport.addEventListener('pointercancel',cancelGesture);viewport.addEventListener('lostpointercapture',()=>{if(gesture)cancelGesture();});
      viewport.addEventListener('contextmenu',event=>{if(!manual)return;event.preventDefault();const b=event.target.closest('[data-node]');if(b){if(!selection.has(b.dataset.node))select(b.dataset.node,event.shiftKey||event.ctrlKey||event.metaKey);showMenu(event.clientX,event.clientY);}});
      viewport.addEventListener('wheel',event=>{if(layers.contains(event.target)||menu.contains(event.target))return;menu.hidden=true;event.preventDefault();if(event.shiftKey||event.ctrlKey)zoom(view.zoom*Math.exp(-event.deltaY*.002),{x:event.clientX,y:event.clientY});else{view.x-=event.deltaX;view.y-=event.deltaY;updateView();}},{passive:false});
      document.addEventListener('keydown',keydown);document.addEventListener('keyup',keyup);window.addEventListener('resize',updateOutline);
    } else if(layout.canvasWidth) {host.style.width=layout.canvasWidth+'px';}
    scan();
    return {
      apply:scan,freeze,
      decorate(next){return {...next,_layout:clone(layout)};},
      invoke(command,payload={}) {
        if(!editing)throw new Error('请先进入该工作台的修改设计模式');
        if(command==='setLayout')freeze();
        scan();
        if(command==='readLayout') {
          const all=[...nodes.values()],offset=Math.max(0,Math.floor(Number(payload.offset)||0)),limit=clamp(Math.floor(Number(payload.limit)||200),1,500);
          return {workbench:key,revision:layout.revision,canvasWidth:host.offsetWidth,total:all.length,nextOffset:offset+limit<all.length?offset+limit:null,manual,view:{...view},elements:all.slice(offset,offset+limit).map(n=>({id:n.id,parentId:n.parentId,tag:n.element.tagName.toLowerCase(),label:label(n.element),visible:visible(n.element),geometry:{...localSize(n.element),...geometry(n.id)},opaque:n.element.tagName==='CANVAS'||(n.element.tagName==='IFRAME'&&!n.element.contentDocument)}))};
        }
        if(command!=='setLayout')throw new Error('未知布局动作');
        if(payload.baseRevision!==layout.revision)throw new Error('布局版本已变化，请先 readLayout 再修改');
        if(!Array.isArray(payload.changes)||!payload.changes.length||payload.changes.length>500)throw new Error('changes 应为 1–500 个元素的布局修改');
        const next=clone(layout);
        for(const change of payload.changes){if(!nodes.has(change.id))throw new Error('元素不存在：'+change.id);const patch={};for(const p of ['x','y','width','height','zIndex'])if(change[p]!==undefined){const value=change[p];if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>20000||(['width','height'].includes(p)&&value<8))throw new Error('无效尺寸或坐标：'+p);patch[p]=round(value);}if(!Object.keys(patch).length)throw new Error('没有提供布局属性');next.nodes[change.id]={...geometry(change.id),...patch};}
        commit(next);return {workbench:key,revision:layout.revision,changed:payload.changes.map(x=>x.id),saved:true,frozen:true};
      },
      dispose(){disposed=true;cancelGesture();observers.forEach(o=>o.disconnect());for(const [f,l] of frameListeners)f.removeEventListener('load',l);document.removeEventListener('keydown',keydown);document.removeEventListener('keyup',keyup);window.removeEventListener('resize',updateOutline);toolbar?.remove();if(viewport){viewport.before(host);viewport.remove();}document.body.classList.remove('design-document');host.classList.remove('design-artboard');host.style.removeProperty('transform');}
    };
  };
})();
