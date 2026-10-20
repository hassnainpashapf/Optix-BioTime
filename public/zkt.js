// ZKT-style page kit. A page is registered with ZK.reg(key, title, async()=>html, module) or built from a
// spec with ZK.grid(key, title, spec). Keys that are not existing page names start with "zk:".
// Spec: {module, load:async()=>rows, cols:[[title, field | row=>text, {link:true, html:true}]], fields:[...], api:'path',
//        acts:[['Add'],['Delete'],['Label', (ctx)=>..],['Menu',[['Sub',(ctx)=>..]]]], save:async(values,row)=>.., remove:async(id)=>..}
// ctx = {ids, rows (selected), all, key}. Form fields: {k, l, t:'text|number|date|datetime|select|textarea|checkbox', opts:[[value,label]] | async()=>[[v,l]], req, hint}
window.ZK={pages:{},title:{},G:{},n:0};
window.ZK_OK='<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#3d9a1c"/><path d="M6.500 12.500l4 4 7-8" stroke="#fff" stroke-width="3" fill="none"/></svg>';
const ZK_EDIT='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.500 2.500a2.100 2.100 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',ZK_TRASH='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v7M14 11v7"/></svg>';
ZK.reg=(key,title,fn,module)=>{ZK.pages[key]=fn;ZK.title[key]=title;if(module)PAGE_MODULE[key]=module;if(typeof pages==='object')pages[key]=fn};
ZK.t=p=>ZK.title[p]||p;
const zE=v=>esc(v==null?'':v);
ZK.grid=(key,title,o)=>{const g='zg'+(++ZK.n);
  ZK.reg(key,title,async()=>{const all=await o.load();ZK.G[key]={o,all,g};
    const acts=(o.acts||[['Add'],['Delete']]).map((a,i)=>Array.isArray(a[1])?`<span class="zdd"><button class="zb" onclick="ZK.dd(event,'${key}',${i})">${esc(a[0])} <i class="cr"></i></button></span>`:`<button class="zb ${a[0]==='Delete'||a[0]==='Bulk Delete'?'zdel':''}" onclick="ZK.act('${key}',${i})">${esc(a[0])}</button>`).join('');
    const cols=(o.cols||[]).map(c=>{const f=c[1],op=c[2]||{};const get=typeof f==='function'?f:(r=>r[f]);return [c[0],typeof f==='string'?f:'',r=>{const v=get(r);const t=op.html?(v==null?'':v):zE(v);return op.link?`<a class="zl" onclick="ZK.edit('${key}',${r.id})">${t||'(edit)'}</a>`:t}]});
    if(o.fields&&o.rowActs!==false&&!(o.cols||[]).some(c=>c[0]===''))cols.push(['','',r=>`<span class="zra"><a title="Edit" style="color:#7ac143" onclick="ZK.edit('${key}',${r.id})">${ZK_EDIT}</a>${o.rowDel===false?'':`<a title="Delete" style="color:#e0463e" onclick="ZK.del1('${key}',${r.id})">${ZK_TRASH}</a>`}</span>`]);
    const hideIdx=(o.cols||[]).map((c,i)=>c[2]&&c[2].hide?i+1:-1).filter(i=>i>0),tb=tbl([zcol(g),...cols],all,hideIdx.length?{hide:hideIdx}:{}),body=o.details?`<div class="zdw"><div style="flex:1;min-width:0">${tb}</div><div class="zdet${o.details&&o.details.wide?' wide':''}" data-key="${key}"><div class="zdh">${esc(o.details&&o.details.title||'Details')}</div><div class="zdb"></div></div></div>`:tb;
    return `<h2>${esc(title)} <span class="cnt">${all.length}</span></h2>${o.note?`<p class="mut">${o.note}</p>`:''}<div class="ztool"><div class="zgrp">${acts}</div></div>`+body+(o.after?o.after(all):'')},o.module)};
