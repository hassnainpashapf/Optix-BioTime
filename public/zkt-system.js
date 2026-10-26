// System module pages in the ZKT layout (columns and toolbar copied from the reference app). Backend: zk-system.js, zk-integration.js, zk-log.js.
(()=>{
const E=v=>esc(v==null?'':v),AD='@admin',yn=v=>v?'Yes':'No';
const OKI='<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#3d9a1c"/><path d="M6.500 12.500l4 4 7-8" stroke="#fff" stroke-width="3" fill="none"/></svg>',NOI='<svg width="12" height="12" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#d9232d"/><path d="M6 12h12" stroke="#fff" stroke-width="3.500"/></svg>';
{const st=document.createElement('style');st.textContent='.zsp input[type=checkbox],.zsp input[type=radio]{width:16px!important;height:16px!important;padding:0!important;margin:2px 4px 2px 0}.zsp .grid>label>input[type=checkbox]{display:block}';document.head.appendChild(st)}
const dl=async(path,name)=>{const r=await fetch('/api/'+path,{headers:{Authorization:'Bearer '+T}});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.statusText);const a=document.createElement('a');a.href=URL.createObjectURL(await r.blob());a.download=name;a.click()};
window.ZKDL=dl;
const need=(c,one)=>{if(!c.ids.length)throw new Error('Tick at least one row first');if(one&&c.ids.length!==1)throw new Error('Tick exactly one row');return c.rows};
const say=(m,c)=>{alert(m);c&&c.reload&&c.reload()};
const titleCase=s=>String(s||'').replace(/[_-]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
// a settings page: sections of fields, Save (and optional Test) buttons. spec: {path, title, sections:[[heading,[field...]]], note, tests:[[label,path]]}
const settingsPage=(key,title,spec)=>ZK.reg(key,title,async()=>{const v=await api(spec.path);window.ZKS=window.ZKS||{};window.ZKS[key]={spec,v};
  const fld=f=>{const id='zs_'+f.k,val=v[f.k];let inp;
    if(f.t==='checkbox')inp=`<input id="${id}" type="checkbox" style="width:16px;height:16px;padding:0" ${val?'checked':''}>`;
    else if(f.t==='select')inp=`<select id="${id}">${f.opts.map(o=>`<option value="${E(o[0])}" ${String(o[0])===String(val)?'selected':''}>${esc(o[1])}</option>`).join('')}</select>`;
    else if(f.t==='textarea')inp=`<textarea id="${id}" rows="${f.rows||4}">${E(val)}</textarea>`;
    else inp=`<input id="${id}" type="${f.t||'text'}" value="${f.t==='password'?'':E(val)}" ${f.t==='password'&&v['has_'+f.k]?'placeholder="(saved - leave empty to keep)"':''} ${f.t==='number'&&f.min!=null?`min="${f.min}"`:''}>`;
    return `<label>${esc(f.l)}${f.req?' <b style="color:#d9453f">*</b>':''}${inp}${f.unit?`<small class="mut"> ${esc(f.unit)}</small>`:''}${f.hint?`<small class="mut"> ${esc(f.hint)}</small>`:''}</label>`};
  return `<div class="zsp"><h2>${esc(title)}</h2>${spec.note?`<p class="mut">${spec.note}</p>`:''}${spec.sections.map(([h,fs])=>`${h?`<h3 style="margin:14px 0 6px;font-size:13px">${esc(h)}</h3>`:''}<div class="grid" style="max-width:760px">${fs.map(fld).join('')}</div>`).join('')}
  <div style="margin-top:14px"><button class="zb" style="border:1px solid #ccc" onclick="ZKSave('${key}')">Save</button>${(spec.tests||[]).map(t=>` <button class="zb" style="border:1px solid #ccc" onclick="ZKTest('${key}','${t[1]}')">${esc(t[0])}</button>`).join('')} <span id="zs_msg" class="sm"></span></div></div>`},AD);
window.ZKSave=async key=>{const {spec}=ZKS[key],b={};for(const [,fs] of spec.sections)for(const f of fs){const e=document.getElementById('zs_'+f.k);if(!e)continue;b[f.k]=f.t==='checkbox'?e.checked:f.t==='number'?(e.value===''?null:Number(e.value)):e.value}
  const m=document.getElementById('zs_msg');try{await api(spec.path,'PUT',b);m.style.color='var(--ok,#2a9d5c)';m.textContent='Saved';setTimeout(()=>go(cur),700)}catch(e){m.style.color='#d9453f';m.textContent=e.message}};
window.ZKTest=async(key,path)=>{const m=document.getElementById('zs_msg');m.style.color='';m.textContent='Testing...';try{const r=await api(path,'POST',{});m.style.color='var(--ok,#2a9d5c)';m.textContent=r.message||'OK'}catch(e){m.style.color='#d9453f';m.textContent=e.message}};
const bool=(k,l,extra={})=>({k,l,t:'checkbox',...extra});

// ---------- User > UserGroup (= roles) ----------
const MODN={employees:'Employees',organization:'Organization',shifts:'Shifts',attendance:'Attendance',leave:'Leave',overtime:'Overtime',payroll:'Payroll',devices:'Devices',access:'Access control',settings:'Settings'};
let MODS=[];
ZK.grid('zk:usergroup','UserGroup',{module:AD,defaults:Object.fromEntries(Object.keys({employees:1,organization:1,shifts:1,attendance:1,leave:1,overtime:1,payroll:1,devices:1,access:1,settings:1}).map(m=>['p_'+m,['payroll','settings'].includes(m)?'none':'view'])),note:'A new UserGroup starts with View on everything except Payroll and Settings. Set Edit where the person must change data. A user whose group has No access to a part cannot open it.',load:async()=>{const [r,m]=await Promise.all([api('roles'),api('zk/modules')]);MODS=m;return r.map((x,i)=>({...x,id:i+1}))},
  cols:[['Name','name',{link:true}],['Users','users']],note:'A UserGroup decides what its users may see and change in each part of the system.',
  fields:[{k:'name',l:'Name',t:'text',req:true},...Object.keys(MODN).map(m=>({k:'p_'+m,l:'Permissions: '+MODN[m],t:'select',blank:false,opts:[['none','No access'],['view','View'],['edit','Edit']]}))],
  save:async(b,row)=>{const perms={};for(const m of MODS)perms[m]=b['p_'+m]||'none';await api(row?'roles/'+row.name:'roles',row?'PUT':'POST',row?{perms}:{name:b.name,perms})},
  remove:async id=>{const r=ZK.G['zk:usergroup'].all.find(x=>x.id===id);await api('roles/'+r.name,'DELETE')}});
const UGT={Personnel:[['Employee','employees'],['Resign','employees'],['Document','employees'],['Department','organization'],['Position','organization'],['Area','organization'],['Workflow Role','settings'],['Workflow Node','settings'],['Workflow Builder','settings'],['Custom Attribute','settings'],['Configuration','settings']],
 Device:[['Device','devices'],['Device Command','devices'],['Device Parameter','devices'],['Message','devices'],['Data','devices'],['Log','devices'],['Mobile App','devices'],['Geo-fence','devices']],
 Attendance:[['Pay Code','settings'],['Rule','settings'],['Break Time','shifts'],['Timetable','shifts'],['Shift','shifts'],['Schedule Assignment','shifts'],['Manual Log','attendance'],['Leave','leave'],['Overtime','overtime'],['Training','attendance'],['Transaction Report','attendance'],['Daily Report','attendance'],['Weekly Report','attendance'],['Monthly Report','attendance'],['Summary Report','attendance'],['Custom Report','attendance']],
 Payroll:[['Formula','payroll'],['Extra Funds','payroll'],['Structure','payroll'],['Profile','payroll'],['Special Payment','payroll'],['Exemption','payroll'],['Payslip','payroll']],
 Access:[['Time Period','access'],['Holiday','access'],['Groups','access'],['Combination','access'],['Privilege','access']],
 Visitor:[['Visitor','attendance'],['Reason','attendance'],['Transaction','attendance']],
 Meeting:[['Room','organization'],['Meeting','organization'],['Manual Log','organization'],['Transaction','organization']],
 MTD:[['Daily Report','attendance'],['Department Summary','attendance'],['Abnormal','attendance']],
 System:[['UserGroup','settings'],['User','settings'],['API Permissions','settings'],['Notification','settings'],['Database','settings'],['Log','settings'],['Configuration','settings']]};
const UGA=['Browse','Add','Change','Delete'];
const ugK=(tab,pg,a)=>(window.UGS.sub||[]).includes(tab+'.'+pg)?tab+'.'+pg:a;
const ugCount=(tab)=>{const S=window.UGS;let n=0,t=0;for(const [pg,a] of UGT[tab]){const k=ugK(tab,pg,a);for(const x of UGA){t++;if(S.st[k].has(x))n++}}return[n,t]};
window.ugDraw=()=>{const S=window.UGS;document.querySelectorAll('.ugtabs a').forEach(a=>a.classList.toggle('on',a.dataset.t===S.tab));
  const [n,t]=ugCount(S.tab);let h=`<div class="ugbar"><a onclick="ugAll(${n===t?0:1})" title="Select all">&#9745;</a> <a onclick="UGS.open=new Set(UGT[UGS.tab].map(x=>x[0]));ugDraw()">&#8963;</a> <a onclick="UGS.open=new Set();ugDraw()">&#8964;</a></div><div class="ugroot"><span class="ugc ${n===t?'on':n?'half':''}" onclick="ugAll(${n===t?0:1})"></span>${S.tab} (${n}/${t})</div><div class="ugkids">`;
  for(const [pg,a0] of UGT[S.tab]){const a=ugK(S.tab,pg,a0),c=UGA.filter(x=>S.st[a].has(x)).length,o=S.open.has(pg);h+=`<div class="ugpg"><span class="ugar" onclick="ugTog('${pg}')">${o?'&#9662;':'&#9656;'}</span><span class="ugc ${c===4?'on':c?'half':''}" onclick="ugPage('${a}',${c===4?0:1})"></span>${pg} (${c}/4)</div>`;
    if(o)h+=UGA.map(x=>`<div class="ugact"><span class="ugc ${S.st[a].has(x)?'on':''}" onclick="ugAct('${a}','${x}')"></span>${x}</div>`).join('')}
  document.getElementById('ug_tree').innerHTML=h+'</div>'};
window.ugTog=pg=>{const o=UGS.open;o.has(pg)?o.delete(pg):o.add(pg);ugDraw()};
window.ugAct=(a,x)=>{const st=UGS.st[a];st.has(x)?st.delete(x):st.add(x);if(x!=='Browse'&&st.has(x))st.add('Browse');if(x==='Browse'&&!st.has('Browse'))UGA.forEach(y=>st.delete(y));ugDraw()};
window.ugPage=(a,on)=>{UGS.st[a]=new Set(on?UGA:[]);ugDraw()};
window.ugAll=on=>{for(const [pg,a] of UGT[UGS.tab])UGS.st[ugK(UGS.tab,pg,a)]=new Set(on?UGA:[]);ugDraw()};
{const orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='zk:usergroup')return orig(key,id);const s=ZK.G[key],row=id?s.all.find(r=>r.id===id):{perms:Object.fromEntries(Object.keys(MODN).map(m=>[m,['payroll','settings'].includes(m)?'none':'view']))};if(id&&row.builtin)return alert('The admin group has every permission and cannot be changed');
  const sub=await api('zk/subpages').catch(()=>[]),st={},toSet=l=>new Set(l==='edit'?UGA:l.startsWith('view')?['Browse',...l.split('+').slice(1).map(x=>x[0].toUpperCase()+x.slice(1))]:[]);for(const m of Object.keys(MODN))st[m]=toSet((row.perms||{})[m]||'none');for(const k of sub)st[k]=toSet((row.perms||{})[k]||(row.perms||{})[(Object.entries(UGT).flatMap(([t,l])=>l.map(([pg,a])=>[t+'.'+pg,a])).find(x=>x[0]===k)||[])[1]]||'none');
  window.UGS={st,sub,tab:'Personnel',open:new Set(),row,id};
  const m=orgModal('Add',`<div class="ugname"><label>Name <b style="color:#e0281b">*</b><input id="ug_name" value="${esc(row.name||'')}" ${id?'readonly':''}></label></div><div class="ugtabs">${Object.keys(UGT).map(t=>`<a data-t="${t}" onclick="UGS.tab='${t}';ugDraw()">${t}</a>`).join('')}</div><div id="ug_tree" class="ugtree"></div><div class="shnote">Each page can be set on its own where it has its own data; pages marked with a shared part (for example Workflow, Reports) follow the part they belong to. Add = create, Change = edit, Delete = remove. A page that is not ticked cannot be opened, including the lists other pages use.</div>`,'ugGo()');
  m.firstChild.classList.add('shw');ugDraw()}}
