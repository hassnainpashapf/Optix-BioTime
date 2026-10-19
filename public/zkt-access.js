// Access Control pages in the ZKT layout (columns and toolbar copied from the reference app). Backend: ac.js + zk-access.js.
(()=>{
const M='access',E=v=>esc(v==null?'':v);
// extra form field type used here: a list of checkboxes -> array of numbers (opts [[value,label]])
if(!ZK._checks){ZK._checks=1;const fh=ZK.fieldHtml,rd=ZK.read;
  ZK.fieldHtml=async(f,v)=>{if(f.t!=='checks')return fh(f,v);const have=new Set((Array.isArray(v)?v:[]).map(String)),opts=typeof f.opts==='function'?await f.opts():f.opts||[];
    return `<label>${esc(f.l)}${f.hint?`<small class="mut"> ${esc(f.hint)}</small>`:''}<div id="zf_${f.k}" class="zchk" style="max-height:110px;overflow:auto;border:1px solid #ccc;padding:4px 6px;background:#fff">${opts.map(o=>`<label style="display:block;font-weight:400"><input type="checkbox" value="${E(o[0])}" ${have.has(String(o[0]))?'checked':''}> ${esc(o[1])}</label>`).join('')||'<span class="mut">None available</span>'}</div></label>`};
  ZK.read=fields=>{const b=rd(fields.filter(f=>f.t!=='checks'));for(const f of fields)if(f.t==='checks')b[f.k]=[...document.querySelectorAll(`#zf_${f.k} input:checked`)].map(c=>+c.value);return b}}
const VERIFY=['Any','Fingerprint','UserID Only','Password','Card Only','Fingerprint/Password','Fingerprint/Card','Password/Card','UserID&Fingerprint','Fingerprint&Password','Fingerprint&Card','Fingerprint&Password&Card'];
const verOpts=VERIFY.map((n,i)=>[i,n]);
const SENSOR=['None','Normally Open','Normally Closed'];
const yn=v=>v?'Yes':'No';
const zoneOpts=async()=>(await api('ac/timezones')).map(t=>[t.id,t.name]);
const levelOpts=async()=>(await api('ac/levels')).map(l=>[l.id,l.name]);
const sure=m=>confirm(m);
const needRows=(c,one)=>{if(!c.ids.length)throw new Error('Tick at least one row first');if(one&&c.ids.length!==1)throw new Error('Tick exactly one row');return c.rows};

// ---------- clone to areas (shared by time period / holiday / groups / combinations) ----------
const cloneAreas=async(kind,c)=>{needRows(c);const ticked=[...document.querySelectorAll('.ac_area:checked')].map(x=>+x.value);
  if(ticked.length){if(!confirm(`Send the selected item(s) to the devices of ${ticked.length} ticked area(s)?`))return;const r=await api('ac/clone','POST',{kind,ids:c.ids,area_ids:ticked});return alert(`${r.commands} command(s) queued for ${r.devices} device(s)${r.areas_mapped?'':' (devices are not assigned to areas yet, so every access device was used)'}`)}
  const areas=await api('branches');
  ZK.form('Clone to Areas',[{k:'area_ids',l:'Areas',t:'checks',opts:areas.map(a=>[a.id,a.name]),hint:'the devices (with doors) of the chosen areas receive the selected items'}],{area_ids:[]},async b=>{
    const r=await api('ac/clone','POST',{kind,ids:c.ids,area_ids:b.area_ids});alert(`${r.commands} command(s) queued for ${r.devices} device(s)${r.areas_mapped?'':' (devices are not assigned to areas yet, so every access device was used)'}`)},'Clone')};

// ---------- Device > Doors ----------
const doorFields=()=>[{k:'name',l:'Device Name',t:'text',req:true,hint:'name of the door'},
  {k:'device_id',l:'Device',t:'select',opts:async()=>(await api('devices')).map(d=>[d.id,(d.sn?d.sn+' - ':'')+d.name]),blank:'Not linked'},
  {k:'door_no',l:'Door number (1-4)',t:'number'},{k:'open_sec',l:'Door Lock Delay (s)',t:'number'},{k:'sensor_delay',l:'Door Sensor Delay (s)',t:'number'},
  {k:'sensor_type',l:'Door Sensor Type',t:'select',opts:SENSOR.map((n,i)=>[i,n]),blank:false},{k:'alarm_delay',l:'Door Alarm Delay (s)',t:'number'},{k:'retry_alarm',l:'Retry Times to Alarm',t:'number'},
  {k:'valid_holidays',l:'Valid Holidays',t:'checkbox'},{k:'location',l:'Location',t:'text'},{k:'note',l:'Note',t:'text'}];
ZK.grid('Doors','Doors',{module:M,load:async()=>api('ac/doors'),
  note:'A door is one relay of a device. Who may open it, and when, comes from the groups (access levels).',
  defaults:{door_no:1,open_sec:5,sensor_delay:15,sensor_type:0,alarm_delay:0,retry_alarm:3,valid_holidays:1},
  cols:[['Serial Number','sn'],['Device Name','name',{link:true}],['State',r=>!r.device_id?'-':r.dev_online==null?'Unknown':r.dev_online?'Online':'Offline'],['Door Lock Delay','open_sec'],['Door Sensor Delay','sensor_delay'],
    ['Door Sensor Type',r=>SENSOR[r.sensor_type||0]],['Door Alarm Delay','alarm_delay'],['Retry Times to Alarm','retry_alarm'],['Valid Holidays',r=>yn(r.valid_holidays)]],
  fields:doorFields(),
  save:async(b,row)=>{if(b.device_id==='')b.device_id=null;b.valid_holidays=b.valid_holidays?1:0;await api(row?'ac/doors/'+row.id:'ac/doors',row?'PUT':'POST',b)},
  remove:async id=>api('ac/doors/'+id,'DELETE'),
  rowActs:false,
  acts:[
    ['Open Door',async c=>{const r=needRows(c);if(!sure('Are you sure to unlock of selected device(s)?'))return;let ok=0,err=[];for(const d of r)try{await api(`ac/doors/${d.id}/open`,'POST',{});ok++}catch(e){err.push(d.name+': '+e.message)}alert(`Open command queued for ${ok} door(s)`+(err.length?'\n'+err.join('\n'):''))}],
    ['Cancel Alarm',async c=>{needRows(c);if(!sure('Are you sure to remove the alarm for the selected device(s)?'))return;const r=await api('ac/doors/cancel-alarm','POST',{ids:c.ids});alert(`Alarm cancelled on ${r.doors} door(s), ${r.queued} device command(s) queued`);c.reload()}],
    ['Set Parameter',async c=>{needRows(c);ZK.form('Set Parameter',[{k:'open_sec',l:'Door Lock Delay (s)',t:'number',hint:'leave empty to keep'},{k:'sensor_delay',l:'Door Sensor Delay (s)',t:'number'},
      {k:'sensor_type',l:'Door Sensor Type',t:'select',opts:SENSOR.map((n,i)=>[i,n]),blank:'(keep)'},{k:'alarm_delay',l:'Door Alarm Delay (s)',t:'number'},{k:'retry_alarm',l:'Retry Times to Alarm',t:'number'},
      {k:'valid_holidays',l:'Valid Holidays',t:'select',opts:[[1,'Yes'],[0,'No']],blank:'(keep)'}],{},async b=>{const r=await api('ac/doors/params','POST',{...b,ids:c.ids});alert(`${r.doors} door(s) updated, ${r.queued} device command(s) queued`)},'Apply')}],
    ['More',[['Add',()=>ZK.edit('Doors',0)],['Delete',()=>ZK.del('Doors')],['Sync to Devices',async()=>{const r=await api('ac/sync','POST',{});alert(`Sent to devices: ${r.commands??0} command(s), ${r.users??0} user(s)${r.removed?`, ${r.removed} removed`:''}.`)}]]]]});

// ---------- Device > Device Command (access devices only) ----------
ZK.grid('zk:acccmd','Device Command',{module:M,load:async()=>api('ac/cmds'),
  cols:[['Serial Number','sn'],['Device Name','device'],['Content','content'],['Commit Time','commit_time'],['Transfer Time',r=>r.transfer_time||'']],
  fields:[{k:'device_id',l:'Device',t:'select',req:true,opts:async()=>{const d=await api('ac/doors'),m=new Map();d.filter(x=>x.device_id).forEach(x=>m.set(x.device_id,(x.sn?x.sn+' - ':'')+x.device));return[...m]}},{k:'cmd',l:'Content',t:'textarea',req:true}],
  api:'ac/cmds',remove:async id=>api('ac/cmds/'+id,'DELETE'),
  acts:[['Add'],['Delete'],
    ['Bulk Delete',async c=>ZK.form('Bulk Delete',[{k:'status',l:'Delete commands that are',t:'select',blank:false,opts:[['done','Transferred and done'],['failed','Failed'],['sent','Sent, no answer yet'],['pending','Waiting for the device'],['all','All']]}],{status:'done'},async b=>{if(!confirm('Delete these commands?'))throw new Error('Cancelled');const r=await api('ac/cmds/clear','POST',{status:b.status});alert(r.deleted+' command(s) deleted')},'Delete')],
    ['Clear all ',async c=>{if(!confirm('Clear ALL device commands of the access devices?'))return;const r=await api('ac/cmds/clear','POST',{status:'all'});alert(r.deleted+' command(s) cleared');c.reload()}]]});

// ---------- Access Control > Time Period ----------
const DAYS=['mon','tue','wed','thu','fri','sat','sun'],DN={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const rangesTxt=r=>(r||[]).map(x=>x.join('-')).join(', ');
const parseRanges=(d,t)=>String(t||'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{const m=x.match(/^(\d\d?:\d\d)\s*-\s*(\d\d?:\d\d)$/);if(!m)throw new Error(`${DN[d]}: "${x}" is not like 08:00-17:00`);return m.slice(1).map(v=>v.padStart(5,'0'))});
ZK.grid('Time zones','Time Period',{module:M,load:async()=>api('ac/timezones'),
  cols:[['Time Period No.','timezone_no',{link:true}],['Time Period Name','name']],
  fields:[{k:'timezone_no',l:'Time Period No.',t:'number',req:true},{k:'name',l:'Time Period Name',t:'text',req:true},{k:'remark',l:'Remark',t:'text'},...DAYS.map(d=>({k:'d_'+d,l:DN[d],t:'text',ph:'08:00-12:00, 13:00-17:00',hint:'up to three ranges; empty = no access'}))],
  defaults:{},
  save:async(b,row)=>{const rules={};for(const d of DAYS)rules[d]=parseRanges(d,b['d_'+d]);const body={name:b.name,rules,timezone_no:b.timezone_no,remark:b.remark};await api(row?'ac/timezones/'+row.id:'ac/timezones',row?'PUT':'POST',body)},
  remove:async id=>api('ac/timezones/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Clone to Areas',c=>cloneAreas('timezones',c)]]});
{const g=ZK.G,orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='Time zones')return orig(key,id);const s=g[key],row=id?s.all.find(r=>r.id===id)||{}:{timezone_no:Math.max(0,...s.all.map(r=>r.timezone_no||0))+1,rules:{}};
  const v={...row};for(const d of DAYS)v['d_'+d]=rangesTxt((row.rules||{})[d]||(id?[]:[['00:00','23:59']]));
  ZK.form((id?'Edit ':'Add ')+'Time Period',s.o.fields,v,async b=>s.o.save(b,id?row:null))}}

// ---------- Access Control > Holiday ----------
ZK.grid('zk:accholiday','Holiday',{module:M,load:async()=>api('ac/holidays'),
  cols:[['Name','name',{link:true}],['Start Date','start_date'],['Duration','duration'],['Time Period','timezone']],
  fields:[{k:'name',l:'Holiday Name',t:'text',req:true},{k:'start_date',l:'Start Date',t:'date',req:true},{k:'duration',l:'Duration (days)',t:'number',req:true},{k:'timezone_id',l:'Time Period 1',t:'select',req:true,opts:zoneOpts}],
  defaults:{duration:1},api:'ac/holidays',
  acts:[['Add'],['Delete'],['Clone to Areas',c=>cloneAreas('holidays',c)]]});

// ---------- Access Control > Groups (access levels) ----------
const levelFields=()=>[{k:'group_no',l:'Group No.',t:'number',req:true},{k:'name',l:'Group Name',t:'text',req:true},{k:'timezone_id',l:'Time Period 1',t:'select',req:true,opts:zoneOpts,blank:false},
  {k:'timezone2_id',l:'Time Period 2',t:'select',opts:zoneOpts},{k:'timezone3_id',l:'Time Period 3',t:'select',opts:zoneOpts},
  {k:'verify_mode',l:'Verification Mode',t:'select',opts:verOpts,blank:false},{k:'include_holiday',l:'Include Holiday',t:'select',opts:[[0,'No'],[1,'Yes']],blank:false},
  {k:'door_ids',l:'Doors',t:'checks',opts:async()=>(await api('ac/doors')).map(d=>[d.id,d.name])},{k:'note',l:'Note',t:'text'}];
ZK.grid('Access levels','Groups',{module:M,load:async()=>{const r=await api('ac/levels');window.ACL=r;return r},
  cols:[['Group No.','group_no'],['Group Name','name',{link:true}],['Verification Mode',r=>VERIFY[r.verify_mode||0]],['Time Period 1','timezone'],['Time Period 2','timezone2'],['Time Period 3','timezone3'],['Include Holiday',r=>yn(r.include_holiday)]],
  fields:levelFields(),defaults:{verify_mode:0,include_holiday:0},
  save:async(b,row)=>{const body={...b,door_ids:b.door_ids||[]};await api(row?'ac/levels/'+row.id:'ac/levels',row?'PUT':'POST',body)},
  remove:async id=>api('ac/levels/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Group Menu',[
    ['Clone to Areas',c=>cloneAreas('levels',c)],
    ['Personnel Transfer',async c=>{const r=needRows(c,true)[0];const lv=await api('ac/levels'),ppl=await api(`ac/levels/${r.id}/people`);
      ZK.form('Personnel Transfer - '+r.name,[{k:'to_level_id',l:'Transfer to group',t:'select',req:true,opts:lv.filter(x=>x.id!==r.id).map(x=>[x.id,x.name])},
        {k:'employee_ids',l:`People in this group (${ppl.length}); none ticked = everyone`,t:'checks',opts:ppl.map(p=>[p.id,p.code+' - '+p.name])},{k:'copy',l:'Keep them in this group too (copy)',t:'checkbox'}],{},
        async b=>{const x=await api(`ac/levels/${r.id}/transfer`,'POST',{to_level_id:b.to_level_id,employee_ids:b.employee_ids.length?b.employee_ids:undefined,copy:!!b.copy});alert(`${x.transferred} person(s) ${x.moved?'moved':'copied'}`)},'Transfer')}],
    ['Manage People',async c=>{const r=needRows(c,true)[0];window.ACL=c.all;return window.acPeople(r.id)}],
    ['Sync to Devices',async()=>{const r=await api('ac/sync','POST',{});alert(`Sent to devices: ${r.commands??0} command(s), ${r.users??0} user(s)${r.removed?`, ${r.removed} removed`:''}.`)}]]]]});
{const orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='Access levels')return orig(key,id);const s=ZK.G[key],row=id?s.all.find(r=>r.id===id)||{}:{...s.o.defaults,group_no:Math.max(0,...s.all.map(r=>r.group_no||0))+1};
  const v={...row,door_ids:(row.doors||[]).map(d=>d.id??d)};ZK.form((id?'Edit ':'Add ')+'Group',s.o.fields,v,async b=>s.o.save(b,id?row:null))}}

