// ZKT-style Device pack: Device, Device Command, Parameter, Messages, Data, Logs, Mobile App, Geo-fence, Configurations.
(()=>{
const U=window.ZKU=window.ZKU||{
  pick:(accept,multiple)=>new Promise(ok=>{const i=document.createElement('input');i.type='file';i.accept=accept||'';i.multiple=!!multiple;i.style.display='none';i.onchange=()=>{ok([...i.files]);i.remove()};document.body.appendChild(i);i.click()}),
  text:f=>f.text(),
  empOpts:async()=>(await api('employees?status=active')).map(e=>[e.id,e.code+' - '+e.name]),
  devOpts:async()=>(await api('devices')).map(d=>[d.id,d.name+(d.sn?' ('+d.sn+')':'')]),
  dl:(url,name)=>fileDl(url,name),
  say:(m)=>alert(m),
};
const E=zE,D='devices';
const need=ctx=>{if(!ctx.ids.length)throw new Error('Tick at least one row first');return ctx.ids};
const delRows=(path,method)=>async id=>api(path.replace('{id}',id),method||'DELETE');
const dtl=v=>v?String(v).replace('T',' ').slice(0,19):'';
const ONOFF=[['1','On'],['0','Off']];

// ---------- Device ----------
const DEV_FIELDS={ // arguments some device actions need
  'upload-tx':[{k:'from',l:'From date',t:'date'},{k:'to',l:'To date',t:'date'}],
  'enroll-remote':[{k:'pin',l:'Employee ID',req:true},{k:'fid',l:'Finger index (0-9)',t:'number'}],
  'dup-punch':[{k:'minutes',l:'Ignore repeated punches within (minutes)',t:'number',req:true}],
  'capture-setting':[{k:'on',l:'Capture a photo when punching',t:'select',opts:ONOFF,blank:false}],
  upgrade:[{k:'url',l:'Firmware file address (http/https)',req:true},{k:'checksum',l:'Checksum'},{k:'size',l:'File size (bytes)',t:'number'}],
  dst:[{k:'on',l:'Daylight saving time',t:'select',opts:ONOFF,blank:false}],
  'punch-state':[{k:'on',l:'Change punch state automatically',t:'select',opts:ONOFF,blank:false}],
  'download-file':[{k:'path',l:'File name on the device',req:true}],
  'set-option':[{k:'name',l:'Option name',req:true},{k:'value',l:'Value'}]};
const DEV_TITLE={'upload-tx':'Upload Transaction','enroll-remote':'Enroll Remotely','dup-punch':'Duplicate Punch Period','capture-setting':'Capture Setting',upgrade:'Upgrade Firmware',dst:'Daylight Saving Time','punch-state':'Punch State Change Setting','download-file':'Download File','set-option':'Set Option'};
const DEV_ASK={'clear-attlog':'Delete the punch log stored ON # device(s)?\nPunches already in this system stay.','clear-photo':'Delete the captured images stored ON # device(s)?','clear-admin':'Remove administrator privilege from every known administrator on # device(s)?','clear-all':'Delete ALL users, fingerprints, faces and punches stored ON # device(s)?\nThis cannot be undone on the device.','sync-to-device':'Send every allowed employee to # device(s)? This can be a lot of commands.',reboot:'Restart # device(s) now?'};
window.zkDev=async action=>{
  const ids=zsel('dev');if(!ids.length)return alert('Tick at least one device first');
  const send=async args=>{const r=await api('zkd/devices/action','POST',{ids,action,args});alert(`${r.queued} command(s) queued for ${r.done} device(s)`+(r.skipped?`, ${r.skipped} skipped (only approved push devices take commands)`:'')+'. They go out when the device next checks in; see Device Command.');};
  if(DEV_FIELDS[action])return ZK.form(DEV_TITLE[action],DEV_FIELDS[action],{on:'1'},send,'Send');
  if(DEV_ASK[action]&&!confirm(DEV_ASK[action].replace('#',ids.length)))return;
  try{await send({});go(cur)}catch(e){alert(e.message)}};
{
  ZK.reg('Devices','Device',async()=>{
    const [d,g,br]=await Promise.all([api('devices'),api('device_groups'),api('branches')]);window.DEVS=d;window.DEVG=g;window.DEVB=br;
    const sel=window.devSel?d.find(x=>x.id===window.devSel):null;let panel='';
    if(sel){const tb=window.devTab||'overview',pf=window.devPf||{};let cm=[],es=[],ex=null;
      if(tb==='queue')[cm,es]=await Promise.all([api(`devices/${sel.id}/commands`),api(`devices/${sel.id}/events`)]);
      else if(tb==='users')ex=await api(`devices/${sel.id}/users`);
      else if(tb==='punches')ex=await api(`devices/${sel.id}/punches?from=${pf.from||''}&to=${pf.to||''}&q=${encodeURIComponent(pf.q||'')}`);
      else if(tb==='health')ex=await api(`devices/${sel.id}/health?days=${window.devDays||7}`);
      else if(tb==='maint')ex=await api(`devices/${sel.id}/maintenance`);
      else if(tb==='access')ex=await api(`devices/${sel.id}/access`);
      panel=devPanel(sel,g,cm,es,await api('settings').catch(()=>({})),ex)}
    const dd=(l,items)=>ddm(l,items.map(([t,a])=>[t,`zkDev('${a}')`]));
    return `<h2>Device <span class="cnt">${d.length}</span></h2>
    <div class="ztool"><div class="zgrp">${zb('Add','devForm()')}${zb('Delete',"devBulk('delete')",'zdel')}${zb('New Area','devArea()')}${zb('Clear Pending Command',"devBulk('clear-commands')")}
    ${dd('Data Clean',[['Clear Attendance Data','clear-attlog'],['Clear the captured image','clear-photo'],['Clear administrator privilege','clear-admin'],['Clear All Data','clear-all']])}
    ${dd('Data Transfer',[['Upload User Data','upload-users'],['Upload Transaction','upload-tx'],['Sync Data to the Device','sync-to-device']])}
    ${dd('Device Menu',[['Reboot','reboot'],['Read Information','info'],['Enroll Remotely','enroll-remote'],['Duplicate Punch Period','dup-punch'],['Capture Setting','capture-setting'],['Upgrade Firmware','upgrade'],['Daylight Saving Time','dst'],['Punch State Change Setting','punch-state']])}
    ${dd('Maintain',[['Download File','download-file'],['Set Option','set-option']])}</div>
    <div class="zrt"><button class="zi" title="Select all" onclick="zall('dev',true)">&#9745;</button><button class="zi" title="Clear selection" onclick="zall('dev',false)">&#9744;</button><button class="zi" title="Export CSV" onclick="devExport()">&#8681;</button><button class="zi" title="Import CSV" onclick="devImport()">&#8682;</button><button class="zi" title="How to connect" onclick="devGuide()">?</button></div></div>`+
    tbl([zcol('dev'),['Device Name','name',x=>`<a class="zl" onclick="window.devSel=${x.id};window.devTab='overview';go('Devices')">${esc(x.name)}</a>`],['Serial Number','sn',x=>esc(x.sn||'')],['Area','group_name'],['Device IP','ip',x=>esc(x.ip||'')],['State','online',x=>(x.approved?'':'')+stIcon(x)+(x.approved?'':` <a class="zl" onclick="devSet(${x.id},{approved:true})">Approve</a>`)],['Last Activity','last_seen',x=>esc(x.last_seen||x.last_sync||'')],['User Qty.','user_qty'],['FP Qty.','fp_qty'],['Face Qty.','face_qty'],['Palm Qty.',()=>'0'],['Transaction Qty.','punches'],['Cmd','pending_commands',x=>x.pending_commands||0]],d)+panel},D);
}

// ---------- Device Command / Command Log ----------
const cmdAdd=()=>ZK.form('Add Device Command',[{k:'device_id',l:'Device',t:'select',opts:()=>U.devOpts(),req:true},{k:'cmd',l:'Content',t:'textarea',req:true,hint:'For example: REBOOT, CLEAR LOG, SET OPTION Delay=20. Use \\t for a tab.'}],{},async b=>{await api('zkd/commands','POST',{device_ids:[+b.device_id],cmd:b.cmd})});
const bulkDel=(scope,label)=>ZK.form('Bulk Delete',[{k:'before',l:'Delete '+label+' committed before',t:'date',req:true}],{before:today()},async b=>{const r=await api('zkd/commands/bulk-delete','POST',{before:b.before,scope});alert(r.cleared+' removed')},'Delete');
const clearAll=scope=>async c=>{if(!confirm('Remove ALL commands in this list?'))return;const r=await api('zkd/commands/clear-all','POST',{scope});alert(r.cleared+' removed');c.reload()};
const delCmds=async c=>{const i=need(c);if(!confirm(`Delete ${i.length} command(s)?`))return;await api('zkd/commands/delete','POST',{ids:i});c.reload()};
const cmdCols=[['Serial Number','sn'],['Device Name','device'],['Content',c=>`<code>${E(c.cmd)}</code>`,{html:true}]];
ZK.grid('Device commands','Device Command',{module:D,load:()=>api('zkd/commands?scope=queue'),
  cols:[...cmdCols,['Commit Time','created'],['Transfer Time','sent']],
  acts:[['Add',cmdAdd],['Delete',delCmds],['Bulk Delete',()=>bulkDel('queue','commands')],['Clear all ',clearAll('queue')]]});
ZK.grid('zk:cmdlog','Command Log',{module:D,load:()=>api('zkd/commands?scope=log'),
  cols:[...cmdCols,['Commit Time','created'],['Transfer Time','sent'],['Return Time','returned'],['Return Value','value']],
  acts:[['Add',cmdAdd],['Delete',delCmds],['Bulk Delete',()=>bulkDel('log','answered commands')],['Clear all ',clearAll('log')]]});

// ---------- Device Parameter ----------
ZK.grid('zk:devparam','Device Parameter',{module:D,load:()=>api('zkd/params'),api:'zkd/params',
  cols:[['Serial Number','sn'],['Device Name','device'],['Name','name',{link:true}],['Value','value']],
  fields:[{k:'device_id',l:'Device',t:'select',opts:()=>U.devOpts(),req:true},{k:'name',l:'Name',req:true,hint:'The device option, e.g. Delay, ErrorDelay, Realtime'},{k:'value',l:'Value'},{k:'push',l:'Send to the device now (SET OPTION)',t:'checkbox'}],
  save:(b,row)=>row?api('zkd/params/'+row.id,'PUT',{value:b.value,push:b.push}):api('zkd/params','POST',b)});

// ---------- Messages ----------
const checkList=(cls,rows)=>`<div style="max-height:180px;overflow:auto;border:1px solid var(--line);padding:4px">${rows.map(r=>`<label style="display:flex;flex-direction:row;justify-content:flex-start;gap:8px;align-items:center;font-weight:500"><input type="checkbox" class="${cls}" value="${r[0]}" ${r[2]?'checked':''}>${E(r[1])}</label>`).join('')||'<span class="mut sm">None</span>'}</div>`;
async function msgForm(scope,id,rows){
  const pv=scope==='private',x=id?rows.find(r=>r.id===id)||{}:{},[devs,emps]=await Promise.all([api('devices'),pv&&!id?U.empOpts():[]]);
  const now=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  orgModal((id?'Edit ':'Add ')+(pv?'Private':'Public')+' Message',`<div class="grid"><label>Content<input id="mg_c" maxlength="200" value="${E(x.content||'')}"></label><label>Start Time<input id="mg_s" type="datetime-local" value="${E((x.start_ts||now).replace(' ','T').slice(0,16))}"></label><label>Duration (minutes)<input id="mg_d" type="number" min="1" max="65535" value="${x.duration_min||1440}"></label></div>
    <p class="mut sm" style="margin:8px 0 2px">Devices (none ticked = every device)</p>${checkList('mgdv',devs.map(d=>[d.id,d.name+(d.sn?' ('+d.sn+')':''),(x.device_ids||[]).includes(d.id)]))}
    ${pv&&!id?`<p class="mut sm" style="margin:8px 0 2px">Employees</p>${checkList('mgem',emps)}`:''}`,`zkMsgSave('${scope}',${id||0})`)}
window.zkMsgSave=async(scope,id)=>{try{const b={scope,content:val('mg_c'),start_ts:val('mg_s'),duration_min:val('mg_d'),device_ids:[...document.querySelectorAll('.mgdv:checked')].map(c=>+c.value),employee_ids:[...document.querySelectorAll('.mgem:checked')].map(c=>+c.value)};await api(id?'zkd/messages/'+id:'zkd/messages',id?'PUT':'POST',b);document.getElementById('dvm').remove();go(cur)}catch(e){document.getElementById('om_e').textContent=e.message}};
for(const [key,scope,title] of [['Public message','public','Public Message'],['Private message','private','Private Message']]){
  const pv=scope==='private';
  ZK.grid(key,title,{module:D,load:()=>api('zkd/messages?scope='+scope),api:'device-messages',
    cols:[...(pv?[['Employee',r=>`<a class="zl" onclick="ZK.edit('${key}',${r.id})">${E((r.code||'')+' '+(r.employee||''))}</a>`,{html:true}]]:[['Device Name','device'],['Serial Number','sn']]),['Content',pv?'content':r=>`<a class="zl" onclick="ZK.edit('${key}',${r.id})">${E(r.content)}</a>`,pv?{}:{html:true}],['Start Time','start_ts'],['Duration','duration_min'],['Last Sent',r=>r.last_sent||'']],
    acts:[['Add',()=>msgForm(scope)],['Delete'],['Send Message',async c=>{const i=need(c);let n=0;for(const id of i)n=(await api(`zkd/messages/${id}/send`,'POST',{})).devices;alert(`Sent to ${n} device(s)`);c.reload()}]]});
}
{const edit=ZK.edit;ZK.edit=(key,id)=>{if(key==='Public message'||key==='Private message'){const s=ZK.G[key];return msgForm(key==='Private message'?'private':'public',id,s.all)}return edit(key,id)}}

// ---------- Data > Employee (users on devices) ----------
const PRIV={0:'User',2:'Enroller',6:'Administrator',14:'Super Administrator'},VMODE={0:'Any (Default)',1:'Fingerprint',3:'Password',4:'Card',15:'Face'};
const dtAct=(action,ask)=>async c=>{const i=need(c);if(ask&&!confirm(ask.replace('#',i.length)))return;const r=await api('zkd/devemp/transfer','POST',{ids:i,action});alert(`${r.done} item(s) queued or done. See Device Command.`);c.reload()};
const enrollAct=type=>async c=>{const r=await api('zkd/devemp/enroll','POST',{ids:need(c),type});alert(`${r.queued} enrollment command(s) queued. The person enrolls at the device.`);c.reload()};
ZK.grid('zk:devemp','Employee',{module:D,load:()=>api('zkd/devemp'),
  cols:[['Employee ID',r=>`<a class="zl" onclick="ZK.edit('zk:devemp',${r.id})">${E(r.code)}</a>`,{html:true}],['First Name','name'],['Department','dept'],['Card NO.','card'],['Fingerprint','fp'],['Face','face'],['Palm','palm'],['VL Palm',()=>'0'],['VL Face',()=>'0'],['VL Face Photo',()=>'0'],['Enroll Device','device'],['Device Privilege',r=>PRIV[r.priv]||r.priv],['Verify Mode',r=>VMODE[r.verify_mode]||r.verify_mode],['Update Time','seen'],['Area','area']],
  fields:[{k:'priv',l:'Device Privilege',t:'select',opts:Object.entries(PRIV),blank:false},{k:'verify_mode',l:'Verify Mode',t:'select',opts:Object.entries(VMODE),blank:false}],
  save:(b,row)=>api('zkd/devemp/'+row.id,'PUT',{priv:+b.priv,verify_mode:+b.verify_mode}),
  acts:[['Add',()=>ZK.form('Add Employee to Device',[{k:'device_id',l:'Device',t:'select',opts:()=>U.devOpts(),req:true},{k:'employee_id',l:'Employee',t:'select',opts:()=>U.empOpts(),req:true}],{},async b=>{await api('zkd/devemp','POST',{device_id:+b.device_id,employee_ids:[+b.employee_id]})})],
    ['Delete',async c=>{const i=need(c);if(!confirm(`Remove ${i.length} user(s) from their device? The employee record stays.`))return;await api('zkd/devemp/delete','POST',{ids:i});c.reload()}],
    ['Area Transfer',async c=>{const rows=need(c)&&c.rows.filter(r=>r.employee_id);if(!rows.length)throw new Error('The ticked people are not employees yet');const a=await api('branches');ZK.form('Area Transfer',[{k:'to_id',l:'New area',t:'select',opts:a.map(x=>[x.id,x.name]),req:true},{k:'date',l:'Effective date',t:'date'}],{date:today()},async b=>{const r=await api('zkp/employees/transfer','POST',{kind:'area',to_id:b.to_id,employee_ids:[...new Set(rows.map(r=>r.employee_id))],date:b.date||today()});alert(r.moved+' moved')},'Transfer')}],
    ['Data Transfer',[['Resynchronize to device',dtAct('resync')],['Re-upload from device',dtAct('reupload')],['Delete the Biometric Template',dtAct('delete-bio','Delete the stored fingerprints and faces of # user(s)?')]]],
    ['Data Enrollment',[['Enroll Fingerprint',enrollAct('fp')],['Enroll Palm',enrollAct('palm')],['Enroll Face Photo',enrollAct('face')]]]]});

// ---------- Work Code ----------
const wcSend=op=>async c=>{const i=need(c),devs=await U.devOpts();ZK.form(op==='send'?'Send to Device':'Remove from Device',[{k:'device_id',l:'Device',t:'select',opts:devs,blank:'All approved push devices'}],{},async b=>{const r=await api('zkd/workcodes/send','POST',{ids:i,action:op,device_ids:b.device_id?[+b.device_id]:[]});alert(`${r.queued} command(s) queued for ${r.devices} device(s)`)},'Send')};
ZK.grid('zk:workcode','Work Code',{module:D,load:()=>api('zkd/workcodes'),api:'zkd/workcodes',
  cols:[['Code','code',{link:true}],['Name','name'],['Last Activity','last_activity']],
  fields:[{k:'code',l:'Code',req:true,hint:'A number, up to 8 digits'},{k:'name',l:'Name',req:true}],
  acts:[['Add'],['Delete'],['Send to Device',wcSend('send')],['Remove from Device',wcSend('remove')]]});

// ---------- Bio-Template (read-only) ----------
ZK.list('zk:biotpl','Bio-Template',{module:D,load:()=>api('zkd/biotemplates'),
  cols:[['Employee ID','code'],['First Name','name'],['Last Name',()=>''],['Bio-Type','type'],['Bio-Index','fid'],['Major Version','major'],['Minor Version','minor'],['Serial Number','sn'],['Update Time','received']]});

// ---------- Bio-Photo ----------
const thumb=(v)=>v?`<img src="${E(v)}" style="height:34px;border:1px solid var(--line)">`:'';
async function bioPhotoAdd(){
  orgModal('Add Bio-Photo',`<div class="grid"><label>Employee<select id="bp_e">${opt((await api('employees?status=active')).map(e=>({id:e.id,name:e.code+' - '+e.name})),'','Choose...')}</select></label><label>Bio-Photo<input id="bp_f" type="file" accept="image/jpeg,image/png"></label><label>User Photo (optional)<input id="bp_u" type="file" accept="image/jpeg,image/png"></label><label>Remark<input id="bp_r"></label></div>`,'zkBioSave()')}
window.zkBioSave=async()=>{try{const f=document.getElementById('bp_f').files[0],u=document.getElementById('bp_u').files[0];if(!val('bp_e'))throw new Error('Choose the employee');if(!f)throw new Error('Choose the bio photo');await api('zkd/biophotos','POST',{employee_id:+val('bp_e'),bio_photo:await readFile(f),user_photo:u?await readFile(u):null,remark:val('bp_r')});document.getElementById('dvm').remove();go(cur)}catch(e){document.getElementById('om_e').textContent=e.message}};
ZK.grid('zk:biophoto','Bio-Photo',{module:D,load:()=>api('zkd/biophotos'),api:'zkd/biophotos',
  cols:[['Employee ID','code'],['First Name','name'],['Last Name',()=>''],['Email','email'],['Serial Number','serial'],['User Photo',r=>thumb(r.user_photo),{html:true}],['Bio-Photo',r=>thumb(r.bio_photo),{html:true}],['Register Time','register_time'],['Remark','remark'],['Approval State','approval_state'],['Approval Time','approval_time']],
  acts:[['Add',bioPhotoAdd],['Delete'],['Approve',async c=>{const r=await api('zkd/biophotos/approve','POST',{ids:need(c)});alert(`${r.done} approved, ${r.queued} command(s) queued for the devices`);c.reload()}],
    ['QR Code',async()=>{const r=await api('zkd/biophotos/qr-info');orgModal('QR Code',`<p>Employees register their own photo at this address (employee portal):</p><p><b>${E(r.url)}</b></p><p class="mut sm">Print this address as a QR code with any QR generator and display it for staff.</p>`,"document.getElementById('dvm').remove()",'OK')}],
    ['Import Bio-Photo',async c=>{const fs=await U.pick('image/jpeg,image/png',true);if(!fs.length)return;let ok=0;const bad=[];for(const f of fs){const code=f.name.replace(/\.[^.]+$/,'').split(/[_\s]/)[0];try{await api('zkd/biophotos','POST',{code,bio_photo:await readFile(f)});ok++}catch(e){bad.push(f.name+' ('+e.message+')')}}alert(`${ok} imported`+(bad.length?'\nNot imported (file name = Employee ID):\n'+bad.slice(0,6).join('\n'):''));c.reload()}]]});

// ---------- Transaction ----------
window.zkTxFilter=()=>{window.txf={from:val('tx_f'),to:val('tx_t'),q:val('tx_q')};go('zk:transaction')};
ZK.grid('zk:transaction','Transaction',{module:D,
  get note(){const f=window.txf||{from:addD(today(),-6),to:today(),q:''};return `<div class="fbar" style="margin:6px 0"><input id="tx_q" placeholder="Employee ID or name" value="${E(f.q||'')}"><input id="tx_f" type="date" value="${E(f.from)}"><input id="tx_t" type="date" value="${E(f.to)}"><button onclick="zkTxFilter()">Search</button></div>`},
  load:()=>{const f=window.txf||{};return api('zkd/transactions?'+new URLSearchParams(Object.entries(f).filter(x=>x[1])))},
  remove:id=>api('zkd/transactions/delete','POST',{ids:[id]}),
  cols:[['Employee ID','code'],['First Name','name'],['Department','dept'],['Date',r=>r.ts.slice(0,10)],['Time',r=>r.ts.slice(11)],['Punch State','state'],['Area Name','area'],['Serial Number','sn'],['Device Name','device'],['Upload Time','uploaded']],
  acts:[['Add',()=>ZK.form('Add Transaction',[{k:'emp',l:'Employee',t:'select',opts:async()=>(await api('employees?status=active')).map(e=>[e.code,e.code+' - '+e.name]),req:true},{k:'ts',l:'Punch time',t:'datetime',req:true}],{ts:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16).replace('T',' ')},async b=>{const r=await api('logs/manual','POST',{emp_code:b.emp,ts:b.ts});if(!r.added)throw new Error('This punch already exists')})],['Delete'],
    ['Upload USB Transactions',async c=>{const fs=await U.pick('.csv,.txt,.dat,text/csv');if(!fs[0])return;const r=await api('logs/import','POST',{csv:await fs[0].text()});alert(`${r.parsed} line(s) read, ${r.added} new punch(es) added`);c.reload()}],
    ['Download Attendance Photo',()=>ZK.form('Download Attendance Photo',[{k:'from',l:'From date',t:'date'},{k:'to',l:'To date',t:'date'}],{from:addD(today(),-6),to:today()},async b=>{const r=await api('zkd/transactions/photos','POST',b);alert(`Asked ${r.devices} device(s) to upload their attendance photos`)},'Request')]]});

// ---------- Logs ----------
const clearBefore=(path,title)=>c=>ZK.form('Bulk Delete',[{k:'before',l:'Delete records uploaded before',t:'date',req:true}],{before:today()},async b=>{const r=await api('zkd/'+path+'/clear','POST',{before:b.before});alert(r.deleted+' removed')},'Delete');
const logActs=(path,more)=>[['Add'],['Delete',async c=>{const i=need(c);if(!confirm(`Delete ${i.length} record(s)?`))return;await api(`zkd/${path}/delete`,'POST',{ids:i});c.reload()}],...(more?[['Bulk Delete',clearBefore(path)]]:[])];
const devF={k:'device_id',l:'Device',t:'select',opts:()=>U.devOpts(),req:true};
const nowS=()=>new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,19).replace('T',' ');
ZK.grid('zk:oplog','Operation Log',{module:D,acts:[['Delete']],rowActs:false,load:()=>api('zkd/oplog'),api:'zkd/oplog',cols:[['Serial Number','sn'],['Device Name','device'],['Time Zone','tz'],['Administrator','admin'],['Action','action'],['Object','object'],['Parameters','params'],['Action Time','action_time'],['Upload Time','upload_time']],
  fields:[devF,{k:'tz',l:'Time Zone'},{k:'admin',l:'Administrator'},{k:'action',l:'Action',req:true},{k:'object',l:'Object'},{k:'params',l:'Parameters'},{k:'action_time',l:'Action Time',t:'datetime'}],defaults:{action_time:nowS()},
  save:b=>api('zkd/oplog','POST',{...b,upload_time:nowS()}),acts:logActs('oplog')});
