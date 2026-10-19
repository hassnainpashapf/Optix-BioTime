// Meeting module in the ZKT layout: Room, Device, Meeting, Transaction, Report. Backend: meetings.js (/api/rooms, /api/meetings).
(()=>{
const E=v=>esc(v==null?'':v),M='attendance';
const emps=async()=>(await api('employees?status=active')).map(e=>[e.id,`${e.code} - ${e.name}`]);
const rooms=async()=>(await api('rooms')).filter(r=>r.active).map(r=>[r.id,r.name]);
const pad=n=>'R'+String(n).padStart(3,'0');
ZK.grid('zk:mroom','Room',{module:M,load:async()=>(await api('rooms')).map(r=>({...r,code:pad(r.id)})),rowActs:false,
  cols:[['Room Code','code',{link:true}],['Room Name','name'],['Capacity',r=>r.capacity||''],['Location',r=>r.location||''],['Device',r=>r.device||''],['State',r=>r.active?'Enable':'Disable']],
  fields:[{k:'name',l:'Room Name',req:true},{k:'capacity',l:'Capacity',t:'number'},{k:'location',l:'Location'},{k:'device_id',l:'Device',t:'select',opts:async()=>(await api('devices')).map(d=>[d.id,d.name||d.sn]),blank:'(none)'},{k:'active',l:'Enable',t:'checkbox'}],defaults:{active:true},
  save:async(b,row)=>{const body={name:b.name,capacity:b.capacity||0,location:b.location||'',device_id:b.device_id?+b.device_id:null,active:b.active?1:0};return api(row?'rooms/'+row.id:'rooms',row?'PUT':'POST',body)},remove:async id=>api('rooms/'+id,'DELETE')});
ZK.list('zk:mdev','Device',{module:M,load:async()=>{const [ds,rs]=await Promise.all([api('devices'),api('rooms')]);return ds.map(d=>({...d,state:d.online?'Online':'Offline',room:(rs.find(r=>r.device_id===d.id)||{}).name||''}))},acts:[],
  cols:[['Device Name','name'],['Serial Number',r=>r.sn||''],['Area',r=>r.branch||r.group||''],['Device IP',r=>r.ip||''],['Room',r=>r.room||''],['State','state'],['Last Activity',r=>r.last_seen||'']]});
const mrows=async()=>(await api('meetings')).map(m=>({...m,where:m.room||m.place||'',st:({scheduled:'Scheduled',done:'Done',cancelled:'Cancelled'}[m.status]||m.status)}));
ZK.grid('zk:meeting','Meeting',{module:M,load:mrows,rowActs:false,
  cols:[['Meeting Title','title',{link:true}],['Organizer',r=>r.organizer||''],['Room / Place','where'],['Start Time','start_ts'],['End Time','end_ts'],['Invited','invited'],['Status','st']],
  fields:[{k:'title',l:'Meeting Title',req:true},{k:'organizer_id',l:'Organizer',t:'select',opts:emps,blank:'---------'},{k:'room_id',l:'Room',t:'select',opts:rooms,blank:'(no room)'},{k:'place',l:'Place',hint:'when no room is chosen'},{k:'start',l:'Start Time',t:'datetime',req:true},{k:'end',l:'End Time',t:'datetime',req:true},{k:'agenda',l:'Agenda',t:'textarea'},{k:'attendees',l:'Attendees',t:'checks',opts:emps}],
  save:async(b,row)=>{if(row)throw new Error('To change a meeting, cancel it and add a new one');const body={...b,organizer_id:b.organizer_id?+b.organizer_id:null,room_id:b.room_id?+b.room_id:null,attendees:(b.attendees||[]).map(Number)};const r=await api('meetings','POST',body);if(r.warnings&&r.warnings.length)alert('Saved. Note:\n'+r.warnings.join('\n'))},
  remove:async id=>api('meetings/'+id,'DELETE'),
  acts:[['Add'],['Delete'],['Cancel Meeting',async c=>{const rows=ZK.need(c).filter(r=>r.status==='scheduled');if(!rows.length)throw new Error('Tick meetings that are still scheduled');for(const r of rows)await api(`meetings/${r.id}/cancel`,'POST',{});c.reload()}]]});
const detail=async()=>{const ms=(await api('meetings')).slice(0,60);return Promise.all(ms.map(m=>api('meetings/'+m.id).catch(()=>null))).then(a=>a.filter(Boolean))};
ZK.list('zk:mtx','Transaction',{module:M,acts:[],load:async()=>{const out=[];let n=0;for(const m of await detail())for(const a of m.attendees||[])out.push({id:++n,title:m.title,start:m.start_ts,code:a.code,name:a.name,rsvp:a.rsvp,attended:a.attended==null?'':a.attended?'Yes':'No'});return out},
  cols:[['Meeting Title','title'],['Start Time','start'],['Employee ID','code'],['First Name','name'],['RSVP',r=>r.rsvp||''],['Attended','attended']]});
ZK.list('zk:mrep','Meeting Report',{module:M,acts:[],load:async()=>(await detail()).map(m=>{const a=m.attendees||[],came=a.filter(x=>x.attended).length;return {id:m.id,title:m.title,start:m.start_ts,where:m.room||m.place||'',invited:a.length,yes:a.filter(x=>x.rsvp==='yes').length,came,rate:m.status==='done'&&a.length?Math.round(came/a.length*100)+'%':'',st:m.status}}),
  cols:[['Meeting Title','title'],['Start Time','start'],['Room / Place','where'],['Invited','invited'],['Accepted','yes'],['Attended','came'],['Attendance Rate','rate'],['Status','st']]});
})();