// ---------- Access Control > Combination ----------
const comboCols=[1,2,3,4,5].map(i=>['Employee from Group',r=>r.groups[i-1]||'']);
ZK.grid('zk:acccombo','Combination',{module:M,load:async()=>api('ac/combos'),
  cols:[['Combination No.','combo_no',{link:true}],['Combination Name','name'],...comboCols],
  note:'People from the listed groups open the door together: one person per group slot. The combinations are sent to the devices with Sync to Devices.',
  fields:[{k:'combo_no',l:'Combination No.',t:'number',req:true},{k:'name',l:'Combination Name',t:'text',req:true},...[1,2,3,4,5].map(i=>({k:'g'+i,l:'Employee from Group '+i,t:'select',opts:levelOpts})),{k:'remark',l:'Remark',t:'text'}],
  defaults:{},api:'ac/combos',
  acts:[['Add'],['Delete'],['Clone to Areas',c=>cloneAreas('combos',c)]]});

// ---------- Access Control > Privilege ----------
const privFields=(withEmp)=>[...(withEmp?[{k:'codes',l:'Employee ID',t:'text',req:true,hint:'one or more IDs separated by comma'}]:[]),{k:'level_id',l:'Group',t:'select',req:withEmp,opts:levelOpts,blank:withEmp?undefined:'(keep)'},
  {k:'tz_mode',l:'Time Period Mode',t:'select',blank:false,opts:[[0,'Group'],[1,'Personnel']]},{k:'tz1',l:'Time Period 1',t:'select',opts:zoneOpts,hint:'personnel mode only'},{k:'tz2',l:'Time Period 2',t:'select',opts:zoneOpts},{k:'tz3',l:'Time Period 3',t:'select',opts:zoneOpts},
  {k:'verify_mode',l:'Verification Mode',t:'select',blank:false,opts:[[-1,'Apply Group Mode'],...verOpts]}];