ZK.grid('zk:errlog','Error Log',{module:D,acts:[['Delete']],rowActs:false,load:()=>api('zkd/errlog'),api:'zkd/errlog',cols:[['Serial Number','sn'],['Device Name','device'],['Error Code','code'],['Error Message','message'],['Error Command','command'],['Command ID','command_id'],['Extra Message','extra'],['Upload Time','upload_time']],
  fields:[devF,{k:'code',l:'Error Code'},{k:'message',l:'Error Message',req:true},{k:'command',l:'Error Command'},{k:'command_id',l:'Command ID'},{k:'extra',l:'Extra Message'}],
  save:b=>api('zkd/errlog','POST',{...b,upload_time:nowS()}),acts:logActs('errlog')});
ZK.grid('zk:uplog','Upload Log',{module:D,acts:[['Delete']],rowActs:false,load:()=>api('zkd/uplog'),api:'zkd/uplog',cols:[['Serial Number','sn'],['Device Name','device'],['Event','event'],['Content','content'],['Count','count'],['Error Count','error_count'],['Upload Time','upload_time']],
  fields:[devF,{k:'event',l:'Event',req:true},{k:'content',l:'Content'},{k:'count',l:'Count',t:'number'},{k:'error_count',l:'Error Count',t:'number'}],
  save:b=>api('zkd/uplog','POST',{...b,upload_time:nowS()}),acts:logActs('uplog',true)});

