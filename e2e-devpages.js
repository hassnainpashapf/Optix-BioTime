// Device pages: extra fields, users on a device, punch log, health history, bulk actions, alert settings, connect info.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const S = await startServer(), api = S.api;
try {
  const today = new Date().toLocaleDateString('sv');
  // ---- extra fields and validation
  const id = (await api('devices', 'POST', { name: 'Lobby', sn: 'LOB-001', model: 'K40', dtype: 'Fingerprint', mac: '00:17:61:AB:CD:EF', installed: '2026-01-05', notes: 'near the door', alert_min: 5 })).id;
  const d = (await api('devices')).find(x => x.id === id);
  assert.equal(d.model, 'K40'); assert.equal(d.mac, '00:17:61:AB:CD:EF'); assert.equal(d.alert_min, 5); assert.equal(d.punches, 0);
  await assert.rejects(api('devices', 'POST', { name: 'x', sn: 'BAD-001', mac: 'nope' }), /MAC/);
  await assert.rejects(api('devices', 'POST', { name: 'x', sn: 'BAD-002', installed: '05/01/2026' }), /Installed date/);
  await assert.rejects(api('devices/' + id, 'PUT', { alert_min: 0 }), /Offline alert/);
  await api('devices/' + id, 'PUT', { alert_min: null, alert_off: 1 }); assert.equal((await api('devices')).find(x => x.id === id).alert_off, 1);

  // ---- users on the device and the punch log, fed by a simulated device
  const A = (await api('employees', 'POST', { name: 'Ayesha' })), B = (await api('employees', 'POST', { name: 'Bilal' }));
  const codeA = (await api('employees')).find(e => e.id === A.id).code, codeB = (await api('employees')).find(e => e.id === B.id).code;
  const sim = new SimDevice(S.base, 'LOB-001');
  sim.users.set(codeA, { name: 'Ayesha' }); sim.users.set('777', { name: 'Stranger' });
  await sim.poll(); await sim.uploadUsers();
  await sim.uploadPunches([{ pin: codeA, ts: `${today} 08:50:00` }, { pin: codeA, ts: `${today} 17:30:00` }, { pin: codeB, ts: `${today} 09:00:00` }]);
  const u = await api(`devices/${id}/users`); const by = Object.fromEntries(u.users.map(x => [x.code, x]));
  assert.ok(u.push && u.approved); assert.equal(by[codeA].in_system, true); assert.equal(by[codeA].punches, 2);
  assert.equal(by[codeB].in_system, true, 'someone who only punched here is listed'); assert.equal(by['777'].listed, 1);
  const p = await api(`devices/${id}/punches`); assert.equal(p.total, 3); assert.equal(p.rows[0].ts, `${today} 17:30:00`);
  assert.equal((await api(`devices/${id}/punches?q=Bilal`)).total, 1); assert.equal((await api(`devices/${id}/punches?from=2001-01-01&to=2001-01-02`)).total, 0);
  assert.equal((await api('devices')).find(x => x.id === id).punches_today, 3);
  // send / remove become commands
  assert.equal((await api(`devices/${id}/users/send`, 'POST', { codes: [codeB, 'nonexistent'] })).queued, 1);
  assert.equal((await api(`devices/${id}/users/send`, 'POST', { all: true })).queued >= 2, true);
  assert.equal((await api(`devices/${id}/users/remove`, 'POST', { codes: ['777'] })).queued, 1);
  assert.ok((await api(`devices/${id}/commands`)).some(c => /DATA DELETE USERINFO PIN=777/.test(c.cmd)));
  assert.ok(!(await api(`devices/${id}/users`)).users.some(x => x.code === '777' && x.listed), 'removed from the list');
  await assert.rejects(api(`devices/${id}/users/remove`, 'POST', { codes: [] }), /Select at least one/);

  // ---- health history from events
  const at = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toLocaleString('sv');
  const db = new DatabaseSync(join(S.dir, 'e2e.db'));
  for (const [h, k] of [[50, 'online'], [30, 'offline'], [28, 'online'], [2, 'offline']]) db.prepare('INSERT INTO device_events(device_id, ts, kind) VALUES(?,?,?)').run(id, at(h), k);
  db.close();
  const h = await api(`devices/${id}/health?days=7`);
  assert.equal(h.outages.length, 2); assert.equal(h.outages[0].to, null); assert.equal(h.outages[1].minutes, 120);
  assert.ok(h.uptime_pct > 85 && h.uptime_pct < 95, 'uptime ' + h.uptime_pct); assert.equal(h.daily.length, 7); assert.equal(h.total_offline_min, 120 + 120);

  // ---- messages on the device screen
  await assert.rejects(api('device-messages', 'POST', { scope: 'public', content: '' }), /Write the message/); await assert.rejects(api('device-messages', 'POST', { scope: 'private', content: 'hi' }), /Choose who/);
  const pm = (await api('device-messages', 'POST', { scope: 'public', content: 'Office closed\tFriday', duration_min: 60 })).ids[0], bm = (await api('device-messages', 'POST', { scope: 'private', content: 'See HR', employee_ids: [A.id] })).ids[0];
  const cb = (await api('device-commands')).length; assert.equal((await api(`device-messages/${pm}/send`, 'POST', {})).devices >= 1, true); await api(`device-messages/${bm}/send`, 'POST', {});
  const mc = (await api('device-commands')).map(c => c.cmd); assert.ok(mc.some(c => c.includes('DATA UPDATE SMS UID=' + pm) && c.includes('Msg=Office closed Friday') && c.includes('Tag=253') && c.includes('Min=60'))); assert.ok(mc.some(c => c.includes('Tag=254')) && mc.some(c => c.includes('DATA UPDATE USER_SMS Pin=' + codeA)));
  assert.equal((await api('device-messages?scope=private')).length, 1); assert.ok((await api('device-messages')).find(m => m.id === pm).last_sent); await api('device-messages/' + pm, 'DELETE'); assert.equal((await api('device-messages?scope=public')).length, 0); void cb;

  // ---- quantities and the ZKT-style bulk menu
  const q = (await api('devices')).find(x => x.id === id); assert.ok(q.user_qty >= 2, 'user quantity from the device'); assert.equal(typeof q.fp_qty, 'number'); assert.equal(typeof q.face_qty, 'number');
  const before = (await api('device-commands')).length; assert.deepEqual(await api('devices/bulk', 'POST', { ids: [id], action: 'clear-log' }), { done: 1, skipped: 0 }); assert.deepEqual(await api('devices/bulk', 'POST', { ids: [id], action: 'clear-data' }), { done: 1, skipped: 0 });
  const dc = await api('device-commands'); assert.equal(dc.length, before + 2); assert.ok(dc.some(c => c.cmd === 'CLEAR LOG' && c.device === 'Lobby') && dc.some(c => c.cmd === 'CLEAR DATA')); assert.equal((await api('device-commands?status=pending')).every(c => c.status === 'pending'), true);
  await api('devices/bulk', 'POST', { ids: [id], action: 'fetch-users' }); await api('devices/bulk', 'POST', { ids: [id], action: 'send-users' }); assert.ok((await api('device-commands')).some(c => /DATA QUERY tablename=USERINFO/.test(c.cmd)));
  assert.equal((await api('devices/bulk', 'POST', { ids: [id], action: 'clear-commands' })).done, 1); assert.equal((await api('device-commands')).filter(c => c.device_id === id).length, 0, 'clear pending commands empties the queue');

  // ---- bulk
  const g2 = (await api('devices', 'POST', { name: 'Back', sn: 'BCK-001' })).id, pull = (await api('devices', 'POST', { name: 'Pull one', ip: '10.9.9.9' })).id;
  const grp = (await api('device_groups', 'POST', { name: 'All' })).id;
  assert.deepEqual(await api('devices/bulk', 'POST', { ids: [id, g2, pull], action: 'group', group_id: grp }), { done: 3, skipped: 0 });
  assert.deepEqual(await api('devices/bulk', 'POST', { ids: [id, g2, pull], action: 'time-sync' }), { done: 2, skipped: 1 });
  await assert.rejects(api('devices/bulk', 'POST', { ids: [], action: 'approve' }), /Select/); await assert.rejects(api('devices/bulk', 'POST', { ids: [id], action: 'explode' }), /Unknown action/);
  assert.deepEqual(await api('devices/bulk', 'POST', { ids: [g2, pull], action: 'delete' }), { done: 2, skipped: 0 });
  assert.equal((await api('devices')).length, 1);
  // deleting a device keeps its punches in the attendance record
  await api('devices/' + id, 'DELETE'); assert.equal((await api('logs?date=' + today)).length >= 3, true);

  // ---- maintenance log
  const mdev = (await api('devices', 'POST', { name: 'Gym', sn: 'GYM-001', warranty_until: '2030-01-01', next_service: '2026-01-01' })).id;
  await assert.rejects(api(`devices/${mdev}/maintenance`, 'POST', { day: today, kind: 'Magic' }), /Choose what/); await assert.rejects(api(`devices/${mdev}/maintenance`, 'POST', { day: '1/1/26', kind: 'Repair' }), /Date must/);
  await assert.rejects(api('devices', 'POST', { name: 'x', sn: 'BAD-003', warranty_until: 'soon' }), /Warranty end/);
  await api(`devices/${mdev}/maintenance`, 'POST', { day: today, kind: 'Repair', cost: 1500, note: 'new screen', by: 'Tech Co' });
  assert.equal((await api(`devices/${mdev}/maintenance`)).next_service, '2026-01-01', 'a repair does not clear the planned service');
  await api(`devices/${mdev}/maintenance`, 'POST', { day: today, kind: 'Service', next_service: '2027-06-01' });
  let mm = await api(`devices/${mdev}/maintenance`); assert.equal(mm.next_service, '2027-06-01'); assert.equal(mm.entries.length, 2); assert.equal(mm.entries.find(e => e.kind === 'Repair').cost, 1500);
  await api('devices/maintenance/' + mm.entries[0].id, 'DELETE'); assert.equal((await api(`devices/${mdev}/maintenance`)).entries.length, 1);

  // ---- who may use a device
  const door = (await api('devices', 'POST', { name: 'Server room', sn: 'DOOR-001' })).id, doorSim = new SimDevice(S.base, 'DOOR-001'); await doorSim.poll();
  assert.equal((await api(`devices/${door}/push-users`, 'POST')).queued >= 2, true, 'everyone by default');
  await api(`devices/${door}/commands/clear`, 'POST'); await api(`devices/${door}/access`, 'PUT', { mode: 'selected' });
  assert.equal((await api(`devices/${door}/push-users`, 'POST')).queued, 0, 'nobody chosen yet');
  assert.deepEqual(await api(`devices/${door}/access/set`, 'POST', { codes: [codeA], allow: true, send: true }), { changed: 1, removed: 0 });
  const acc = await api(`devices/${door}/access`); assert.equal(acc.mode, 'selected'); assert.deepEqual(acc.employees.filter(e => e.allowed).map(e => e.code), [codeA]);
  assert.equal((await api(`devices/${door}/push-users`, 'POST')).queued, 1); assert.equal((await api(`devices/${door}/users/send`, 'POST', { codes: [codeB] })).queued, 0, 'a blocked person cannot be sent by hand either');
  const cmdsBefore = (await api(`devices/${door}/commands`)).length;
  await api('employees', 'POST', { name: 'Newcomer' }); // new employees are not pushed to a restricted device
  assert.equal((await api(`devices/${door}/commands`)).length, cmdsBefore);
  assert.equal((await api(`devices/${door}/access/set`, 'POST', { codes: [codeA], allow: false, remove: true })).removed, 1);
  assert.ok((await api(`devices/${door}/commands`)).some(c => new RegExp(`DATA DELETE USERINFO PIN=${codeA}`).test(c.cmd)));
  await assert.rejects(api(`devices/${door}/access`, 'PUT', { mode: 'some' }), /Mode/);

  // ---- CSV export / import
  const csv = 'name,serial,ip,port,model,type,location,group,installed\nImp A,IMP-001,,,K50,Fingerprint,Hall,Imported,2026-02-01\nImp B,,10.5.5.5,4370,,,Store,Imported,\nImp A again,IMP-001,,,,,,,\n,,,,,,,,2026-01-01\nBad IP,,999.1.1.1,,,,,,\n';
  const im = await api('devices/import', 'POST', { csv }); assert.equal(im.added, 2); assert.equal(im.skipped, 1); assert.equal(im.errors.length, 2); assert.equal(im.errors[0].line, 5);
  const devs = await api('devices'); assert.equal(devs.find(d => d.sn === 'IMP-001').approved, 1); assert.equal(devs.find(d => d.name === 'Imp B').group_name, 'Imported');
  assert.equal((await api('devices/import', 'POST', { csv })).added, 0, 'importing twice adds nothing');
  await assert.rejects(api('devices/import', 'POST', { csv: 'serial\nX' }), /name/);
  const ex = await api('devices/export'); assert.match(ex.csv, /^name,serial,ip/); assert.ok(ex.csv.includes('IMP-001')); assert.equal(ex.count, devs.length);
  assert.deepEqual(await api('devices/import', 'POST', { csv: ex.csv }).then(r => [r.added, r.errors.length]), [0, 0], 'an export imports cleanly');

  // ---- connect guide
  const ci = await api('devices/connect-info'); assert.ok(Array.isArray(ci.addresses) && ci.port > 0);
  console.log('e2e-devpages passed: device fields, maintenance, access, CSV, users on device, punch log, health, bulk, alerts, connect info');
} catch (e) { console.error('E2E-DEVPAGES FAILED:', (e.stack || '').split('\n').filter(l => /e2e-devpages.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
