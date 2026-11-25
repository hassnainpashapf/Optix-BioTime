// ZKT-style access control: door parameters, device commands, time period numbers, holidays, groups, combinations, privileges, clone to areas, transfer.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const stamp = (d = 0, hhmm = '12:00') => new Date(Date.now() + d * 86400000).toLocaleDateString('sv') + ' ' + hhmm + ':00';
try {
  const dev = (await api('devices', 'POST', { name: 'Gate unit', sn: 'ZA-001' })).id; const sim = new SimDevice(S.base, 'ZA-001'); await sim.poll();
  const mk = (name) => api('employees', 'POST', { name, join_date: '2025-01-01' }); const A = await mk('Ayesha Khan'), B = await mk('Bilal Ahmed'), C = await mk('Chand Ali');
  const codes = (await api('employees')).reduce((m, e) => (m[e.id] = e.code, m), {});

  // ---- doors with the ZKT parameters
  await assert.rejects(api('ac/doors', 'POST', { name: 'x', sensor_type: 7 }), /sensor type/); await assert.rejects(api('ac/doors', 'POST', { name: 'x', retry_alarm: 99 }), /Retry/);
  const d1 = (await api('ac/doors', 'POST', { name: 'Front', device_id: dev, door_no: 1, open_sec: 6, sensor_delay: 20, sensor_type: 1, alarm_delay: 4, retry_alarm: 5, valid_holidays: 0 })).id;
  let row = (await api('ac/doors')).find(d => d.id === d1); assert.equal(row.sn, 'ZA-001'); assert.equal(row.sensor_delay, 20); assert.equal(row.sensor_type, 1); assert.equal(row.retry_alarm, 5); assert.equal(row.valid_holidays, 0);
  const d2 = (await api('ac/doors', 'POST', { name: 'Back', device_id: dev, door_no: 2 })).id; row = (await api('ac/doors')).find(d => d.id === d2); assert.equal(row.sensor_delay, 15); assert.equal(row.valid_holidays, 1, 'defaults');
  await assert.rejects(api('ac/doors/params', 'POST', { ids: [], open_sec: 3 }), /at least one door/); await assert.rejects(api('ac/doors/params', 'POST', { ids: [d1], open_sec: 999 }), /lock delay/); await assert.rejects(api('ac/doors/params', 'POST', { ids: [d1] }), /Nothing/);
  const p = await api('ac/doors/params', 'POST', { ids: [d1, d2], open_sec: 9, sensor_type: 2 }); assert.deepEqual([p.doors, p.queued], [2, 2]);
  row = (await api('ac/doors')).find(d => d.id === d2); assert.equal(row.open_sec, 9); assert.equal(row.sensor_type, 2);
  let cmds = (await api('ac/cmds')); assert.ok(cmds.some(c => /SET OPTION Door2Drivertime=9/.test(c.content) && /SensorType=2/.test(c.content)), 'set parameter queues the device option'); assert.equal(cmds[0].sn, 'ZA-001');
  await api('ac/doors/cancel-alarm', 'POST', { ids: [d1] }); cmds = await api('ac/cmds'); assert.ok(cmds.some(c => c.content === 'CONTROL DEVICE 02 00 00 00'));

  // ---- device commands of access devices only
  const other = (await api('devices', 'POST', { name: 'Plain clock', sn: 'ZA-002' })).id; const { queueCommand } = { queueCommand: async () => {} }; void queueCommand;
  await api(`devices/${other}/reboot`, 'POST'); assert.ok(!(await api('ac/cmds')).some(c => c.sn === 'ZA-002'), 'a device without doors is not listed');
  await assert.rejects(api('ac/cmds', 'POST', { device_id: other, cmd: 'REBOOT' }), /has a door/); await assert.rejects(api('ac/cmds', 'POST', { device_id: dev, cmd: '' }), /command/);
  const cid = (await api('ac/cmds', 'POST', { device_id: dev, cmd: 'CHECK' })).id; assert.ok((await api('ac/cmds')).some(c => c.id === cid)); await api('ac/cmds/' + cid, 'DELETE'); assert.ok(!(await api('ac/cmds')).some(c => c.id === cid));
  await assert.rejects(api('ac/cmds/clear', 'POST', { status: 'weird' }), /Unknown status`?/);
  await sim.poll(); const cl = await api('ac/cmds/clear', 'POST', { status: 'sent' }); assert.ok(cl.deleted >= 0);
  const cl2 = await api('ac/cmds/clear', 'POST', { status: 'all' }); assert.equal((await api('ac/cmds')).length, 0); assert.ok(cl2.deleted >= 0);
  assert.equal((await api('devices')).length, 2, 'clearing commands keeps the devices');

  // ---- time periods: number + remark
  const always = (await api('ac/timezones'))[0]; assert.equal(always.timezone_no, always.id);
  const rules = (a, b) => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, [[a, b]]]));
  await assert.rejects(api('ac/timezones', 'POST', { name: 'bad', timezone_no: 0, rules: rules('08:00', '17:00') }), /1 to 255/); await assert.rejects(api('ac/timezones', 'POST', { name: 'bad', timezone_no: always.timezone_no, rules: rules('08:00', '17:00') }), /already used/);
  const office = (await api('ac/timezones', 'POST', { name: 'Office', timezone_no: 7, remark: 'day', rules: rules('08:00', '17:00') })).id, nightId = (await api('ac/timezones', 'POST', { name: 'Night', rules: rules('20:00', '23:00') })).id;
  const tzs = await api('ac/timezones'); assert.equal(tzs.find(t => t.id === office).timezone_no, 7); assert.equal(tzs.find(t => t.id === office).remark, 'day'); assert.equal(tzs.find(t => t.id === nightId).timezone_no, nightId);
  await api('ac/timezones/' + office, 'PUT', { name: 'Office', timezone_no: 8, rules: rules('08:00', '17:00') }); assert.equal((await api('ac/timezones')).find(t => t.id === office).timezone_no, 8);

  // ---- groups: three time periods, verification mode, holidays
  await assert.rejects(api('ac/levels', 'POST', { name: 'G', timezone_id: office, verify_mode: 99 }), /verification/); await assert.rejects(api('ac/levels', 'POST', { name: 'G', timezone_id: office, timezone2_id: 9999 }), /Unknown time zone/);
  const g1 = (await api('ac/levels', 'POST', { name: 'Day staff', group_no: 3, timezone_id: office, timezone2_id: nightId, verify_mode: 6, include_holiday: 0, door_ids: [d1, d2] })).id;
  const g2 = (await api('ac/levels', 'POST', { name: 'Guards', timezone_id: always.id, include_holiday: 1, door_ids: [d1] })).id;
  await assert.rejects(api('ac/levels', 'POST', { name: 'Dup no', group_no: 3, timezone_id: office }), /already used/);
  let lv = (await api('ac/levels')).find(l => l.id === g1); assert.equal(lv.group_no, 3); assert.equal(lv.verify_mode, 6); assert.equal(lv.timezone2, 'Night'); assert.equal(lv.include_holiday, 0);
  assert.equal((await api('ac/levels')).find(l => l.id === g2).group_no, g2, 'group number defaults to the id');

  // ---- privileges
  assert.equal((await api('ac/privileges', 'POST', { level_id: g1, employee_ids: [A.id, B.id] })).added, 2); await assert.rejects(api('ac/privileges', 'POST', { level_id: g1, employee_ids: [A.id] }), /already in/);
  await assert.rejects(api('ac/privileges', 'POST', { level_id: g1, employee_ids: [C.id], tz_mode: 1 }), /Time Period 1/); await assert.rejects(api('ac/privileges', 'POST', { level_id: g1, employee_ids: [C.id], verify_mode: 40 }), /verification/);
  await api('ac/privileges', 'POST', { level_id: g2, employee_ids: [C.id], tz_mode: 1, tz1: nightId, verify_mode: 3 });
  let pv = await api('ac/privileges'); assert.equal(pv.length, 3); const pa = pv.find(r => r.employee_id === A.id); assert.equal(pa.first_name, 'Ayesha'); assert.equal(pa.last_name, 'Khan'); assert.equal(pa.level, 'Day staff'); assert.equal(pa.tz_mode, 0); assert.equal(pa.time1, 'Office'); assert.equal(pa.time2, 'Night');
  const pc = pv.find(r => r.employee_id === C.id); assert.equal(pc.tz_mode, 1); assert.equal(pc.time1, 'Night'); assert.equal(pc.verify_mode, 3);
  assert.equal((await api('ac/privileges?q=' + encodeURIComponent('Bilal'))).length, 1);
  // access decisions use the extra time periods, personal periods and holidays
  const noon = stamp(0, '12:00'), late = stamp(0, '21:00'), early = stamp(0, '03:00');
  const chk = (e, door, at) => api(`ac/check?employee_id=${e.id}&door_id=${door}&at=${encodeURIComponent(at)}`);
  assert.equal((await chk(A, d1, noon)).allowed, true, 'time period 1'); assert.equal((await chk(A, d1, late)).allowed, true, 'time period 2 of the group'); assert.equal((await chk(A, d1, early)).allowed, false);
  assert.equal((await chk(C, d1, late)).allowed, true, 'personal time period'); assert.equal((await chk(C, d1, noon)).allowed, false, 'personal period replaces the group 24 hours');
  // adjust: move B to the guards group with a personal period
  const rowB = pv.find(r => r.employee_id === B.id).id; const adj = await api('ac/privileges/adjust', 'POST', { ids: [rowB], level_id: g2, tz_mode: 1, tz1: office, verify_mode: -1 }); assert.equal(adj.updated, 1);
  pv = await api('ac/privileges'); assert.equal(pv.find(r => r.employee_id === B.id).level, 'Guards'); assert.equal(pv.find(r => r.employee_id === B.id).time1, 'Office'); await assert.rejects(api('ac/privileges/adjust', 'POST', { ids: [] }), /at least one/);
  await api('ac/privileges/adjust', 'POST', { ids: [rowB], level_id: g1, tz_mode: 0 }); assert.equal((await api('ac/privileges')).find(r => r.employee_id === B.id).level, 'Day staff');

  // ---- holidays
  await assert.rejects(api('ac/holidays', 'POST', { name: '', start_date: stamp().slice(0, 10), duration: 1, timezone_id: office }), /name/); await assert.rejects(api('ac/holidays', 'POST', { name: 'H', start_date: '2026-13-45', duration: 1, timezone_id: office }), /Start date/);
  await assert.rejects(api('ac/holidays', 'POST', { name: 'H', start_date: stamp().slice(0, 10), duration: 0, timezone_id: office }), /Duration/); await assert.rejects(api('ac/holidays', 'POST', { name: 'H', start_date: stamp().slice(0, 10), duration: 1, timezone_id: 9999 }), /time period/);
  const today = stamp().slice(0, 10), hol = (await api('ac/holidays', 'POST', { name: 'Founders day', start_date: today, duration: 2, timezone_id: office })).id;
  const hr = (await api('ac/holidays')).find(h => h.id === hol); assert.equal(hr.timezone, 'Office'); assert.equal(hr.end_date, new Date(Date.now() + 86400000).toLocaleDateString('sv'));
  // Day staff do not include holidays: shut out; Guards include them but only inside the holiday period; door 2 ignores holidays? (valid_holidays default 1 there too) door1 has valid_holidays=0
  const r1 = await chk(A, d2, noon); assert.equal(r1.allowed, false); assert.match(r1.reason, /Holiday "Founders day"/);
  assert.equal((await chk(A, d1, noon)).allowed, true, 'a door that does not honour holidays ignores them');
  await api('ac/levels/' + g1, 'PUT', { name: 'Day staff', timezone_id: office, include_holiday: 1, door_ids: [d1, d2] }); const r2 = await chk(A, d2, noon); assert.equal(r2.allowed, true); assert.match(r2.reason, /holiday/);
  assert.equal((await chk(A, d2, late)).allowed, false, 'outside the holiday time period');
  await api('ac/holidays/' + hol, 'PUT', { name: 'Founders day', start_date: new Date(Date.now() + 5 * 86400000).toLocaleDateString('sv'), duration: 1, timezone_id: office }); assert.equal((await chk(A, d2, late)).allowed, true, 'holiday moved away');
  await api('ac/holidays/' + hol, 'DELETE'); assert.equal((await api('ac/holidays')).length, 0);

  // ---- combinations
  await assert.rejects(api('ac/combos', 'POST', { combo_no: 1, name: 'x', g1: g1 }), /at least two/); await assert.rejects(api('ac/combos', 'POST', { combo_no: 1, name: 'x', g1: g1, g3: g2 }), /without gaps/); await assert.rejects(api('ac/combos', 'POST', { combo_no: 100, name: 'x', g1: g1, g2: g2 }), /1 to 99/);
  const cb = (await api('ac/combos', 'POST', { combo_no: 1, name: 'Vault', g1: g1, g2: g2, remark: 'two people' })).id; await assert.rejects(api('ac/combos', 'POST', { combo_no: 1, name: 'again', g1: g1, g2: g2 }), /already used/);
  assert.deepEqual((await api('ac/combos'))[0].groups, ['Day staff', 'Guards', '', '', '']);
  const ok1 = await api('ac/combos/check', 'POST', { combo_id: cb, employee_ids: [A.id, C.id] }); assert.equal(ok1.ok, true, 'one from each group'); assert.equal((await api('ac/combos/check', 'POST', { combo_id: cb, codes: [codes[A.id], codes[B.id]] })).ok, false, 'both from the same group');
  assert.equal((await api('ac/combos/check', 'POST', { combo_id: cb, employee_ids: [A.id] })).ok, false, 'too few people'); assert.equal((await api('ac/combos/check', 'POST', { combo_id: cb, employee_ids: [A.id, A.id, C.id] })).ok, true, 'a person is counted once');
  // ---- sync sends holidays + combinations
  await api('ac/holidays', 'POST', { name: 'New year', start_date: '2027-01-01', duration: 2, timezone_id: office });
  await sim.poll(); await api('ac/sync', 'POST', { device_id: dev }); const cm = (await api(`devices/${dev}/commands`)).map(c => c.cmd);
  assert.equal(cm.filter(c => /^DATA UPDATE holiday /.test(c)).length, 2, 'one holiday entry per day'); assert.ok(cm.some(c => /multimcard Index=1\s+Group1=3\s+Group2=\d+/.test(c)), 'combination uses group numbers');
  assert.ok(cm.some(c => /DATA UPDATE timezone TimezoneId=8\s/.test(c)), 'device time period id is the Time Period No.');

  // ---- clone to areas and transfer
  const br = (await api('branches', 'POST', { name: 'North' })).id;
  await assert.rejects(api('ac/clone', 'POST', { kind: 'bad', ids: [1] }), /Unknown kind/); await assert.rejects(api('ac/clone', 'POST', { kind: 'timezones', ids: [] }), /at least one row/);
  const before = (await api(`devices/${dev}/commands`)).length; const cl3 = await api('ac/clone', 'POST', { kind: 'timezones', ids: [office, nightId], area_ids: [br] });
  assert.equal(cl3.devices, 1); assert.equal(cl3.commands, 2); assert.equal((await api(`devices/${dev}/commands`)).length, before + 2);
  const cl4 = await api('ac/clone', 'POST', { kind: 'combos', ids: [cb], area_ids: [br] }); assert.ok(cl4.commands >= 1);
  await assert.rejects(api('ac/levels/' + g1 + '/transfer', 'POST', { to_level_id: g1 }), /different group/); await assert.rejects(api('ac/levels/' + g1 + '/transfer', 'POST', { to_level_id: 9999 }), /Choose the group/);
  const tr = await api('ac/levels/' + g1 + '/transfer', 'POST', { to_level_id: g2, employee_ids: [A.id] }); assert.deepEqual([tr.transferred, tr.added, tr.moved], [1, 1, true]);
  assert.ok(!(await api(`ac/levels/${g1}/people`)).some(p => p.id === A.id)); assert.ok((await api(`ac/levels/${g2}/people`)).some(p => p.id === A.id));
  const cp = await api('ac/levels/' + g2 + '/transfer', 'POST', { to_level_id: g1, copy: true }); assert.ok(cp.transferred >= 2); assert.ok((await api(`ac/levels/${g2}/people`)).length >= 2, 'copy keeps people');
  await api('ac/privileges/' + (await api('ac/privileges')).find(r => r.employee_id === A.id && r.level === 'Guards').id, 'DELETE');

  // ---- permissions: a viewer reads, cannot change
  await api('users', 'POST', { username: 'viewer1', password: 'viewer-pass', role: 'viewer' }); const vt = await S.login('viewer1', 'viewer-pass');
  assert.equal((await S.raw('ac/privileges', 'GET', undefined, vt)).status, 200); assert.equal((await S.raw('ac/holidays', 'POST', { name: 'x', start_date: today, duration: 1, timezone_id: office }, vt)).status, 403);
  assert.equal((await S.raw('ac/doors/params', 'POST', { ids: [d1], open_sec: 3 }, vt)).status, 403); assert.equal((await S.raw('ac/cmds/clear', 'POST', {}, vt)).status, 403);
  console.log('e2e-zk-access passed: door parameters, access device commands, time period numbers, groups with 3 periods, privileges, holidays in decisions, combinations, device sync, clone to areas, transfer, permissions');
} catch (e) { console.error('E2E-ZK-ACCESS FAILED:', e.stack?.split('\n').slice(0, 4).join('\n') ?? e); process.exitCode = 1; } finally { S.stop(); }