// ---------- Mobile App ----------
const appAct=(action,ask)=>async c=>{const i=need(c);if(ask&&!confirm(ask.replace('#',i.length)))return;await api('zkd/app/accounts/action','POST',{ids:i,action});c.reload()};
ZK.grid('zk:appacct','Accounts',{module:'employees',load:()=>api('zkd/app/accounts'),
  cols:[['User Name','user'],['Login Time','login_time'],['Last Active','last_active'],['Client Id','client_id'],['Device Token','token'],['Client Category','category'],['Running Status','running'],['APP Status','status']],
  acts:[['Add',async()=>{const em=await U.empOpts();ZK.form('Add App Account',[{k:'employee_id',l:'For',t:'select',opts:em,blank:'My own login (staff phone)'}],{},async b=>{const r=await api('zkd/app/accounts/pair','POST',{employee_id:b.employee_id?+b.employee_id:undefined});alert(`Enter this pairing code in the phone app within ${Math.round(r.expires_in/60)} minutes:\n\n${r.code}`)},'Create code')}],
    ['Delete',appAct('delete','Delete # app account(s)? The phone has to be paired again.')],
    ['Push Notification',async c=>{const i=need(c);ZK.form('Push Notification',[{k:'title',l:'Title',req:true},{k:'body',l:'Content',t:'textarea'}],{},async b=>{const r=await api('zkd/app/accounts/push','POST',{ids:i,title:b.title,body:b.body});alert(r.sent+' notification(s) sent')},'Send')}],
    ['Force Offline',appAct('offline','Sign # phone(s) out now?')],['Disable',appAct('disable')],['Enable',appAct('enable')]]});
