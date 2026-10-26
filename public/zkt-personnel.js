// ZKT-style Personnel pack: Department, Position, Area, Employee, Resign (+ Workflow/Custom Attribute touch-ups).
(()=>{
const U=window.ZKU=window.ZKU||{
  pick:(accept,multiple)=>new Promise(ok=>{const i=document.createElement('input');i.type='file';i.accept=accept||'';i.multiple=!!multiple;i.style.display='none';i.onchange=()=>{ok([...i.files]);i.remove()};document.body.appendChild(i);i.click()}),
  text:f=>f.text(),
  empOpts:async()=>(await api('employees?status=active')).map(e=>[e.id,e.code+' - '+e.name]),
  devOpts:async()=>(await api('devices')).map(d=>[d.id,d.name+(d.sn?' ('+d.sn+')':'')]),
  dl:(url,name)=>fileDl(url,name),
  say:(m)=>alert(m),
};
const E=zE;
const ids=ctx=>{if(!ctx.ids.length)throw new Error('Tick at least one row first');return ctx.ids};

// ---------- Department / Position / Area ----------
const sup=(rows,id)=>rows.filter(r=>r.id!==id).map(r=>[r.id,(r.code?r.code+' - ':'')+r.name]);
async function orgTransfer(kind,ctx){ // kind: area (department / position keep their existing dialogs)
  const rows=await api('zkp/org/areas'),o=rows.map(r=>`<option value="${r.id}">${E((r.code?r.code+' - ':'')+r.name)} (${r.employees})</option>`).join('');
  orgModal('Personnel Transfer',`<p class="mut sm">Move people from one area to another. Leave the list empty to move everyone active in the first area. Each move is added to the person's history.</p><div class="grid"><label>From<select id="tr_f" onchange="zkAreaTrList()"><option value="">Choose...</option>${o}</select></label><label>To<select id="tr_t"><option value="">Choose...</option>${o}</select></label><label>Date<input id="tr_d" type="date" value="${today()}"></label><label>Note<input id="tr_n" placeholder="optional"></label></div><div id="tr_l" style="max-height:200px;overflow:auto;margin-top:8px"></div>`,'zkAreaTransferGo()','Transfer')}
window.zkAreaTrList=async()=>{const f=val('tr_f'),el=document.getElementById('tr_l');if(!f){el.innerHTML='';return}const emps=await api('employees?branch_id='+f+'&status=active');el.innerHTML=emps.length?`<div class="sm mut">Pick people, or none for everybody (${emps.length}):</div>`+emps.map(e=>`<label style="display:flex;flex-direction:row;justify-content:flex-start;gap:8px;align-items:center;font-weight:500"><input type="checkbox" class="trck" value="${e.id}">${esc(e.code)} - ${esc(e.name)}</label>`).join(''):'<div class="mut sm">Nobody active in this area.</div>'};
window.zkAreaTransferGo=async()=>{const ids=[...document.querySelectorAll('.trck:checked')].map(c=>+c.value);try{const r=await api('zkp/org/transfer-area','POST',{from_area_id:val('tr_f')||null,to_area_id:val('tr_t'),employee_ids:ids,date:val('tr_d'),note:val('tr_n')});document.getElementById('dvm').remove();alert(`${r.moved} moved`);go('Area')}catch(e){document.getElementById('om_e').textContent=e.message}};

const nextNum=rows=>String(Math.max(0,...rows.map(r=>/^\d+$/.test(String(r.code||''))?+r.code:0))+1);
async function deptForm(id){
  const [rows,sh,em]=await Promise.all([api('zkp/org/departments'),api('shifts'),U.empOpts()]);window.DEP=rows;const x=id?(rows.find(r=>r.id===id)||{}):{code:nextNum(rows)};
  ZK.form((id?'Edit ':'Add ')+'Department',[{k:'code',l:'Department Code',req:true},{k:'name',l:'Department Name',req:true},
    {k:'parent_id',l:'Superior',t:'select',opts:sup(rows,id),blank:'None (top level)'},{k:'shift_id',l:'Default shift',t:'select',opts:sh.map(s=>[s.id,s.name]),blank:'None'},{k:'manager_id',l:'Department Manager',t:'select',opts:em,blank:'None'}],x,
    async b=>{const body={code:b.code||'',name:b.name,parent_id:b.parent_id||null,shift_id:b.shift_id||null};const r=await api(id?'org/departments/'+id:'org/departments',id?'PUT':'POST',body);await api(`zkp/org/departments/${id||r.id}/manager`,'PUT',{manager_id:b.manager_id||null})})}
async function posForm(id){
  const rows=await api('org/positions');window.POS=rows;const x=id?(rows.find(r=>r.id===id)||{}):{code:nextNum(rows)};
  ZK.form((id?'Edit ':'Add ')+'Position',[{k:'code',l:'Position Code',req:true},{k:'name',l:'Position Name',req:true},{k:'parent_id',l:'Superior',t:'select',opts:sup(rows,id),blank:'None (top level)'}],x,
    async b=>{await api(id?'org/positions/'+id:'org/positions',id?'PUT':'POST',{code:b.code||'',name:b.name,parent_id:b.parent_id||null})})}
async function areaForm(id){
  const [rows,cos]=await Promise.all([api('zkp/org/areas'),api('companies')]);window.COS=cos;const x=id?rows.find(r=>r.id===id)||{}:{};
  ZK.form((id?'Edit ':'Add ')+'Area',[{k:'code',l:'Area Code',ph:'optional'},{k:'name',l:'Area Name',req:true},{k:'parent_id',l:'Superior',t:'select',opts:sup(rows,id),blank:'None (top level)'},{k:'company_id',l:'Company',t:'select',opts:cos.map(c=>[c.id,c.name]),blank:'None'},{k:'address',l:'Address'}],x,
    async b=>{const r=await api(id?'org/areas/'+id:'org/areas',id?'PUT':'POST',{code:b.code||'',name:b.name,company_id:b.company_id||null,address:b.address||''});await api(`zkp/org/areas/${id||r.id}/parent`,'PUT',{parent_id:b.parent_id||null})})}
window.zkOrgForm=(k,id)=>({dept:deptForm,pos:posForm,area:areaForm})[k](id);

// one page builder for the three organisation lists: toolbar + grid (+ the structure tree for department and position)
function orgPage(o){
  ZK.reg(o.key,o.title,async()=>{
    const [rows,tree]=await Promise.all([api(o.api),o.tree?api(o.tree):[]]);window[o.var]=rows;
    const sel=window[o.sel],below=id=>{const out=new Set([id]);let ch=true;while(ch){ch=false;for(const r of rows)if(r.parent_id&&out.has(r.parent_id)&&!out.has(r.id)){out.add(r.id);ch=true}}return out},vis=sel?rows.filter(r=>below(sel).has(r.id)):rows;
    const link=(r,t)=>`<a class="zl" onclick="zkOrgForm('${o.k}',${r.id})">${E(t)}</a>`;
    const node=n=>`<li><span class="tn ${sel===n.id?'on':''}" onclick="window.${o.sel}=${n.id};go('${o.key}')"><span>${E(n.name)}</span></span>${n.children?.length?`<ul>${n.children.map(node).join('')}</ul>`:''}</li>`;
    const tb=`<div class="ztool"><div class="zgrp">${zb('Add',`zkOrgForm('${o.k}')`)}${zb('Delete',`orgDel('${o.kind}','${o.g}')`,'zdel')}${zb('Import',`orgImport('${o.kind}')`)}${zb('Personnel Transfer',o.transfer)}</div><div class="zrt"><button class="zi" title="Select all" onclick="zall('${o.g}',true)">&#9745;</button><button class="zi" title="Clear selection" onclick="zall('${o.g}',false)">&#9744;</button></div></div>`;
    const grid=tb+tbl([zcol(o.g),[o.cols[0][0],'',r=>link(r,r[o.cols[0][1]]||'(edit)')],...o.cols.slice(1).map(c=>[c[0],c[1],r=>E(r[c[1]])])],vis);
    const side=o.tree?`<aside class="orgtree card"><div class="otl"><b></b><span class="zrt"><button class="zi" title="Show all" onclick="window.${o.sel}=null;go('${o.key}')">&#8635;</button></span></div><ul><li><span class="tn ${sel?'':'on'}" onclick="window.${o.sel}=null;go('${o.key}')"><span>${o.title}</span></span><ul>${tree.map(node).join('')}</ul></li></ul></aside>`:'';
    return `<h2>${o.title} <span class="cnt">${rows.length}</span></h2>`+(o.tree?`<div class="split3"><div>${grid}</div>${side}</div>`:grid)},'organization')}
orgPage({key:'Department',k:'dept',kind:'departments',title:'Department',api:'zkp/org/departments',tree:'org/tree',var:'DEP',sel:'depSel',g:'dep',transfer:'depTransfer()',
  cols:[['Department Code','code'],['Department Name','name'],['Superior','superior'],['Employee Qty.','employees'],['Resigned Qty.','resigned'],['Department Manager','manager']]});
orgPage({key:'Position',k:'pos',kind:'positions',title:'Position',api:'org/positions',tree:'org/positions-tree',var:'POS',sel:'posSel',g:'pos',transfer:'posTransfer()',
  cols:[['Position Code','code'],['Position Name','name'],['Superior','superior'],['Employee Qty.','employees'],['Resigned Qty.','resigned']]});
orgPage({key:'Area',k:'area',kind:'areas',title:'Area',api:'zkp/org/areas',var:'AREAS',sel:'areaSel',g:'area',transfer:"orgTransfer_('area')",
  cols:[['Area Code','code'],['Area Name','name'],['Superior','superior'],['Device Qty.','devices'],['Employee Qty.','employees'],['Resigned Qty.','resigned']]});
window.orgTransfer_=k=>orgTransfer(k);

// ---------- Employee ----------
const ORIG_EMP=pages.Employees;
let EL={d:[],p:[],a:[],t:[]};
const filt=()=>window.ef||{};
async function pickTransfer(kind,ctx){
  const ids_=ids(ctx),map={department:['departments','Department'],position:['designations','Position'],area:['branches','Area']}[kind],list=await api(map[0]);
  ZK.form(map[1]+' Transfer',[{k:'to_id',l:'New '+map[1].toLowerCase(),t:'select',opts:list.map(x=>[x.id,x.name]),req:true},{k:'date',l:'Effective date',t:'date'},{k:'note',l:'Note'}],{date:today()},
    async b=>{const r=await api('zkp/employees/transfer','POST',{kind,to_id:b.to_id,employee_ids:ids_,date:b.date||today(),note:b.note||''});alert(`${r.moved} of ${ids_.length} moved`)},'Transfer')}
async function resignForm(ctx){
  const sel=ctx?ids(ctx):null,opts=await api('zkp/employees/extra-options');
  const f=[...(sel?[]:[{k:'employee_id',l:'Employee',t:'select',opts:U.empOpts,req:true}]),{k:'type',l:'Resignation Type',t:'select',opts:opts.resign_types.map(t=>[t,t]),blank:false},{k:'date',l:'Resignation Date',t:'date'},{k:'reason',l:'Resignation Reason',t:'textarea'}];
  ZK.form('Resignation',f,{date:today(),type:'Resignation'},async b=>{const r=await api('zkp/resign','POST',{employee_ids:sel||[+b.employee_id],type:b.type,date:b.date||today(),reason:b.reason||''});if(r.errors?.length)alert(r.errors.join('\n'))},'Confirm')}
const devSync=async(ctx,action,ask)=>{const ids_=ids(ctx);if(ask&&!confirm(ask.replace('#',ids_.length)))return;const r=await api('zkp/employees/device-sync','POST',{employee_ids:ids_,action});alert(`Queued for ${r.devices} device(s) (${r.done} item${r.done===1?'':'s'}). See Device > Device Command.`);ctx.reload()};
const appSet=async(ctx,on)=>{const r=await api('zkp/employees/app','POST',{employee_ids:ids(ctx),enabled:on});alert(`${r.done} updated`+(r.skipped?`, ${r.skipped} skipped. ${r.note}`:''));ctx.reload()};
const byCode=(all,f)=>{const m=f.name.replace(/\.[^.]+$/,'').split(/[_\s]/)[0];return all.find(e=>e.code===m)};
async function importPhotos(ctx){const fs=await U.pick('image/jpeg,image/png',true);if(!fs.length)return;let ok=0;const bad=[];for(const f of fs){const e=byCode(ctx.all,f);if(!e){bad.push(f.name);continue}try{await api(`employees/${e.id}/photo`,'POST',{data:await readFile(f)});ok++}catch(x){bad.push(f.name+' ('+x.message+')')}}alert(`${ok} photo(s) imported`+(bad.length?`\nNot imported (file name must start with the Employee ID):\n`+bad.slice(0,8).join('\n'):''));ctx.reload()}
async function importDocs(ctx){const fs=await U.pick('',true);if(!fs.length)return;let ok=0;const bad=[];for(const f of fs){const e=byCode(ctx.all,f);if(!e){bad.push(f.name);continue}try{await api(`employees/${e.id}/documents`,'POST',{name:f.name,filename:f.name,data:await readFile(f)});ok++}catch(x){bad.push(f.name+' ('+x.message+')')}}alert(`${ok} document(s) imported`+(bad.length?`\nNot imported (file name must start with the Employee ID):\n`+bad.slice(0,8).join('\n'):''));ctx.reload()}
async function importEmployees(ctx){const fs=await U.pick('.csv,text/csv');if(!fs[0])return;const r=await api('employees/import','POST',{csv:await fs[0].text()});alert(`Imported: ${r.created} new, ${r.updated} updated.`+(r.errors.length?`\nSkipped: ${r.errors.slice(0,6).map(x=>'line '+x.line+' ('+x.error+')').join(', ')}`:''));ctx.reload()}
async function importUsb(ctx){const fs=await U.pick('.csv,.txt,text/csv');if(!fs[0])return;const r=await api('zkp/employees/usb-import','POST',{csv:await fs[0].text()});alert(`${r.added} added, ${r.updated} updated, ${r.skipped} skipped`);ctx.reload()}
window.zkEmpFilter=()=>{window.ef={q:val('ef_q'),department_id:val('ef_dept'),branch_id:val('ef_area')};go('Employees')};
ZK.grid('Employees','Employee',{module:'employees',
  get note(){const f=filt();return `<div class="fbar" style="margin:6px 0"><input id="ef_q" placeholder="Employee ID, name, phone, email" value="${E(f.q||'')}" onkeydown="if(event.key==='Enter')zkEmpFilter()" style="min-width:230px"><select id="ef_dept">${opt(EL.d,f.department_id,'Department')}</select><select id="ef_area">${opt(EL.a,f.branch_id,'Area')}</select><button onclick="zkEmpFilter()">Search</button><button class="g" onclick="window.ef={};go('Employees')">Clear</button></div>`},
  load:async()=>{const f=filt(),qs=new URLSearchParams(Object.entries(f).filter(x=>x[1])).toString();const [rows,d,a]=await Promise.all([api('zkp/employees?'+qs),api('departments'),api('branches')]);EL.d=d;EL.a=a;return rows},
  api:'employees',
  cols:[['Employee ID',r=>`<a class="zl" onclick="openEmp(${r.id})">${E(r.code)}</a>`,{html:true}],['First Name','name'],['Last Name','last_name',{hide:true}],['Local Name','local_name',{hide:true}],['National','nationality',{hide:true}],['Department Code','dept_code',{hide:true}],['Department','dept'],['Position',r=>r.position||'–'],['Area Code','area_code',{hide:true}],['Employment Type',r=>r.emp_type||'–'],['Hired Date',r=>r.join_date||''],['APP Status',r=>r.app_status==='Enable'?window.ZK_OK:'<svg width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#e0463e"/><path d="M6 12h12" stroke="#fff" stroke-width="3"/></svg>',{html:true}],['Area','area'],['Superior','superior',{hide:true}],['Card NO.','card_no',{hide:true}],['Gender','gender',{hide:true}],['Email','email',{hide:true}],['Update Time','update_time',{hide:true}],['',r=>`<span class="zra"><a title="Details" style="color:#7ac143" onclick="openEmp(${r.id})"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></a><a title="Edit" style="color:#7ac143" onclick="openEmp(${r.id})"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg></a><a title="Delete" style="color:#e0463e" onclick="zkEmpDel(${r.id})"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></a></span>`,{html:true}]],
  acts:[['Add',()=>zkEmpModal()],['Delete'],
    ['Import',[['Import Employee',importEmployees],['Import Document',importDocs],['Import Photo',importPhotos],['Import USB Employee',importUsb]]],
    ['Personnel Transfer',[['Department Transfer',c=>pickTransfer('department',c)],['Position Transfer',c=>pickTransfer('position',c)],['Area Transfer',c=>pickTransfer('area',c)],
      ['Pass Probation',async c=>{const i=ids(c);if(!confirm(`Mark ${i.length} employee(s) as having passed probation?`))return;const r=await api('zkp/employees/pass-probation','POST',{employee_ids:i});alert(r.done+' updated');c.reload()}],['Resignation',c=>resignForm(c)]]],
    ['App',[['Enable',c=>appSet(c,true)],['Disable',c=>appSet(c,false)]]],
    ['More',[['Resynchronize to device',c=>devSync(c,'resync')],['Re-upload from device',c=>devSync(c,'reupload')],['Delete the Biometric Template',c=>devSync(c,'delete-bio','Delete the fingerprints and faces of # employee(s) here and on every approved device?')],['Export USB Employee',()=>U.dl('/api/zkp/employees/usb-export','user.csv')]]]]});
{ // the rich detail page (click a row) and the add page wrap the original employee code
  const grid=pages.Employees;
  const extraCard=async id=>{const [x,o]=await Promise.all([api(`zkp/employees/${id}/extra`),api('zkp/employees/extra-options')]);const wf=await api('workflow/roles').catch(()=>[]);return `<div class="card efx" style="margin-top:12px;max-width:1100px"><b>More details</b><div class="efc on" style="padding:12px 0">${zxAll(x,o,wf)}</div><div class="bar"><button onclick="zkEmpExtra(${id})">Save details</button></div></div>`};
  window.zkEmpExtra=async id=>{try{await api(`zkp/employees/${id}/extra`,'PUT',zxRead());alert('Saved')}catch(e){alert(e.message)}};
  window.zkEmpSave=async()=>{try{const cf=await cfList(),r=await api('employees','POST',readEmpForm(cf));await api(`zkp/employees/${r.id}/extra`,'PUT',zxRead());
    const ph=window.ZXPH||{};try{if(ph.photo)await api(`employees/${r.id}/photo`,'POST',{data:ph.photo});if(ph.bio)await api('zkd/biophotos','POST',{employee_id:r.id,bio_photo:ph.bio,user_photo:ph.photo||null,remark:''})}catch(e){alert('The employee was saved, but the photo was not: '+e.message)}window.ZXPH=null;window.empAdd=false;document.getElementById('dvm')?.remove();go('Employees');setTimeout(()=>zkEnrollAsk(r.code,(bd.name||'')),400)}catch(e){const m=document.getElementById('om_e');m?m.textContent=e.message:alert(e.message)}};
  const fn=async()=>{
    if(window.empId){const h=await ORIG_EMP();return h+await extraCard(window.empId).catch(()=>'')}
    if(window.empAdd){const [d,b,ds,g,sh,cf,lp,op,ro,mg,o]=await Promise.all([api('departments'),api('branches'),api('designations'),api('emp_groups'),api('shifts'),cfList(),api('leave_policies'),api('ot_policies'),api('rotations'),api('employees'),api('zkp/employees/extra-options')]);
      return `<h2>Add Employee</h2><div class="bar"><button onclick="zkEmpSave()">Save</button><button class="g" onclick="window.empAdd=false;go('Employees')">Back</button></div><div class="card" style="margin-top:10px">${empForm({},{d,b,ds,g,sh,cf,lp,op,ro,mg})}<div class="grid" style="margin-top:8px"><label>National<input id="zx_nat"></label><label>Employment Type<select id="zx_type"><option value="">-</option>${o.emp_types.map(t=>`<option>${t}</option>`).join('')}</select></label></div></div>`}
    return grid()};
  pages.Employees=fn;ZK.pages.Employees=fn}


// ---------- Add Employee as a dialog laid out like the reference (Profile + tabs); the fields and saving are the existing ones ----------
{const st=document.createElement('style');st.textContent=`
.efm{max-width:1160px!important;width:min(1160px,96%)!important;padding:0!important;border-radius:2px!important}.efm .dfb{min-height:0;padding:12px 10px 0}
.efh{background:#f2f2f2;padding:11px 14px;color:#555;font-size:13px;margin:0 0 14px}
.efp{display:grid;grid-template-columns:1fr 1fr 220px;gap:14px 20px;padding:0 10px 16px;border-bottom:1px solid #eee}.efp .dfr>label{width:130px}
.efpic{grid-row:1/5;grid-column:3;display:flex;align-items:flex-start;justify-content:center}.efpic div{width:128px;height:140px;border:1px dashed #ccc;padding:4px}.efpic svg{width:100%;height:100%;background:#fff;border:1px solid #bbb}
.eft{display:flex;background:#f6f6f6;border-bottom:1px solid #ddd;margin:14px 0 0}.eft a{padding:11px 18px;cursor:pointer;color:#333;font-size:13px}.eft a.on{background:#fff;color:#16a085;border-bottom:2px solid #16a085}
.efc{display:none;grid-template-columns:repeat(3,1fr);gap:14px 20px;padding:18px 10px;min-height:190px;align-content:start}.efc.on{display:grid}.efc .dfr>label{width:130px}
.efm .dfr input,.efm .dfr select{height:26px}
.efsh{display:flex;flex:1;min-width:0}.efsh input{flex:1;min-width:0;border-radius:0}.efsh button{height:28px;border:1px solid #ddd;border-left:0;background:#f5f5f5!important;color:#333!important;padding:0 16px;cursor:pointer;box-shadow:none}.efsh input.msk{-webkit-text-security:disc}
.efv{display:inline-flex;align-items:center;padding:0 14px;border:1px solid #ddd;background:#f5f5f5;font-size:13px}.efq{font-style:italic;background:#fafafa}
.efsw{display:inline-flex;align-items:center;justify-content:flex-start;gap:6px;min-width:62px;height:26px;border-radius:14px;padding:0 4px;background:#e9e9e9;color:#888;cursor:pointer;font-size:13px;flex-direction:row}.efsw i{width:20px;height:20px;border-radius:50%;background:#fff;order:0}.efsw b{font-weight:400;order:1}
.efsw.on{background:#6aaa3a;color:#fff;flex-direction:row-reverse;justify-content:flex-end}.efsw.on i{order:0}
.efd,.ef2{grid-template-columns:1fr 1fr 220px!important}.efbio{grid-column:3;grid-row:1/5;display:flex;flex-direction:column;align-items:center;gap:4px;color:#777}.efbio div{width:128px;height:140px;border:1px dashed #ccc;padding:4px}.efbio svg{width:100%;height:100%;background:#fff;border:1px solid #bbb}
.eftip{grid-column:2/4;color:#e8512f;font-size:15px;align-self:center}.efx .efc{grid-template-columns:repeat(3,1fr);display:grid}`;document.head.appendChild(st)}
// the BioTime Employee form fields that are not part of the original form, shared by the Add dialog (placed in tabs) and the profile page
const ZXV=[[0,'Any'],[1,'Fingerprint'],[2,'Face'],[3,'Password'],[4,'Card'],[5,'Fingerprint or Password'],[6,'Fingerprint or Card'],[7,'Card or Password'],[8,'Fingerprint and Password'],[9,'Fingerprint and Card'],[10,'Card and Password']],
  ZXP=[[0,'Employee'],[2,'Enroller'],[6,'Administrator'],[14,'Super Administrator']];
const zxSel=(k,v,o)=>`<select id="zx_${k}">${o.map(x=>`<option value="${E(x[0])}" ${String(x[0])===String(v)?'selected':''}>${E(x[1])}</option>`).join('')}</select>`;
const zxRow=(l,inner,req)=>`<div class="dfr"><label>${l}${req?'<b>*</b>':''}</label>${inner}</div>`;
const zxTxt=(k,l,x,mask)=>zxRow(l,mask?`<span class="efsh"><input id="zx_${k}" class="msk" value="${E(x[k]||'')}" autocomplete="off"><button type="button" onclick="zxShow('zx_${k}',this)">Show</button></span>`:`<input id="zx_${k}" value="${E(x[k]||'')}" autocomplete="off">`);
const zxTog=(k,l,v)=>zxRow(l,`<span class="efsw ${v?'on':''}" id="zx_${k}" data-v="${v?1:0}" onclick="zxToggle(this)"><i></i><b>${v?'Yes':'No'}</b></span>`);
const zxQty=(l,pre,n)=>zxRow(l,`<span class="efsh">${pre?`<span class="efv">${pre}</span>`:''}<input readonly class="efq" placeholder="0" value="${n||''}"><button type="button" onclick="zxEnroll()">Enroll</button></span>`);
const zxD=(x,k,d)=>x[k]==null?d:x[k];
const zxTabs=(x,o,wf)=>({
  priv:[zxTxt('local_name','Local Name',x,1),'@@f_gender','@@f_dob','@@f_phone',zxTxt('office_tel','Office Tel',x),zxTxt('mobile','Mobile',x,1),zxTxt('nationality','National',x,1),zxTxt('city','City',x,1),'@@f_address',zxTxt('postcode','Postcode',x,1),'@@f_email','@@f_emergency_contact'],
  dev:[zxRow('Verify Mode',zxSel('verify_mode',zxD(x,'verify_mode',0),ZXV)),zxRow('Device Privilege',zxSel('device_priv',zxD(x,'device_priv',0),ZXP)),'@@f_card_no',zxRow('PIN',`<input id="zx_pin" type="password" autocomplete="new-password" placeholder="${x.has_pin?'(set)':''}" maxlength="8">`),zxRow('Enroll Device','<input readonly>'),zxQty('FP Qty.','',''),zxQty('Palm Qty.','v8',''),zxQty('Face Qty.','v12','')],
  att:[zxRow('Self-Password',`<input id="zx_self_password" type="password" autocomplete="new-password" placeholder="${x.has_account?'(set)':'at least 8 characters'}">`),'@@f_group_id',zxTog('enable_att','Enable Attendance',zxD(x,'enable_att',1)),zxTog('enable_schedule','Enable Schedule',zxD(x,'enable_schedule',1)),zxTog('enable_holiday','Enable Holiday',zxD(x,'enable_holiday',1)),zxTog('enable_ot','Enable Overtime',zxD(x,'enable_ot',1)),zxTog('enable_comp','Enable Compensatory',zxD(x,'enable_comp',0)),'@@f_shift_id','@@f_rotation_id','@@f_rotation_anchor','@@f_ot_policy_id'],
  app:[zxRow('APP Status',zxSel('app_status',x.app_status?1:0,[[0,'Disable'],[1,'Enable']])),zxRow('APP Role',zxSel('app_role',zxD(x,'app_role','Employee'),[['Employee','Employee'],['Manager','Manager']]))],
  pay:[zxRow('Payment Period',zxSel('pay_period',zxD(x,'pay_period','Monthly'),['Monthly','Weekly','Daily'].map(t=>[t,t])),1),zxRow('Payment Type',zxSel('pay_type',zxD(x,'pay_type','Cash'),['Cash','Bank Transfer','Cheque'].map(t=>[t,t])),1),'@@f_bank_name','@@f_bank_account',zxTxt('agent_id','Agent ID',x),zxTxt('agent_account','Agent Account',x),'@@f_salary','@@f_eobi_no','@@f_bank_title','@@f_cnic'],
  wf:[zxRow('Workflow Role',zxSel('workflow_role',x.workflow_role||'',[['','-----------'],...wf.map(r=>[r.name,r.name])]))]});
const zxAll=(x,o,wf)=>{const t=zxTabs(x,o,wf);return Object.values(t).flat().filter(h=>!h.startsWith('@@')).join('')+zxRow('Last Name',`<input id="zx_last_name" value="${E(x.last_name||'')}">`)+zxRow('Employment Type',`<select id="zx_emp_type"><option value="">-</option>${o.emp_types.map(t=>`<option ${x.emp_type===t?'selected':''}>${t}</option>`).join('')}</select>`)};
window.zkEmpDel=async id=>{if(!confirm('Delete this employee?'))return;try{await api('employees/'+id,'DELETE');go(cur)}catch(e){alert(e.message)}};
window.zxShow=(id,b)=>{const el=document.getElementById(id);el.classList.toggle('msk');b.textContent=el.classList.contains('msk')?'Show':'Hide'};
window.zxToggle=el=>{const on=el.dataset.v!=='1';el.dataset.v=on?1:0;el.classList.toggle('on',on);el.querySelector('b').textContent=on?'Yes':'No'};
window.zxEnroll=()=>alert('Press Confirm to save the employee. OKT then offers to open the enrolment screen on a device, where the person puts the finger.');
// after an employee is saved: choose a device and open its enrolment screen for this person
window.zkEnrollAsk=async(code,name)=>{try{const devs=(await api('devices')).filter(d=>d.approved);if(!devs.length){alert('Saved. Employee ID: '+code);return}
  ZK.form('Enroll Fingerprint',[{k:'device_id',l:'Device',t:'select',opts:devs.map(d=>[d.id,d.name+(d.sn?' (push)':' (pull)')]),blank:'Skip: enroll later',req:false},{k:'fid',l:'Finger',t:'select',opts:['Right Thumb','Right Index','Right Middle','Right Ring','Right Little','Left Thumb','Left Index','Left Middle','Left Ring','Left Little'].map((x,i)=>[i,x]),blank:false}],{fid:5},
   async b=>{if(!b.device_id){alert('Saved. Employee ID: '+code);return}const r=await api(`devices/${b.device_id}/enroll`,'POST',{code,fid:+b.fid});alert(r.message)},'Start enrolment')}catch(e){alert('Saved. Employee ID: '+code+'\n'+e.message)}};
window.zxRead=()=>{const o={};const ids=['last_name','local_name','office_tel','mobile','nationality','city','postcode','emp_type','workflow_role','verify_mode','device_priv','pin','self_password','app_status','app_role','pay_period','pay_type','agent_id','agent_account'];
  for(const k of ids){const el=document.getElementById('zx_'+k);if(el)o[k]=el.value}
  for(const k of ['enable_att','enable_schedule','enable_holiday','enable_ot','enable_comp']){const el=document.getElementById('zx_'+k);if(el)o[k]=el.dataset.v==='1'?1:0}
  if(o.pin==='')delete o.pin;if(!o.self_password)delete o.self_password;if(o.app_status!==undefined)o.app_status=+o.app_status;return o};
window.zkEmpModal=async()=>{
  const [d,b,ds,g,sh,cf,lp,op,ro,mg,o,wf]=await Promise.all([api('departments'),api('branches'),api('designations'),api('emp_groups'),api('shifts'),cfList(),api('leave_policies'),api('ot_policies'),api('rotations'),api('employees'),api('zkp/employees/extra-options'),api('workflow/roles').catch(()=>[])]);
  const tmp=document.createElement('div');tmp.innerHTML=empForm({},{d,b,ds,g,sh,cf,lp,op,ro,mg});
  const take=(id,label,req)=>{const el=tmp.querySelector('#'+id);if(!el)return '';const w=document.createElement('div');w.className='dfr';const l=document.createElement('label');l.innerHTML=label+(req?'<b>*</b>':'');w.appendChild(l);w.appendChild(el);return w};
  const L={f_phone:'Contact Tel',f_emergency_contact:'Emergency Contact',f_gender:'Gender',f_dob:'Birthday',f_address:'Address',f_email:'Email',f_card_no:'Card NO.',f_group_id:'Attendance Group',f_shift_id:'Shift',f_rotation_id:'Shift Rotation',f_rotation_anchor:'Rotation Day 1',f_ot_policy_id:'Overtime Policy',f_bank_name:'Bank Name',f_bank_account:'Bank Account',f_salary:'Monthly Salary',f_eobi_no:'EOBI Number',f_bank_title:'Account Title',f_cnic:'CNIC'};
  const prof=['f_code','f_name','f_department_id','@last','f_designation_id','f_branch_id','@type','f_join_date','f_manager_id','@wf'];
  const PL={f_code:['Employee ID',1],f_name:['First Name'],f_department_id:['Department',1],f_designation_id:['Position'],f_branch_id:['Area',1],f_join_date:['Hired Date'],f_manager_id:['Superior']};
  const t=zxTabs({enable_att:1,enable_schedule:1,enable_holiday:1,enable_ot:1,enable_comp:0},o,wf);
  const tabs=[['Private Information',t.priv,''],['Device Access Settings',t.dev,' efd'],['Attendance Settings',t.att,''],['App Settings',t.app,' ef2'],['Payroll Settings',t.pay,' ef2'],['Leave Group',[`@@f_leave_policy_id`,'<div class="eftip">Tips : Change leave group will change employee\'s all leave balance rules !!!</div>'],' ef2']];
  L.f_leave_policy_id='Leave Group';
  const m=document.createElement('div');m.id='dvm';m.className='dvm';m.onclick=e=>{if(e.target===m)m.remove()};
  window.ZXPH=null;m.innerHTML=`<div class="dvbox dfm efm"><div class="dfh"><span>Add</span><a onclick="this.closest('.dvm').remove()" title="Close">&times;</a></div><div class="dfb"><div class="efh">Profile</div><div class="efp" id="ef_prof"><div class="efpic"><div id="ef_pic" title="Click to choose a photo" style="cursor:pointer" onclick="zxPick('photo')"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.500" fill="#8a8a8a"/><path d="M3 22c0-5 4-8 9-8s9 3 9 8z" fill="#8a8a8a"/></svg></div></div></div>
   <div class="eft">${tabs.map((x,i)=>`<a class="${i?'':'on'}" onclick="zkEmpTab(${i})">${x[0]}</a>`).join('')}</div>${tabs.map((x,i)=>`<div class="efc${x[2]} ${i?'':'on'}" id="ef_tab${i}">${x[2]?'<div class="efbio"><div id="ef_bio" title="Click to choose a bio-photo" style="cursor:pointer" onclick="zxPick(\'bio\')"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.500" fill="#8a8a8a"/><path d="M3 22c0-5 4-8 9-8s9 3 9 8z" fill="#8a8a8a"/></svg></div><span>Bio-Photo</span></div>':''}</div>`).join('')}<p id="om_e" class="err" style="padding:0 10px"></p></div>
   <div class="dff"><button class="dfc" onclick="zkEmpSave()">Confirm</button><button class="dfx2" onclick="this.closest('.dvm').remove()">Cancel</button></div></div>`;
  document.body.appendChild(m);
  const node=h=>{const e=document.createElement('div');e.innerHTML=h;return e.firstElementChild};
  const prow=m.querySelector('#ef_prof');
  prof.forEach(id=>{if(id==='@last')prow.appendChild(node(zxRow('Last Name','<input id="zx_last_name">')));else if(id==='@type')prow.appendChild(node(zxRow('Employment Type',`<select id="zx_emp_type"><option value="">-----------</option>${o.emp_types.map(x=>`<option>${x}</option>`).join('')}</select>`)));else if(id==='@wf')prow.appendChild(node(zxRow('Workflow Role',zxSel('workflow_role','',[['','-----------'],...wf.map(r=>[r.name,r.name])]))));else{const n=take(id,PL[id][0],PL[id][1]);if(n)prow.appendChild(n)}});
  const mg0=prow.querySelector('#f_manager_id');if(mg0&&mg0.options[0])mg0.options[0].textContent='Department Manager';
  tabs.forEach((x,i)=>{const c=m.querySelector('#ef_tab'+i);x[1].forEach(h=>{if(h.startsWith('@@')){const id=h.slice(2),n=take(id,L[id]||id);if(n)c.appendChild(n)}else c.appendChild(node(h))})});
  // required marks the way BioTime shows them: the department select starts empty
  const dep=prow.querySelector('#f_department_id');if(dep&&dep.options[0])dep.options[0].textContent='-----------';const ar=prow.querySelector('#f_branch_id');if(ar&&ar.options[0])ar.options[0].textContent='-----------';
  // anything the layout above does not place (e.g. custom fields) goes to Private Information
  [...tmp.querySelectorAll('label')].filter(l=>l.querySelector('input,select,textarea')).forEach(l=>{const inp=l.querySelector('input,select,textarea'),w=document.createElement('div'),lb=document.createElement('label');w.className='dfr';lb.textContent=(l.childNodes[0]&&l.childNodes[0].textContent||inp.id).trim();w.appendChild(lb);w.appendChild(inp);m.querySelector('#ef_tab0').appendChild(w)});
  const nc=await api('employees/next-code').catch(()=>null);if(nc&&m.querySelector('#f_code'))m.querySelector('#f_code').value=nc.code;const jd=m.querySelector('#f_join_date');if(jd&&!jd.value)jd.value=today();const ps=prow.querySelector('#f_designation_id');if(ps&&ps.options[0])ps.options[0].textContent='-----------';
  const first=m.querySelector('#f_name');if(first)first.focus()};
window.zxPick=kind=>{const i=document.createElement('input');i.type='file';i.accept='image/jpeg,image/png';i.onchange=()=>{const f=i.files[0];if(!f)return;if(f.size>2*1024*1024){alert('The photo must be under 2 MB');return}const r=new FileReader();r.onload=()=>{window.ZXPH=window.ZXPH||{};window.ZXPH[kind]=r.result;const box=document.getElementById(kind==='bio'?'ef_bio':'ef_pic');if(box)box.innerHTML=`<img src="${r.result}" style="width:100%;height:100%;object-fit:cover;background:#fff;border:1px solid #bbb">`};r.readAsDataURL(f)};i.click()};
window.zkEmpTab=i=>{document.querySelectorAll('.eft a').forEach((a,k)=>a.classList.toggle('on',k===i));document.querySelectorAll('.efc').forEach((c,k)=>c.classList.toggle('on',k===i))};
// ---------- Resign ----------
ZK.grid('zk:resign','Resign',{module:'employees',
  load:()=>api('zkp/resign'),
  cols:[['Employee ID','code'],['First Name','name'],['Last Name',()=>''],['Department','dept'],['Position','position'],['Resignation Type','type'],['Resignation Date','date'],['Attendance',r=>r.att_disabled?'Disabled':'Enabled'],['Resignation Reason','reason']],
  remove:id=>api('zkp/resign/'+id,'DELETE'),
  acts:[['Add',()=>resignForm(null)],['Delete',async c=>{const i=ids(c);if(!confirm(`Delete ${i.length} resigned employee record(s) permanently? To bring a person back use Reinstate.`))return;const errs=[];for(const id of i)try{await api('zkp/resign/'+id,'DELETE')}catch(e){errs.push(e.message)}if(errs.length)alert(errs.slice(0,4).join('\n'));c.reload()}],
    ['Reinstate',async c=>{const i=ids(c);if(!confirm(`Reinstate ${i.length} employee(s)? They become active again and are sent back to the devices.`))return;const r=await api('zkp/resign/reinstate','POST',{employee_ids:i});alert(r.done+' reinstated');c.reload()}],
    ['Import',()=>ZK.csvModal('Import Resignation','zkp/resign/import','One per line: employee id, type (Resignation, Termination, Dismissal, Retirement, Contract end, Transfer out), date YYYY-MM-DD, reason.')],
    ['Disable Attendance',async c=>{const i=ids(c);await api('zkp/resign/attendance','POST',{employee_ids:i});c.reload()}]]});

// ---------- Workflow Builder gets its generic Add; Custom Attribute shows only the reference columns ----------
ZK.reg('Workflow Builder','Workflow Builder',async()=>{const rows=await api('workflow/rules');window.WRU=rows;
  return `<h2>Workflow Builder <span class="cnt">${rows.length}</span></h2><div class="ztool"><div class="zgrp">${zb('Add',"wbForm('department')")}${zb('Delete',"wbDel()",'zdel')}${zb('Add for Department',"wbForm('department')")}${zb('Add for Position',"wbForm('position')")}${zb('Add for Employee',"wbForm('employee')")}</div></div>`+
  tbl([zcol('wbr'),['Code','code',r=>`<a class="zl" onclick="wbForm('${r.scope}',${r.id})">${esc(r.code)}</a>`],['Name','name',r=>esc(r.name)+` <span class="mut sm">(${esc(r.scope+': '+r.target)})</span>`],['Start Date','start_date'],['End Date','end_date'],['Content Type','kind_label'],['Workflow Type','',r=>'Approval'],['Workflow','workflow']],rows)},'settings');
ZK.reg('Custom Attribute','Custom Attribute',async()=>{const rows=await api('custom_fields');
  const sw=(r,k)=>`<label class="sw"><input type="checkbox" ${k==='enabled'?(r.enabled!==0?'checked':''):(r.uniq?'checked':'')} onchange="caSet(${r.id},'${k}',this.checked)"><i></i></label>`;
  return `<h2>Custom Attribute <span class="cnt">${rows.length}</span></h2><div class="ztool"><div class="zgrp">${zb('Add','caForm()')}${zb('Delete',"caDel()",'zdel')}</div></div>`+
  tbl([zcol('cat'),['Attribute Name','label'],['Input Type','type'],['Unique','',r=>sw(r,'uniq')],['Enable','',r=>sw(r,'enabled')]],rows)},'employees');
})();