ZK.del1=async(key,id)=>{const s=ZK.G[key],o=s.o;if(!confirm('Delete this record?'))return;try{o.remove?await o.remove(id):await api(o.api+'/'+id,'DELETE');go(cur)}catch(e){alert(e.message)}};
ZK.ctx=key=>{const s=ZK.G[key],ids=zsel(s.g);return {key,ids,all:s.all,rows:s.all.filter(r=>ids.includes(r.id)),reload:()=>go(cur)}};
ZK.act=async(key,i)=>{const s=ZK.G[key],a=(s.o.acts||[['Add'],['Delete']])[i],n=a[0];try{
  if(a[1]&&typeof a[1]==='function')return await a[1](ZK.ctx(key));
  if(n==='Add')return ZK.edit(key,0);
  if(n==='Delete'||n==='Bulk Delete')return ZK.del(key)}catch(e){alert(e.message)}};
ZK.dd=(ev,key,i)=>{ev.stopPropagation();document.querySelectorAll('.tbmenu').forEach(m=>m.remove());const a=ZK.G[key].o.acts[i],m=document.createElement('div');m.className='tbmenu';
  m.innerHTML=a[1].map((x,j)=>`<a onclick="document.querySelector('.tbmenu').remove();ZK.sub('${key}',${i},${j})">${esc(x[0])}</a>`).join('');const b=ev.currentTarget.getBoundingClientRect();m.style.top=b.bottom+2+'px';m.style.left=b.left+'px';document.body.appendChild(m);
  setTimeout(()=>document.addEventListener('click',function f(e){if(!m.contains(e.target)){m.remove();document.removeEventListener('click',f)}}),0)};
ZK.sub=async(key,i,j)=>{try{await ZK.G[key].o.acts[i][1][j][1](ZK.ctx(key))}catch(e){alert(e.message)}};
ZK.need=(ctx,n)=>{if(n===1&&ctx.ids.length!==1)throw new Error('Tick exactly one row');if(!ctx.ids.length)throw new Error('Tick at least one row first');return ctx.rows};
ZK.del=async key=>{const s=ZK.G[key],o=s.o,ids=zsel(s.g);if(!ids.length)return alert('Tick at least one row first');if(!confirm(`Delete ${ids.length} selected record(s)?`))return;const errs=[];
  for(const id of ids)try{o.remove?await o.remove(id):await api(o.api+'/'+id,'DELETE')}catch(e){errs.push(e.message)}
  if(errs.length)alert(`${ids.length-errs.length} deleted, ${errs.length} could not be:\n`+errs.slice(0,4).join('\n'));go(cur)};
ZK.fieldHtml=async(f,v)=>{const id='zf_'+f.k,val=v==null?'':v;let inp;
  if(f.t==='select'){let opts=typeof f.opts==='function'?await f.opts():(f.opts||[]);inp=`<select id="${id}">${f.blank===false?'':'<option value="">'+(f.blank||'---------')+'</option>'}${opts.map(o=>`<option value="${zE(o[0])}" ${String(o[0])===String(val)?'selected':''}>${zE(o[1])}</option>`).join('')}</select>`}
  else if(f.t==='textarea')inp=`<textarea id="${id}" rows="3">${zE(val)}</textarea>`;
  else if(f.t==='checkbox')inp=`<input id="${id}" type="checkbox" ${val?'checked':''}>`;
  else inp=`<input id="${id}" type="${f.t==='datetime'?'datetime-local':f.t||'text'}" value="${zE(f.t==='datetime'?String(val).replace(' ','T').slice(0,16):val)}" ${f.ph?`placeholder="${zE(f.ph)}"`:''}>`;
  return `<label><span class="lt">${esc(f.l)}${f.req?' <b style="color:#d9453f">*</b>':''}</span>${inp}${f.hint?`<small class="mut">${esc(f.hint)}</small>`:''}</label>`};