ZK.grid('Announcements','Announcement',{module:'organization',load:()=>api('zkd/ann/list'),api:'zkd/ann',
  cols:[['Subject','title'],['Category',r=>r.category||(r.employee_id?'Private':'Public')],['Employee ID','code'],['Content','body'],['Sender','created_by'],['System Sender',r=>r.system_sender?'Yes':'No'],['Notice Time','created']],
  fields:[{k:'title',l:'Subject',req:true},{k:'category',l:'Category'},{k:'employee_id',l:'Employee (blank = everyone)',t:'select',opts:()=>U.empOpts(),blank:'Everyone'},{k:'body',l:'Content',t:'textarea'}],
  save:b=>api('zkd/ann','POST',{title:b.title,category:b.category,employee_id:b.employee_id?+b.employee_id:null,body:b.body}),
  acts:[['Add'],['Delete'],['Push Public Notice',async c=>{const i=need(c);const r=await api('zkd/ann/push','POST',{ids:i,mode:'public'});alert(r.sent+' notice(s) sent to the employees\' apps');c.reload()}],['Push Private Notice',async c=>{const i=need(c);const r=await api('zkd/ann/push','POST',{ids:i,mode:'private'});alert(r.sent+' notice(s) sent');c.reload()}]]});
ZK.grid('zk:appnotice','Notice',{module:'employees',load:()=>api('zkd/app/notices'),
  remove:id=>api('zkd/app/notices/delete','POST',{ids:[id]}),
  cols:[['Receiver',r=>r.audience==='employee'?((r.code||'')+' '+(r.employee||'')).trim():'All staff'],['Category',r=>String(r.kind||'general').replace(/_/g,' ')],['Content',r=>r.title+(r.body?' - '+r.body:'')],['Sender',()=>'System'],['Send Time','created'],['Read Status',r=>r.is_read?'Read':'Unread']],
  fields:[{k:'employee_id',l:'Receiver',t:'select',opts:()=>U.empOpts(),blank:'All staff'},{k:'category',l:'Category'},{k:'title',l:'Content',req:true},{k:'body',l:'Details',t:'textarea'}],
  save:b=>api('zkd/app/notices','POST',{employee_id:b.employee_id?+b.employee_id:null,category:b.category,title:b.title,body:b.body})});