window.ugGo=async()=>{const S=window.UGS,e=document.getElementById('om_e'),name=document.getElementById('ug_name').value.trim();if(!name)return e.textContent='Name is required';
  const lvl=st=>{const ex=['Add','Change','Delete'].filter(x=>st.has(x));return ex.length===3?'edit':ex.length?'view+'+ex.map(x=>x.toLowerCase()).join('+'):st.size?'view':'none'};
  const perms={},pageOf=[];for(const [t,l] of Object.entries(UGT))for(const [pg,a] of l)pageOf.push([t+'.'+pg,a]);
  for(const m of MODS){const u=new Set(S.st[m]||[]);for(const [k,a] of pageOf)if(a===m&&S.sub.includes(k))S.st[k].forEach(x=>u.add(x));perms[m]=lvl(u)}
  for(const [k,a] of pageOf)if(S.sub.includes(k)&&lvl(S.st[k])!==perms[a])perms[k]=lvl(S.st[k]);
  try{await api(S.id?'roles/'+S.row.name:'roles',S.id?'PUT':'POST',S.id?{perms}:{name,perms});document.getElementById('dvm')?.remove();go(cur)}catch(x){e.textContent=x.message}};

// ---------- User > User ----------
const deps=async()=>(await api('departments')).map(d=>[d.id,d.name]),areas=async()=>(await api('branches')).map(d=>[d.id,d.name]);
const groupOpts=async()=>(await api('roles')).map(r=>[r.name,r.name]);
const userFields=add=>[{k:'username',l:'Username',t:'text',req:true},...(add?[{k:'password',l:'Password',t:'password',req:true},{k:'password2',l:'Confirm Password',t:'password',req:true}]:[]),
  {k:'first_name',l:'First Name',t:'text'},{k:'last_name',l:'Last Name',t:'text'},{k:'email',l:'Email',t:'text'},{k:'enabled',l:'Enable',t:'checkbox'},{k:'superuser',l:'Superuser',t:'checkbox'},
  {k:'departments',l:'Authorized Department',t:'checks',opts:deps,hint:'none ticked = all'},{k:'branches',l:'Authorized Area',t:'checks',opts:areas,hint:'none ticked = all'},
  {k:'usergroup',l:'Groups',t:'select',opts:groupOpts,blank:'---------'},{k:'twofa',l:'Enable 2FA',t:'checkbox'}];