ZK.read=fields=>{const b={};for(const f of fields){const e=document.getElementById('zf_'+f.k);if(!e)continue;b[f.k]=f.t==='checkbox'?e.checked:e.value;if(f.t==='number'&&b[f.k]!=='')b[f.k]=Number(b[f.k]);if(f.t==='datetime'&&b[f.k])b[f.k]=b[f.k].replace('T',' ');if(b[f.k]===''&&f.nullable!==false&&f.t!=='text'&&f.t!=='textarea')b[f.k]=null}return b};
ZK.form=async(title,fields,values,onSave,label)=>{const html=(await Promise.all(fields.map(f=>ZK.fieldHtml(f,(values||{})[f.k])))).join('');ZK._f={fields,onSave};
  orgModal(title,`<div class="grid">${html}</div>`,'ZK.formGo()',label||'Save')};
ZK.formGo=async()=>{const {fields,onSave}=ZK._f,b=ZK.read(fields);for(const f of fields)if(f.req&&(b[f.k]===''||b[f.k]==null||b[f.k]===false))return document.getElementById('om_e').textContent=`${f.l} is required`;
  try{await onSave(b);document.getElementById('dvm')?.remove();go(cur)}catch(e){document.getElementById('om_e').textContent=e.message}};
ZK.edit=async(key,id)=>{const s=ZK.G[key],o=s.o;if(!o.fields)return alert('Not available for this list');const row=id?s.all.find(r=>r.id===id)||{}:(o.defaults||{});
  ZK.form((id?'Edit ':'Add ')+ZK.t(key),o.fields,row,async b=>{if(o.save)return o.save(b,id?row:null);await api(id?`${o.api}/${id}`:o.api,id?'PUT':'POST',b)})};
ZK.csvModal=(title,path,note)=>orgModal(title,`<p class="mut sm">${note||'Paste CSV rows. The first line may be a header.'}</p><textarea id="im_t" rows="8" style="width:100%"></textarea><div id="im_m" class="sm"></div>`,`ZK.csvGo('${path}')`,'Import');
ZK.csvGo=async path=>{const o=document.getElementById('im_m');try{const r=await api(path,'POST',{csv:val('im_t')});o.innerHTML=`<span style="color:var(--ok)">${r.added??0} added${r.skipped?`, ${r.skipped} skipped`:''}.</span>`;if(r.added)setTimeout(()=>{document.getElementById('dvm')?.remove();go(cur)},900)}catch(e){o.innerHTML=`<span class="err">${esc(e.message)}</span>`}};
// a read-only table with an optional filter bar (used by logs and reports)
ZK.list=(key,title,o)=>ZK.grid(key,title,{...o,acts:o.acts||[]});