ZK.grid('zk:applog','Mobile Operation Log',{module:'employees',load:()=>api('zkd/app/log'),
  remove:id=>api('zkd/app/log/delete','POST',{ids:[id]}),
  cols:[['User','user'],['Request Time','ts'],['Path','path'],['Method','method'],['Remote Address','ip'],['Status','status'],['Time',r=>r.ms+' ms']],
  fields:[{k:'user',l:'User'},{k:'path',l:'Path',req:true},{k:'method',l:'Method'},{k:'ip',l:'Remote Address'},{k:'status',l:'Status',t:'number'}],
  save:b=>api('zkd/app/log','POST',b)});

// ---------- Geo-fence ----------
ZK.grid('Locations','Location Setup',{module:'organization',load:()=>api('zkd/geo/locations'),api:'zkd/geo/locations',
  cols:[['Alias','alias',{link:true}],['Location','location'],['Longitude','lng'],['Latitude','lat']],
  fields:[{k:'alias',l:'Alias',req:true},{k:'location',l:'Location'},{k:'lng',l:'Longitude',t:'number',req:true},{k:'lat',l:'Latitude',t:'number',req:true},{k:'radius_m',l:'Radius (m)',t:'number',hint:'Default 150'}],
  defaults:{radius_m:150},save:(b,row)=>{const body={alias:b.alias,location:b.location||'',lng:b.lng,lat:b.lat,...(b.radius_m!=null?{radius_m:b.radius_m}:{})};return api(row?'zkd/geo/locations/'+row.id:'zkd/geo/locations',row?'PUT':'POST',body)}});