ZK.grid('zk:user','User',{module:AD,load:async()=>api('zk/users'),
  cols:[['Username','username',{link:true}],['First Name','first_name'],['Last Name','last_name'],['Email','email'],['UserGroup Name',r=>r.superuser?'':r.usergroup],['Enable',r=>r.enabled?OKI:NOI,{html:true}],['Superuser',r=>r.superuser?OKI:NOI,{html:true}],['Enable 2FA',r=>r.twofa?OKI:NOI,{html:true}],['Date Joined','date_joined'],['Last Login','last_login'],['Login Times','login_count'],['',r=>`<a title="Edit" style="cursor:pointer;color:#7ac143" onclick="ZK.edit('zk:user',${r.id})"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.100 2.100 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></a>`,{html:true}]],
  fields:userFields(true),defaults:{enabled:true,superuser:false},
  save:async(b,row)=>{const body={...b,superuser:!!b.superuser,enabled:!!b.enabled,twofa:!!b.twofa,departments:b.departments||[],branches:b.branches||[]};if(!body.usergroup)delete body.usergroup;if(row){delete body.password;delete body.password2;await api('zk/users/'+row.id,'PUT',body)}else await api('zk/users','POST',body)},
  remove:async id=>api('zk/users/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Change Password',async c=>{const r=need(c,true)[0];ZK.form('Change Password - '+r.username,[{k:'password',l:'New Password',t:'password',req:true},{k:'password2',l:'Confirm Password',t:'password',req:true}],{},async b=>{await api(`zk/users/${r.id}/password`,'POST',b);alert('Password changed. The user is signed out.')},'Change')}],
    ['2FA',[['Enable',async c=>{need(c);const r=await api('zk/users/2fa','POST',{ids:c.ids,enable:true});say(r.updated+' user(s): 2FA switched on',c)}],['Disable',async c=>{need(c);const r=await api('zk/users/2fa','POST',{ids:c.ids,enable:false});say(r.updated+' user(s): 2FA switched off',c)}]]]]});
{const orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='zk:user')return orig(key,id);const s=ZK.G[key],row=id?s.all.find(r=>r.id===id):s.o.defaults;const v={...row,usergroup:row.superuser?'':row.usergroup,enabled:!!row.enabled,twofa:!!row.twofa,superuser:!!row.superuser,departments:row.departments||[],branches:row.branches||[]};
  ZK.form((id?'Edit ':'Add ')+'User',userFields(!id),v,async b=>s.o.save(b,id?row:null))}}

// ---------- User > API Permissions (per API user: which API groups it may call) ----------
ZK.reg('zk:apiperm','API Permissions',async()=>{const d=await api('zk/api-permissions');window.ZAP={d,sel:d.keys[0]?.id||null,scopes:new Set(d.keys[0]?d.keys[0].scopes:[]),cat:'All',q:'',uq:''};return apRender()},AD);
const apRender=()=>{const {d,sel,cat}=ZAP,k=d.keys.find(x=>x.id===sel),groups=['All',...new Set(d.scopes.map(s=>s.group))];
  const eps=d.endpoints.filter(e=>(cat==='All'||String(e.scope).split(':')[0]===cat||(cat==='All'))&&(!ZAP.q||(e.path+e.description+e.method).toLowerCase().includes(ZAP.q.toLowerCase())));
  return `<div id="zap"><h2>API Permissions</h2><p class="mut">API users are the keys created in Integrations. Tick the API groups a user may call.</p><div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap">
  <div style="min-width:220px"><div class="mut sm" style="margin-bottom:4px">Users</div><input id="zap_u" placeholder="Search users..." value="${E(ZAP.uq)}" oninput="ZAP.uq=this.value;apUsers()"><div id="zap_ul" style="margin-top:6px">${apUsersHtml()}</div></div>
  <div style="flex:1;min-width:420px"><div class="ztool"><div>API Permissions - ${k?esc(k.name):'No user selected'}</div><div class="zgrp"><button class="zb" onclick="apSave()">Save</button><button class="zb" onclick="apAll(1)">Select All</button><button class="zb" onclick="apAll(0)">Deselect All</button></div></div>
  <div style="display:flex;gap:6px;margin-bottom:6px">${groups.map(g=>`<a class="zl" style="padding:2px 8px;${g===cat?'background:#e8f0fb':''}" onclick="ZAP.cat='${g}';apRedraw()">${esc(titleCase(g))}</a>`).join('')}</div>
  <input id="zap_q" placeholder="Search APIs..." value="${E(ZAP.q)}" oninput="ZAP.q=this.value;apRedraw(1)"><div id="zap_t" style="margin-top:6px;overflow:auto;max-width:100%">${apTable(eps)}</div></div></div></div>`};