// ---- date boxes show plain YYYY-MM-DD (as in the reference app) with a small calendar popup; the value stays an ISO date ----
{const st=document.createElement('style');st.textContent='.zdp{position:fixed;z-index:200;background:#fff;border:1px solid #ddd;box-shadow:0 4px 14px rgba(0,0,0,.18);padding:8px;width:236px;font-size:12px;user-select:none}.zdp .h{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.zdp .h b{font-weight:600}.zdp .h a{cursor:pointer;padding:0 8px;color:#555;font-size:14px}.zdp .g{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;text-align:center}.zdp .g i{font-style:normal;color:#999;padding:3px 0}.zdp .g a{padding:5px 0;cursor:pointer;color:#333}.zdp .g a:hover{background:#eef6e2}.zdp .g a.on{background:#7ac143;color:#fff}.zdp .g a.o{color:#bbb}.zdp .f{margin-top:6px;text-align:right}.zdp .f a{cursor:pointer;color:#4f8a1e;padding:0 6px}';document.head.appendChild(st)}
ZK.dateify=root=>{root.querySelectorAll&&root.querySelectorAll('input[type=date]').forEach(e=>{if(document.documentElement.dataset.skin!=='classic')return;const v=e.value;e.type='text';e.classList.add('zd');e.autocomplete='off';if(!e.placeholder)e.placeholder='YYYY-MM-DD';e.value=v})};
ZK.cal=inp=>{document.querySelector('.zdp')?.remove();const p=document.createElement('div');p.className='zdp';const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  let cur=/^\d{4}-\d\d-\d\d$/.test(inp.value)?new Date(inp.value+'T00:00:00'):new Date();cur=new Date(cur.getFullYear(),cur.getMonth(),1);
  const draw=()=>{const y=cur.getFullYear(),m=cur.getMonth(),first=(new Date(y,m,1).getDay()+6)%7,days=new Date(y,m+1,0).getDate(),sel=inp.value,t=iso(new Date());let cells='';
    for(let i=0;i<first;i++){const d=new Date(y,m,1-first+i);cells+=`<a class="o" data-d="${iso(d)}">${d.getDate()}</a>`}
    for(let d=1;d<=days;d++){const s=iso(new Date(y,m,d));cells+=`<a class="${s===sel?'on':''}" data-d="${s}">${d}</a>`}
    p.innerHTML=`<div class="h"><span><a data-n="-12">&laquo;</a><a data-n="-1">&lsaquo;</a></span><b>${cur.toLocaleString('en',{month:'long'})} ${y}</b><span><a data-n="1">&rsaquo;</a><a data-n="12">&raquo;</a></span></div><div class="g">${['Mo','Tu','We','Th','Fr','Sa','Su'].map(x=>`<i>${x}</i>`).join('')}${cells}</div><div class="f"><a data-d="${t}">Today</a><a data-x="1">Clear</a></div>`};
  draw();document.body.appendChild(p);const b=inp.getBoundingClientRect();p.style.left=Math.min(b.left,innerWidth-250)+'px';p.style.top=(b.bottom+2+260>innerHeight?Math.max(4,b.top-262):b.bottom+2)+'px';
  p.onmousedown=e=>e.preventDefault();p.onclick=e=>{const a=e.target.closest('a');if(!a)return;if(a.dataset.n){cur=new Date(cur.getFullYear(),cur.getMonth()+Number(a.dataset.n),1);return draw()}
    if(a.dataset.d||a.dataset.x){inp.value=a.dataset.x?'':a.dataset.d;inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));p.remove()}};
  setTimeout(()=>document.addEventListener('mousedown',function f(e){if(!p.contains(e.target)&&e.target!==inp){p.remove();document.removeEventListener('mousedown',f)}}),0)};
document.addEventListener('focusin',e=>{if(e.target.classList&&e.target.classList.contains('zd')&&!e.target.disabled&&!e.target.readOnly)ZK.cal(e.target)});
document.addEventListener('click',e=>{if(e.target.classList&&e.target.classList.contains('zd')&&!document.querySelector('.zdp')&&!e.target.disabled)ZK.cal(e.target)});
new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)if(n.nodeType===1){if(n.matches&&n.matches('input[type=date]'))ZK.dateify({querySelectorAll:()=>[n]});else ZK.dateify(n)}}).observe(document.documentElement,{childList:true,subtree:true});