const siteOpts=async()=>(await api('geo_sites')).map(s=>[s.id,s.name]);
const gpsCols=[['Location','location'],['Distance',r=>r.distance==null?'':r.distance+' m'],['Start Date','start_date'],['End Date','end_date']];
const gpsFields=[{k:'site_id',l:'Location',t:'select',opts:siteOpts,req:true},{k:'distance',l:'Distance (m)',t:'number'},{k:'start_date',l:'Start Date',t:'date'},{k:'end_date',l:'End Date',t:'date'}];
ZK.grid('zk:gpsemp','Employee Setup',{module:'organization',load:()=>api('zkd/geo/emp'),api:'zkd/geo/emp',cols:[['Employee',r=>`<a class="zl" onclick="ZK.edit('zk:gpsemp',${r.id})">${E(r.target)}</a>`,{html:true}],...gpsCols],
  fields:[{k:'employee_id',l:'Employee',t:'select',opts:()=>U.empOpts(),req:true},...gpsFields],save:(b,row)=>api(row?'zkd/geo/emp/'+row.id:'zkd/geo/emp',row?'PUT':'POST',{...b,employee_id:+b.employee_id,site_id:+b.site_id})});
ZK.grid('zk:gpsdept','Department Setup',{module:'organization',load:()=>api('zkd/geo/dept'),api:'zkd/geo/dept',cols:[['Department',r=>`<a class="zl" onclick="ZK.edit('zk:gpsdept',${r.id})">${E(r.target)}</a>`,{html:true}],...gpsCols],
  fields:[{k:'department_id',l:'Department',t:'select',opts:async()=>(await api('departments')).map(d=>[d.id,d.name]),req:true},...gpsFields],save:(b,row)=>api(row?'zkd/geo/dept/'+row.id:'zkd/geo/dept',row?'PUT':'POST',{...b,department_id:+b.department_id,site_id:+b.site_id})});

