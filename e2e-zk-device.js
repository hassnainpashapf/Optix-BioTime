// ZKT-style Device pages: actions -> device commands, command log / error log / upload log, parameters, work codes, messages, device data,
// bio photos, transactions, mobile app, announcements, geo-fence, configuration, restricted roles.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const status = async (p, m, b, t) => (await S.raw(p, m, b, t)).status;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
try {
  const mk = (name, extra = {}) => api('employees', 'POST', { name, join_date: '2025-01-01', ...extra });
  const A = await mk('Ayesha'), B = await mk('Bilal'); const dep = (await api('departments', 'POST', { name: 'Sales' })).id;
  const gate = (await api('devices', 'POST', { name: 'Gate', sn: 'ZD-1' })).id, gate2 = (await api('devices', 'POST', { name: 'Back', sn: 'ZD-2' })).id, pull = (await api('devices', 'POST', { name: 'Pull', ip: '10.9.9.9' })).id;
  const sim = new SimDevice(S.base, 'ZD-1'); await sim.handshake();
  const cmds = async (scope = 'queue') => api('zkd/commands?scope=' + scope);

  // ---- device actions
  const act = (action, args, ids = [gate]) => api('zkd/devices/action', 'POST', { ids, action, args });
  await assert.rejects(act('nope'), /Unknown action/); await assert.rejects(api('zkd/devices/action', 'POST', { ids: [], action: 'reboot' }), /at least one/);
  assert.deepEqual(await act('reboot', {}, [gate, pull]), { done: 1, skipped: 1, queued: 1, direct: 0 });
  for (const [a, args, re] of [['clear-attlog', {}, /^CLEAR LOG$/], ['clear-photo', {}, /^CLEAR PHOTO$/], ['clear-all', {}, /^CLEAR DATA$/], ['upload-users', {}, /tablename=USERINFO/], ['info', {}, /^INFO$/], ['upload-tx', { from: '2026-01-01', to: '2026-01-31' }, /ATTLOG StartTime=2026-01-01 00:00:00\s+EndTime=2026-01-31 23:59:59/],
    ['enroll-remote', { pin: '5', fid: 2 }, /ENROLL_FP PIN=5\s+FID=2/], ['dup-punch', { minutes: 3 }, /SET OPTION DuplicatePunchPeriod=3/], ['capture-setting', { on: '0' }, /CameraOpen=0/], ['dst', { on: '1' }, /DSTOn=1/], ['punch-state', { on: '1' }, /PunchStateAuto=1/],
    ['upgrade', { url: 'http://x.test/fw.bin', size: 5 }, /^UPGRADE checksum=,url=http:\/\/x.test\/fw.bin,size=5/], ['download-file', { path: 'user.dat' }, /^GET FILE user.dat/], ['set-option', { name: 'Delay', value: '20' }, /^SET OPTION Delay=20/]]) {
    await act(a, args); assert.match((await cmds())[0].cmd, re, a);
  }
  await assert.rejects(act('enroll-remote', {}), /Enter the employee ID/); await assert.rejects(act('dup-punch', { minutes: -1 }), /0 to 999/); await assert.rejects(act('upgrade', { url: 'ftp://x' }), /http/); await assert.rejects(act('set-option', { name: 'bad name', value: 1 }), /Option name/);
  assert.ok((await act('sync-to-device', {})).queued >= 2, 'all employees go to the device');
  assert.ok((await api('zkd/oplog')).some(o => o.action === 'Reboot' && o.admin === 'admin' && o.object === 'Gate'), 'device actions are in the operation log');

  // ---- device command pages: queue vs log, Add / Bulk Delete / Clear all
  const q = await cmds(); assert.ok(q.every(c => ['pending', 'sent'].includes(c.status)) && q[0].sn === 'ZD-1' && q[0].device === 'Gate');
  await assert.rejects(api('zkd/commands', 'POST', { device_ids: [pull], cmd: 'REBOOT' }), /pull device/); await assert.rejects(api('zkd/commands', 'POST', { device_ids: [gate], cmd: ' ' }), /Write the command/); await assert.rejects(api('zkd/commands', 'POST', { device_ids: [], cmd: 'x' }), /at least one/);
  await api('zkd/commands', 'POST', { device_ids: [gate, gate2], cmd: 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*' });
  const sim2 = new SimDevice(S.base, 'ZD-2'); await sim2.handshake();
  while ((await sim.poll()).length); while ((await sim2.poll()).length); // the devices fetch and answer everything (unsupported ones fail)
  assert.equal((await cmds()).length, 0, 'answered commands leave the queue');
  const log = await cmds('log'); assert.ok(log.length > 10 && log.some(c => c.value === '0' && c.returned) && log.some(c => c.value === '-1'), 'Return Time / Return Value');
  const errs = await api('zkd/errlog'); assert.ok(errs.length > 0 && errs[0].sn === 'ZD-1' && errs[0].code === '-1' && /could not run/.test(errs[0].message) && errs[0].command_id, 'failed commands reach the error log');
  const up = await api('zkd/uplog'); assert.ok(up.some(u => u.event === 'OPERLOG' && u.device === 'Gate' && u.count >= 0), 'uploads are logged');
  await api('zkd/commands', 'POST', { device_ids: [gate], cmd: 'REBOOT' }); await api('zkd/commands', 'POST', { device_ids: [gate], cmd: 'REBOOT' });
  const keep = (await cmds())[0].id; await api('zkd/commands/delete', 'POST', { ids: [(await cmds())[1].id] }); assert.equal((await cmds()).length, 1);
  await assert.rejects(api('zkd/commands/bulk-delete', 'POST', { before: 'x' }), /Choose a date/);
  assert.equal((await api('zkd/commands/bulk-delete', 'POST', { before: '2000-01-01', scope: 'queue' })).cleared, 0); assert.equal((await cmds()).length, 1);
  assert.ok((await api('zkd/commands/clear-all', 'POST', { scope: 'log' })).cleared > 5); assert.equal((await cmds('log')).length, 0); assert.equal((await cmds()).length, 1, 'clearing the log leaves the queue');
  assert.equal((await api('zkd/commands/clear-all', 'POST', {})).cleared, 1); void keep;
  // manual log records
  await assert.rejects(api('zkd/oplog', 'POST', { action: 'x' }), /Choose a device/); const op = (await api('zkd/oplog', 'POST', { device_id: gate, action: 'Manual', admin: 'me' })).id;
  assert.equal((await api('zkd/oplog/delete', 'POST', { ids: [op] })).deleted, 1);
  await api('zkd/uplog', 'POST', { device_id: gate, event: 'ATTLOG', content: 'x', count: 3, upload_time: '2020-01-01 00:00:00' }); await assert.rejects(api('zkd/uplog/clear', 'POST', { before: 'bad' }), /YYYY-MM-DD/);
  assert.ok((await api('zkd/uplog/clear', 'POST', { before: '2021-01-01' })).deleted >= 1); assert.ok((await api('zkd/uplog')).length >= 1, 'only old rows go'); assert.ok((await api('zkd/uplog/clear', 'POST', {})).deleted >= 1);
  assert.ok((await api('zkd/errlog/clear', 'POST', {})).deleted >= 1);

  // ---- device parameters
  await assert.rejects(api('zkd/params', 'POST', { device_id: gate, name: 'bad name', value: 1 }), /Name:/); await assert.rejects(api('zkd/params', 'POST', { name: 'Delay' }), /Choose a device/);
  const p1 = await api('zkd/params', 'POST', { device_id: gate, name: 'Delay', value: '30', push: true }); assert.ok(p1.command);
  assert.match((await cmds())[0].cmd, /^SET OPTION Delay=30$/); await api('zkd/params', 'POST', { device_id: gate, name: 'Delay', value: '40' }); let ps = await api('zkd/params'); assert.equal(ps.length, 1); assert.equal(ps[0].value, '40'); assert.equal(ps[0].sn, 'ZD-1');
  await api('zkd/params/' + ps[0].id, 'PUT', { value: '50' }); assert.equal((await api('zkd/params'))[0].value, '50'); await api('zkd/params/' + ps[0].id, 'DELETE'); assert.equal((await api('zkd/params')).length, 0);

  // ---- work codes
  await assert.rejects(api('zkd/workcodes', 'POST', { code: 'abc', name: 'x' }), /number/); const wc = (await api('zkd/workcodes', 'POST', { code: '12', name: 'Site visit' })).id; await assert.rejects(api('zkd/workcodes', 'POST', { code: '12', name: 'dup' }), /already exists/);
  await api('zkd/workcodes/' + wc, 'PUT', { code: '12', name: 'Client visit' }); await assert.rejects(api('zkd/workcodes/send', 'POST', { ids: [] }), /at least one/);
  const before = (await cmds()).length; const sent = await api('zkd/workcodes/send', 'POST', { ids: [wc] }); assert.equal(sent.devices, 2); assert.equal((await cmds()).length, before + 2);
  assert.match((await cmds())[0].cmd, /DATA UPDATE WORKCODE PIN=12\s+CODE=12\s+NAME=Client visit/); assert.ok((await api('zkd/workcodes'))[0].last_activity);
  await api('zkd/workcodes/send', 'POST', { ids: [wc], action: 'remove', device_ids: [gate] }); assert.match((await cmds())[0].cmd, /DATA DELETE WORKCODE CODE=12/);
  await api('zkd/workcodes/' + wc, 'DELETE'); assert.equal((await api('zkd/workcodes')).length, 0); await api('zkd/commands/clear-all', 'POST', {});

  // ---- messages with device targeting
  await assert.rejects(api('zkd/messages', 'POST', { scope: 'public', content: '' }), /Write the message/); await assert.rejects(api('zkd/messages', 'POST', { scope: 'private', content: 'hi' }), /Choose who/); await assert.rejects(api('zkd/messages', 'POST', { scope: 'public', content: 'x', duration_min: 0 }), /Duration/);
  const m1 = (await api('zkd/messages', 'POST', { scope: 'public', content: 'Holiday on Friday', duration_min: 60, device_ids: [gate] })).ids[0], m2 = (await api('zkd/messages', 'POST', { scope: 'public', content: 'To all' })).ids[0];
  const pm = (await api('zkd/messages', 'POST', { scope: 'private', content: 'See HR', employee_ids: [A.id, B.id], device_ids: [gate2] })).ids; assert.equal(pm.length, 2);
  let pub = await api('zkd/messages?scope=public'); assert.equal(pub.find(m => m.id === m1).device, 'Gate'); assert.equal(pub.find(m => m.id === m1).sn, 'ZD-1'); assert.equal(pub.find(m => m.id === m2).device, 'All devices');
  assert.equal((await api('zkd/messages?scope=private')).find(m => m.id === pm[0]).code, A.code);
  assert.equal((await api(`zkd/messages/${m1}/send`, 'POST', {})).devices, 1); assert.match((await cmds())[0].cmd, /DATA UPDATE SMS UID=\d+\s+Msg=Holiday on Friday\s+Tag=253\s+Min=60/); assert.ok((await api('zkd/messages?scope=public')).find(m => m.id === m1).last_sent);
  assert.equal((await api(`zkd/messages/${m2}/send`, 'POST', {})).devices, 2); assert.equal((await api(`zkd/messages/${pm[0]}/send`, 'POST', {})).devices, 1);
  assert.ok((await cmds()).some(c => /USER_SMS Pin=\d+/.test(c.cmd)));
  await api('zkd/messages/' + m1, 'PUT', { content: 'Edited', duration_min: 30, device_ids: [gate, gate2] }); assert.equal((await api('zkd/messages?scope=public')).find(m => m.id === m1).device, 'Gate, Back');
  await api('device-messages/' + m2, 'DELETE'); assert.equal((await api('zkd/messages?scope=public')).length, 1); await api('zkd/commands/clear-all', 'POST', {});

  // ---- device data: users on devices, privilege, transfer, enrolment
  await sim.upload('OPERLOG', [`USER PIN=${A.code}\tName=Ayesha\tPri=0\tPasswd=\tCard=[0000005555]\tGrp=1`]);
  let du = await api('zkd/devemp'); const u = du.find(r => r.code === A.code); assert.ok(u && u.device === 'Gate' && u.card === '5555' && u.priv === 0);
  await api('zkd/devemp/' + u.id, 'PUT', { priv: 14, verify_mode: 1 }); assert.match((await cmds())[0].cmd, /Pri=14/); assert.equal((await api('zkd/devemp')).find(r => r.id === u.id).verify_mode, 1);
  await assert.rejects(api('zkd/devemp/' + u.id, 'PUT', { priv: 5 }), /Privilege/);
  assert.equal((await api('zkd/devemp', 'POST', { device_id: gate2, employee_ids: [B.id] })).added, 1); assert.match((await cmds())[0].cmd, new RegExp(`USERINFO PIN=${B.code}`));
  await assert.rejects(api('zkd/devemp', 'POST', { device_ids: [], employee_ids: [] }), /Choose a device/);
  await api('zkd/commands/clear-all', 'POST', {});
  assert.equal((await api('zkd/devemp/transfer', 'POST', { ids: [u.id], action: 'resync' })).done, 1); assert.match((await cmds())[0].cmd, /Pri=14/); await assert.rejects(api('zkd/devemp/transfer', 'POST', { ids: [u.id], action: 'x' }), /Unknown action/);
  await api('zkd/devemp/transfer', 'POST', { ids: [u.id], action: 'reupload' }); assert.match((await cmds())[0].cmd, /tablename=USERINFO/);
  for (const [t, re] of [['fp', /ENROLL_FP PIN=\d+/], ['palm', /ENROLL_PALM/], ['face', /ENROLL_MF/]]) { await api('zkd/devemp/enroll', 'POST', { ids: [u.id], type: t }); assert.match((await cmds())[0].cmd, re); }
  await assert.rejects(api('zkd/devemp/enroll', 'POST', { ids: [u.id], type: 'iris' }), /Choose fingerprint/);
  const bd = du.length; await api('zkd/devemp/delete', 'POST', { ids: [u.id] }); assert.equal((await api('zkd/devemp')).length, bd, 'B added, A removed'); assert.match((await cmds())[0].cmd, /DATA DELETE USERINFO PIN=/);
  // templates list is read-only and comes from stored biometrics
  sim2.templates.push({ kind: 'fp', pin: B.code, fid: 3, tmpl: 'QUJDREVGR0g=' }); await sim2.uploadTemplates();
  const bt = await api('zkd/biotemplates'); assert.equal(bt.length, 1); assert.deepEqual([bt[0].code, bt[0].type, bt[0].fid, bt[0].sn], [B.code, 'Fingerprint', 3, 'ZD-2']);
  await sim2.upload('OPERLOG', [`OPLOG 1\t0\t0\tOBJ=5`, `FP PIN=${B.code}\tFID=4\tSize=9\tValid=1\tTMP=SECRETTEMPLATE12345`]);
  assert.ok(!JSON.stringify(await api('zkd/oplog')).includes('SECRETTEMPLATE'), 'biometric templates never reach the operation log');
  assert.ok((await api('zkd/oplog')).some(o => o.action === 'OPLOG' && o.device === 'Back'), 'device operation lines do');
  assert.equal((await api('zkd/devemp')).find(r => r.code === B.code).fp, 2, 'FP column counts templates of that device');

  // ---- bio photos
  await assert.rejects(api('zkd/biophotos', 'POST', { employee_id: A.id }), /Choose the bio photo/); await assert.rejects(api('zkd/biophotos', 'POST', { employee_id: A.id, bio_photo: 'nope' }), /JPEG or PNG/); await assert.rejects(api('zkd/biophotos', 'POST', { code: 'zzz', bio_photo: PNG }), /No such employee/);
  const bp = (await api('zkd/biophotos', 'POST', { code: A.code, bio_photo: PNG, remark: 'self upload' })).id; let bps = await api('zkd/biophotos'); assert.equal(bps[0].approval_state, 'Pending'); assert.equal(bps[0].name, 'Ayesha');
  await api('zkd/commands/clear-all', 'POST', {}); const ap = await api('zkd/biophotos/approve', 'POST', { ids: [bp] }); assert.deepEqual([ap.done, ap.queued], [1, 2]); assert.match((await cmds())[0].cmd, /DATA UPDATE BIOPHOTO PIN=\d+\s+Type=9\s+Size=\d+\s+Content=\[photo\]/); bps = await api('zkd/biophotos'); assert.equal(bps[0].approval_state, 'Approved'); assert.ok(bps[0].approval_time);
  assert.match((await api('zkd/biophotos/qr-info')).url, /\/portal$/); await api('zkd/biophotos/' + bp, 'DELETE'); assert.equal((await api('zkd/biophotos')).length, 0); await api('zkd/commands/clear-all', 'POST', {});

  // ---- transactions
  await api('employees/' + A.id, 'PUT', { department_id: dep });
  await api('logs/manual', 'POST', { emp_code: A.code, ts: '2026-02-02 09:00:00' }); await api('logs/manual', 'POST', { emp_code: A.code, ts: '2026-02-02 18:00:00' });
  await sim.uploadPunches([{ pin: B.code, ts: '2026-02-02 09:05:00' }]);
  let tx = await api('zkd/transactions?from=2026-02-02&to=2026-02-02'); assert.equal(tx.length, 3);
  const a1 = tx.filter(t => t.code === A.code).sort((x, y) => x.ts.localeCompare(y.ts)); assert.deepEqual(a1.map(t => t.state), ['Check In', 'Check Out']); assert.equal(a1[0].dept, 'Sales');
  const bt1 = tx.find(t => t.code === B.code); assert.deepEqual([bt1.sn, bt1.device, bt1.uploaded.length], ['ZD-1', 'Gate', 19]);
  assert.equal((await api('zkd/transactions?from=2026-02-02&to=2026-02-02&q=Bilal')).length, 1); assert.equal((await api('zkd/transactions?from=2026-02-03&to=2026-02-04')).length, 0);
  assert.equal((await api('zkd/transactions/delete', 'POST', { ids: [bt1.id] })).deleted, 1); assert.equal((await api('zkd/transactions?from=2026-02-02&to=2026-02-02')).length, 2);
  assert.equal((await api('zkd/transactions/photos', 'POST', { from: '2026-02-01', to: '2026-02-02' })).devices, 2); assert.match((await cmds())[0].cmd, /DATA QUERY ATTPHOTO StartTime=2026-02-01 00:00:00\s+EndTime=2026-02-02 23:59:59/);

  // ---- mobile app: accounts, notices, announcements, request log
  const code = await api('zkd/app/accounts/pair', 'POST', {}); assert.match(code.code, /^\d{8}$/);
  const pr = await fetch(S.base + '/api/m/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.code, device_name: 'Pixel' }) }); const tok = (await pr.json()).token; assert.ok(tok);
  const ms = await fetch(S.base + '/api/m/me', { headers: { Authorization: 'Bearer ' + tok } }); assert.equal(ms.status, 200);
  let acc = await api('zkd/app/accounts'); const mine = acc.find(a => a.category === 'Pixel'); assert.deepEqual([mine.user, mine.status, mine.running, mine.kind], ['admin', 'Enable', 'Online', 'staff']); assert.match(mine.client_id, /^S\d{5}$/);
  const lg = await api('zkd/app/log'); assert.ok(lg.some(r => r.path === '/api/m/me' && r.method === 'GET' && r.status === 200 && r.user === 'admin'), 'phone requests are logged');
  await api('zkd/app/accounts/action', 'POST', { ids: [mine.id], action: 'disable' }); assert.equal((await fetch(S.base + '/api/m/me', { headers: { Authorization: 'Bearer ' + tok } })).status, 401); assert.equal((await api('zkd/app/accounts')).find(a => a.id === mine.id).status, 'Disable');
  await api('zkd/app/accounts/action', 'POST', { ids: [mine.id], action: 'enable' }); assert.equal((await fetch(S.base + '/api/m/me', { headers: { Authorization: 'Bearer ' + tok } })).status, 200);
  await api('zkd/app/accounts/action', 'POST', { ids: [mine.id], action: 'offline' }); assert.equal((await api('zkd/app/accounts')).find(a => a.id === mine.id).running, 'Offline');
  await assert.rejects(api('zkd/app/accounts/action', 'POST', { ids: [mine.id], action: 'x' }), /Unknown action/); await assert.rejects(api('zkd/app/accounts/pair', 'POST', { employee_id: A.id }), /portal account/);
  await api('portal-accounts', 'POST', { employee_ids: [A.id] }); assert.match((await api('zkd/app/accounts/pair', 'POST', { employee_id: A.id })).code, /^\d{8}$/);
  await assert.rejects(api('zkd/app/accounts/push', 'POST', { ids: [mine.id] }), /Write the notification/); assert.equal((await api('zkd/app/accounts/push', 'POST', { ids: [mine.id], title: 'Hello', body: 'b' })).sent, 1);
  await api('zkd/app/notices', 'POST', { employee_id: A.id, title: 'Your badge is ready', category: 'automation' }); const nt = (await api('zkd/app/notices')).find(n => n.title === 'Your badge is ready'); assert.equal(nt.code, A.code); assert.equal((await api('zkd/app/notices/delete', 'POST', { ids: [nt.id] })).deleted, 1);
  await assert.rejects(api('zkd/ann', 'POST', { title: '' }), /subject/); const an = (await api('zkd/ann', 'POST', { title: 'Office closed', body: 'Monday', category: 'General' })).id, ap2 = (await api('zkd/ann', 'POST', { title: 'Badge', body: 'Collect it', employee_id: A.id })).id;
  const al = await api('zkd/ann/list'); assert.deepEqual([al.find(a => a.id === ap2).code, al.find(a => a.id === an).employee_id, al.find(a => a.id === an).created_by], [A.code, null, 'admin']);
  assert.ok((await api('announcements')).some(a => a.title === 'Office closed'), 'a public notice is also a portal announcement');
  assert.equal((await api('zkd/ann/push', 'POST', { ids: [ap2], mode: 'private' })).sent, 1); await assert.rejects(api('zkd/ann/push', 'POST', { ids: [an], mode: 'private' }), /public notice/); await assert.rejects(api('zkd/ann/push', 'POST', { ids: [ap2], mode: 'public' }), /one employee/);
  assert.equal((await api('zkd/ann/push', 'POST', { ids: [an], mode: 'public' })).sent, 1, 'one portal account exists (A)');
  assert.ok((await api('zkd/app/notices')).some(n => n.employee_id === A.id && n.title === 'Office closed')); await api('zkd/ann/' + an, 'DELETE'); assert.equal((await api('zkd/ann/list')).some(a => a.id === an), false);
  assert.equal((await api('zkd/app/log/delete', 'POST', { ids: [lg[0].id] })).deleted, 1);

  // ---- geo-fence
  await assert.rejects(api('zkd/geo/locations', 'POST', { alias: 'HQ', lng: 74, lat: 'x' }), /Latitude/); await assert.rejects(api('zkd/geo/locations', 'POST', { alias: '', lng: 74, lat: 31 }), /Alias/);
  const site = (await api('zkd/geo/locations', 'POST', { alias: 'HQ', location: 'Main Blvd', lng: 74.3, lat: 31.5, radius_m: 200 })).id; await assert.rejects(api('zkd/geo/locations', 'POST', { alias: 'HQ', lng: 1, lat: 1 }), /exists/);
  await api('zkd/geo/locations/' + site, 'PUT', { alias: 'HQ', location: 'Gulberg', lng: 74.31, lat: 31.5 }); let loc = (await api('zkd/geo/locations')).find(l => l.id === site); assert.deepEqual([loc.location, loc.lng, loc.radius_m], ['Gulberg', 74.31, 200]);
  assert.equal((await api('geo_sites')).find(g => g.id === site).name, 'HQ', 'it is the same table the phone punch check reads');
  await assert.rejects(api('zkd/geo/emp', 'POST', { employee_id: A.id, site_id: 9999 }), /Choose a location/); await assert.rejects(api('zkd/geo/emp', 'POST', { employee_id: A.id, site_id: site, start_date: '2026-03-01', end_date: '2026-02-01' }), /end date/);
  const ge = (await api('zkd/geo/emp', 'POST', { employee_id: A.id, site_id: site, distance: 100, start_date: '2026-01-01' })).id; assert.deepEqual((await api('zkd/geo/emp'))[0], { id: ge, employee_id: A.id, site_id: site, target: `${A.code} Ayesha`, location: 'HQ', distance: 100, start_date: '2026-01-01', end_date: null });
  assert.deepEqual(await api(`geo_sites/${site}/employees`), [A.id], 'employee setup grants the real geofence');
  const gd = (await api('zkd/geo/dept', 'POST', { department_id: dep, site_id: site })).id; await api('zkd/geo/dept/' + gd, 'PUT', { department_id: dep, site_id: site, distance: 50 }); assert.equal((await api('zkd/geo/dept'))[0].distance, 50); await api('zkd/geo/dept/' + gd, 'DELETE'); await api('zkd/geo/emp/' + ge, 'DELETE'); assert.equal((await api('zkd/geo/emp')).length, 0);
  await api('zkd/geo/locations/' + site, 'DELETE'); assert.equal((await api('zkd/geo/locations')).length, 0);

  // ---- configuration
  let cfg = await api('zkd/config'); assert.deepEqual([cfg.zkd_delay, cfg.zkd_auto_approve, cfg.device_offline_min], [10, 0, 5]);
  await assert.rejects(api('zkd/config', 'PUT', { zkd_delay: 0 }), /Upload interval/); await assert.rejects(api('zkd/config', 'PUT', { device_offline_min: 'x' }), /Offline after/);
  cfg = await api('zkd/config', 'PUT', { zkd_delay: 25, zkd_error_delay: 60, zkd_realtime: 0, zkd_auto_approve: 1, zkd_timezone: 'Asia/Karachi', device_offline_min: 9 }); assert.deepEqual([cfg.zkd_delay, cfg.zkd_realtime, cfg.zkd_timezone, cfg.device_offline_min], [25, 0, 'Asia/Karachi', 9]);
  assert.equal((await api('zkd/config/apply', 'POST')).devices, 3); const d0 = (await api('devices')).find(d => d.id === gate); assert.deepEqual([d0.delay, d0.error_delay, d0.realtime, d0.timezone], [25, 60, 0, 'Asia/Karachi']);
  await new SimDevice(S.base, 'NEW-AUTO').handshake(); assert.equal((await api('devices')).find(d => d.sn === 'NEW-AUTO').approved, 1, 'new devices are approved automatically when switched on');
  await api('zkd/config', 'PUT', { zkd_auto_approve: 0 }); await new SimDevice(S.base, 'NEW-MANUAL').handshake(); assert.equal((await api('devices')).find(d => d.sn === 'NEW-MANUAL').approved, 0);

  // ---- permissions: devices module view/none
  await api('roles', 'POST', { name: 'devview', perms: { devices: 'view', organization: 'view' } }); await api('users', 'POST', { username: 'devview', password: 'password1', role: 'devview' }); const vt = await S.login('devview', 'password1');
  assert.equal(await status('zkd/params', 'GET', undefined, vt), 200); assert.equal(await status('zkd/commands?scope=log', 'GET', undefined, vt), 200);
  assert.equal(await status('zkd/devices/action', 'POST', { ids: [gate], action: 'reboot' }, vt), 403); assert.equal(await status('zkd/commands/clear-all', 'POST', {}, vt), 403); assert.equal(await status('zkd/config', 'PUT', { zkd_delay: 5 }, vt), 403); assert.equal(await status('zkd/geo/locations', 'POST', { alias: 'x', lng: 1, lat: 1 }, vt), 403);
  assert.equal(await status('zkd/app/accounts', 'GET', undefined, vt), 403, 'app accounts follow the employees module');
  await api('roles', 'POST', { name: 'nodev', perms: { employees: 'view' } }); await api('users', 'POST', { username: 'nodev', password: 'password1', role: 'nodev' }); const nt2 = await S.login('nodev', 'password1');
  assert.equal(await status('zkd/params', 'GET', undefined, nt2), 403); assert.equal(await status('zkd/transactions', 'GET', undefined, nt2), 403); assert.equal(await status('zkd/ann/list', 'GET', undefined, nt2), 403);
  console.log('e2e-zk-device: all passed');
} catch (e) { console.error(e); process.exitCode = 1; } finally { S.stop(); }
