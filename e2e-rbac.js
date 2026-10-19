// Roles, module permissions and department / branch scope.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const as = (token) => ({
  get: async (p) => { const r = await S.raw(p, 'GET', undefined, token); return { status: r.status, body: await r.json().catch(() => ({})) }; },
  send: async (p, m, b) => { const r = await S.raw(p, m, b, token); return { status: r.status, body: await r.json().catch(() => ({})) }; },
});
try {
  const eng = (await api('departments', 'POST', { name: 'Engineering' })).id, sales = (await api('departments', 'POST', { name: 'Sales' })).id;
  const hq = (await api('branches', 'POST', { name: 'HQ' })).id, khi = (await api('branches', 'POST', { name: 'Karachi' })).id;
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const mk = async (name, department_id, branch_id) => { const r = await api('employees', 'POST', { name, department_id, branch_id, shift_id: shift, join_date: '2026-07-01' }); return r; };
  const e1 = await mk('Eng One', eng, hq), e2 = await mk('Eng Two', eng, khi), s1 = await mk('Sales One', sales, hq);
  await api('logs/import', 'POST', { csv: [e1, e2, s1].map(e => `${e.code},2026-07-06 09:00\n${e.code},2026-07-06 18:00`).join('\n') });
  await api('leaves', 'POST', { employee_id: s1.id, type: 'Casual', from_date: '2026-07-08', to_date: '2026-07-08' });   // pending request in Sales

  // roles
  const roles = await api('roles'); assert.deepEqual(roles.map(r => r.name).sort(), ['admin', 'hr', 'manager', 'viewer']);
  assert.equal(roles.find(r => r.name === 'manager').perms.leave, 'edit'); assert.equal(roles.find(r => r.name === 'viewer').perms.payroll, 'none');
  await assert.rejects(api('roles', 'POST', { name: 'bad name!', perms: {} }), /Role name/);
  await assert.rejects(api('roles', 'POST', { name: 'x1', perms: { leave: 'god' } }), /none, view or edit/);
  await assert.rejects(api('roles/admin', 'PUT', { perms: { leave: 'none' } }), /cannot be changed/);
  await assert.rejects(api('roles/admin', 'DELETE'), /cannot be deleted/);
  await api('roles', 'POST', { name: 'nobody', perms: {} });
  await api('roles', 'POST', { name: 'reporter', perms: { attendance: 'view' } });
  assert.equal((await api('roles')).find(r => r.name === 'reporter').perms.leave, 'none', 'unlisted modules default to none');

  // users with scope
  const mkUser = (username, role, extra = {}) => api('users', 'POST', { username, password: 'password1', role, ...extra });
  await mkUser('mgr', 'manager', { departments: [eng] });            // approves leave/overtime, sees only Engineering
  await mkUser('hrlimited', 'hr', { departments: [eng] });
  await mkUser('hrfull', 'hr');
  await mkUser('branchuser', 'viewer', { branches: [khi] });
  await mkUser('nobody', 'nobody'); await mkUser('rep', 'reporter');
  await assert.rejects(mkUser('ghost', 'doesnotexist'), /existing role/);
  assert.deepEqual((await api('users')).find(u => u.username === 'mgr').departments, [eng]);
  await assert.rejects(api('roles/manager', 'DELETE'), /still have this role/);
  const T = async (u) => as(await S.login(u, 'password1'));
  const mgr = await T('mgr'), hrl = await T('hrlimited'), hrf = await T('hrfull'), br = await T('branchuser'), nob = await T('nobody'), rep = await T('rep');

  // scope: the manager sees only Engineering
  assert.deepEqual((await mgr.get('employees')).body.map(e => e.name).sort(), ['Eng One', 'Eng Two']);
  assert.equal((await mgr.get('employees/' + s1.id)).status, 403);
  assert.equal((await mgr.get('employees/' + e1.id)).status, 200);
  const from = 'from=2026-07-06&to=2026-07-06';
  assert.deepEqual((await mgr.get('report/daily?' + from)).body.map(r => r.name).sort(), ['Eng One', 'Eng Two']);
  assert.equal((await mgr.get('report/summary?' + from)).body.length, 2);
  assert.equal((await mgr.get('logs?date=2026-07-06')).body.length, 4, 'punch log is limited to the scope');
  assert.equal((await mgr.get('leaves')).body.length, 0, 'the pending Sales leave is invisible');
  assert.equal((await mgr.get('employees/next-code')).status, 200);
  assert.equal((await mgr.get('dashboard')).body.employees, 2);
  assert.equal((await mgr.get('dashboard')).body.pending_leaves, 0);
  assert.equal((await api('dashboard')).pending_leaves, 1);
  assert.equal((await mgr.get('notifications')).body.items.some(n => /Sales One/.test(n.title)), false, 'notices about out-of-scope people are hidden');
  assert.equal((await api('notifications')).items.some(n => /Sales One/.test(n.title)), true);

  // manager acts inside the scope, not outside
  const ok = await mgr.send('leaves', 'POST', { employee_id: e1.id, type: 'Casual', from_date: '2026-07-14', to_date: '2026-07-14' });
  assert.equal(ok.status, 200); assert.equal((await mgr.send(`leaves/${ok.body.id}/approve`, 'POST', {})).status, 200);
  assert.equal((await mgr.send('leaves', 'POST', { employee_id: s1.id, type: 'Casual', from_date: '2026-07-14', to_date: '2026-07-14' })).status, 403);
  const salesLeave = (await api('leaves?status=pending'))[0];
  assert.equal((await mgr.send(`leaves/${salesLeave.id}/approve`, 'POST', {})).status, 403, 'cannot approve someone outside the scope');
  assert.equal((await mgr.send('employees', 'POST', { name: 'X', department_id: eng })).status, 403, 'view-only on employees');
  assert.equal((await mgr.get('payroll/items?month=2026-07')).status, 403);
  assert.equal((await mgr.get('report/payroll?month=2026-07')).status, 403);
  assert.equal((await mgr.get('settings')).status, 403);
  assert.equal((await mgr.get('devices')).status, 403);

  // hr limited to Engineering: may edit people there, never company-wide settings or other departments
  assert.equal((await hrl.send('employees', 'POST', { name: 'New Eng', department_id: eng })).status, 200);
  assert.equal((await hrl.send('employees', 'POST', { name: 'New Sales', department_id: sales })).status, 403);
  assert.equal((await hrl.send('employees', 'POST', { name: 'No dept' })).status, 403);
  assert.equal((await hrl.send(`employees/${s1.id}`, 'PUT', { phone: '1' })).status, 403);
  assert.equal((await hrl.send(`employees/${e1.id}`, 'PUT', { phone: '1' })).status, 200);
  assert.equal((await hrl.send('holidays', 'POST', { date: '2026-08-14', name: 'x' })).status, 403, 'company-wide settings need an unscoped login');
  assert.equal((await hrl.send('shifts', 'POST', { name: 'N', start: '10:00', end: '19:00' })).status, 403);
  assert.equal((await hrl.send('logs/import', 'POST', { csv: '1,2026-07-06 09:00' })).status, 403);
  assert.equal((await hrl.send('payroll/finalize', 'POST', { month: '2026-07', force: true })).status, 403);
  assert.equal((await hrl.get('report/payroll?month=2026-07')).body.rows.every(r => r.name.startsWith('Eng') || r.name === 'New Eng'), true);
  // unscoped hr may do those
  assert.equal((await hrf.send('holidays', 'POST', { date: '2026-08-14', name: 'Independence Day' })).status, 200);
  assert.equal((await hrf.get('employees')).body.length, 4);

  // admin-only areas stay closed to every other role, even "edit everything"
  for (const p of ['users', 'audit', 'roles', 'backup']) assert.equal((await hrf.get(p)).status, 403, p);

  // branch scope
  assert.deepEqual((await br.get('employees')).body.map(e => e.name), ['Eng Two']);
  assert.equal((await br.send('employees', 'POST', { name: 'q' })).status, 403);

  // custom roles
  assert.equal((await nob.get('employees')).status, 403); assert.equal((await nob.get('report/daily?' + from)).status, 403);
  assert.equal((await nob.get('dashboard')).body.employees, 0, 'no attendance access: dashboard shows nothing');
  assert.equal((await nob.get('me')).body.perms.attendance, 'none');
  assert.equal((await rep.get('report/daily?' + from)).status, 200); assert.equal((await rep.get('leaves')).status, 403);

  // role edits apply on the very next request, no new login needed
  await api('roles/manager', 'PUT', { perms: { attendance: 'none' } });
  assert.equal((await mgr.get('report/daily?' + from)).status, 403);
  await api('roles/manager', 'PUT', { perms: { attendance: 'view' } });
  assert.equal((await mgr.get('report/daily?' + from)).status, 200);
  // scope edits too
  const mgrId = (await api('users')).find(u => u.username === 'mgr').id;
  await api('users/' + mgrId, 'PUT', { departments: [] });                       // empty = whole company
  assert.equal((await mgr.get('employees')).body.length >= 4, true);
  await api('users/' + mgrId, 'PUT', { departments: [sales] });
  assert.deepEqual((await mgr.get('employees')).body.map(e => e.name), ['Sales One']);
  // roles can be deleted once nobody uses them
  const nobId = (await api('users')).find(u => u.username === 'nobody').id; await api('users/' + nobId, 'DELETE');
  await api('roles/nobody', 'DELETE');
  assert.equal((await api('roles')).some(r => r.name === 'nobody'), false);
  console.log('e2e-rbac passed: roles, module permissions, department/branch scope, live role changes');
} catch (e) { console.error('E2E-RBAC FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); }