const apUsersHtml=()=>ZAP.d.keys.filter(k=>!ZAP.uq||k.name.toLowerCase().includes(ZAP.uq.toLowerCase())).map(k=>`<div><a class="zl" style="${k.id===ZAP.sel?'font-weight:700':''}" onclick="apPick(${k.id})">${esc(k.name)}</a> <span class="mut sm">${k.active?'':'(off)'} ${esc(k.prefix||'')}</span></div>`).join('')||'<div class="mut sm">No API users yet. Create a key in Integrations.</div>';
const apTable=eps=>`<table><tr><th></th><th>Permission</th><th>Method</th><th>API</th><th>Description</th></tr>${eps.map(e=>{const sc=e.scope,real=ZAP.d.scopes.some(s=>s.scope===sc);return `<tr><td>${real?`<input type="checkbox" ${ZAP.scopes.has(sc)?'checked':''} onchange="apToggle('${sc}',this.checked)">`:''}</td><td>${esc(sc)}</td><td>${esc(e.method)}</td><td><code>${esc(e.path)}</code></td><td>${esc(e.description)}</td></tr>`}).join('')||'<tr><td colspan="5" class="mut">Nothing matches</td></tr>'}</table>`;
window.apUsers=()=>{document.getElementById('zap_ul').innerHTML=apUsersHtml()};
window.apRedraw=keep=>{const m=document.getElementById('main'),q=document.getElementById('zap_q')?.value;m.innerHTML=apRender();if(keep){const i=document.getElementById('zap_q');i.focus();i.setSelectionRange(q.length,q.length)}};
window.apPick=id=>{ZAP.sel=id;ZAP.scopes=new Set(ZAP.d.keys.find(k=>k.id===id).scopes);apRedraw()};
window.apToggle=(sc,on)=>{on?ZAP.scopes.add(sc):ZAP.scopes.delete(sc);apRedraw(1)};
window.apAll=on=>{ZAP.scopes=on?new Set(ZAP.d.scopes.map(s=>s.scope)):new Set();apRedraw()};
window.apSave=async()=>{if(!ZAP.sel)return alert('Choose a user first');try{await api('zk/api-permissions/'+ZAP.sel,'PUT',{scopes:[...ZAP.scopes]});const k=ZAP.d.keys.find(x=>x.id===ZAP.sel);k.scopes=[...ZAP.scopes];alert('Saved')}catch(e){alert(e.message)}};

// ---------- User > Notification (re-registers the existing key) ----------
ZK.grid('Notifications','Notification',{module:undefined,load:async()=>(await api('notifications')).items,
  cols:[['Event',r=>r.kind?titleCase(r.kind):'Notice'],['Content',r=>{const t=E(r.title)+(r.body?' - '+E(r.body):'');return r.link?`<a class="zl" onclick="go('${E(r.link).replace(/'/g,"\\'")}')">${t}</a>`:t},{html:true}],['Send Time','created'],['Read Time',r=>r.read_time||''],['Status',r=>r.is_read?'Read':'Unread']],
  fields:[{k:'title',l:'Event',t:'text',req:true},{k:'body',l:'Content',t:'textarea',req:true}],api:'zk/notifications',
  acts:[['Add'],['Delete'],['Mark All As Read',async c=>{await api('notifications/read','POST',{});c.reload()}]]});

