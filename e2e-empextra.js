// The rest of the Employee form (private info, device access, attendance toggles, app, payroll) is saved, validated and used.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const e = await api('employees', 'POST', { name: 'Sara', join_date: '2026-01-01' });
  const put = (b) => api(`zkp/employees/${e.id}/extra`, 'PUT', b);
  await put({ last_name: 'Khan', local_name: 'سارہ', office_tel: '021', mobile: '0300', city: 'Karachi', postcode: '75500', workflow_role: '', verify_mode: 4, device_priv: 6, pin: '1234', enable_att: 1, enable_ot: 0, enable_comp: 1, app_role: 'Manager', pay_period: 'Weekly', pay_type: 'Bank Transfer', agent_id: 'A1', agent_account: 'AC9' });
  const x = await api(`zkp/employees/${e.id}/extra`);
  assert.equal(x.last_name, 'Khan'); assert.equal(x.mobile, '0300'); assert.equal(x.verify_mode, 4); assert.equal(x.device_priv, 6); assert.equal(x.enable_ot, 0); assert.equal(x.enable_comp, 1); assert.equal(x.pay_period, 'Weekly'); assert.equal(x.app_role, 'Manager'); assert.equal(x.pin, ''); assert.equal(x.has_pin, true, 'the PIN is never sent back');
  assert.equal((await api(`zkp/employees/${(await api('employees', 'POST', { name: 'New', join_date: '2026-01-01' })).id}/extra`)).enable_att, 1, 'new people default to attendance on');
  await assert.rejects(put({ device_priv: 5 }), /Device Privilege/); await assert.rejects(put({ pin: 'abc' }), /PIN/); await assert.rejects(put({ verify_mode: 99 }), /verify mode/);
  await assert.rejects(put({ app_status: 1 }), /Self-Password/); await assert.rejects(put({ self_password: 'short' }), /8 characters/);
  await put({ self_password: 'longenough1', app_status: 1 }); assert.equal((await api(`zkp/employees/${e.id}/extra`)).app_status, 1);
  const code = (await api('employees')).find(r => r.id === e.id).code;
  const login = await fetch(`${S.base}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: 'longenough1' }) }); assert.equal(login.status, 200, 'the Self-Password opens the employee portal');
  await put({ app_status: 0 }); assert.equal((await fetch(`${S.base}/api/portal/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, password: 'longenough1' }) })).status, 401, 'APP Status Disable closes it');
  { const row = (await api('zkp/employees')).find(r => r.id === e.id); assert.ok(/^\d{4}-\d\d-\d\d \d\d:/.test(row.update_time), 'Update Time is filled: ' + row.update_time); assert.equal(row.last_name, 'Khan'); }
  // the Attendance Settings switches change the calculation
  const day = '2026-03-04', q = (r) => r.find(x => x.code === code);
  const db = new DatabaseSync(join(S.dir, 'e2e.db')); db.prepare('INSERT INTO holidays(date, name) VALUES(?,?)').run(day, 'Test holiday'); db.close();
  const rep = async () => (await api(`report/daily?from=${day}&to=${day}`));
  assert.equal(q(await rep()).status, 'Holiday', 'a holiday is a holiday by default');
  await put({ enable_holiday: 0 }); assert.notEqual(q(await rep()).status, 'Holiday', 'Enable Holiday = No: the holiday does not apply');
  await put({ enable_holiday: 1, enable_att: 0 }); assert.ok(!q(await rep()), 'Enable Attendance = No: left out of attendance');
  await put({ enable_att: 1 }); assert.ok(q(await rep()), 'and back in');
  { // Company on Department, Position and Group
    const co = (await api('companies', 'POST', { name: 'Acme Ltd' })).id;
    const dep = (await api('org/departments', 'POST', { name: 'Ops' })).id, pos = (await api('org/positions', 'POST', { name: 'Lead' })).id, grp = (await api('att/groups', 'POST', { code: 'G1', name: 'Day crew' })).id;
    for (const [t, id] of [['departments', dep], ['designations', pos], ['emp_groups', grp]]) { await api(`zkp/org/company/${t}/${id}`, 'PUT', { company_id: co }); assert.equal((await api(`zkp/org/company/${t}`)).find(r => r.id === id).company_id, co, t); }
    await assert.rejects(api(`zkp/org/company/departments/${dep}`, 'PUT', { company_id: 9999 }), /Unknown company/); await assert.rejects(api(`zkp/org/company/employees/1`, 'PUT', { company_id: co }), /Unknown list/);
  }
  { // enrolment from the employee screen
    const pushD = (await api('devices', 'POST', { name: 'Gate push', sn: 'ENR-1', approved: 1 })).id;
    const r1 = await api(`devices/${pushD}/enroll`, 'POST', { code, fid: 5 }); assert.equal(r1.mode, 'push');
    const cmds = await api(`devices/${pushD}/commands`); assert.ok(!cmds.some(c => /Passwd=1234/.test(c.cmd)), 'the device PIN is not shown in the command list');
    assert.ok(cmds.some(c => /ENROLL_FP PIN=\d+\s+FID=5/.test(c.cmd)), 'the enrolment command is queued: ' + JSON.stringify(cmds.map(c => c.cmd)));
    await assert.rejects(api(`devices/${pushD}/enroll`, 'POST', { code: 'nobody-here' }), /employee that exists/);
    const pullD = (await api('devices', 'POST', { name: 'Gate pull', ip: '127.0.0.1', port: 9 })).id;
    await assert.rejects(api(`devices/${pullD}/enroll`, 'POST', { code, fid: 0 }), /Could not start enrolment/);
  }
  console.log('e2e-empextra passed: employee form extras saved, validated, Self-Password and APP Status drive the portal');
} finally { S.stop(); }
