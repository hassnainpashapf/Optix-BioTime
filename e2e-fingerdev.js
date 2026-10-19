// Fingerprint enrolment / removal on devices end to end with the simulated device, and mask + temperature punches (MTD).
import assert from 'node:assert/strict';
import { SimDevice } from './sim-device.js';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const e = await api('employees', 'POST', { name: 'Finger Dev', join_date: '2025-01-01' }), emp = (await api('employees')).find(x => x.id === e.id);
  const d1 = await api('devices', 'POST', { name: 'Gate A', sn: 'FPA-001', approved: 1 }), d2 = await api('devices', 'POST', { name: 'Gate B', sn: 'FPB-001', approved: 1 });
  const A = new SimDevice(S.base, 'FPA-001'), B = new SimDevice(S.base, 'FPB-001'); await A.handshake(); await B.handshake();
  await api('settings', 'PUT', { store_templates: 1 });
  // enrol on Gate A only
  const en = await api('fingerprint/enroll', 'POST', { employee_id: emp.id, fid: 2, device_ids: [d1.id] }); assert.equal(en.started, 1);
  await A.poll(); await B.poll();
  assert.ok(A.users.has(emp.code), 'the employee was created on the chosen device'); assert.ok(!B.users.has(emp.code), 'the other device was not touched');
  assert.deepEqual(A.enrolled && { pin: A.enrolled.pin, fid: A.enrolled.fid }, { pin: emp.code, fid: 2 }, 'the device was told to start enrolment for that finger');
  await A.uploadTemplates();   // the device reports the finger it just captured
  let ov = await api('fingerprint/overview'); let row = ov.rows.find(r => r.src === 'device' && r.code === emp.code); assert.ok(row && row.fid === 2, 'the template shows up in the Fingerprint page');
  // enrol on both devices (one or many)
  const both = await api('fingerprint/enroll', 'POST', { employee_id: emp.id, fid: 2, device_ids: [d1.id, d2.id] }); assert.equal(both.started, 2);
  await A.poll(); await B.poll(); assert.ok(B.users.has(emp.code)); await B.uploadTemplates();
  ov = await api('fingerprint/overview'); assert.equal(ov.rows.filter(r => r.src === 'device' && r.code === emp.code).length >= 1, true);
  // remove from Gate A
  await api('fingerprint/remove', 'POST', { employee_id: emp.id, fid: 2, device_ids: [d1.id] }); await A.poll(); await B.poll();
  assert.ok(!A.templates.some(t => t.pin === emp.code && t.fid === 2), 'the device deleted the finger'); assert.ok(B.templates.some(t => t.pin === emp.code && t.fid === 2), 'the device that was not chosen kept it');
  // mask + temperature punches
  const day = new Date().toLocaleDateString('sv');
  await A.uploadPunches([{ pin: emp.code, ts: `${day} 08:00:00`, mask: 1, temp: 36.6 }, { pin: emp.code, ts: `${day} 08:05:00`, mask: 0, temp: 36.7 }, { pin: emp.code, ts: `${day} 08:10:00`, mask: 1, temp: 38.4 }]);
  await api('settings', 'PUT', { temp_alert_c: 37.5 });
  const r = await api('mtd/records'), at = (t) => r.rows.find(x => x.ts.endsWith(t));
  assert.equal(at('08:00:00').mask, 1); assert.ok(!at('08:00:00').abnormal, 'mask on, normal temperature');
  assert.equal(at('08:05:00').mask, 0); assert.ok(at('08:05:00').abnormal && !at('08:05:00').hot, 'no mask is abnormal');
  assert.ok(at('08:10:00').abnormal && at('08:10:00').hot, 'high temperature is abnormal');
  const sm = await api('mtd/summary'); assert.equal(sm.daily.total, 1); assert.equal(sm.daily.abnormal, 1, 'the person is counted once, by the worst reading of the day'); assert.equal(sm.daily.unchecked + sm.daily.normal + sm.daily.nomask, 0);
  assert.equal(sm.departments.reduce((a, d) => a + d.abnormal, 0), 1); const dayRow = sm.monthly.find(x => x.date === day); assert.equal(dayRow.abnormal, 1); assert.equal(dayRow.nomask, 1); assert.equal(dayRow.max_temp, 38.4);
  console.log('e2e-fingerdev passed: enrol on chosen devices, remove, mask + temperature from device punches');
} finally { S.stop(); }