// ---------- Database > Backup ----------
const dlBackup=async id=>{try{const r=ZK.G['zk:backup'].all.find(x=>x.id===id);await dl(`zk/backups/${id}/download`,r.path.split('/').pop())}catch(e){alert(e.message)}};window.zkDlBackup=dlBackup;
ZK.grid('zk:backup','Backup',{module:AD,load:async()=>api('zk/backups'),
  cols:[['Database','db_type'],['Database Name','db_name'],['Operator','operator'],['Time','ts'],['Storage Path',r=>r.exists?`<a class="zl" title="Download" onclick="zkDlBackup(${r.id})">${E(r.path)}</a>`:E(r.path)+' (file missing)',{html:true}],['Status','status'],['Remark','remark']],
  fields:[{k:'remark',l:'Remark',t:'text'}],save:async b=>{await api('zk/backups','POST',{remark:b.remark||'Manual backup'})},remove:async id=>api('zk/backups/'+id,'DELETE'),
  acts:[['Add'],['Delete'],
    ['Backup Automatically',async c=>{const a=await api('zk/backups/auto');ZK.form('Backup Automatically',[{k:'enabled',l:'Enable automatic backup',t:'checkbox'},{k:'frequency',l:'Frequency',t:'select',blank:false,opts:[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly']]},{k:'time',l:'Time (HH:MM)',t:'text',req:true},{k:'keep',l:'Keep the newest',t:'number',req:true,hint:'automatic backups'}],a,async b=>{await api('zk/backups/auto','PUT',b)},'Save')}],
    ['Backup Manually',async c=>{if(!confirm('Back up the database now?'))return;await api('zk/backups','POST',{remark:'Manual backup'});c.reload()}],
    ['Restore Manually',async c=>{const r=need(c,true)[0];if(r.status!=='Success'||!r.exists)throw new Error('Choose a backup whose file still exists');if(!confirm(`Restore the database from ${r.ts}?\nAll data entered after that time is lost and the server restarts.`))return;const x=await api('zk/backups/restore','POST',{id:r.id});alert(x.message+' This page reloads in a few seconds.');setTimeout(()=>location.reload(),6000)}]]});

// ---------- Database > Migrate ----------
const MIG_OK=[['area','Area/Zone'],['department','Department'],['position','Position'],['employee','Employee'],['transaction','Transaction']];
const MIG_NO=['Device data','Attendance setup&Rules','Schedule Assignment','Shift','Benefit Management','Approvals','Fingerprint','Face','Bio-Template','Resign'];
ZK.reg('zk:migrate','Database Migrate',async()=>`<div class="zsp"><h2>Database Migrate</h2><p class="mut">Copy personnel and punches from a database of another system into this one. Only SQLite files can be read here (export other databases to SQLite first). Nothing is deleted; people that already exist are skipped.</p>
 <div class="grid" style="max-width:760px"><label>Migrate From<span class="sm" style="display:block">${['BioTime 7.0','BioTime8.5.2 ~ 8.5.4','BioTime 9.5.2','BioTime8.5.5 or above'].map((x,i)=>`<label style="display:inline-block;font-weight:400;margin-right:12px"><input type="radio" name="mg_sw" ${i===2?'checked':''}> ${x}</label>`).join('')}</span></label>
 <label>Database Type<select id="mg_type" onchange="mgType()"><option value="sqlite">SQLite</option><option value="sqlserver_ado">MSSQL Server</option><option value="mysql">MySQL</option><option value="oracle">Oracle</option><option value="postgresql">PostgreSQL</option></select></label>
 <label>SQLite File<input id="mg_file" type="file" accept=".db,.sqlite,.sqlite3"><small class="mut">or the path of a file on the server:</small><input id="mg_path" placeholder="/path/to/biotime.db"></label>
 <label>Transaction Period<span class="sm"><input id="mg_from" type="date"> to <input id="mg_to" type="date"></span></label></div>
 <h3 style="margin:14px 0 6px;font-size:13px">Migration Data</h3><div style="display:flex;flex-wrap:wrap;gap:6px 18px;max-width:760px">${MIG_OK.map(m=>`<label style="font-weight:400"><input type="checkbox" class="mgck" value="${m[0]}" ${m[0]!=='transaction'?'checked':''}> ${m[1]}</label>`).join('')}${MIG_NO.map(m=>`<label style="font-weight:400;color:#999" title="Not supported yet"><input type="checkbox" disabled> ${m}</label>`).join('')}</div>
 <div style="margin-top:14px"><button class="zb" style="border:1px solid #ccc" onclick="mgGo()">Migrate</button> <span id="mg_msg" class="sm"></span></div><pre id="mg_out" class="sm"></pre></div>`,AD);
window.mgType=()=>{document.getElementById('mg_msg').textContent=val('mg_type')==='sqlite'?'':'Only SQLite can be migrated here.'};
window.mgGo=async()=>{const m=document.getElementById('mg_msg'),items=[...document.querySelectorAll('.mgck:checked')].map(c=>c.value);m.style.color='';m.textContent='Migrating...';
  try{const f=document.getElementById('mg_file').files[0],body={database_type:val('mg_type'),items,period:{from:val('mg_from'),to:val('mg_to')}};if(f)body.data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f)});else body.sqlite_file=val('mg_path');
    const r=await api('zk/migrate','POST',body);m.style.color='var(--ok,#2a9d5c)';m.textContent='Done';document.getElementById('mg_out').textContent=Object.entries(r.result).map(([k,v])=>`${k}: ${v.skipped?'skipped - '+v.skipped:Object.entries(v).map(([a,b])=>b+' '+a).join(', ')}`).join('\n')}catch(e){m.style.color='#d9453f';m.textContent=e.message}};

// ---------- Integration (auto export tasks) ----------
let XM=null;const xmeta=async()=>XM||(XM=await api('zk/exports-meta'));
const DAYN=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const expFields=kind=>[{k:'name',l:'Name',t:'text',req:true},{k:'enabled',l:'Auto Export',t:'checkbox'},
  ...(kind==='report'?[{k:'report_type',l:'Report Type',t:'select',req:true,opts:async()=>(await xmeta()).reports.map(r=>[r.id,r.title]),blank:'----------'},{k:'report_template',l:'Report Template',t:'select',opts:async()=>(await xmeta()).templates.map(t=>[t.id,t.name+' ('+t.type+')'])}]:[]),
  {k:'file_prefix',l:'File Name',t:'text',req:true,hint:kind==='report'?'macros: {report_template} {cur_date} {cur_time}':'macros: {cur_date} {cur_time}'},{k:'format',l:'File Format',t:'select',blank:false,opts:kind==='report'?[['xls','Excel'],['csv','Csv'],['txt','Txt'],['pdf','PDF']]:[['xls','Excel'],['csv','Csv'],['txt','Txt']]},
  ...(kind==='tx'?[{k:'template',l:'Data Template',t:'textarea',hint:'fields: emp_code first_name last_name dept_code dept_name date time verify_type punch_state work_code card_number area_name terminal_alias terminal_sn; use \\t and \\n'},{k:'query_field',l:'Filter By',t:'select',blank:false,opts:[[1,'Punch Time'],[2,'Upload Time'],[3,'Flag']]},{k:'export_type',l:'Export Type',t:'select',blank:false,opts:[[1,'Full Volume'],[2,'Incremental']]}]:[{k:'contains_heads',l:'Include Header',t:'checkbox'}]),
  {k:'policy',l:kind==='tx'?'Export Policy':'Export By',t:'select',blank:false,opts:[[1,'By Timing'],[2,'By Interval']]},{k:'interval_min',l:'Interval (minutes)',t:'number'},{k:'frequency',l:'Frequency',t:'select',blank:false,opts:[[0,'Daily'],[1,'Weekly'],[2,'Monthly']]},
  {k:'week_day',l:'Weekday',t:'select',blank:false,opts:DAYN.map((d,i)=>[i,d])},{k:'month_day',l:'Month Day',t:'number',hint:'1 to 28'},{k:'export_time',l:'Export Time',t:'text',req:true,ph:'00:01'},{k:'period',l:kind==='tx'?'Export Period':'Period',t:'select',blank:false,opts:[[0,'Unnatural Period'],[1,'Natural Period']]},
  {k:'path',l:'Export Path',t:'text',hint:'folder under the exports folder'},{k:'ftp_id',l:'FTP Server',t:'select',opts:async()=>(await api('zk/ftp')).map(f=>[f.id,f.host+' ('+(f.is_sftp?'SFTP, not uploaded':'FTP')+')']),blank:'---------'},{k:'ftp_path',l:'FTP Path',t:'text'}];
const expGrid=(key,title,kind)=>ZK.grid(key,title,{module:AD,load:async()=>{await xmeta();return api('zk/exports/'+kind)},
  note:`Files are written to the data/exports folder on the server (and sent to the FTP server when one is chosen). Scheduled tasks run once the time has come; use Manual Export to run one now.`,
  cols:[['Code','code'],['Name','name',{link:true}],...(kind==='report'?[['Report Type','report_type_label'],['Report Template','template_name']]:[]),['File Name','file_prefix'],['File Format','format_label'],['Export By',r=>kind==='tx'?r.export_by:(r.policy===2?'By Interval':'By Timing')],['Auto Export',r=>yn(r.enabled)],['Last Process Time',r=>r.last_run?r.last_run+(r.last_status==='Failed'?' (failed)':''):'']],
  fields:expFields(kind),defaults:{enabled:true,file_prefix:kind==='tx'?'{cur_date}':'{report_template}_{cur_date}',format:kind==='tx'?'txt':'xls',template:'{emp_code}\\t{first_name}\\t{last_name}\\t{dept_code}\\t{dept_name}\\t{date}\\t{time}\\t{verify_type}\\t{punch_state}\\t{work_code}\\t{card_number}\\t{area_name}\\t{terminal_alias}\\t{terminal_sn}\\n',query_field:3,export_type:1,policy:1,interval_min:0,frequency:0,week_day:0,month_day:1,export_time:'00:01',period:1,path:kind==='tx'?'AutoExport':'AutoAttExport',contains_heads:true},
  save:async(b,row)=>{const body={...b,enabled:!!b.enabled,contains_heads:b.contains_heads===undefined?undefined:!!b.contains_heads};if(body.ftp_id==null)body.ftp_id=null;await api(row?`zk/exports/${kind}/${row.id}`:`zk/exports/${kind}`,row?'PUT':'POST',body)},
  remove:async id=>api(`zk/exports/${kind}/${id}`,'DELETE'),
  acts:[['Add'],['Delete'],
    ['Manual Export',async c=>{const t=need(c,true)[0];ZK.form('Manual Export - '+t.name,[{k:'from',l:'From',t:'date',req:true},{k:'to',l:'To',t:'date',req:true}],{from:today(),to:today()},async b=>{const r=await api(`zk/exports/${kind}/${t.id}/run`,'POST',b);alert(`${r.rows} row(s) written to\n${r.path}${r.ftp?'\nFTP: '+r.ftp:''}`)},'Export')}],
    ['Task',[['Enable',async c=>{need(c);await api(`zk/exports/${kind}/enable`,'POST',{ids:c.ids,enable:true});c.reload()}],['Disable',async c=>{need(c);await api(`zk/exports/${kind}/enable`,'POST',{ids:c.ids,enable:false});c.reload()}],
      ['Exported Files',async c=>{const t=need(c,true)[0],f=await api(`zk/exports/${kind}/${t.id}/files`);window.ZXF={kind,id:t.id};orgModal('Exported files - '+esc(t.name),`<div style="max-height:300px;overflow:auto"><table><tr><th>File</th><th>Size</th><th>Time</th></tr>${f.map(x=>`<tr><td><a class="zl" onclick="ZKDL('zk/exports/${kind}/${t.id}/files/'+encodeURIComponent('${E(x.name)}'),'${E(x.name)}')">${E(x.name)}</a></td><td>${x.size}</td><td>${E(x.time)}</td></tr>`).join('')||'<tr><td colspan="3" class="mut">No files yet</td></tr>'}</table></div>`,"document.getElementById('dvm').remove()",'Close')}],
      ['Run Due Tasks Now',async c=>{const r=await api('zk/exports-tick','POST');say(r.ran+' task(s) ran',c)}]]]]});
expGrid('zk:exptx','Attendance Transaction','tx');expGrid('zk:exprep','Attendance Report','report');
{const orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='zk:exptx'&&key!=='zk:exprep')return orig(key,id);const s=ZK.G[key],row=id?s.all.find(r=>r.id===id):{...s.o.defaults};ZK.form((id?'Edit ':'Add ')+(key==='zk:exptx'?'Attendance Transaction':'Attendance Report')+' Task',s.o.fields,{...row,enabled:!!row.enabled,contains_heads:!!row.contains_heads},async b=>s.o.save(b,id?row:null))}}

// ---------- Middleware tables ----------
const mwGrid=(key,title,kind,codeL,nameL,extraCols,extraFields)=>ZK.grid(key,title,{module:AD,load:async()=>api('zk/mw/'+kind),
  note:'Rows added here (or by another program) are applied to the real personnel tables automatically within seconds. Flag Add/Update creates or changes the record, Delete removes it.',
  cols:[[codeL,'code'],...(kind==='emp'?[]:[[nameL,'name']]),...extraCols,['Submit Time','submit_time'],['Flag','flag_label'],['Target Time','target_time'],['Status','status']],
  fields:[{k:'code',l:codeL,t:'text',req:true},...(kind==='emp'?[]:[{k:'name',l:nameL,t:'text'}]),...extraFields,{k:'flag',l:'Flag',t:'select',blank:false,opts:[[0,'Add/Update'],[1,'Delete']]}],defaults:{flag:0},api:'zk/mw/'+kind,
  acts:[['Add'],['Delete'],['Process Now',async c=>{const r=await api('zk/mw-process','POST');say(`${r.applied} applied, ${r.failed} failed`,c)}]]});
mwGrid('zk:mwdept','Department','dept','Department Code','Department Name',[],[]);mwGrid('zk:mwpos','Position','pos','Position Code','Position Name',[],[]);mwGrid('zk:mwarea','Area','area','Area Code','Area Name',[],[]);
const g=k=>r=>r[k]||'';
mwGrid('zk:mwemp','Employee','emp','Employee ID','',[['First Name',g('first_name')],['Last Name',g('last_name')],['Department Code',g('dept_code')],['Department Name',g('dept_name')],['Position Code',g('pos_code')],['Position Name',g('pos_name')],['Area Code',g('area_code')],['Area Name',g('area_name')],['Multiple Area',g('multi_area')],['Card NO.',g('card_no')],['Hired Date',g('hired_date')],['Gender',g('gender')],['Birthday',g('birthday')],['Email',g('email')],['Active Status',g('active')]],
  [{k:'first_name',l:'First Name',t:'text'},{k:'last_name',l:'Last Name',t:'text'},{k:'dept_code',l:'Department Code',t:'text'},{k:'dept_name',l:'Department Name',t:'text'},{k:'pos_code',l:'Position Code',t:'text'},{k:'pos_name',l:'Position Name',t:'text'},{k:'area_code',l:'Area Code',t:'text'},{k:'area_name',l:'Area Name',t:'text'},{k:'multi_area',l:'Multiple Area',t:'text'},{k:'card_no',l:'Card NO.',t:'text'},{k:'hired_date',l:'Hired Date',t:'date'},{k:'gender',l:'Gender',t:'select',opts:[['M','Male'],['F','Female']]},{k:'birthday',l:'Birthday',t:'date'},{k:'email',l:'Email',t:'text'},{k:'active',l:'Active Status',t:'select',blank:false,opts:[['Yes','Yes'],['No','No']]}]);

// ---------- Log ----------
ZK.grid('Audit log','User Log',{module:AD,load:async()=>api('zk/userlog'),cols:[['User','user'],['IP Address','ip'],['Action Time','ts'],['Action','action'],['Content Type','ctype'],['Object','object'],['Status','status'],['Describe','description']],
  fields:[{k:'action',l:'Action',t:'text',req:true},{k:'ctype',l:'Content Type',t:'text'},{k:'object',l:'Object',t:'text'},{k:'description',l:'Describe',t:'text'}],api:'zk/userlog',note:'Every change made through the system, and every sign-in, with who and from where.'});
ZK.grid('zk:syslog','System Log',{module:AD,load:async()=>api('zk/syslog'),cols:[['Execution Time','ts'],['Operation','operation'],['Result','result'],['Description','description']],
  fields:[{k:'operation',l:'Operation',t:'text',req:true},{k:'result',l:'Result',t:'select',blank:false,opts:[['Success','Success'],['Failed','Failed']]},{k:'description',l:'Description',t:'text'}],api:'zk/syslog'});
ZK.grid('zk:calclog','Calculation Log',{module:AD,load:async()=>api('zk/calclog'),cols:[['Execution Time','ts'],['Task','task'],['Started By','started_by'],['Result','result'],['Employees','employees'],['Time Spent',r=>r.seconds==null?'':r.seconds+' s'],['Attendance Dates','dates'],['Run Group','run_group'],['Details','details'],['Processed By','processed_by']],
  note:'Add runs the attendance calculation for a period and records it here.',
  fields:[{k:'from',l:'Attendance Dates from',t:'date',req:true},{k:'to',l:'to',t:'date',req:true},{k:'department_id',l:'Run Group (department)',t:'select',opts:deps,blank:'All employees'}],defaults:{from:mstart(),to:today()},
  save:async b=>{await api('zk/calclog','POST',b)},remove:async id=>api('zk/calclog/'+id,'DELETE')});
ZK.grid('zk:apireq','API Request',{module:AD,load:async()=>api('zk/apireq'),cols:[['User','user'],['Request Time','ts'],['Path','path'],['Method','method'],['Host','host'],['Remote Address','ip'],['Status','status'],['Time',r=>r.ms+' ms'],['Errors','error']],
  acts:[['Delete']],remove:async id=>api('zk/apireq/'+id,'DELETE'),note:'Requests of other software to the /api/v1 interface (the key name is the user).'});
ZK.grid('zk:walog','WhatsApp Log',{module:AD,load:async()=>api('zk/walog'),cols:[['Employee ID',r=>r.emp_code||''],['Content','content'],['Status','status'],['Reason','reason'],['Push Time','ts']],
  fields:[{k:'emp_code',l:'Employee ID',t:'text',hint:'or a phone number below'},{k:'phone',l:'Phone',t:'text'},{k:'content',l:'Content',t:'textarea',req:true}],
  save:async b=>{await api('zk/walog','POST',b)},remove:async id=>api('zk/walog/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Resend',async c=>{need(c);const r=await api('zk/walog/resend','POST',{ids:c.ids});say(`${r.sent} sent, ${r.failed} failed`,c)}]]});