ZK.grid('zk:accpriv','Privilege',{module:M,load:async()=>api('ac/privileges'),
  cols:[['Employee ID','code'],['First Name','first_name'],['Last Name','last_name'],['Group','level'],['Time Period Mode',r=>r.tz_mode?'Personnel':'Group'],['Time Period 1',r=>r.time1||''],['Time Period 2',r=>r.time2||''],['Time Period 3',r=>r.time3||''],
    ['Verification Mode',r=>r.verify_mode<0||r.verify_mode==null?'Apply Group Mode':VERIFY[r.verify_mode]]],
  fields:privFields(true),defaults:{tz_mode:0,verify_mode:-1},
  save:async b=>{const codes=String(b.codes).split(/[\s,;]+/).filter(Boolean),emps=await api('employees?status=active'),m=new Map(emps.map(e=>[String(e.code),e.id])),miss=codes.filter(c=>!m.has(c));
    if(miss.length)throw new Error('Unknown employee ID: '+miss.slice(0,5).join(', '));const {codes:_c,...rest}=b;await api('ac/privileges','POST',{...rest,employee_ids:codes.map(c=>m.get(c))})},
  remove:async id=>api('ac/privileges/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Adjust',async c=>{needRows(c);ZK.form('Adjust Privilege ('+c.ids.length+' selected)',privFields(false),{tz_mode:0,verify_mode:-1},async b=>{const r=await api('ac/privileges/adjust','POST',{...b,ids:c.ids});alert(r.updated+' updated')},'Apply')}]]});
{const orig=ZK.edit;ZK.edit=async(key,id)=>{if(key!=='zk:accpriv'||!id)return orig(key,id);return alert('Tick the row and use Adjust to change a privilege')}}

// left Area list on Time Period / Holiday / Groups / Combination: tick areas, then "Clone to Areas" sends the selected rows there without asking again
for(const key of ['Time zones','zk:accholiday','Access levels','zk:acccombo']){const base=ZK.pages[key];if(!base)continue;
  ZK.reg(key,ZK.t(key),async()=>{const [h,areas]=await Promise.all([base(),api('branches')]);return `<div class="pfw"><div class="pft"><div class="pfh"><a style="cursor:pointer;color:#555" title="Refresh" onclick="go('${key}')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.300-5.600M20 4v5h-5"/></svg></a></div>${areas.map(a=>`<label class="pfi" style="display:flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" class="ac_area" value="${a.id}" style="width:14px;height:14px"> ${esc(a.name)}</label>`).join('')}</div><div class="pfm">${h}</div></div>`},M)}
})();
