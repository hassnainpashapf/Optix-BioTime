// zkt-attsetup pack: Attendance > Setting Guide / Setup / Rule / Shift / Schedule / Approvals / Benefit / Configurations pages.
// Backend: zk-attsetup.js (/api/att/*). Existing keys (Pay codes, Shifts, Roster, Requests, Leaves, Overtime, Holidays, Shift calendar) are re-registered here.
(()=>{
const OLD={...pages};                       // the original pages, kept for the tools that have no ZKT equivalent
const A=(p,m,b)=>api('att/'+p,m,b);
const yn=v=>v?'Yes':'No';
const OTC=[['','---------'],...['Regular','Normal OT','Weekend OT','Holiday OT','OT1','OT2','OT3'].map(x=>[x,x])];
const OTC2=OTC.filter(x=>x[0]!=='Regular');
const empOpts=async()=>(await api('employees?status=active')).map(e=>[e.id,`${e.code} - ${e.name}`]);
const idName=p=>async()=>(await api(p)).map(x=>[x.id,(x.code?x.code+' - ':'')+x.name]);
const swatch=c=>c?`<span style="display:inline-block;width:30px;height:14px;background:${esc(c)};border:1px solid #ccc;vertical-align:middle"></span>`:'';
const photo=r=>avt(r.employee_id,r.name,r.has_photo);
const loadPhotos=()=>document.querySelectorAll('#main .av2[data-eid]').forEach(el=>{if(el.dataset.done)return;el.dataset.done=1;fetch(`/api/employees/${el.dataset.eid}/photo`,{headers:{Authorization:'Bearer '+T}}).then(r=>r.ok?r.blob():null).then(bl=>{if(bl)el.innerHTML=`<img src="${URL.createObjectURL(bl)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`}).catch(()=>{})});
// custom edit handlers (pages whose form depends on the row)
ZK.custom=ZK.custom||{};
{const e0=ZK.edit;ZK.edit=(key,id)=>ZK.custom[key]?ZK.custom[key](id):e0(key,id)}
// grid + photo loader + optional old-page tail
function attGrid(key,title,o,module,tail){
  ZK.grid(key,title,o);const base=pages[key];
  ZK.reg(key,title,async()=>{let h=await base();let after=null;
    if(o.filter)h=h.replace('<div class="ztool">',o.filter()+'<div class="ztool">');
    if(tail){const t=await tail();h+=t;after=window.afterRender}
    window.afterRender=()=>{after&&after();loadPhotos()};return h},module);
}
const tailOf=(oldKey,hdr,dropTitle)=>async()=>{try{let h=await OLD[oldKey]();h=h.replace(new RegExp('<h2>[^<]*</h2>'),'');return `<details style="margin-top:18px"><summary style="cursor:pointer;font-weight:600">${esc(hdr)}</summary>${h}</details>`}catch(e){return ''}};
// filter bar kept per page
window.ATF=window.ATF||{};
const fbar=(key,o={})=>{const f=ATF[key]||(ATF[key]={});if(o.dates){f.from=f.from??(o.empty?'':today().slice(0,8)+'01');f.to=f.to??(o.empty?'':today())}
  return `<span class="bar" style="display:inline-flex;gap:6px;align-items:center;margin:0 0 8px">${o.dates?`<input id="af_f" type="date" value="${esc(f.from)}"> - <input id="af_t" type="date" value="${esc(f.to)}">`:''}`+
   `<select id="af_s"><option value="">Approval Status: All</option>${['pending','approved','rejected','cancelled'].map(x=>`<option value="${x}" ${f.status===x?'selected':''}>${{pending:'Pending',approved:'Approved',rejected:'Rejected',cancelled:'Revoked'}[x]}</option>`).join('')}</select><button class="g" onclick="attFilter('${key}',${!!o.dates})">Search</button></span>`};
window.attFilter=(key,dates)=>{const f=ATF[key]=ATF[key]||{};f.status=val('af_s');if(dates){f.from=val('af_f');f.to=val('af_t')}go(cur)};
const fq=(key)=>{const f=ATF[key]||{};return Object.entries({status:f.status,from:f.from,to:f.to}).filter(x=>x[1]).map(x=>x.join('=')).join('&')};
// run one call per ticked row and report what failed
async function each(ctx,fn,label){const rows=ZK.need(ctx);const errs=[];let adv=null;
  for(const r of rows){try{const x=await fn(r);if(x&&x.advanced)adv=x}catch(e){errs.push(`${r.code||r.id}: ${e.message}`)}}
  if(errs.length)alert(`${rows.length-errs.length} ${label}, ${errs.length} could not be:\n`+errs.slice(0,5).join('\n'));
  else if(adv)alert(`Approved this step. It now waits for step ${adv.step} of ${adv.of}: ${adv.waiting_for}.`);
  ctx.reload()}
const note=()=>prompt('Reason (optional):');
// pick employees for a bulk action: department / area / group / codes
const pickFields=[{k:'p_dept',l:'Department',t:'select',opts:idName('departments')},{k:'p_area',l:'Area',t:'select',opts:idName('branches')},{k:'p_group',l:'Group',t:'select',opts:async()=>(await api('emp_groups')).map(x=>[x.id,x.name])},
  {k:'codes',l:'Employee ID list',t:'textarea',hint:'Optional: employee IDs separated by comma, space or new line (added to the department, area or group above)'}];
const pickBody=b=>{const o={codes:b.codes||''};if(b.p_dept){o.by='dept';o.target_id=b.p_dept}else if(b.p_area){o.by='area';o.target_id=b.p_area}else if(b.p_group){o.by='group';o.target_id=b.p_group}return o};
const bulkDone=r=>alert(`${r.added} added`+(r.skipped?`, ${r.skipped} skipped:\n`+r.errors.slice(0,6).join('\n'):''));
// CSV import dialog: file or pasted text, existing data policy, auto approve
function attImport(title,path,cols,o={}){
  window._imp={path,o};
  orgModal(title,`<p class="mut sm">Columns: <b>${esc(cols)}</b>. Choose a CSV file or paste the rows. The first line may be a header.</p><input type="file" accept=".csv,.txt" onchange="attImpFile(this)"><textarea id="im_t" rows="7" style="width:100%;margin-top:6px"></textarea>`+
   (o.mode?`<label>Existing Data<select id="im_mode"><option value="ignore">Ignore</option><option value="overwrite">Overwrite</option></select></label>`:'')+(o.auto?`<label style="flex-direction:row;align-items:center;gap:6px"><input id="im_auto" type="checkbox" checked> Auto Approved</label>`:'')+`<div id="im_m" class="sm"></div>`,'attImpGo()','Import')}
window.attImpFile=inp=>{const f=inp.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{document.getElementById('im_t').value=r.result};r.readAsText(f)};
window.attImpGo=async()=>{const {path,o}=window._imp,m=document.getElementById('im_m');try{const b={csv:val('im_t'),...(o.extra||{})};if(o.mode)b.mode=val('im_mode');if(o.auto)b.auto_approve=document.getElementById('im_auto').checked;
  const r=await api(path,'POST',b);m.innerHTML=`<span style="color:var(--ok)">${r.added??0} added${r.updated?`, ${r.updated} updated`:''}${r.skipped?`, ${r.skipped} skipped`:''}.</span>`+(r.errors&&r.errors.length?`<br><span class="err">${r.errors.map(esc).join('<br>')}</span>`:'');
  if(r.added||r.updated)setTimeout(()=>{if(!(r.errors&&r.errors.length)){document.getElementById('dvm')?.remove();go(cur)}},r.errors&&r.errors.length?60000:900)}catch(e){m.innerHTML=`<span class="err">${esc(e.message)}</span>`}};
const tierFields=(p,n=3)=>Array.from({length:n},(_,i)=>i+1).flatMap(i=>[{k:`${p}${i}_pay_code`,l:'Work Hours Assign To',t:'select',opts:OTC,blank:false},{k:`${p}${i}_hrs_from`,l:'Work Hours From (Hour)',t:'number'},{k:`${p}${i}_hrs_to`,l:'Work Hours To (Hour)',t:'number'}]);
const WK=[[7,'None'],[0,'Monday'],[1,'Tuesday'],[2,'Wednesday'],[3,'Thursday'],[4,'Friday'],[5,'Saturday'],[6,'Sunday']];
const PAIR=[[1,'First And Last'],[2,'Odd Even'],[3,'Punch State Based']];
const OTPOL=[[-1,'Ignore'],[1,'Pending'],[2,'Auto Approved']];
const dateF=(k,l,x={})=>({k,l,t:'date',req:true,...x}),timeF=(k,l,x={})=>({k,l,t:'text',ph:'HH:MM',req:true,...x});

// ============================================================ Workbench
ZK.reg('zk:workbench','Workbench',async()=>{
  const ic=(d)=>`<svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="#7cc144" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const I={brk:'<path d="M12 24h30v15a13 13 0 0 1-13 13h-4a13 13 0 0 1-13-13z"/><path d="M42 29h4a6 6 0 0 1 0 12h-5"/><path d="M20 6c4 3-3 6 0 11M30 6c4 3-3 6 0 11"/>',
    tt:'<path d="M32 6a14 14 0 0 1 14 14c0 10-14 24-14 24S18 30 18 20A14 14 0 0 1 32 6z"/><circle cx="32" cy="20" r="6"/><path d="M22 44l-9 13h38l-9-13"/>',
    sh:'<rect x="6" y="12" width="46" height="42" rx="5"/><path d="M6 24h46M17 6v10M41 6v10M14 34h8M14 44h8M28 34h8"/><circle cx="46" cy="46" r="11" fill="#fff"/><path d="M46 40v6l4 3"/>',
    sc:'<circle cx="32" cy="14" r="10"/><path d="M32 8v6l4 3M32 24v8M32 32H14v8M32 32h18v8M32 32v8"/><rect x="8" y="40" width="12" height="12" rx="2"/><rect x="26" y="40" width="12" height="12" rx="2"/><rect x="44" y="40" width="12" height="12" rx="2"/>',
    ca:'<rect x="12" y="6" width="40" height="52" rx="4"/><rect x="18" y="12" width="28" height="10" rx="2"/><rect x="18" y="29" width="7" height="7"/><rect x="29" y="29" width="7" height="7"/><rect x="18" y="42" width="7" height="7"/><rect x="29" y="42" width="7" height="7"/><rect x="40" y="29" width="6" height="20"/>',
    rp:'<path d="M10 58V6h32v14"/><path d="M10 58h26"/><text x="14" y="30" font-size="22" font-family="Arial" fill="#7cc144" stroke="none">30</text><path d="M16 40h8M16 50h8"/><circle cx="46" cy="46" r="11" fill="#fff"/><path d="M46 40v6l4 3"/>'};
  const card=(i,t,d,go_)=>`<div class="wbc" onclick="${go_}">${ic(I[i])}<b>${t}</b><span>${d}</span></div>`,arrow='<div class="wba"><svg viewBox="0 0 64 24" width="52" height="24" fill="none" stroke="#7cc144" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h58M50 3l10 9-10 9"/></svg></div>';
  return `<style>.wbw{padding:4px 8px}.wbh{color:#7cc144;font-weight:700;font-size:15px;margin:14px 0 14px;padding:10px 0 10px 4px;border-bottom:1px solid #eee}.wbr{display:flex;align-items:flex-start;gap:0;margin:0 0 6px 4px}.wbc{width:201px;height:181px;box-sizing:border-box;border:1px solid #e3e3e3;background:#fff;border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:36px 3px 0;text-align:center;cursor:pointer;color:#444}.wbc:hover{box-shadow:0 2px 8px rgba(0,0,0,.14)}.wbc>svg{width:64px;height:64px;flex:none}.wbc b{color:#444;font-size:13px;font-weight:700;margin-top:12px;letter-spacing:.3px}.wbc span{color:#444;font-size:12.5px;line-height:24px;margin-top:4px;letter-spacing:0}.wba{padding:0 18px;align-self:flex-start;margin-top:72px}.wbq{display:flex;justify-content:flex-end;padding:0 12px;margin:-4px 0 0}.wbq button{background:#7cc144!important;color:#fff!important;border:0!important;border-radius:8px!important;height:40px!important;padding:0 28px!important;font-size:16px!important;cursor:pointer}.wbq button:hover{background:#6bb139!important}.wb2{display:flex;gap:0}.wb2>div{flex:1;min-width:0}</style>
  <div class="wbw"><div class="wbh" style="margin-top:6px">Schedule Setting Steps</div><div class="wbr">${card('brk','Set Break Time','Set break time for employees',"go('zk:breaktime')")}${arrow}${card('tt','Set Timetable','Set the time when employees start and end work',"go('zk:timetable')")}${arrow}${card('sh','Set Shift','Set shifts for employees',"go('Shifts')")}${arrow}${card('sc','Set Schedule','Assign shifts to employees',"go('Roster')")}</div>
  <div class="wbq"><button onclick="attQuick()">Quick Setup</button></div>
  <div class="wb2"><div><div class="wbh">Attendance Calculation</div><div class="wbr">${card('ca','Attendance Calculation','Calculate attendance according to employees punch records',"go('zk:calculation')")}</div></div><div><div class="wbh">Generate Report</div><div class="wbr">${card('rp','Attendance Report','View total time card of employees',"go('zk:rp:totalTimeCardReportV2')")}</div></div></div></div>`},'shifts');
window.attQuick=()=>ZK.form('Quick Setup',[{k:'break_name',l:'Break Time Name',ph:'optional, e.g. Lunch'},{k:'break_start',l:'Break Start Time',t:'text',ph:'13:00'},{k:'break_end',l:'Break End Time',t:'text',ph:'14:00'},
  {k:'timetable_name',l:'Timetable Name',req:true},{k:'check_in',l:'Check-In',t:'text',ph:'09:00',req:true},{k:'check_out',l:'Check-Out',t:'text',ph:'18:00',req:true},{k:'shift_name',l:'Shift Name',hint:'Leave empty to use the timetable name'},{k:'workdays',l:'Work Days',hint:'0=Sunday ... 6=Saturday',ph:'1,2,3,4,5,6'}],{check_in:'09:00',check_out:'18:00'},
  async b=>{await A('quickset','POST',b);go('Shifts')},'Finish');

// ============================================================ Setup: pay code, fixed code, group
const pcFields=[{k:'code',l:'Code',req:true},{k:'name',l:'Name',req:true},{k:'ptype',l:'Type',t:'select',opts:['Regular','Overtime','Leave','Exception','Training'].map(x=>[x,x]),blank:false},{k:'pay_factor',l:'Pay Share (0 unpaid - 1 full day)',t:'number',req:true},
  {k:'fixed_hours',l:'Working Fixed Hours (Hour)',t:'number',req:true},{k:'unit',l:'Unit',t:'select',opts:['Minute','Hour','Workday','HH:MM'].map(x=>[x,x]),blank:false},{k:'symbol',l:'Symbol'},{k:'round_off',l:'Round Off',t:'select',opts:['Round Off','Round Up','Round Down'].map(x=>[x,x]),blank:false},
  {k:'min_val',l:'Minimum',t:'number',req:true},{k:'ord',l:'Display Order',t:'number',req:true},{k:'display',l:'Display',t:'checkbox'},{k:'descr',l:'Description',t:'textarea'},{k:'color',l:'Color Settings',hint:'e.g. #f0ad4e'}];
attGrid('Pay codes','Pay Code',{load:()=>A('paycodes'),defaults:{pay_factor:1,fixed_hours:8,unit:'Hour',round_off:'Round Off',min_val:0.1,ord:999,display:1,ptype:'Regular'},
  cols:[['Code','code',{link:true}],['Name','name'],['Type','ptype'],['Unit','unit'],['Symbol',r=>r.symbol||''],['Order','ord'],['Description',r=>r.descr||'-'],['Color Settings',r=>swatch(r.color)||'-',{html:true}],['Display',r=>r.display?window.ZK_OK:'<span style="color:#d9453f">&#10007;</span>',{html:true}]],
  fields:pcFields,api:'att/paycodes',note:'Every attendance status has a code. Pay Share is how much of a day is paid for it (1 = full day, 0 = nothing); payroll takes the unpaid part off the salary.'},'settings');

attGrid('zk:fixedcode','Fixed Code',{acts:[],rowDel:false,load:()=>A('fixedcodes'),defaults:{format:'HH:MM',round_off:'Round Off',min_val:0.1},
  cols:[['Name','name',{link:true}],['Format','format'],['Symbol',r=>r.symbol||''],['Round Off','round_off'],['Minimum','min_val'],['Color Settings',r=>swatch(r.color),{html:true}]],
  fields:[{k:'name',l:'Name',req:true},{k:'format',l:'Format',t:'select',opts:['HH:MM','Hour','Minute','Workday'].map(x=>[x,x]),blank:false},{k:'symbol',l:'Symbol'},{k:'round_off',l:'Round Off',t:'select',opts:['Round Off','Round Up','Round Down'].map(x=>[x,x]),blank:false},{k:'min_val',l:'Minimum',t:'number',req:true},{k:'color',l:'Color Settings',hint:'e.g. #f0ad4e'}],
  api:'att/fixedcodes'},'settings');

attGrid('zk:attgroup','Group',{details:{title:'Employees',wide:true,render:async r=>{const e=(await api('employees?status=active')).filter(x=>x.group_id==r.id);return `<div style="margin:-10px -14px 8px;background:#fff"><button class="zb" onclick="ZK.rmGroupEmp()">Remove</button></div>`+(e.length?`<table style="width:100%;border-collapse:collapse"><tr><th></th><th style="text-align:left">Employee ID</th><th style="text-align:left">First Name</th><th style="text-align:left">Department</th></tr>${e.map(x=>`<tr><td><input type="checkbox" class="gp_e" value="${x.id}"></td><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td>${esc(x.department||'')}</td></tr>`).join('')}</table>`:'<div style="text-align:center;color:#999;padding:16px">None</div>')}},load:()=>A('groups'),defaults:{},
  cols:[['Group Code','code',{link:true}],['Group Name','name'],['Employee Qty.','employees']],
  fields:[{k:'code',l:'Group Code',req:true},{k:'name',l:'Group Name',req:true}],api:'att/groups',
  save:async(b,row)=>{if(!row&&!b.code)b.code=(await A('groups/next-code')).code;return api(row?`att/groups/${row.id}`:'att/groups',row?'PUT':'POST',b)},
  acts:[['Add'],['Delete'],['Personnel Transfer',()=>ZK.form('Personnel Transfer',[{k:'group_id',l:'Move into group',t:'select',req:true,opts:async()=>(await A('groups')).map(g=>[g.id,`${g.code} - ${g.name}`])},...pickFields],{},async b=>{const r=await A('groups/transfer','POST',{group_id:b.group_id,...pickBody(b)});alert(`${r.moved} employee(s) moved`)},'Transfer')]]},'organization');
ZK.custom['zk:attgroup']=async id=>{const o=ZK.G['zk:attgroup'].o,row=id?ZK.G['zk:attgroup'].all.find(r=>r.id===id)||{}:{code:(await A('groups/next-code')).code};ZK.form((id?'Edit ':'Add ')+'Group',o.fields,row,b=>o.save(b,id?row:null))};

// ============================================================ Rule: global rule, department rule, group rule
const GR_TABS=[['Basic Settings',[{k:'weekend1',l:'Weekend1',t:'select',opts:WK,blank:false},{k:'global_weekend1_color_setting',l:'Color Setting'},{k:'weekend2',l:'Weekend2',t:'select',opts:WK,blank:false},{k:'global_weekend2_color_setting',l:'Color Setting'},
    {k:'punch_period',l:'Duplicate Punch Interval (Minute)',t:'number',req:true},{k:'start_of_week',l:'Start Off for the Week',t:'select',opts:[...WK.slice(1),[7,'System Based']],blank:false}]],
  ['Rule for Non-scheduled Days',[{k:'max_hrs',l:'Max Work Hour (Hour)',t:'number',req:true},timeF('day_change','Day Change Time',{ph:'HH:MM:SS'}),{k:'paring_rule',l:'Paring Rule',t:'select',opts:PAIR,blank:false}]],
  ['Overtime Rule',[{k:'ot_pay_code',l:'Overtime Assign To',t:'select',opts:OTC2,blank:false},{k:'overtime_policy',l:'Overtime Approval Policy',t:'select',opts:OTPOL,blank:false},{k:'enable_daily_ot',l:'Daily Overtime',t:'checkbox'},...tierFields('d'),
    {k:'use_ot',l:'Overtime Rule',t:'select',opts:[[0,'Disable Overtime Calculation'],[1,'Calculation OT'],[2,'Approval OT'],[3,'Approval OT Priority']],blank:false},{k:'enable_compensatory',l:'Enable Compensatory',t:'checkbox'},
    {k:'enable_weekend_ot',l:'Weekend Overtime',t:'checkbox'},...tierFields('w1'),{k:'enable_holiday_ot',l:'Holiday Overtime',t:'checkbox'},...tierFields('h'),{k:'enable_weekly_ot',l:'Weekly Overtime',t:'checkbox'},...tierFields('t')]],
  ['Calculation Settings',[{k:'late_in2absence',l:'When late exceeds (Minute)',t:'number',req:true,hint:'Arriving later than this counts as Absent (0 = off)'},{k:'early_out2absence',l:'When early-leave exceeds (Minute)',t:'number',req:true},
    {k:'miss_in',l:'Missing Check-In as',t:'select',opts:[[1,'Late'],[2,'Absent'],[0,'Incomplete']],blank:false},{k:'late_in_hrs',l:'Missing Check-In counts as late by (Minute)',t:'number'},
    {k:'miss_out',l:'Missing Check-Out as',t:'select',opts:[[1,'Early Leave'],[2,'Absent'],[0,'Incomplete']],blank:false},{k:'early_out_hrs',l:'Missing Check-Out counts as early by (Minute)',t:'number'}]],
  ['APP Settings',[{k:'require_capture',l:'Capture',t:'checkbox'},{k:'require_work_code',l:'Work Code',t:'checkbox'},{k:'require_punch_state',l:'Punch State',t:'checkbox'}]],
  ['Attendance Alert Settings',[{k:'max_late_in',l:'When the number of late exceeds',t:'number'},{k:'max_early_out',l:'When the number of early-leave exceeds',t:'number'},{k:'max_absent',l:'When the number of absents exceeds',t:'number'},
    {k:'global_frequency',l:'Sending Frequency',t:'select',opts:[[0,'No'],[3,'Daily'],[2,'Weekly'],[1,'Monthly']],blank:false},{k:'global_send_day',l:'Day',t:'select',opts:Array.from({length:31},(_,i)=>[i,String(i)]),blank:false},timeF('email_send_time','Time',{ph:'HH:MM:SS'}),
    {k:'sending_day',l:'Sending Day',t:'select',opts:[[0,'Current Day'],[-1,'Next Day']],blank:false},{k:'bot_uid',l:'Bot Uid'}]]];
const GR_ALL=GR_TABS.flatMap(t=>t[1]);
ZK.reg('zk:globalrule','Global Rule',async()=>{const v=await A('globalrule');window._gr=v;
  const body=(await Promise.all(GR_TABS.map(async(t,i)=>`<div class="grt" id="grt${i}" style="${i?'display:none':''}"><div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">${(await Promise.all(t[1].map(async f=>{const h=await ZK.fieldHtml(f,v[f.k]);return f.t==='checkbox'||f.k==='use_ot'?`<div style="grid-column:1/-1;border-top:1px solid var(--line);padding-top:8px">${h}</div>`:h}))).join('')}</div></div>`))).join('');
  return `<div class="zse zse2"><div class="zst">${GR_TABS.map((t,i)=>`<a class="${i?'':'on'}" id="grb${i}" onclick="grTab(${i})">${esc(t[0])}</a>`).join('')}</div>${body}<div class="svbar"><span id="gr_m" class="mut sm"></span><button class="sv" onclick="grSave()">Save</button></div></div>`},'settings');
window.grTab=i=>{document.querySelectorAll('.grt').forEach((e,j)=>e.style.display=i===j?'':'none');document.querySelectorAll('.grb,#zse_x a[id^=grb],.zse2 .zst a').forEach((e,j)=>e.classList.toggle('on',i===j))};
window.grSave=async()=>{const m=document.getElementById('gr_m');try{const b=ZK.read(GR_ALL);for(const f of GR_ALL)if(b[f.k]==null&&f.t==='number')b[f.k]=0;await A('globalrule','PUT',b);m.textContent='Saved';m.style.color='var(--ok)'}catch(e){m.textContent=e.message;m.style.color='var(--bad)'}};
const ruleFields=(tgtLabel,tgtOpts)=>[{k:'target_id',l:tgtLabel,t:'select',req:true,opts:tgtOpts,blank:'---------'},{k:'weekend1',l:'Weekend1',t:'select',opts:WK,blank:false},{k:'weekend1_color_setting',l:'Color Settings'},{k:'weekend2',l:'Weekend2',t:'select',opts:WK,blank:false},{k:'weekend2_color_setting',l:'Color Settings'},
  {k:'punch_period',l:'Duplicate Punch Interval (Minute)',t:'number',req:true},{k:'max_hrs',l:'Max Work Hour (Hour)',t:'number',req:true},timeF('day_change','Day Change Time',{ph:'HH:MM:SS'}),{k:'paring_rule',l:'Paring Rule',t:'select',opts:PAIR,blank:false},
  {k:'ot_pay_code',l:'Overtime Assign To',t:'select',opts:OTC2,blank:false},{k:'overtime_policy',l:'Overtime Approval Policy',t:'select',opts:OTPOL,blank:false},{k:'enable_daily_ot',l:'Daily Overtime',t:'checkbox'},...tierFields('d'),
  {k:'enable_weekend_ot',l:'Weekend Overtime',t:'checkbox'},...tierFields('w1'),{k:'enable_holiday_ot',l:'Holiday Overtime',t:'checkbox'},...tierFields('h'),{k:'enable_weekly_ot',l:'Weekly Overtime',t:'checkbox'},...tierFields('t')];
const ruleDefaults={weekend1:7,weekend2:7,punch_period:1,max_hrs:12,day_change:'00:00:00',paring_rule:1,overtime_policy:-1,ot_pay_code:''};
const paringName=v=>(PAIR.find(x=>x[0]==v)||[0,''])[1];
const ruleOt=(on,p)=>on?'Enable':'Disable';
for(const [key,title,scope,tl,opts,col] of [['zk:deptrule','Department Rule','dept','Department',idName('departments'),'Department'],['zk:grprule','Group Rule','group','Group',async()=>(await api('emp_groups')).map(x=>[x.id,x.name]),'Group']])
  attGrid(key,title,{load:()=>A('rules/'+scope),defaults:ruleDefaults,fields:ruleFields(tl,opts),api:`att/rules/${scope}`,
    save:async(b,row)=>{if(row)delete b.target_id;return api(row?`att/rules/${scope}/${row.id}`:`att/rules/${scope}`,row?'PUT':'POST',b)},
    cols:[[col,'target',{link:true}],[scope==='dept'?'Max Working Hours':'Max Work Hour','max_hrs'],['Day Change Time','day_change'],['Paring Rule',r=>paringName(r.paring_rule)],['Daily Overtime',r=>ruleOt(r.enable_daily_ot)],['Weekend Overtime',r=>ruleOt(r.enable_weekend_ot)],['Holiday Overtime',r=>ruleOt(r.enable_holiday_ot)],['Weekly Overtime',r=>ruleOt(r.enable_weekly_ot)]],
    note:'The duplicate punch interval of a rule is applied to the people of the '+tl.toLowerCase()+' through an attendance policy; the Global Rule covers everybody else.'},'settings');
{ // the target cannot be changed when editing
  for(const key of ['zk:deptrule','zk:grprule'])ZK.custom[key]=async id=>{const s=ZK.G[key],o=s.o,row=id?s.all.find(r=>r.id===id)||{}:o.defaults;const f=id?o.fields.filter(x=>x.k!=='target_id'):o.fields;
    ZK.form((id?'Edit ':'Add ')+ZK.t(key)+(id?' - '+row.target:''),f,row,b=>o.save(b,id?row:null))}}

// ============================================================ Shift: break time, timetable, shift
const BR_FIELDS=[{k:'alias',l:'Name',req:true},{k:'calc_type',l:'Calculation Type',t:'select',opts:[[0,'Auto Deduct'],[1,'Punch Time Is Required']],blank:false},timeF('period_start','Start Time'),timeF('period_end','End Time'),{k:'end_margin',l:'Latest punch after end (Minute)',t:'number'},{k:'duration',l:'Duration (Minute)',t:'number',req:true},
  {k:'with_salary',l:'With Salary',t:'select',opts:[[0,'No'],[1,'Yes']],blank:false,hint:'Yes: the break is paid, nothing is deducted from worked time'},{k:'available_interval_type',l:'Duplicate Punch Policy',t:'select',opts:[[0,'Rule Based'],[1,'User Defined']],blank:false},{k:'available_interval',l:'Duplicate Punch Interval (Minute)',t:'number'},
  {k:'func_key',l:'Punch State Based',t:'select',opts:[[0,'No'],[1,'Yes']],blank:false},{k:'multiple_punch',l:'Multiple In/Out',t:'select',opts:[[0,'No'],[1,'Yes']],blank:false},{k:'minimum_duration',l:'Minimum Break Time (Minute)',t:'number'},
  {k:'profit_rule',l:'Early In',t:'checkbox'},{k:'min_early_in',l:'Early In More Than (Minute)',t:'number'},{k:'profit_code',l:'Early In Assign To',t:'select',opts:OTC,blank:false},
  {k:'loss_rule',l:'Late In',t:'checkbox'},{k:'min_late_in',l:'Late In More Than (Minute)',t:'number'},{k:'loss_code',l:'Late In Assign To',t:'select',opts:[['','---------'],['Late In','Late In'],['Early Out','Early Out'],['Absence','Absence']],blank:false}];
const brRow=r=>({...r,alias:r.name,period_start:r.start,period_end:r.end});
attGrid('zk:breaktime','Break Time',{load:async()=>(await A('breaktimes')).map(brRow),defaults:{calc_type:0,period_start:'12:00',period_end:'13:00',end_margin:60,duration:60,with_salary:1,available_interval:1,min_early_in:0,min_late_in:0,minimum_duration:0},fields:BR_FIELDS,api:'att/breaktimes',
  cols:[['Name','name',{link:true}],['Start Time',r=>r.start+':00'],['End Time',r=>r.end+':00'],['Duration','duration'],['With Salary',r=>yn(r.with_salary)],['Calculation Type',r=>r.calc_type?'Punch Time Is Required':'Auto Deduct']]},'shifts');

const hm5=v=>String(v||'').slice(0,5);
const ttCommon=(flex)=>[{k:'alias',l:'Name',req:true},{k:'pay_code',l:'Work Hours Assign To',t:'select',opts:OTC.filter(x=>x[0]===''||x[0]==='Regular'||x[0]==='Compensatory'||true),blank:false},
  timeF('in_time','Check-In'),...(flex?[]:[]),timeF('out_time','Check-Out'),{k:'out_time_cross_days',l:'Check-Out Cross Days',t:'select',opts:[[0,'0'],[1,'1'],[2,'2'],[3,'3']],blank:false},
  ...(flex?[{k:'work_time_duration',l:'Work Time (Minute)',t:'number',req:true},{k:'work_type',l:'Work Type',t:'select',opts:[[0,'Normal Work'],[1,'Day Off'],[2,'Weekend']],blank:false}]
   :[timeF('begin_in','Check-In Start Time'),timeF('end_in','Check-In End Time'),timeF('begin_out','Check-Out Start Time'),timeF('end_out','Check-Out End Time'),{k:'break_id',l:'Break Time',t:'select',opts:async()=>(await A('breaktimes')).map(b=>[b.id,`${b.name} (${b.start}-${b.end})`]),blank:'None'}]),
  {k:'work_day',l:'WorkDay (Days)',t:'number',req:true},{k:'color_setting',l:'Color Settings',hint:'e.g. #5bc0de'},
  {k:'enable_early_in',l:'Early In',t:'checkbox'},{k:'min_early_in',l:'Early In Minimum (Minute)',t:'number'},{k:'enable_late_out',l:'Late Out',t:'checkbox'},{k:'min_late_out',l:'Late Out Minimum (Minute)',t:'number'},
  ...(flex?[]:[]),{k:'enable_overtime',l:'Overtime',t:'checkbox'},...tierFields('t')];
const ttFields=(flex)=>ttCommon(flex).map(f=>f.k==='work_time_duration'||!f.opts?f:f);
const ttToForm=r=>({...r,alias:r.name,in_time:hm5(r.check_in),out_time:hm5(r.check_out),out_time_cross_days:r.out_cross,work_time_duration:r.work_time,work_type:r.work_type_key,color_setting:r.color,begin_in:r.begin_in,end_in:r.end_in,begin_out:r.begin_out,end_out:r.end_out,
  enable_overtime:r.overtime==='Yes',min_early_in:r.early_in_min,min_late_out:r.late_out_min,compensate_duration:r.compensate,
  ...Object.fromEntries([1,2,3].flatMap(i=>[[`t${i}_pay_code`,(r.ot_tiers[i-1]||{}).pay_code||''],[`t${i}_hrs_from`,(r.ot_tiers[i-1]||{}).from||0],[`t${i}_hrs_to`,(r.ot_tiers[i-1]||{}).to||0]]))});
const ttDefaults=flex=>flex?{in_time:'00:00',out_time:'00:00',out_time_cross_days:1,work_time_duration:480,work_day:1,work_type:0,pay_code:'Regular',min_late_out:60}:{in_time:'09:00',out_time:'18:00',out_time_cross_days:0,begin_in:'08:00',end_in:'10:00',begin_out:'17:00',end_out:'19:00',work_day:1,pay_code:'Regular',min_early_in:60,min_late_out:60};
const ttForm=(flex,row)=>ZK.form((row?'Edit ':'Add ')+(flex?'Flexible':'Normal')+' Timetable',ttFields(flex),row?ttToForm(row):ttDefaults(flex),async b=>{for(const f of ['t1_hrs_from','t1_hrs_to','t2_hrs_from','t2_hrs_to','t3_hrs_from','t3_hrs_to'])if(b[f]==null)b[f]=0;
  if(row)return A('timetables/'+row.id,'PUT',b);return A('timetables/'+(flex?'flexible':'normal'),'POST',b)});
attGrid('zk:timetable','Timetable',{load:()=>A('timetables'),defaults:{},fields:[],
  cols:[['Name','name',{link:true}],['Type','type'],['Check-In','check_in'],['Check-Out','check_out'],['Work Time','work_time'],['Break Time','break_time'],['WorkDay','work_day'],['Work Type','work_type'],['Overtime','overtime'],['Color Settings',r=>swatch(r.color),{html:true}],['Compensate Duration','compensate']],
  acts:[['Add',()=>ttForm(false)],['Delete'],['Add Normal Timetable',()=>ttForm(false)],['Add Flexible Timetable',()=>ttForm(true)],
    ['Import',[['Import Normal Timetable',()=>attImport('Import Normal Timetable','att/timetables/import','name, check-in HH:MM, check-out HH:MM, workday',{mode:true,extra:{type:'normal'}})],['Import Flexible Timetable',()=>attImport('Import Flexible Timetable','att/timetables/import','name, work minutes, check-in, check-out',{mode:true,extra:{type:'flexible'}})]]]],
  remove:id=>A('timetables/'+id,'DELETE'),api:'att/timetables'},'shifts');
ZK.custom['zk:timetable']=id=>{const row=id?ZK.G['zk:timetable'].all.find(r=>r.id===id):null;ttForm(row?row.type_key==='flexible':false,row)};

const shFields=[{k:'alias',l:'Company Shift Name',req:true},{k:'code',l:'Short code',hint:'Up to 4 letters, shown on the shift calendar'},{k:'timetable_id',l:'Timetable',t:'select',req:true,opts:async()=>(await A('timetables')).map(t=>[t.id,`${t.name} (${hm5(t.check_in)}-${hm5(t.check_out)})`])},
  {k:'workdays',l:'Work Days',hint:'0=Sunday, 1=Monday ... 6=Saturday, comma separated',req:true},{k:'grace_min',l:'Grace (Minute)',t:'number'},{k:'unit',l:'Unit',t:'select',opts:[['Day','Day'],['Week','Week'],['Month','Month']],blank:false},{k:'cycle',l:'Cycle',t:'number',req:true},{k:'auto_shift',l:'Auto Shift',t:'checkbox'},
  {k:'enable_ot_rule',l:'Weekly Overtime',t:'checkbox'},...tierFields('t')];
const shToForm=r=>({...r,alias:r.name,auto_shift:!!r.auto_shift_key,enable_ot_rule:!!r.weekly_ot_key,...Object.fromEntries([1,2,3].flatMap(i=>[[`t${i}_pay_code`,(r.tiers[i-1]||{}).pay_code||''],[`t${i}_hrs_from`,(r.tiers[i-1]||{}).from||0],[`t${i}_hrs_to`,(r.tiers[i-1]||{}).to||0]]))});
attGrid('Shifts','Shift',{details:true,load:()=>A('shiftdefs'),defaults:{workdays:'1,2,3,4,5,6',grace_min:10,unit:'Week',cycle:1},fields:shFields,api:'att/shiftdefs',
  cols:[['Shift Name','name',{link:true}],['Timetable','timetable'],['Unit','unit'],['Cycle','cycle'],['Auto Shift','auto_shift'],['Weekly Overtime','weekly_ot']],
  save:async(b,row)=>{for(const f of ['t1_hrs_from','t1_hrs_to','t2_hrs_from','t2_hrs_to','t3_hrs_from','t3_hrs_to'])if(b[f]==null)b[f]=0;return api(row?`att/shiftdefs/${row.id}`:'att/shiftdefs',row?'PUT':'POST',b)}},'shifts',tailOf('Shifts','Rotations, saved breaks, overtime policies and shift rules (advanced)'));
ZK.custom['Shifts']=async id=>{const s=ZK.G['Shifts'],row=id?s.all.find(r=>r.id===id):null,tts=await A('timetables');
  const S=window.SHF={tts,id,unit:row?.unit||'Week',cycle:row?.cycle||1,sel:null,pat:row?.pattern||null,fields:[{k:'code',l:'Short code',hint:'Up to 4 letters, shown on the shift calendar'},{k:'grace_min',l:'Grace (Minute)',t:'number'}],otf:[{k:'enable_ot_rule',l:'Weekly Overtime',t:'checkbox'},...tierFields('t')],row};
  if(row&&!S.pat){const ids=tts.find(t=>t.id===row.timetable_id)?row.timetable_id:null,wd=String(row.workdays||'').split(',').map(Number);S.pat=[Array.from({length:7},(_,i)=>wd.includes(i)?ids:null)]}
  S.sel=row?.timetable_id||(tts[0]||{}).id||null;
  const v=row?shToForm(row):s.o.defaults,f1=(await Promise.all(S.fields.map(f=>ZK.fieldHtml(f,v[f.k])))).join(''),f2=(await Promise.all(S.otf.map(f=>ZK.fieldHtml(f,v[f.k])))).join('');
  const m=orgModal('Add',`<div class="shtop"><label>Shift Name <b style="color:#e0281b">*</b><input id="sh_name" value="${esc(row?.name||'')}"></label><label>Auto Shift<input id="sh_auto" type="checkbox" ${row?.auto_shift_key?'checked':''}></label></div>
  <div class="shtabs"><a class="on" onclick="shTab(0)">General Setting</a><a onclick="shTab(1)">Other Setting</a><a onclick="shTab(2)">Weekly Overtime</a></div>
  <div id="shp0" class="shpane"><div class="shl"><input id="sh_q" placeholder="Timetable" oninput="shDraw()"><div class="shtt"><table id="sh_tt"></table></div></div><div class="shr"><div class="shur"><label>Unit <b style="color:#e0281b">*</b> <select id="sh_unit" onchange="shUnit()">${['Day','Week','Month'].map(u=>`<option ${u===S.unit?'selected':''}>${u}</option>`).join('')}</select></label><label>Cycle <b style="color:#e0281b">*</b> <input id="sh_cyc" type="number" min="1" max="31" value="${S.cycle}" onchange="shUnit()"></label></div><div class="shg"><table id="sh_grid"></table></div></div></div>
  <div id="shp1" class="shpane" style="display:none"><div class="grid">${f1}</div></div><div id="shp2" class="shpane" style="display:none"><div class="grid">${f2}</div></div>
  <div class="shnote"><b>*Notice</b><br>1. Pick a timetable on the left, then click the days of the grid it applies to.<br>2. Click a filled day again to clear it. Different days can use different timetables.</div>`,'shGo()');
  m.firstChild.classList.add('shw');window.shTab=i=>{[0,1,2].forEach(j=>{document.getElementById('shp'+j).style.display=j===i?'':'none';document.querySelectorAll('.shtabs a')[j].classList.toggle('on',j===i)})};shDraw();shGridDraw()};
window.shDraw=()=>{const S=window.SHF,q=(document.getElementById('sh_q').value||'').toLowerCase();document.getElementById('sh_tt').innerHTML=`<tr><th></th><th>Name</th><th>Check-In</th><th>Check-Out</th><th>Break Time</th></tr>`+(S.tts.filter(t=>t.name.toLowerCase().includes(q)).map(t=>`<tr class="${t.id===S.sel?'on':''}" onclick="SHF.sel=${t.id};shDraw()"><td><input type="radio" ${t.id===S.sel?'checked':''}></td><td>${esc(t.name)}</td><td>${hm5(t.check_in)}</td><td>${hm5(t.check_out)}</td><td>${esc(t.break_time||'')}</td></tr>`).join('')||'<tr><td colspan=5 style="text-align:center;color:#999">None</td></tr>')};
window.shUnit=()=>{const S=window.SHF;S.unit=document.getElementById('sh_unit').value;S.cycle=Math.max(1,Math.min(31,Number(document.getElementById('sh_cyc').value)||1));S.pat=null;shGridDraw()};
window.shGridDraw=()=>{const S=window.SHF,w=S.unit==='Week'?7:S.unit==='Month'?31:1,hd=S.unit==='Week'?['Sun','Mon','Tue','Wed','Thu','Fri','Sat']:Array.from({length:w},(_,i)=>S.unit==='Month'?i+1:'Day');
  S.pat=Array.from({length:S.cycle},(_,r)=>Array.from({length:w},(_,c)=>(S.pat&&S.pat[r]&&S.pat[r][c])||null));
  document.getElementById('sh_grid').innerHTML=`<tr><th style="width:26px"></th>${hd.map(h=>`<th>${h}</th>`).join('')}</tr>`+S.pat.map((r,i)=>`<tr><td>${i+1}</td>${r.map((v,c)=>`<td class="shc ${v?'on':''}" onclick="shCell(${i},${c})">${v?esc((S.tts.find(t=>t.id===v)||{}).name||''):''}</td>`).join('')}</tr>`).join('')};
window.shCell=(r,c)=>{const S=window.SHF;S.pat[r][c]=S.pat[r][c]?null:S.sel;shGridDraw()};
window.shGo=async()=>{const S=window.SHF,e=document.getElementById('om_e'),name=document.getElementById('sh_name').value.trim();if(!name)return e.textContent='Shift Name is required';
  const b={alias:name,auto_shift:document.getElementById('sh_auto').checked,unit:S.unit,cycle:S.cycle,pattern:S.pat,...ZK.read([...S.fields,...S.otf])};for(const f of ['t1_hrs_from','t1_hrs_to','t2_hrs_from','t2_hrs_to','t3_hrs_from','t3_hrs_to'])if(b[f]==null)b[f]=0;
  try{await api(S.row?`att/shiftdefs/${S.row.id}`:'att/shiftdefs',S.row?'PUT':'POST',b);document.getElementById('dvm')?.remove();go('Shifts')}catch(x){e.textContent=x.message}};

// ============================================================ Schedule assignment
const shiftOpts=async()=>(await A('shiftdefs')).map(s=>[s.id,`${s.name} (${s.timetable})`]);
for(const [key,title,path,tcol,tl,topts,cols] of [
  ['zk:deptsched','Department Schedule','deptsched','department_id','Department',idName('departments'),[['Department Code',r=>r.dept_code||''],['Department Name','dept_name',{link:true}],['Employee Qty.','employees'],['Shift Name','shift'],['Start Date','start_date'],['End Date','end_date']]],
  ['zk:grpsched','Group Schedule','grpsched','group_id','Group',async()=>(await A('groups')).map(g=>[g.id,`${g.code} - ${g.name}`]),[['Group Code',r=>r.group_code||''],['Group Name','group_name',{link:true}],['Employee Qty.','employees'],['Start Date','start_date'],['End Date','end_date'],['Shift','shift']]]])
  attGrid(key,title,{details:{title:'Details',render:r=>schedPanel(r,[tl,r.dept_name||r.group_name||''])},load:()=>A(path),defaults:{start_date:today(),end_date:addD(today(),365)},fields:[{k:tcol,l:tl,t:'select',req:true,opts:topts},dateF('start_date','Start Date'),dateF('end_date','End Date'),{k:'shift_id',l:'Shift',t:'select',req:true,opts:shiftOpts}],api:'att/'+path,cols,
    note:'The department or group follows this shift on those dates unless an employee has an own schedule, temporary schedule or rotation.'},'shifts');

const empShiftFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},dateF('start_date','Start Date'),dateF('end_date','End Date'),{k:'shift_id',l:'Shift',t:'select',req:true,opts:shiftOpts}];
const L2=(a,b)=>`<div><b style="font-weight:400;color:#999;display:inline-block;width:90px">${a}</b>${esc(b==null?'':b)}</div>`;
window.ZSCHED=null;
ZK.schedDays=()=>{const r=window.ZSCHED,f=document.getElementById('zsd_f').value,t=document.getElementById('zsd_t').value,box=document.getElementById('zsd_l');if(!r||!box)return;const out=[];let d=new Date((f||r.start_date)+'T00:00:00'),end=new Date((t||r.end_date)+'T00:00:00');
  for(let n=0;d<=end&&n<62;n++,d=new Date(d.getTime()+864e5)){const s=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');if(s>=r.start_date&&s<=r.end_date)out.push(s)}
  box.innerHTML=out.length?`<table><tr><th>Date</th><th>Shift Name</th></tr>${out.map(x=>`<tr><td>${x}</td><td>${esc(r.shift||'')}</td></tr>`).join('')}</table>`:'<div style="text-align:center;color:#999;padding:14px">None</div>'};
const schedPanel=(r,head)=>{window.ZSCHED=r;const m=today().slice(0,8),f=m+'01',t=m+'31';setTimeout(()=>ZK.schedDays(),0);return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px"><input id="zsd_f" class="zd" type="text" value="${f}" style="width:100px;height:26px"><span>-</span><input id="zsd_t" class="zd" type="text" value="${t}" style="width:100px;height:26px"><a style="cursor:pointer" onclick="ZK.schedDays()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></a></div>${L2(head[0],head[1])}${L2('Employee Qty.',r.employees)}<div id="zsd_l" style="margin-top:8px"></div>`};
const DRD={title:'Details',render:r=>schedPanel(r,['Employee',(r.first_name||'')+' '+(r.last_name||'')])};
attGrid('Roster','Employee Schedule',{details:DRD,rowActs:false,load:()=>A('empsched'),defaults:{start_date:today(),end_date:today()},fields:empShiftFields,api:'att/empsched',
  cols:[['Employee ID','code',{link:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Position',r=>r.position||''],['Department',r=>r.dept||''],['Shift Name','shift'],['Start Date','start_date'],['End Date','end_date']],
  acts:[['Delete'],['Add Schedule',()=>ZK.form('Add Schedule',[...pickFields,dateF('start_date','Start Date'),dateF('end_date','End Date'),{k:'shift_id',l:'Shift',t:'select',req:true,opts:shiftOpts},{k:'schedule_cover',l:'Cover existing schedule',t:'checkbox'}],{start_date:today(),end_date:today(),schedule_cover:true},async b=>bulkDone(await A('empsched','POST',{...pickBody(b),shift_id:b.shift_id,start_date:b.start_date,end_date:b.end_date,schedule_cover:b.schedule_cover})),'Save')],
    ['Import',()=>attImport('Import Employee Schedule','att/empsched/import','employee ID, shift name, start date, end date',{mode:true})]]},'shifts',tailOf('Roster','Shift change and swap requests, rotation suggestions (advanced)'));
ZK.custom['Roster']=id=>{const s=ZK.G['Roster'],row=id?s.all.find(r=>r.id===id):null;ZK.form((id?'Edit ':'Add ')+'Employee Schedule'+(id?` - ${row.code} ${row.name}`:''),id?empShiftFields.filter(f=>f.k!=='employee_id'):empShiftFields,row||s.o.defaults,
  async b=>{if(row){delete b.employee_id;return A('empsched/'+row.id,'PUT',b)}return A('empsched','POST',b)})};
const ttOpts=async()=>(await A('timetables')).map(t=>[t.id,`${t.name} (${hm5(t.check_in)}-${hm5(t.check_out)})`]);
attGrid('zk:tempsched','Temporary Schedule',{load:()=>A('tempsched'),defaults:{date:today()},fields:[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},dateF('date','Date'),{k:'timetable_id',l:'Timetable',t:'select',req:true,opts:ttOpts}],api:'att/tempsched',
  cols:[['Employee ID','code',{link:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Position',r=>r.position||''],['Department',r=>r.dept||''],['Date','date'],['Timetable','timetable'],['Check In','check_in'],['Check Out','check_out']],
  acts:[['Add'],['Delete'],['Add Temporary Schedule',()=>ZK.form('Add Temporary Schedule',[...pickFields,dateF('date','Start Date'),dateF('end_date','End Date'),{k:'timetable_id',l:'Timetable',t:'select',req:true,opts:ttOpts}],{date:today(),end_date:today()},async b=>bulkDone(await A('tempsched','POST',{...pickBody(b),timetable_id:b.timetable_id,date:b.date,end_date:b.end_date})),'Save')],
    ['Import',()=>attImport('Import Temporary Schedule','att/tempsched/import','employee ID, date, timetable name')]],
  note:'A temporary schedule replaces the employee\'s normal schedule for that one day.'},'shifts');

// ============================================================ Schedule preview
{const old=OLD['Shift calendar'];ZK.reg('Shift calendar','Schedule View',async()=>(await old()).replace('<h2>Shift calendar</h2>','<h2>Schedule View</h2>'),'shifts')}
window.PSF=window.PSF||{};
ZK.reg('zk:personsched','View by Person',async()=>{const f=window.PSF,emps=await api('employees?status=active');if(!f.employee_id&&emps.length)f.employee_id=emps[0].id;f.month=f.month||today().slice(0,7);
  const d=f.employee_id?await A(`personsched?employee_id=${f.employee_id}&month=${f.month}`):{days:[]};const DN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return `<h2>View by Person</h2><div class="bar"><select id="ps_e">${emps.map(e=>`<option value="${e.id}" ${e.id==f.employee_id?'selected':''}>${esc(e.code)} - ${esc(e.name)}</option>`).join('')}</select><input id="ps_m" type="month" value="${esc(f.month)}"><button onclick="window.PSF={employee_id:+val('ps_e'),month:val('ps_m')};go('zk:personsched')">Show</button></div>`+
  tbl([['Date','date'],['Day','',r=>DN[r.dow]],['Schedule','',r=>r.holiday?`Holiday: ${esc(r.holiday)}`:r.leave?`Leave: ${esc(r.leave)}`:r.off?'Off':esc(r.shift||'No shift')],['Check-In','',r=>r.holiday||r.leave||r.off?'':esc(r.start||'')],['Check-Out','',r=>r.holiday||r.leave||r.off?'':esc(r.end||'')],['Source','',r=>r.shift?esc(r.source):'']],d.days,{size:31})},'shifts');

// ============================================================ Approvals
const dtF=(k,l,x={})=>({k,l,t:'datetime',req:true,...x});
const approvalActs=(key,o)=>[['Add'],['Delete'],['Bulk Add',()=>o.bulk()],['Approve',ctx=>each(ctx,r=>o.approve(r),'approved')],['Reject',ctx=>{const n=note();if(n===null)return;return each(ctx,r=>o.reject(r,n),'rejected')}],['Revoke',ctx=>each(ctx,r=>o.revoke(r),'revoked')],['Import',()=>o.imp()]];
const apCols=(mid)=>[['Employee ID','code',{link:true}],['Photo',photo,{html:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Department',r=>r.dept||''],['Position',r=>r.position||''],...mid,['Apply Reason',r=>r.reason||''],['Apply Time','apply_time'],];
const tail=[['Approval Status','approval_status'],['Workflow Builder',r=>r.workflow||'General'],['Attachment',r=>r.attachment||''],['Approval Comment',r=>r.decision_note||''],['Approval Time',r=>r.decided_at||''],['Last Approver',r=>r.decided_by||'']];
const nowLocal=()=>new Date().toLocaleString('sv').slice(0,16);

// ---- Manual Log (Requests)
const mlFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},{k:'type',l:'Type',t:'select',opts:[['punch','Manual punch'],['On Duty','On Duty'],['Work From Home','Work From Home'],['Training','Training']],blank:false},
  dtF('punch_time','Punch Time'),{k:'punch_state',l:'Punch State',t:'select',opts:['Check In','Check Out','Break Out','Break In','Overtime In','Overtime Out'].map((x,i)=>[i,x]),blank:false},{k:'work_code',l:'Work Code'},{k:'reason',l:'Apply Reason',t:'textarea'}];
const mlApi={approve:r=>api(`attendance/requests/${r.id}/approve`,'POST',{}),reject:(r,n)=>api(`attendance/requests/${r.id}/reject`,'POST',{note:n}),revoke:r=>A(`manuallog/${r.id}/revoke`,'POST',{}),
  bulk:()=>ZK.form('Bulk Add Manual Log',[...pickFields,dtF('punch_time','Punch Time'),{k:'punch_state',l:'Punch State',t:'select',opts:['Check In','Check Out','Break Out','Break In','Overtime In','Overtime Out'].map((x,i)=>[i,x]),blank:false},{k:'work_code',l:'Work Code'},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},{k:'reason',l:'Apply Reason',t:'textarea'}],{punch_time:nowLocal(),auto_approve:true},async b=>bulkDone(await A('manuallog/bulk','POST',{...pickBody(b),punch_time:b.punch_time,punch_state:b.punch_state,work_code:b.work_code,auto_approve:b.auto_approve,reason:b.reason})),'Save'),
  imp:()=>attImport('Import Manual Log','att/manuallog/import','employee ID, punch time YYYY-MM-DD HH:MM, punch state number, reason',{auto:true})};
const WFD={title:'Workflow',render:r=>`<div style="line-height:26px">${[['Applicant',(r.name||r.code||'')],['Apply Time',r.apply_time],['Reason',r.reason],['Approval Status',r.approval_status||r.status],['Approved By',r.approved_by||r.approver]].map(x=>`<div><b style="font-weight:400;color:#999;display:inline-block;width:110px">${x[0]}</b>${esc(x[1]||'')}</div>`).join('')}</div>`};
attGrid('Requests','Manual Log',{details:{title:'Workflow',render:r=>`<div style="line-height:26px"><div><b style="font-weight:400;color:#999;display:inline-block;width:110px">Applicant</b>${esc(r.name||r.code||'')}</div><div><b style="font-weight:400;color:#999;display:inline-block;width:110px">Apply Time</b>${esc(r.apply_time||'')}</div><div><b style="font-weight:400;color:#999;display:inline-block;width:110px">Reason</b>${esc(r.reason||'')}</div><div><b style="font-weight:400;color:#999;display:inline-block;width:110px">Approval Status</b>${esc(r.approval_status||r.status||'')}</div><div><b style="font-weight:400;color:#999;display:inline-block;width:110px">Approved By</b>${esc(r.approved_by||r.approver||'')}</div></div>`},load:()=>A('manuallog?'+fq('Requests')),defaults:{type:'punch',punch_time:nowLocal(),punch_state:0,auto_approve:false},fields:mlFields,api:'att/manuallog',remove:id=>A('manuallog/'+id,'DELETE'),
  filter:()=>fbar('Requests',{dates:true,empty:true}),
  cols:[...apCols([['Punch Time','punch_time'],['Punch State','punch_state'],['Work Code',r=>r.work_code||'']]).slice(0,6),['Punch Time','punch_time'],['Punch State','punch_state'],['Work Code',r=>r.work_code||''],['Apply Reason',r=>r.reason||''],['Apply Time','apply_time'],...tail],
  acts:approvalActs('Requests',mlApi)},'attendance');
ZK.custom['Requests']=id=>{const s=ZK.G['Requests'];if(id)return alert('A manual log cannot be edited. Revoke or delete it and add a new one.');ZK.form('Add Manual Log',mlFields,s.o.defaults,b=>A('manuallog','POST',b))};

// ---- Leave
const lvTypes=async()=>(await api('leave_types')).map(t=>[t.name,t.name]);
const lvFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},dateF('start_time','Start Time'),dateF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:lvTypes},{k:'half',l:'Half Day',t:'checkbox'},{k:'reason',l:'Apply Reason',t:'textarea'}];
const lvApi={approve:r=>api(`leaves/${r.id}/approve`,'POST',{}),reject:(r,n)=>api(`leaves/${r.id}/reject`,'POST',{note:n}),revoke:r=>api(`leaves/${r.id}/cancel`,'POST',{}),
  bulk:()=>ZK.form('Bulk Add Leave',[...pickFields,dateF('start_time','Start Time'),dateF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:lvTypes},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},{k:'reason',l:'Apply Reason',t:'textarea'}],{start_time:today(),end_time:today(),auto_approve:true},async b=>bulkDone(await A('leavelist/bulk','POST',{...pickBody(b),start_time:b.start_time,end_time:b.end_time,pay_code:b.pay_code,auto_approve:b.auto_approve,reason:b.reason})),'Save'),
  imp:()=>attImport('Import Leave','att/leavelist/import','employee ID, leave type, start date, end date, reason',{auto:true})};
attGrid('Leaves','Leave',{details:WFD,load:()=>A('leavelist?'+fq('Leaves')),defaults:{start_time:today(),end_time:today(),auto_approve:false},fields:lvFields,api:'leaves',remove:id=>api('leaves/'+id,'DELETE'),filter:()=>fbar('Leaves',{dates:true,empty:true}),
  save:b=>api('leaves','POST',{employee_id:b.employee_id,from_date:b.start_time,to_date:b.end_time,type:b.pay_code,half:b.half,note:b.reason,auto_approve:b.auto_approve}),
  cols:[['Employee ID','code',{link:true}],['Photo',photo,{html:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Department',r=>r.dept||''],['Position',r=>r.position||''],['Start Time','start_time'],['End Time','end_time'],['Apply Reason',r=>r.reason||''],['Apply Time',r=>r.apply_time||''],['Pay Code','pay_code'],...tail],
  acts:approvalActs('Leaves',lvApi)},'leave',async()=>'<input id="l_e" type="hidden"><div id="balbox"></div>');
ZK.custom['Leaves']=id=>{const s=ZK.G['Leaves'];if(id)return alert('A leave cannot be edited. Revoke or delete it and add a new one.');ZK.form('Add Leave',lvFields,s.o.defaults,b=>s.o.save(b))};

// ---- Overtime
const OT_PAY=OTC.filter(x=>x[0]);
const otFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},{k:'auto_approve',l:'Auto Approved',t:'checkbox',hint:'Entries added here are approved immediately'},dtF('start_time','Start Time'),dtF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:OT_PAY,blank:false},{k:'reason',l:'Apply Reason',t:'textarea'}];
const otApi={approve:r=>api(`overtime/${r.id}/approve`,'POST',{}),reject:(r,n)=>api(`overtime/${r.id}/reject`,'POST',{note:n}),revoke:r=>A(`otlist/${r.id}/revoke`,'POST',{}),
  bulk:()=>ZK.form('Bulk Add Overtime',[...pickFields,dtF('start_time','Start Time'),dtF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:OT_PAY,blank:false},{k:'reason',l:'Apply Reason',t:'textarea'}],{start_time:today()+' 18:00',end_time:today()+' 20:00',pay_code:'Normal OT'},async b=>bulkDone(await A('otlist/bulk','POST',{...pickBody(b),start_time:b.start_time,end_time:b.end_time,pay_code:b.pay_code,reason:b.reason})),'Save'),
  imp:()=>attImport('Import Overtime','att/otlist/import','employee ID, start YYYY-MM-DD HH:MM, end YYYY-MM-DD HH:MM, pay code, reason')};
attGrid('Overtime','Overtime',{details:WFD,load:()=>A('otlist?'+fq('Overtime')),defaults:{start_time:today()+' 18:00',end_time:today()+' 20:00',pay_code:'Normal OT'},fields:otFields,api:'att/otlist',remove:id=>api('overtime/'+id,'DELETE'),filter:()=>fbar('Overtime',{dates:true}),
  save:b=>A('otlist','POST',b),
  cols:[['Employee ID','code',{link:true}],['Photo',photo,{html:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Department',r=>r.dept||''],['Position',r=>r.position||''],['Pay Code','pay_code'],['Start Time','start_time'],['End Time','end_time'],['Apply Reason',r=>r.reason||''],['Apply Time','apply_time'],...tail],
  acts:approvalActs('Overtime',otApi)},'overtime',tailOf('Overtime','Overtime report and overtime policies (advanced)'));
ZK.custom['Overtime']=id=>{const s=ZK.G['Overtime'];if(id)return alert('Overtime cannot be edited. Revoke or delete it and add a new one.');ZK.form('Add Overtime',otFields,s.o.defaults,b=>s.o.save(b))};

// ---- Training
const trPay=async()=>{const c=(await api('att/paycodes')).filter(x=>x.ptype==='Training').map(x=>[x.name,x.name]);return c.length?c:[['Training','Training']]};
const trFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},dtF('start_time','Start Time'),dtF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:trPay,blank:false},{k:'reason',l:'Apply Reason',t:'textarea'}];
const trApi={approve:r=>A(`training/${r.id}/approve`,'POST',{}),reject:(r,n)=>A(`training/${r.id}/reject`,'POST',{note:n}),revoke:r=>A(`training/${r.id}/revoke`,'POST',{}),
  bulk:()=>ZK.form('Bulk Add Training',[...pickFields,dtF('start_time','Start Time'),dtF('end_time','End Time'),{k:'pay_code',l:'Pay Code',t:'select',req:true,opts:trPay,blank:false},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},{k:'reason',l:'Apply Reason',t:'textarea'}],{start_time:today()+' 09:00',end_time:today()+' 17:00',auto_approve:true},async b=>bulkDone(await A('training/bulk','POST',{...pickBody(b),start_time:b.start_time,end_time:b.end_time,pay_code:b.pay_code,auto_approve:b.auto_approve,reason:b.reason})),'Save'),
  imp:()=>attImport('Import Training','att/training/import','employee ID, start YYYY-MM-DD HH:MM, end YYYY-MM-DD HH:MM, pay code, reason',{auto:true})};
attGrid('zk:training','Training',{details:WFD,load:()=>A('training?'+fq('zk:training')),defaults:{start_time:today()+' 09:00',end_time:today()+' 17:00',pay_code:'Training'},fields:trFields,api:'att/training',remove:id=>A('training/'+id,'DELETE'),filter:()=>fbar('zk:training'),
  save:(b,row)=>row?A('training/'+row.id,'PUT',b):A('training','POST',b),
  cols:[['Employee ID','code',{link:true}],['Photo',photo,{html:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Department',r=>r.dept||''],['Position',r=>r.position||''],['Pay Code','pay_code'],['Start Time','start_time'],['End Time','end_time'],['Apply Reason',r=>r.reason||''],['Apply Time','apply_time'],...tail],
  acts:approvalActs('zk:training',trApi)},'attendance');
ZK.custom['zk:training']=id=>{const s=ZK.G['zk:training'],row=id?s.all.find(r=>r.id===id):null;if(row&&row.status!=='pending')return alert('Only a pending training can be edited.');ZK.form((id?'Edit ':'Add ')+'Training',id?trFields.filter(f=>f.k!=='employee_id'&&f.k!=='auto_approve'):trFields,row||s.o.defaults,b=>s.o.save(b,row))};

// ---- Schedule Adjustment
const saFields=[{k:'employee_id',l:'Employee',t:'select',req:true,opts:empOpts},{k:'auto_approve',l:'Auto Approved',t:'checkbox'},dateF('date','Date'),{k:'shift_id',l:'New Schedule',t:'select',req:true,opts:shiftOpts},{k:'reason',l:'Apply Reason',t:'textarea'}];
attGrid('zk:schedadj','Schedule Adjustment',{load:()=>A('schedadj'),defaults:{date:today()},fields:saFields,api:'att/schedadj',
  cols:[['Employee ID','code',{link:true}],['Photo',photo,{html:true}],['First Name','first_name'],['Last Name',r=>r.last_name||''],['Department',r=>r.dept||''],['Position',r=>r.position||''],['Date','date'],['Previous Schedule',r=>r.previous||''],['New Schedule','new_schedule'],['Apply Reason',r=>r.reason||''],['Apply Time','apply_time'],...tail],
  acts:[['Add'],['Delete'],['Approve',ctx=>each(ctx,r=>api(`shifts/requests/${r.id}/approve`,'POST',{}),'approved')],['Reject',ctx=>{const n=note();if(n===null)return;return each(ctx,r=>api(`shifts/requests/${r.id}/reject`,'POST',{note:n}),'rejected')}],['Revoke',ctx=>each(ctx,r=>api(`shifts/requests/${r.id}/cancel`,'POST',{}),'revoked')]]},'shifts');
ZK.custom['zk:schedadj']=id=>{if(id)return alert('A schedule adjustment cannot be edited. Revoke or delete it and add a new one.');ZK.form('Add Schedule Adjustment',saFields,ZK.G['zk:schedadj'].o.defaults,b=>A('schedadj','POST',b))};

// ============================================================ Benefit management
attGrid('zk:leavegroup','Leave Group',{details:{title:'Employees',wide:true,render:async r=>{const e=(await api('employees?status=active')).filter(x=>x.leave_policy_id==r.id);return `<div style="margin-bottom:8px"><button class="zb" onclick="ZK.rmLeaveEmp()">Remove Employee</button></div>`+(e.length?`<table style="width:100%;border-collapse:collapse"><tr><th></th><th style="text-align:left">Employee ID</th><th style="text-align:left">First Name</th></tr>${e.map(x=>`<tr><td><input type="checkbox" class="lg_e" value="${x.id}"></td><td>${esc(x.code)}</td><td>${esc(x.name)}</td></tr>`).join('')}</table>`:'<div style="text-align:center;color:#999;padding:16px">None</div>')}},load:()=>A('leavegroups'),defaults:{},fields:[{k:'code',l:'Code',req:true},{k:'name',l:'Name',req:true}],api:'att/leavegroups',
  save:async(b,row)=>{if(!row&&!b.code)b.code=(await A('leavegroups/next-code')).code;return api(row?`att/leavegroups/${row.id}`:'att/leavegroups',row?'PUT':'POST',b)},
  cols:[['Code','code',{link:true}],['Name','name']],
  acts:[['Add'],['Delete'],['Assign Employee',()=>ZK.form('Assign Employee',[{k:'policy_id',l:'Leave Group',t:'select',req:true,opts:async()=>(await A('leavegroups')).map(g=>[g.id,`${g.code} - ${g.name}`])},...pickFields],{},async b=>{const r=await A('leavegroups/assign','POST',{policy_id:b.policy_id,...pickBody(b)});alert(`${r.assigned} employee(s) assigned`)},'Assign')]]},'leave');
ZK.rmGroupEmp=async()=>{const ids=[...document.querySelectorAll('.gp_e:checked')].map(x=>+x.value);if(!ids.length)return alert('Tick at least one employee first');try{await A('groups/remove','POST',{employee_ids:ids});alert(ids.length+' employee(s) removed');go(cur)}catch(e){alert(e.message)}};
ZK.rmLeaveEmp=async()=>{const ids=[...document.querySelectorAll('.lg_e:checked')].map(x=>+x.value);if(!ids.length)return alert('Tick at least one employee first');try{await A('leavegroups/remove','POST',{employee_ids:ids});alert(ids.length+' employee(s) removed');go(cur)}catch(e){alert(e.message)}};
ZK.custom['zk:leavegroup']=async id=>{const s=ZK.G['zk:leavegroup'],o=s.o,row=id?s.all.find(r=>r.id===id)||{}:{code:(await A('leavegroups/next-code')).code};ZK.form((id?'Edit ':'Add ')+'Leave Group',o.fields,row,b=>o.save(b,id?row:null))};
const holFields=[{k:'alias',l:'Name',req:true},dateF('start_date','Start Date'),{k:'duration_day',l:'Duration (Days)',t:'number',req:true},{k:'department_id',l:'Department',t:'select',opts:idName('departments'),hint:'Optional: only for this department'},{k:'group_id',l:'Attendance Group',t:'select',opts:async()=>(await api('emp_groups')).map(x=>[x.id,x.name]),hint:'Optional: only for this group'},
  {k:'color_setting',l:'Color Settings',hint:'e.g. #d9453f'},{k:'enable_ot_rule',l:'Overtime',t:'checkbox'},...tierFields('t')];
attGrid('Holidays','Holiday',{load:()=>A('holidays'),defaults:{start_date:today(),duration_day:1},fields:holFields,api:'att/holidays',
  save:async(b,row)=>{for(const f of ['t1_hrs_from','t1_hrs_to','t2_hrs_from','t2_hrs_to','t3_hrs_from','t3_hrs_to'])if(b[f]==null)b[f]=0;return api(row?`att/holidays/${row.id}`:'att/holidays',row?'PUT':'POST',b)},
  cols:[['Name','name',{link:true}],['Start Date','start_date'],['Duration','duration'],['Overtime','overtime'],['Department',r=>r.department||''],['Attendance Group',r=>r.group||''],['Color Settings',r=>swatch(r.color),{html:true}]],
  note:'Holidays for the whole company mark those days as holiday in attendance. A holiday limited to a department or group is recorded but the attendance calculation only applies company-wide holidays.'},'shifts');
ZK.custom['Holidays']=id=>{const s=ZK.G['Holidays'],row=id?s.all.find(r=>r.id===id):null;
  ZK.form((id?'Edit ':'Add ')+'Holiday',holFields,row?{...row,alias:row.name,duration_day:row.duration,color_setting:row.color,enable_ot_rule:!!row.ot_enable,...Object.fromEntries([1,2,3].flatMap(i=>[[`t${i}_pay_code`,row[`t${i}_pay_code`]||''],[`t${i}_hrs_from`,row[`t${i}_hrs_from`]||0],[`t${i}_hrs_to`,row[`t${i}_hrs_to`]||0]]))}:s.o.defaults,b=>s.o.save(b,row))};

// ============================================================ Configurations: calculation, attendance configuration
window.CALC=window.CALC||{};
ZK.reg('zk:calculation','Calculation',async()=>{const c=window.CALC;c.from=c.from||today().slice(0,8)+'01';c.to=c.to||today();
  const [emps,deps,brs,grs]=await Promise.all([api('employees?status=active'),api('departments'),api('branches'),api('emp_groups')]);window.CALC_E=emps;
  const flt=emps.filter(e=>(!c.dept||e.department_id==c.dept)&&(!c.area||e.branch_id==c.area)&&(!c.group||e.group_id==c.group)&&(!c.code||String(e.code).includes(c.code))&&(!c.name||e.name.toLowerCase().includes(c.name.toLowerCase())));window.CALC_F=flt;
  const dn=Object.fromEntries(deps.map(d=>[d.id,d.name]));
  return `<div class="zse zse2"><div class="bar" style="flex-wrap:wrap;gap:10px;margin:6px 0"><select id="cl_dept" style="width:130px"><option value="">Department: All</option>${deps.map(d=>`<option value="${d.id}" ${c.dept==d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select><select id="cl_area" style="width:110px"><option value="">Area: All</option>${brs.map(d=>`<option value="${d.id}" ${c.area==d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select><select id="cl_group" style="width:110px"><option value="">Group: All</option>${grs.map(d=>`<option value="${d.id}" ${c.group==d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select>
   <span>Employee ID</span><input id="cl_code" value="${esc(c.code||'')}" style="width:100px"><span>First Name</span><input id="cl_name" value="${esc(c.name||'')}" style="width:100px"><button class="tbi" title="Search" onclick="calcFilter()" style="width:30px;height:30px;border:0;background:none;cursor:pointer"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg></button>
   <span style="margin-left:24px">Start Date</span><input id="cl_f" type="date" value="${c.from}" style="width:100px"><span>End Date</span><input id="cl_t" type="date" value="${c.to}" style="width:100px"><label style="display:inline-flex;flex-direction:row;align-items:center;gap:6px"><input id="cl_re" type="checkbox" checked> Recalculate</label><button class="sv" style="height:30px;padding:0 14px;font-size:12px" onclick="calcRun()">Calculate</button><span id="cl_m" class="mut sm"></span></div></div>`+
  tbl([['','',r=>`<input type="checkbox" class="zck" data-g="calc" value="${r.id}">`],['Employee ID','code'],['First Name','name'],['Department',r=>esc(dn[r.department_id]||'')]],flt)+`<p class="mut sm">Tick employees to calculate only them; with nothing ticked all ${flt.length} listed employees are calculated.</p>`},'attendance');
window.calcFilter=()=>{Object.assign(window.CALC,{dept:val('cl_dept'),area:val('cl_area'),group:val('cl_group'),code:val('cl_code'),name:val('cl_name'),from:val('cl_f'),to:val('cl_t')});go('zk:calculation')};
window.calcRun=async()=>{const m=document.getElementById('cl_m');const ids=zsel('calc'),use=ids.length?ids:window.CALC_F.map(e=>e.id);if(!use.length){m.textContent='No employees to calculate';return}
  m.textContent='Calculating...';try{const r=await A('calc','POST',{employee_ids:use,start_date:val('cl_f'),end_date:val('cl_t')});m.style.color='var(--ok)';m.textContent=`Done: ${r.employees} employee(s), ${r.days} day(s) in ${r.spent_ms} ms. `+Object.entries(r.counts).map(x=>`${x[0]} ${x[1]}`).join(', ')}catch(e){m.style.color='var(--bad)';m.textContent=e.message}};
const CFG=[{k:'short_date',l:'Short Date Format',t:'select',opts:['yyyy-MM-DD','yyyy/MM/DD','yyyy.MM.DD','DD/MM/yyyy','DD-MM-yyyy','MM/DD/yyyy','MM-DD-yyyy','YY-MM-DD','YY/MM/DD','DD/MM/YY','YY.MM.DD','yyyyMMDD','yyyyDDMM','MMDDyyyy','DDMMyyyy','YYMMDD','YYDDMM','MMDDYY','DDMMYY'].map((x,i)=>[i+1,x]),blank:false,req:true},
  {k:'short_time',l:'Short Time Format',t:'select',opts:['HH:mm','h:mm','HH:mm tt','h:mm tt','HH:mm:ss','h:mm:ss','HH:mm:ss tt','h:mm:ss tt','HHmm','hmm','HHmmss','hmmss'].map((x,i)=>[i+1,x]),blank:false,req:true},
  {k:'resign_emp',l:'Resign Employee Display Filter By Hire Date',t:'checkbox'},{k:'filter_by_hire_date',l:'Filter By Hire Date',t:'checkbox'},{k:'auto_calculate',l:'Auto Calculate',t:'checkbox'},timeF('calculate_time','Calculate Time',{ph:'HH:MM:SS'}),
  {k:'change_recalc_days',l:'Recalculate changes, days back (Days)',t:'number',req:true,hint:'When a schedule, timetable, holiday or approved leave changes, attendance is recalculated from the day the change takes effect, but no further back than this. Older days are left as they are; use the Calculation page to redo them.'},{k:'change_recalc_month_floor',l:'Not before the start of the month',t:'checkbox'}];
ZK.reg('zk:attconfig','Attendance Configuration',async()=>{const v=await A('config');
  const body=(await Promise.all(CFG.map(f=>ZK.fieldHtml(f,v[f.k])))).join('');
  return `<div class="zse zse2"><div class="grid">${body}</div><div class="svbar"><span id="cf_m" class="mut sm"></span><button class="sv" onclick="cfgSave()">Save</button></div></div>`},'settings');
window.cfgSave=async()=>{const m=document.getElementById('cf_m');try{const b=ZK.read(CFG);await A('config','PUT',b);m.textContent='Saved';m.style.color='var(--ok)'}catch(e){m.textContent=e.message;m.style.color='var(--bad)'}};
})();