// ---------- Configuration ----------
settingsPage('zk:bgtask','Background Task Setting',{path:'zk/settings/bgtask',note:'Switch the background work of a module off or on. Payroll: hourly salary sync. Access Control: door events and alerts for punches. Meeting and MTD have no background work in this system yet.',
  sections:[['',[bool('meeting','Meeting'),bool('payroll','Payroll'),bool('ep','MTD'),bool('access','Access Control'),{k:'retention',l:'Task History Retention (days)',t:'number',min:1,hint:'older system, calculation, API request and WhatsApp log rows are removed'}]]]});
settingsPage('zk:ldap','LDAP Setup',{path:'zk/settings/ldap',note:'The connection details are stored and the server address can be tested. Signing in with LDAP accounts is not available in this system yet.',tests:[['Test Connection','zk/settings/ldap/test']],
  sections:[['',[{k:'host',l:'Host Address',t:'text',req:true},{k:'port',l:'Port Number',t:'number',req:true},{k:'username',l:'Username',t:'text',req:true},{k:'password',l:'Password',t:'password',req:true}]],
    ['Employee',[{k:'emp_location',l:'Location',t:'text'},bool('emp_auth','Authenticate'),bool('emp_sync','Auto Sync'),{k:'sync_frequency',l:'Frequency',t:'select',opts:[[1,'Daily'],[2,'Weekly'],[3,'Monthly']]},{k:'sync_day',l:'Day',t:'number'},{k:'sync_time',l:'Time',t:'text'}]],
    ['User',[{k:'user_location',l:'Location',t:'text'},bool('user_auth','Authenticate')]]]});
