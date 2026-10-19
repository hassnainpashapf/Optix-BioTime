// Payroll (Employee Profile, Extra Funds, Loan, Salary Advance, Reimbursement) and Visitor (Entry Registration, Visitor, Reservation, Blocklist) pages in the ZKT layout.
// Backend: payextra.js (loan / advance / reimbursement -> payroll adjustments), visitors.js, existing /api/payroll/items and /api/employees.
(()=>{
const E=v=>esc(v==null?'':v),P='payroll',V='attendance';
const emps=async()=>(await api('employees?status=active')).map(e=>[e.id,`${e.code} - ${e.name}`]);
const cm=()=>today().slice(0,7),tag=(t,c)=>`<span style="color:${c}">${E(t)}</span>`;
const stText=s=>({pending:'Pending',approved:'Approved',rejected:'Rejected'}[s]||s);

// ---------- Payroll > Employee Profile (department tree + list) ----------
ZK.grid('zk:payprofile','Employee Profile',{module:P,load:async()=>(await api('employees?status=active')).map(e=>({...e,dept:e.dept||e.department||''})),acts:[],rowDel:false,
  cols:[['Employee ID','code',{link:true}],['First Name','name'],['Last Name',()=>''],['Department',r=>r.dept],['Payment Period',()=>'Monthly'],['Payment Type',r=>r.bank_account?'Bank Transfer':'Cash']],
  fields:[{k:'bank_name',l:'Bank Name'},{k:'bank_account',l:'Bank Account / IBAN',hint:'6 to 40 letters, digits, spaces or dashes'},{k:'bank_title',l:'Account Title'}],
  save:async(b,row)=>api('employees/'+row.id,'PUT',{bank_name:b.bank_name,bank_account:b.bank_account,bank_title:b.bank_title})});
{const base=ZK.pages['zk:payprofile'];
 ZK.reg('zk:payprofile','Employee Profile',async()=>{const [h,deps]=await Promise.all([base(),api('departments')]);
  const tree=`<div class="pft"><div class="pfh"><span class="pfs">Department</span></div><div class="pfi on" onclick="payDept('')">&#9633; Department</div>${deps.map(d=>`<div class="pfi sub" onclick="payDept(${E(JSON.stringify(d.name))})">&#9633; ${E(d.name)}</div>`).join('')}</div>`;
  return `<div class="pfw">${tree}<div class="pfm">${h}</div></div>`},P);}
window.payDept=name=>{const id=fltTable();if(!id)return;const t=TB[id],i=t.cols.findIndex(c=>c[0]==='Department');if(i<0)return;if(name)t.f[i]={t:'exact',v:name};else delete t.f[i];t.page=0;tbDraw(id);fltBadge();document.querySelectorAll('.pfi').forEach(x=>x.classList.toggle('on',x.textContent.trim().replace('□ ','')===(name||'Department')))};
{const st=document.createElement('style');st.textContent='.pfw{display:flex;gap:8px;align-items:flex-start}.pft{width:200px;flex:none;background:#fff;border:1px solid #eee;min-height:420px}.pfh{padding:8px;border-bottom:1px solid #eee}.pfs{display:inline-block;border:1px solid #ddd;padding:4px 10px;font-size:12px;color:#333;min-width:120px}.pfi{padding:6px 12px;font-size:13px;color:#333;cursor:pointer}.pfi.sub{padding-left:26px}.pfi.on,.pfi:hover{background:#eef6e2}.pfm{flex:1;min-width:0}';document.head.appendChild(st)}

// ---------- Payroll > Extra Funds (monthly allowances / bonuses / deductions / advances) ----------
window.pxm=window.pxm||cm();
ZK.grid('zk:payextra','Extra Funds',{module:P,load:()=>api('payroll/items?month='+window.pxm).then(r=>r.map(x=>({...x,kind_t:{allowance:'Allowance',bonus:'Bonus',deduction:'Deduction',advance:'Advance'}[x.kind]||x.kind}))),
  note:'', cols:[['Employee ID','code'],['First Name','employee'],['Type','kind_t'],['Amount','amount'],['Month','month'],['Note',r=>r.note||'']],rowActs:false,
  fields:[{k:'employee_id',l:'Employee',t:'select',req:true,opts:emps},{k:'month',l:'Month',req:true,ph:'YYYY-MM'},{k:'kind',l:'Type',t:'select',req:true,blank:false,opts:[['allowance','Allowance'],['bonus','Bonus'],['deduction','Deduction'],['advance','Advance']]},{k:'amount',l:'Amount',t:'number',req:true},{k:'note',l:'Note'}],defaults:{month:window.pxm,kind:'allowance'},
  save:async b=>api('payroll/items','POST',{employee_id:+b.employee_id,month:b.month,kind:b.kind,amount:Number(b.amount),note:b.note}),remove:async id=>api('payroll/items/'+id,'DELETE'),
  after:()=>`<div style="margin:8px 4px;color:#666">Month <input type="month" value="${window.pxm}" onchange="window.pxm=this.value||window.pxm;go('zk:payextra')" style="height:26px"> &nbsp; These are added to or taken from the salary of that month when it is calculated.</div>`});

// ---------- Payroll > Loan / Salary Advance / Reimbursement ----------
const extra=(key,title,kind)=>{const loan=kind==='loan';
  ZK.grid(key,title,{module:P,load:()=>api('payroll/extras?kind='+kind),rowActs:false,
  cols:[['Employee ID','code'],['First Name','name'],['Department',r=>r.department||''],['Amount','amount'],...(loan?[['Installments','installments'],['Monthly Deduction','monthly']]:[]),[loan?'Start Month':'Month','month'],['Reason',r=>r.reason||''],['Status',r=>stText(r.status)],['Apply Time','created']],
  fields:[{k:'employee_id',l:'Employee',t:'select',req:true,opts:emps},{k:'amount',l:'Amount',t:'number',req:true},{k:'month',l:loan?'Start Month':'Month',req:true,ph:'YYYY-MM'},...(loan?[{k:'installments',l:'Installments (months)',t:'number',req:true}]:[]),{k:'reason',l:'Reason'}],defaults:{month:cm(),installments:6},
  save:async b=>api('payroll/extras','POST',{kind,employee_id:+b.employee_id,amount:Number(b.amount),month:b.month,installments:Number(b.installments)||1,reason:b.reason}),remove:async id=>api('payroll/extras/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Approve',async c=>{const rows=ZK.need(c);let sk=[];for(const r of rows){const x=await api(`payroll/extras/${r.id}/decide`,'POST',{approve:true});sk.push(...(x.skipped_finalized_months||[]))}alert(`${rows.length} approved.`+(sk.length?`\nNot added to finalized months: ${[...new Set(sk)].join(', ')}`:''));c.reload()}],
    ['Reject',async c=>{const rows=ZK.need(c);for(const r of rows)await api(`payroll/extras/${r.id}/decide`,'POST',{approve:false});c.reload()}]],
  note:loan?'Approving a loan deducts one installment from the salary of each month from the start month.':kind==='advance'?'Approving an advance takes it from the salary of that month.':'Approving a reimbursement adds it to the salary of that month.'})};
extra('zk:payloan','Loan','loan');extra('zk:payadv','Salary Advance','advance');extra('zk:payreimb','Reimbursement','reimbursement');

// ---------- Visitor ----------
const vcols=[['Visitor ID','id'],['First Name','name',{link:true}],['Last Name',()=>''],['Certification Type',r=>r.id_no?'ID Card':''],['Certification No.',r=>r.id_no||''],['Status',r=>({in:'Entered',out:'Exit',expected:'Reserved',cancelled:'Cancelled'}[r.status]||r.status)],['Create Time',r=>r.checked_in||r.created||''],['Exit Time',r=>r.checked_out||'']];
const vfields=[{k:'name',l:'Name',req:true},{k:'company',l:'Company'},{k:'phone',l:'Phone'},{k:'id_no',l:'Certification No.'},{k:'purpose',l:'Purpose'},{k:'host_id',l:'Host',t:'select',opts:emps,blank:'---------'},{k:'vehicle',l:'Vehicle No.'}];
const vsave=(extra={})=>async(b,row)=>{const body={...b,host_id:b.host_id?+b.host_id:null,...extra};if(row)return api('visitors/'+row.id,'PUT',body);return api('visitors','POST',body)};
ZK.grid('zk:ventry','Entry Registration',{module:V,load:async()=>(await api('visitors')).filter(v=>v.status==='in'||v.status==='out'),cols:vcols,fields:vfields,rowActs:false,
  save:vsave({check_in:true}),remove:async id=>api('visitors/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Exit Registration',async c=>{const rows=ZK.need(c).filter(r=>r.status==='in');if(!rows.length)throw new Error('Tick visitors who are still inside');for(const r of rows)await api(`visitors/${r.id}/check-out`,'POST',{});c.reload()}]]});
