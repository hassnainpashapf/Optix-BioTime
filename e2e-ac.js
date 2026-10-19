// Access control: doors, time zones, access levels, who may pass, door events, sync commands, remote open.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stamp = (m = 0) => new Date(Date.now() + m * 60000).toLocaleString('sv');
try {
  const dev = (await api('devices', 'POST', { name: 'Server room', sn: 'AC-001' })).id; const sim = new SimDevice(S.base, 'AC-001'); await sim.poll();
  const mk = (name) => api('employees', 'POST', { name, join_date: '2025-01-01' }); const A = await mk('Ayesha'), B = await mk('Bilal'), C = await mk('Chand');
  const code = async (r) => (await api('employees')).find(e => e.id === r.id).code, [cA, cB, cC] = await Promise.all([A, B, C].map(code));

  // ---- time zones
  const tz = await api('ac/timezones'); assert.equal(tz.length, 1); assert.equal(tz[0].builtin, 1); await assert.rejects(api('ac/timezones/' + tz[0].id, 'PUT', { name: 'x', rules: tz[0].rules }), /built-in/); await assert.rejects(api('ac/timezones/' + tz[0].id, 'DELETE'), /built-in/);
  const rules = (a, b, days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) => Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => [d, days.includes(d) ? [[a, b]] : []]));
  await assert.rejects(api('ac/timezones', 'POST', { name: 'bad', rules: rules('18:00', '09:00') }), /must end after it starts/); await assert.rejects(api('ac/timezones', 'POST', { name: 'bad', rules: { ...rules('09:00', '18:00'), mon: [['09:00', '12:00'], ['11:00', '13:00']] } }), /overlap/);
  await assert.rejects(api('ac/timezones', 'POST', { name: 'bad', rules: { ...rules('09:00', '18:00'), mon: [['9', '12']] } }), /HH:MM/);
  const never = (await api('ac/timezones', 'POST', { name: 'Never', rules: rules('00:00', '00:01', []) })).id, always = tz[0].id;
  // ---- doors
  await assert.rejects(api('ac/doors', 'POST', { name: '' }), /Name/); await assert.rejects(api('ac/doors', 'POST', { name: 'x', door_no: 9 }), /1 to 4/); await assert.rejects(api('ac/doors', 'POST', { name: 'x', device_id: 999 }), /Unknown device/);
  const door = (await api('ac/doors', 'POST', { name: 'Server room door', device_id: dev, door_no: 1, location: 'Basement', open_sec: 7 })).id; await assert.rejects(api('ac/doors', 'POST', { name: 'dup', device_id: dev, door_no: 1 }), /already defined/);
  const door2 = (await api('ac/doors', 'POST', { name: 'Back door', device_id: dev, door_no: 2 })).id;
  // ---- levels and people
  const lv = (await api('ac/levels', 'POST', { name: 'IT staff', timezone_id: always, door_ids: [door, door2] })).id; await assert.rejects(api('ac/levels', 'POST', { name: 'IT staff', timezone_id: always }), /exists/); await assert.rejects(api('ac/levels', 'POST', { name: 'x', timezone_id: 999 }), /time zone/);
  assert.equal((await api('ac/levels/' + lv + '/people', 'POST', { employee_ids: [A.id] })).added, 1); assert.equal((await api('ac/levels/' + lv + '/people', 'POST', { employee_ids: [A.id] })).added, 0, 'adding twice changes nothing'); await assert.rejects(api('ac/levels/' + lv + '/people', 'POST', {}), /Choose people/);
  const dep = (await api('departments', 'POST', { name: 'IT' })).id; await api('employees/' + B.id, 'PUT', { department_id: dep }); await api('employees/' + C.id, 'PUT', { department_id: dep });
  assert.equal((await api('ac/levels/' + lv + '/people', 'POST', { department_id: dep })).added, 2, 'everyone in a department'); await api(`ac/levels/${lv}/people/${C.id}`, 'DELETE'); assert.deepEqual((await api(`ac/levels/${lv}/people`)).map(p => p.code), [cA, cB]);
  const l = (await api('ac/levels')).find(x => x.id === lv); assert.equal(l.people, 2); assert.equal(l.doors.length, 2); assert.equal((await api('ac/doors')).find(d => d.id === door).people, 2);
  // ---- who may pass
  let r = await api(`ac/check?code=${cA}&door_id=${door}`); assert.equal(r.allowed, true); assert.match(r.reason, /IT staff/);
  r = await api(`ac/check?code=${cC}&door_id=${door}`); assert.equal(r.allowed, false); assert.match(r.reason, /No access level/);
  const office = (await api('ac/timezones', 'POST', { name: 'Office hours', rules: rules('09:00', '18:00', ['mon', 'tue', 'wed', 'thu', 'fri']) })).id; await api('ac/levels/' + lv, 'PUT', { name: 'IT staff', timezone_id: office, door_ids: [door, door2] });
  const monday = '2026-10-19', saturday = '2026-10-17'; // 2026-10-19 is a Monday
  assert.equal((await api(`ac/check?code=${cA}&door_id=${door}&at=${monday}T10:00`)).allowed, true); assert.equal((await api(`ac/check?code=${cA}&door_id=${door}&at=${monday}T19:30`)).allowed, false); assert.match((await api(`ac/check?code=${cA}&door_id=${door}&at=${saturday}T10:00`)).reason, /Outside the time zone/);
  await assert.rejects(api('ac/timezones/' + office, 'DELETE'), /Access levels still use/); await assert.rejects(api('ac/check?code=nobody&door_id=' + door), /Unknown/);
  // ---- door events from the device
  await api('ac/levels/' + lv, 'PUT', { name: 'IT staff', timezone_id: never, door_ids: [door] }); // nobody may pass: every entry is outside policy
  await sim.uploadPunches([{ pin: cA, ts: stamp(-1) }, { pin: cC, ts: stamp(-2) }]); await sleep(600);
  const ev = await api('ac/events'); assert.equal(ev.length, 2); assert.ok(ev.every(e => e.violation === 1 && e.door === 'Server room door')); assert.ok(ev.some(e => e.employee === 'Ayesha' && /Outside the time zone/.test(e.detail)) && ev.some(e => e.employee === 'Chand' && /No access level/.test(e.detail)));
  assert.equal((await api('ac/events?violation=1&q=Ayesha')).length, 1); assert.equal((await api('ac/events?from=2001-01-01&to=2001-01-02')).length, 0);
  assert.ok((await api('notifications')).items.some(i => /Door entry outside policy: Ayesha/.test(i.title)), 'the admins are told'); await api('alerts/prefs', 'PUT', { kind: 'access', enabled: false }); assert.ok(!(await api('notifications')).items.some(i => /Door entry outside policy/.test(i.title)), 'the alert can be switched off'); await api('alerts/prefs', 'PUT', { kind: 'access', enabled: true });
  await api('ac/levels/' + lv, 'PUT', { name: 'IT staff', timezone_id: always, door_ids: [door, door2] }); await sim.uploadPunches([{ pin: cB, ts: stamp(0) }]); await sleep(500);
  assert.equal((await api('ac/events')).find(e => e.employee === 'Bilal').violation, 0, 'an allowed entry is logged without a flag');
  // ---- send the rules to the device
  const before = (await api(`devices/${dev}/commands`)).length; const sy = await api('ac/sync', 'POST', {}); assert.equal(sy.devices, 1); assert.equal(sy.users, 2); assert.equal(sy.commands, 3);
  const cmds = (await api(`devices/${dev}/commands`)).map(c => c.cmd); assert.equal(cmds.length, before + 3);
  assert.ok(cmds.some(c => /^DATA UPDATE timezone TimezoneId=\d+/.test(c) && /SunTime1=\d+/.test(c)), 'the time zone goes first'); assert.ok(cmds.some(c => c.includes(`DATA UPDATE userauthorize Pin=${cA}`) && c.includes('AuthorizeDoorId=3')), 'doors 1 and 2 = mask 3');
  await api(`ac/levels/${lv}/people/${B.id}`, 'DELETE'); const sy2 = await api('ac/sync', 'POST', {}); assert.equal(sy2.removed, 1); assert.ok((await api(`devices/${dev}/commands`)).some(c => c.cmd === `DATA DELETE userauthorize Pin=${cB}`), 'a person who lost the level is removed from the device');
  await assert.rejects(api('ac/sync', 'POST', { device_id: 9999 }), /No approved push device/);
  // ---- remote open
  const o = await api(`ac/doors/${door}/open`, 'POST', {}); assert.equal(o.seconds, 7); assert.ok((await api(`devices/${dev}/commands`)).some(c => c.cmd === 'CONTROL DEVICE 1 1 1 7')); assert.ok((await api('ac/events')).some(e => e.kind === 'remote_open'));
  await assert.rejects(api(`ac/doors/${door}/open`, 'POST', { seconds: 999 }), /1 to 254/); const nodev = (await api('ac/doors', 'POST', { name: 'No device' })).id; await assert.rejects(api(`ac/doors/${nodev}/open`, 'POST', {}), /approved push device/);
  await api('ac/doors/' + nodev, 'DELETE');
  // ---- permissions: its own module
  await api('users', 'POST', { username: 'viewer6', password: 'password1', role: 'viewer' }); const vt = await S.login('viewer6', 'password1');
  assert.equal((await S.raw('ac/doors', 'GET', undefined, vt)).status, 200); assert.equal((await S.raw('ac/doors', 'POST', { name: 'x' }, vt)).status, 403); assert.equal((await S.raw(`ac/doors/${door}/open`, 'POST', {}, vt)).status, 403);
  console.log('e2e-ac passed: time zones, doors, access levels, who may pass, door events + alerts, sync commands, remote open, permissions');
} catch (e) { console.error('E2E-AC FAILED:', (e.stack || '').split('\n').filter(l => /e2e-ac.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