settingsPage('zk:zoom','Zoom Setting',{path:'zk/settings/zoom',tests:[['Test Credentials','zk/settings/zoom/test']],sections:[['',[{k:'account_id',l:'Account ID',t:'text',req:true},{k:'client_id',l:'Client ID',t:'text',req:true},{k:'client_secret',l:'Client Secret',t:'password',req:true},bool('zoom_enable','Enable')]]]});
settingsPage('zk:twilio','Twilio Setting',{path:'zk/settings/twilio',note:'When enabled (and no SMS_URL gateway is set on the server), SMS messages of the alerts and automation rules are sent through this Twilio account.',tests:[['Test Credentials','zk/settings/twilio/test']],
  sections:[['',[{k:'mobile',l:'Mobile',t:'text',req:true,hint:'your Twilio number, like +15005550006'},{k:'account_sid',l:'Account Sid',t:'text',req:true},{k:'auth_token',l:'Auth Token',t:'password',req:true},bool('twilio_enable','Enable')]]]});
settingsPage('zk:security','Security Settings',{path:'zk/settings/security',note:'Settings marked "saved" are stored but not enforced yet (the sign-in screen has no code prompt). All others apply at once.',
  sections:[['Login Setup',[bool('single_login','Single Login',{hint:'a new sign-in ends the older session of the same account'}),bool('security_code','Verification Code',{hint:'saved'}),{k:'code_length',l:'Length of Code',t:'number',unit:'Digit(s) - saved'},{k:'valid_duration',l:'Valid Duration',t:'number',unit:'Minute(s) - saved'},{k:'failed_times',l:'Login Failures Exceed',t:'number',unit:'Times - saved'},
      bool('failed_locked','Lock Settings',{hint:'lock an account after repeated wrong passwords'}),{k:'lock_failed_count',l:'Failed Login',t:'number',unit:'Times'},{k:'lock_duration',l:'Lock Duration',t:'number',unit:'Minute(s)'},bool('app_single_user_login','App Single User Login',{hint:'saved'}),bool('app_single_device_login','App Single Device Login',{hint:'saved'}),bool('web_2fa_user','WEB 2FA Admin',{hint:'saved'}),{k:'code_length_2fa',l:'Length of Code',t:'number',unit:'saved'}]],
    ['Password Policy',[{k:'password_level',l:'Password Strength',t:'select',opts:[[1,'Weak (6+ characters)'],[2,'Normal (8+, letters and digits)'],[3,'Strong (8+, upper, lower, digit, symbol)']],hint:'checked whenever a password is set'},bool('enforce_pwd_change','User must change the password at first login',{hint:'saved'}),bool('enforce_pwd_expiration','Enforce Password Expiration',{hint:'saved'}),{k:'validity_period',l:'Validity Duration',t:'number',unit:'Days - saved'}]],
    ['Session Timeout',[{k:'session_timeout',l:'Session Timeout',t:'number',unit:'Minute(s) of inactivity, 0 = never'}]],
    ['Export Security',[bool('export_encryption','Export Encryption',{hint:'saved'}),bool('backup_encryption','Backup Encryption',{hint:'saved'})]]]});
