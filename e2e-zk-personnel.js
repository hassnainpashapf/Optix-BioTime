// ZKT-style Personnel pages: employee list/actions, bulk transfer, resign, department manager, area superior, restricted role.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
try {
  const d1 = (await api('departments', 'POST', { name: 'Sales' })).id, d2 = (await api('departments', 'POST', { name: 'Ops' })).id;
  const pos = (await api('designations', 'POST', { name: 'Clerk' })).id, pos2 = (await api('designations', 'POST', { name: 'Lead' })).id;
  const a1 = (await api('branches', 'POST', { name: 'Karachi' })).id, a2 = (await api('branches', 'POST', { name: 'Lahore' })).id;
  const mk = (name, extra = {}) => api('employees', 'POST', { name, join_date: '2025-01-01', ...extra });
  const A = await mk('Amna Sales', { department_id: d1, designation_id: pos, branch_id: a1 }), B = await mk('Bilal Ops', { department_id: d2 }), C = await mk('Chand Ops', { department_id: d2 });

  // ---- employee list
  let list = await api('zkp/employees'); assert.equal(list.length, 3);
  const row = list.find(r => r.id === A.id); assert.equal(row.dept, 'Sales'); assert.equal(row.position, 'Clerk'); assert.equal(row.area, 'Karachi'); assert.equal(row.app_status, 'Disable');
  assert.equal((await api('zkp/employees?department_id=' + d2)).length, 2); assert.equal((await api('zkp/employees?q=Amna')).length, 1);
  assert.deepEqual((await api('zkp/employees/extra-options')).emp_types, ['Official', 'Temporary', 'Probation']);
  await api(`zkp/employees/${A.id}/extra`, 'PUT', { nationality: 'Pakistani', emp_type: 'Probation' });
  assert.equal((await api('zkp/employees')).find(r => r.id === A.id).nationality, 'Pakistani');
  assert.deepEqual(await api(`zkp/employees/${A.id}/extra`), { nationality: 'Pakistani', emp_type: 'Probation' });

  // ---- bulk transfer (department / position / area) with history
  await assert.rejects(api('zkp/employees/transfer', 'POST', { kind: 'x', to_id: d1, employee_ids: [B.id] }), /department, position or area/);
  await assert.rejects(api('zkp/employees/transfer', 'POST', { kind: 'department', to_id: d1, employee_ids: [] }), /at least one/);
  await assert.rejects(api('zkp/employees/transfer', 'POST', { kind: 'department', to_id: 9999, employee_ids: [B.id] }), /Choose the department/);
  assert.equal((await api('zkp/employees/transfer', 'POST', { kind: 'department', to_id: d1, employee_ids: [B.id, C.id, A.id], note: 'merge' })).moved, 2, 'A is already there');
  assert.equal((await api('zkp/employees/transfer', 'POST', { kind: 'position', to_id: pos2, employee_ids: [B.id] })).moved, 1);
  assert.equal((await api('zkp/employees/transfer', 'POST', { kind: 'area', to_id: a2, employee_ids: [B.id, C.id] })).moved, 2);
  list = await api('zkp/employees'); const b = list.find(r => r.id === B.id); assert.deepEqual([b.dept, b.position, b.area], ['Sales', 'Lead', 'Lahore']);
  assert.ok((await api(`employees/${B.id}/history`)).some(h => h.kind === 'transfer' && /Lahore/.test(h.detail)));
  assert.equal((await api('zkp/org/transfer-area', 'POST', { from_area_id: a2, to_area_id: a1 })).moved, 2);
  await assert.rejects(api('zkp/org/transfer-area', 'POST', { from_area_id: a1 }), /Choose the area to move people into/);

  // ---- probation, app access, device sync
  await api('zkp/employees/pass-probation', 'POST', { employee_ids: [A.id] }); assert.equal((await api('zkp/employees')).find(r => r.id === A.id).emp_type, 'Official');
  const app = await api('zkp/employees/app', 'POST', { employee_ids: [A.id], enabled: true }); assert.equal(app.skipped, 1, 'no portal account yet');
  await api('portal-accounts', 'POST', { employee_ids: [A.id] }); await api('zkp/employees/app', 'POST', { employee_ids: [A.id], enabled: false });
  assert.equal((await api('zkp/employees')).find(r => r.id === A.id).app_status, 'Disable');
  assert.equal((await api('zkp/employees/app', 'POST', { employee_ids: [A.id], enabled: true })).done, 1); assert.equal((await api('zkp/employees')).find(r => r.id === A.id).app_status, 'Enable');
  const dev = (await api('devices', 'POST', { name: 'Gate', sn: 'ZP-1' })).id;
  assert.equal((await api('zkp/employees/device-sync', 'POST', { employee_ids: [A.id], action: 'resync' })).done, 1);
  assert.ok((await api('device-commands')).some(c => /USERINFO PIN=\d+\s+Name=Amna Sales/.test(c.cmd)));
  await api('zkp/employees/device-sync', 'POST', { employee_ids: [A.id], action: 'delete-bio' });
  assert.ok((await api('device-commands')).some(c => /DATA DELETE FINGERTMP/.test(c.cmd)));
  await assert.rejects(api('zkp/employees/device-sync', 'POST', { employee_ids: [A.id], action: 'zzz' }), /Unknown action/);
  const usb = await (await S.raw('zkp/employees/usb-export')).text(); assert.match(usb, /^PIN,Name,Card/); assert.match(usb, /Amna Sales/);
  assert.deepEqual(await api('zkp/employees/usb-import', 'POST', { csv: 'PIN,Name,Card\n900,Usb User,12345\n' + A.code + ',x,777' }), { added: 1, updated: 1, skipped: 0 });
  assert.equal((await api('zkp/employees')).find(r => r.code === '900').card_no, '12345');
  void dev;

  // ---- resign
  await assert.rejects(api('zkp/resign', 'POST', { employee_ids: [], type: 'Resignation' }), /at least one/);
  await assert.rejects(api('zkp/resign', 'POST', { employee_ids: [C.id], date: 'bad' }), /YYYY-MM-DD/);
  assert.equal((await api('zkp/resign', 'POST', { employee_ids: [C.id], type: 'Termination', date: '2026-03-01', reason: 'Policy breach' })).done, 1);
  await assert.rejects(api('zkp/resign', 'POST', { employee_ids: [C.id] }), /already inactive/);
  let rs = await api('zkp/resign'); assert.equal(rs.length, 1); assert.deepEqual([rs[0].type, rs[0].date, rs[0].reason, rs[0].att_disabled], ['Termination', '2026-03-01', 'Policy breach', 0]);
  assert.equal((await api('employees/' + C.id)).status, 'terminated'); assert.equal((await api('zkp/employees')).some(r => r.id === C.id), false, 'resigned people leave the employee list');
  assert.equal((await api('zkp/employees?status=all')).some(r => r.id === C.id), true);
  // a resignation made through the old employee flow still shows up
  await api(`employees/${B.id}/resign`, 'POST', { date: '2026-04-01', reason: 'Moving abroad' });
  rs = await api('zkp/resign'); const old = rs.find(r => r.id === B.id); assert.deepEqual([old.type, old.reason, old.date], ['Resignation', 'Moving abroad', '2026-04-01']);
  await api('zkp/resign/attendance', 'POST', { employee_ids: [C.id] }); assert.equal((await api('zkp/resign')).find(r => r.id === C.id).att_disabled, 1);
  assert.equal((await api('zkp/resign/import', 'POST', { csv: `employee id,type,date,reason\n${A.code},Retirement,2026-05-01,Retired\n999,Resignation,2026-05-01,none\n` })).added, 1);
  assert.equal((await api('zkp/resign')).find(r => r.id === A.id).type, 'Retirement');
  assert.equal((await api('zkp/resign/reinstate', 'POST', { employee_ids: [A.id, C.id] })).done, 2); assert.equal((await api('employees/' + C.id)).active, 1);
  assert.equal((await api('zkp/resign')).some(r => r.id === C.id), false);
  await api('leave_types', 'POST', { name: 'Errand', paid: 1, quota: 0, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 });
  await assert.rejects(api('zkp/resign/' + A.id, 'DELETE'), /has not resigned/);
  const D = await mk('Dina Gone'); await api('zkp/resign', 'POST', { employee_ids: [D.id] }); await api('zkp/resign/' + D.id, 'DELETE'); await assert.rejects(api('employees/' + D.id), /No such employee/);

  // ---- department manager, area superior and quantities
  await api(`zkp/org/departments/${d1}/manager`, 'PUT', { manager_id: A.id });
  let deps = await api('zkp/org/departments'); assert.equal(deps.find(x => x.id === d1).manager, 'Amna Sales'); assert.equal(deps.find(x => x.id === d2).manager, null);
  await assert.rejects(api(`zkp/org/departments/${d1}/manager`, 'PUT', { manager_id: 99999 }), /Unknown employee/);
  assert.ok(deps.find(x => x.id === d1).employees >= 2); assert.equal(deps.find(x => x.id === d1).resigned, 1, 'B resigned from Sales');
  await api(`zkp/org/areas/${a2}/parent`, 'PUT', { parent_id: a1 });
  let areas = await api('zkp/org/areas'); assert.equal(areas.find(x => x.id === a2).superior, 'Karachi');
  await assert.rejects(api(`zkp/org/areas/${a1}/parent`, 'PUT', { parent_id: a2 }), /under itself/); await assert.rejects(api(`zkp/org/areas/${a1}/parent`, 'PUT', { parent_id: a1 }), /under itself/);
  const g = (await api('device_groups', 'POST', { name: 'KHI devices', branch_id: a1 })).id; await api('devices/' + (await api('devices'))[0].id, 'PUT', { group_id: g });
  assert.equal((await api('zkp/org/areas')).find(x => x.id === a1).devices, 1, 'device qty');
  await api('org/areas/' + a1, 'DELETE').catch(() => {}); // still has employees, refused; the child keeps its superior
  await api('org/areas/' + a2, 'DELETE').catch(() => {});

  // ---- restricted role: view-only users may read but not act
  await api('roles', 'POST', { name: 'orgviewer', perms: { organization: 'view', employees: 'view' } });
  await api('users', 'POST', { username: 'zkview', password: 'password1', role: 'orgviewer' }); const vt = await S.login('zkview', 'password1');
  assert.equal((await (await S.raw('zkp/employees', 'GET', undefined, vt)).json()).length >= 1, true);
  assert.equal((await S.raw('zkp/employees/transfer', 'POST', { kind: 'department', to_id: d1, employee_ids: [B.id] }, vt)).status, 403);
  assert.equal((await S.raw('zkp/resign', 'POST', { employee_ids: [B.id] }, vt)).status, 403);
  assert.equal((await S.raw('zkp/org/areas', 'GET', undefined, vt)).status, 200); assert.equal((await S.raw(`zkp/org/areas/${a1}/parent`, 'PUT', { parent_id: null }, vt)).status, 403);
  await api('roles', 'POST', { name: 'nodev', perms: {} }); await api('users', 'POST', { username: 'zknone', password: 'password1', role: 'nodev' }); const nt = await S.login('zknone', 'password1');
  assert.equal((await S.raw('zkp/employees', 'GET', undefined, nt)).status, 403); assert.equal((await S.raw('zkp/org/departments', 'GET', undefined, nt)).status, 403);
  console.log('e2e-zk-personnel: all passed');
} catch (e) { console.error(e); process.exitCode = 1; } finally { S.stop(); }
