// Organization: departments with codes and superiors, the tree, quantities, import, personnel transfer, positions and areas.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
try {
  // ---- departments
  const hq = (await api('org/departments', 'POST', { code: '1', name: 'Head office' })).id, ops = (await api('org/departments', 'POST', { code: '10', name: 'Operations', parent_id: hq })).id, hr = (await api('org/departments', 'POST', { code: '11', name: 'HR', parent_id: hq })).id;
  await assert.rejects(api('org/departments', 'POST', { code: '10', name: 'Dup code' }), /already used/); await assert.rejects(api('org/departments', 'POST', { name: '' }), /Name required/); await assert.rejects(api('org/departments', 'POST', { name: 'Ops' + 'x', parent_id: 999 }), /Unknown superior/);
  await assert.rejects(api('org/departments/' + hq, 'PUT', { parent_id: ops }), /cannot sit under itself/); await assert.rejects(api('org/departments/' + hq, 'PUT', { parent_id: hq }), /cannot sit under itself/);
  const mk = (name, department_id, extra = {}) => api('employees', 'POST', { name, department_id, join_date: '2025-01-01', ...extra });
  const A = await mk('Ayesha', ops), B = await mk('Bilal', ops), C = await mk('Chand', hr), D = await mk('Dania', ops); await api('employees/' + D.id, 'PUT', { active: false });
  let rows = await api('org/departments'); const r = Object.fromEntries(rows.map(x => [x.name, x]));
  assert.equal(r.Operations.employees, 2); assert.equal(r.Operations.resigned, 1); assert.equal(r.Operations.superior, 'Head office'); assert.equal(r.HR.employees, 1); assert.equal(r['Head office'].employees, 0);
  const tree = await api('org/tree'); assert.equal(tree.length, 1); assert.equal(tree[0].name, 'Head office'); assert.equal(tree[0].children.length, 2); assert.equal(tree[0].total, 3, 'a department counts everyone below it');
  await api('org/departments/' + ops, 'PUT', { name: 'Operations team' }); assert.equal((await api('org/departments')).find(x => x.id === ops).name, 'Operations team');
  // import: codes, names, superior by code or by name, later parents allowed
  const im = await api('org/departments/import', 'POST', { csv: 'code,name,superior\n20,Finance,1\n21,Payroll,Finance\n22,Audit,99\n,,\n20,Finance again,\n23,Legal,' }); assert.equal(im.added, 4); assert.equal(im.skipped, 1); assert.equal(im.errors.length, 1);
  rows = await api('org/departments'); assert.equal(rows.find(x => x.name === 'Payroll').superior, 'Finance'); assert.equal(rows.find(x => x.name === 'Finance').superior, 'Head office'); assert.equal(rows.find(x => x.name === 'Audit').superior, null, 'an unknown superior is reported, the department is still created');
  // delete rules
  await assert.rejects(api('org/departments/' + ops, 'DELETE'), /still has 3 employees/); await assert.rejects(api('org/departments/' + hq, 'DELETE'), /sub-departments/);
  const fin = rows.find(x => x.name === 'Finance').id; await assert.rejects(api('org/departments/' + fin, 'DELETE'), /sub-departments/); await api('org/departments/' + rows.find(x => x.name === 'Legal').id, 'DELETE');
  // ---- personnel transfer
  const legal2 = (await api('org/departments', 'POST', { code: '30', name: 'Support' })).id;
  await assert.rejects(api('org/transfer', 'POST', { to_department_id: 999 }), /Choose the department to move people into/); await assert.rejects(api('org/transfer', 'POST', { to_department_id: legal2 }), /move people out of/);
  const t1 = await api('org/transfer', 'POST', { employee_ids: [A.id], to_department_id: legal2, note: 'new desk' }); assert.equal(t1.moved, 1); assert.equal((await api('employees/' + A.id)).dept, 'Support');
  const hist = (await api(`employees/${A.id}/history`)).find(h => h.kind === 'transfer'); assert.equal(JSON.parse(hist.detail).department.to, 'Support'); assert.equal(JSON.parse(hist.detail).note, 'new desk');
  const t2 = await api('org/transfer', 'POST', { from_department_id: ops, to_department_id: legal2 }); assert.equal(t2.moved, 1, 'everybody active in the source moves (Bilal; Dania has resigned)'); assert.equal((await api('org/transfer', 'POST', { from_department_id: ops, to_department_id: legal2 })).moved, 0);
  assert.equal((await api('org/departments')).find(x => x.id === legal2).employees, 2);
  await api('employees/' + D.id, 'DELETE').catch(() => {}); // the resigned person is the only one left in Operations
  // ---- positions and areas
  const p1 = (await api('org/positions', 'POST', { code: 'M1', name: 'Manager' })).id; await api('org/positions', 'POST', { code: 'D1', name: 'Developer' });
  await assert.rejects(api('org/positions', 'POST', { code: 'M1', name: 'Other' }), /already used/); await api('employees/' + C.id, 'PUT', { designation_id: p1 });
  const pos = await api('org/positions'); assert.equal(pos.find(x => x.id === p1).employees, 1); await assert.rejects(api('org/positions/' + p1, 'DELETE'), /still used by 1 employee/);
  // position tree and transfer by position
  const pd = (await api('org/positions')).find(x => x.code === 'D1').id; await api('org/positions/' + pd, 'PUT', { parent_id: p1 });
  assert.equal((await api('org/positions')).find(x => x.id === pd).superior, 'Manager'); await assert.rejects(api('org/positions/' + p1, 'PUT', { parent_id: pd }), /own sub-position/);
  const ptree = await api('org/positions-tree'); assert.equal(ptree.find(n => n.id === p1).children[0].id, pd);
  assert.equal((await api('org/transfer-position', 'POST', { from_position_id: p1, to_position_id: pd })).moved, 1); assert.equal((await api('org/positions')).find(x => x.id === pd).employees >= 1, true);
  await assert.rejects(api('org/transfer-position', 'POST', { to_position_id: pd }), /Choose the position to move people out of/); await api('employees/' + C.id, 'PUT', { designation_id: p1 });
  const pim = await api('org/positions/import', 'POST', { csv: 'code,name\nQ1,Analyst\nM1,Manager\n,' }); assert.equal(pim.added, 1); assert.equal(pim.skipped, 1); assert.equal(pim.errors.length, 0);
  const co = (await api('companies', 'POST', { name: 'Acme' })).id, a1 = (await api('org/areas', 'POST', { code: 'LHE', name: 'Lahore HQ', company_id: co, address: 'Gulberg' })).id;
  await api('device_groups', 'POST', { name: 'Lahore devices', branch_id: a1 }); await api('employees/' + B.id, 'PUT', { branch_id: a1 });
  const ar = (await api('org/areas')).find(x => x.id === a1); assert.equal(ar.company, 'Acme'); assert.equal(ar.employees, 1); assert.equal(ar.device_groups, 1); assert.equal(ar.address, 'Gulberg');
  await assert.rejects(api('org/areas/' + a1, 'DELETE'), /still used by 1 employee/); await api('employees/' + B.id, 'PUT', { branch_id: null }); await assert.rejects(api('org/areas/' + a1, 'DELETE'), /device groups/);
  await api('org/areas/' + a1, 'PUT', { name: 'Lahore main office' }); assert.equal((await api('org/areas')).find(x => x.id === a1).name, 'Lahore main office');
  // permissions: needs the organization module
  await api('users', 'POST', { username: 'viewer5', password: 'password1', role: 'viewer' }); const vt = await S.login('viewer5', 'password1');
  assert.equal((await S.raw('org/departments', 'GET', undefined, vt)).status, 200); assert.equal((await S.raw('org/departments', 'POST', { name: 'x' }, vt)).status, 403); assert.equal((await S.raw('org/transfer', 'POST', { to_department_id: hq, from_department_id: ops }, vt)).status, 403);
  console.log('e2e-org passed: departments (code, superior tree, quantities), import, personnel transfer with history, positions, areas, permissions');
} catch (e) { console.error('E2E-ORG FAILED:', (e.stack || '').split('\n').filter(l => /e2e-org.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