// ---------- Device Configurations ----------
window.zkCfgSave=async apply=>{const m=document.getElementById('dcm');try{await api('zkd/config','PUT',{zkd_delay:+val('dc_delay'),zkd_error_delay:+val('dc_err'),zkd_realtime:+val('dc_rt'),zkd_auto_approve:+val('dc_auto'),zkd_timezone:val('dc_tz'),device_offline_min:+val('dc_off'),store_templates:+val('dc_tpl')});let t='Saved';if(apply){const r=await api('zkd/config/apply','POST');t=`Saved and applied to ${r.devices} device(s)`}m.innerHTML=`<span style="color:var(--ok)">${t}</span>`}catch(e){m.innerHTML=`<span class="err">${E(e.message)}</span>`}};
ZK.reg('zk:devcfg','Configurations',async()=>{const c=await api('zkd/config'),sel=(id,v,o)=>`<select id="${id}">${o.map(x=>`<option value="${x[0]}" ${String(v)===String(x[0])?'selected':''}>${x[1]}</option>`).join('')}</select>`;
  return `<h2>Configurations</h2><div class="card" style="max-width:760px"><h3 style="margin-top:0">Device defaults</h3><div class="grid">
   <label>Upload interval (seconds)<input id="dc_delay" type="number" min="1" max="3600" value="${c.zkd_delay}"><small class="mut">How often a push device checks in for commands.</small></label>
   <label>Retry delay after an error (seconds)<input id="dc_err" type="number" min="1" max="3600" value="${c.zkd_error_delay}"></label>
   <label>Real-time upload${sel('dc_rt',c.zkd_realtime,[[1,'On'],[0,'Off']])}<small class="mut">Devices send each punch as soon as it happens.</small></label>
   <label>Approve new devices automatically${sel('dc_auto',c.zkd_auto_approve,[[0,'No, wait for approval'],[1,'Yes']])}</label>
   <label>Default time zone<input id="dc_tz" value="${E(c.zkd_timezone)}" placeholder="e.g. Asia/Karachi"></label>
   <label>Show a device as offline after (minutes)<input id="dc_off" type="number" min="1" max="1440" value="${c.device_offline_min}"></label>
   <label>Keep fingerprint and face templates${sel('dc_tpl',c.store_templates,[[0,'No (only count them)'],[1,'Yes (encrypted)']])}<small class="mut">Needed to copy templates from one device to another.</small></label></div>
   <div class="bar"><button onclick="zkCfgSave(false)">Save</button><button class="g" onclick="zkCfgSave(true)">Save and apply to all devices</button><span id="dcm"></span></div></div>`},D);
})();