// right-hand Details panel (grids with spec.details): click a row to see its fields
{const st=document.createElement('style');st.textContent='.zdw{display:flex;gap:5px;align-items:flex-start}.zdet{width:300px;flex:none;border:1px solid #e6e6e6;min-height:200px;background:#fff}.zdh{background:#f2f2f2;padding:10px 14px;color:#555;font-size:12px}.zdb{padding:10px 14px;font-size:12px;color:#666;line-height:22px}.zdb .zdr{display:flex;gap:8px}.zdet.wide{width:48%}.zdb table{width:100%;border-collapse:collapse;font-size:12px;border:0;border-radius:0}.zdb table th,.zdb table td{padding:5px 6px;border:0;border-bottom:1px solid #eee;text-align:left;font-weight:400;color:#666;background:none}.zdb input[type=checkbox]{width:16px;height:16px;margin:0;padding:0}.zdb b{font-weight:400;color:#999;min-width:96px}.zdw tbody tr[data-rid]{cursor:pointer}.zdw tbody tr.zsel td{background:#eef6e2}';document.head.appendChild(st)}
document.addEventListener('click',e=>{const tr=e.target.closest&&e.target.closest('.zdw tbody tr[data-rid]');if(!tr||e.target.closest('a,input,button'))return;const box=tr.closest('.zdw').querySelector('.zdet'),s=ZK.G[box.dataset.key];if(!s)return;const row=s.all.find(r=>String(r.id)===tr.dataset.rid);if(!row)return;
  tr.closest('tbody').querySelectorAll('tr.zsel').forEach(x=>x.classList.remove('zsel'));tr.classList.add('zsel');
  const cells=[...tr.children].slice(1),d=s.o.details;ZK.sel=row;const body=box.querySelector('.zdb');
  if(d&&typeof d==='object'&&d.render){body.innerHTML='<span class="mut">Loading...</span>';Promise.resolve(d.render(row,s)).then(h=>{body.innerHTML=h}).catch(e=>{body.innerHTML='<span class="err">'+esc(e.message)+'</span>'})}
  else body.innerHTML=(s.o.cols||[]).map((c,i)=>`<div class="zdr"><b>${esc(c[0])}</b><span>${cells[i]?cells[i].innerHTML:''}</span></div>`).join('')});

// label-left settings forms (Global Rule, Attendance Configuration): wrap a page in .zse2 .zse
{const st=document.createElement('style');st.textContent=`
.zse2 .grid{display:grid!important;grid-template-columns:repeat(2,minmax(390px,1fr))!important;gap:0 24px;max-width:980px;padding:18px 5px 6px}
.zse2 .grid>label,.zse2 .grid>div>label{display:flex;flex-direction:row;align-items:center;margin:0 0 14px;font-weight:400;color:#555;font-size:12px;text-transform:none;letter-spacing:0;flex-wrap:wrap}
.zse2 .grid>div{grid-column:1/-1;border-top:0!important;padding-top:0!important}
.zse2 .lt{width:190px;text-align:right;padding-right:10px;line-height:16px;display:inline-block}
.zse2 label input:not([type=checkbox]),.zse2 label select,.zse2 label textarea{width:190px;height:26px;border:1px solid #ddd;border-radius:0;padding:0 8px;font-size:12px;background:#fff;margin:0}
.zse2 label small{display:block;flex-basis:100%;margin:6px 0 0 200px;max-width:640px;color:#999;font-size:12px;line-height:18px}
.zse2 input[type=checkbox]{appearance:none;-webkit-appearance:none;width:58px!important;height:22px!important;border-radius:11px;background:#ddd;position:relative;cursor:pointer;margin:0;padding:0;border:0;transition:background .15s}
.zse2 input[type=checkbox]::before{content:"No";position:absolute;right:9px;top:0;line-height:22px;font-size:11px;color:#fff}
.zse2 input[type=checkbox]::after{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.zse2 input[type=checkbox]:checked{background:#7ac143}.zse2 input[type=checkbox]:checked::before{content:"Yes";left:9px;right:auto}.zse2 input[type=checkbox]:checked::after{left:39px}
.zse2 .sv{display:inline-block;background:#7ac143;color:#fff;border:0;height:38px;min-width:68px;padding:0 20px;font-size:14px;cursor:pointer;border-radius:0}
.zse2 .svbar{display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:6px 0;border-top:1px solid #eee;margin-top:6px}
.zse2 .clrx{width:24px!important;height:24px!important;border:1px solid #ccc!important;text-align:center;padding:0!important;cursor:pointer}
`;document.head.appendChild(st)}

{const st=document.createElement('style');st.textContent='.zra{display:flex;gap:12px;justify-content:flex-end;padding-right:18px}.zra a{cursor:pointer;display:inline-flex}.zra a:hover{opacity:.7}';document.head.appendChild(st)}