// Email Template: one template per event
ZK.reg('zk:emailtpl','Email Template',async()=>{const d=await api('zk/email-templates');window.ZET=d;return `<div class="zsp"><h2>Email Template</h2><p class="mut">A template per event. When switched on, alert e-mails of that event use the subject and text, with the macros filled in. (E-mail itself needs SMTP_URL on the server.)</p>
 <div class="grid" style="max-width:760px"><label>Event<select id="et_ev" onchange="etPick()">${d.events.map(e=>`<option value="${e.event}">${esc(titleCase(e.event))}${e.enable?' (on)':''}</option>`).join('')}</select></label><label>Subject<input id="et_sub"></label><label>Status<input id="et_on" type="checkbox"></label>
 <label>Macros<span class="sm">${d.macros.map(m=>`<a class="zl" onclick="etIns('${m}')">${m}</a>`).join(' ')}</span></label><label>Template<textarea id="et_tpl" rows="8"></textarea></label></div>
 <div style="margin-top:14px"><button class="zb" style="border:1px solid #ccc" onclick="etSave()">Save</button> <span id="et_msg" class="sm"></span></div></div>`},AD);
window.etPick=()=>{const e=ZET.events.find(x=>x.event===val('et_ev'));document.getElementById('et_sub').value=e.subject;document.getElementById('et_on').checked=!!e.enable;document.getElementById('et_tpl').value=e.template};
window.etIns=m=>{const t=document.getElementById('et_tpl');t.setRangeText(m,t.selectionStart,t.selectionEnd,'end');t.focus()};
window.etSave=async()=>{const m=document.getElementById('et_msg');try{const ev=val('et_ev'),r=await api('zk/email-templates/'+ev,'PUT',{subject:val('et_sub'),enable:document.getElementById('et_on').checked,template:val('et_tpl')});Object.assign(ZET.events.find(x=>x.event===ev),r);m.style.color='var(--ok,#2a9d5c)';m.textContent='Saved'}catch(e){m.style.color='#d9453f';m.textContent=e.message}};
const emailAfter=window.afterRender;
{const f=ZK.pages['zk:emailtpl'];ZK.pages['zk:emailtpl']=async()=>{const h=await f();window.afterRender=()=>etPick();return h};if(typeof pages==='object')pages['zk:emailtpl']=ZK.pages['zk:emailtpl']}

// ---------- Configuration > FTP Settings ----------
ZK.grid('zk:ftp','FTP Settings',{module:AD,load:async()=>api('zk/ftp'),cols:[['Host Address','host',{link:true}],['Port Number','port'],['Username','username'],['Is SFTP',r=>yn(r.is_sftp)]],
  fields:[{k:'host',l:'Host Address',t:'text',req:true},{k:'port',l:'Port Number',t:'number',req:true},{k:'is_sftp',l:'Is SFTP',t:'select',blank:false,opts:[[0,'No'],[1,'Yes']],hint:'SFTP servers can be saved, but files are only uploaded to plain FTP'},{k:'username',l:'Username',t:'text',req:true},{k:'password',l:'Password',t:'password'},{k:'ssh_key',l:'SSH Key',t:'textarea'}],defaults:{port:21,is_sftp:0},api:'zk/ftp'});

// ---------- Configuration > Bookmarks (server-side store; the toolbar menu can use window.ZKBM) ----------
window.ZKBM={list:()=>api('bookmarks'),add:(title,content_type,filters='',shared=false)=>api('bookmarks','POST',{title,content_type,filters,shared}),del:id=>api('bookmarks/'+id,'DELETE')};
ZK.grid('zk:bookmarks','Bookmarks',{module:undefined,load:async()=>api('bookmarks'),cols:[['Title','title',{link:true}],['User','user'],['Content Type',r=>ZK.t(r.content_type)],['Filters','filters'],['Shared Status',r=>r.shared?'Shared':'Private'],['Saved Time','saved']],
  fields:[{k:'title',l:'Title',t:'text',req:true},{k:'content_type',l:'Content Type',t:'select',req:true,opts:()=>Object.keys(ZK.title).concat(Object.keys(typeof pages==='object'?pages:{})).filter((k,i,a)=>a.indexOf(k)===i).sort().map(k=>[k,ZK.t(k)])},{k:'filters',l:'Filters',t:'text'},{k:'shared',l:'Shared',t:'checkbox'}],
  save:async(b,row)=>{const body={...b,shared:!!b.shared};await api(row?'bookmarks/'+row.id:'bookmarks',row?'PUT':'POST',body)},remove:async id=>api('bookmarks/'+id,'DELETE')});
})();