ZK.grid('zk:vlist','Visitor',{module:V,load:()=>api('visitors'),rowActs:false,cols:[['Visitor ID','id'],['First Name','name',{link:true}],['Last Name',()=>''],['Company',r=>r.company||''],['Phone',r=>r.phone||''],['Certification No.',r=>r.id_no||''],['Host',r=>r.host||''],['Last Visit',r=>r.checked_in||r.expected_date||'']],
  fields:vfields,save:vsave({}),remove:async id=>api('visitors/'+id,'DELETE')});
ZK.grid('zk:vres','Reservation',{module:V,load:async()=>(await api('visitors?status=expected')),rowActs:false,
  cols:[['Visitor ID','id'],['First Name','name',{link:true}],['Last Name',()=>''],['Company',r=>r.company||''],['Phone',r=>r.phone||''],['Host',r=>r.host||''],['Expected Date',r=>r.expected_date||''],['Expected Time',r=>r.expected_time||''],['Purpose',r=>r.purpose||'']],
  fields:[...vfields,{k:'expected_date',l:'Expected Date',t:'date',req:true},{k:'expected_time',l:'Expected Time',ph:'HH:MM'}],defaults:{expected_date:today()},save:vsave({}),remove:async id=>api('visitors/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Check In',async c=>{const rows=ZK.need(c);for(const r of rows)await api(`visitors/${r.id}/check-in`,'POST',{});c.reload()}],['Cancel Reservation',async c=>{const rows=ZK.need(c);for(const r of rows)await api(`visitors/${r.id}/cancel`,'POST',{});c.reload()}]]});
ZK.grid('zk:vblock','Blocklist',{module:V,load:()=>api('visitors/blocklist'),cols:[['Name',r=>r.name||'',{link:true}],['Certification No.',r=>r.id_no||''],['Phone',r=>r.phone||''],['Reason',r=>r.reason||'']],rowActs:false,
  fields:[{k:'name',l:'Name'},{k:'id_no',l:'Certification No.'},{k:'phone',l:'Phone'},{k:'reason',l:'Reason'}],save:async b=>api('visitors/blocklist','POST',b),remove:async id=>api('visitors/blocklist/'+id,'DELETE'),note:'A blocked visitor cannot be checked in.'});
ZK.grid('zk:vhist','Visit History',{module:V,load:async()=>(await api('visitors?status=out')),cols:[...vcols.slice(0,2),['Company',r=>r.company||''],['Host',r=>r.host||''],['Badge',r=>r.badge_no||''],['Time In',r=>r.checked_in||''],['Time Out',r=>r.checked_out||'']],acts:[],rowActs:false});
})();
