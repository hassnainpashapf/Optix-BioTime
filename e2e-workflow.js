// Approval workflows: several approvers in turn, skipped steps, manager step in the portal, roles, admin, rejection, automation override.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const P = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const as = (token) => async (path, method = 'GET', body) => { const r = await S.raw(path, method, body, token); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
try {
  await api('leave_types', 'POST', { name: 'Errand', paid: 1, quota: 0, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 });
  const mk = (name, extra = {}) => api('employees', 'POST', { name, join_date: '2025-01-01', ...extra });
  const M = await mk('Manager Mona'), R = await mk('Report One'), N = await mk('No Manager'); await api('employees/' + R.id, 'PUT', { manager_id: M.id });
  const codeOf = async (r) => (await api('employees')).find(e => e.id === r.id).code, cM = await codeOf(M), cR = await codeOf(R);
  const acc = Object.fromEntries((await api('portal-accounts', 'POST', { all: true })).accounts.map(a => [a.code, a.password]));
  const login = async (c) => { const l = await P('login', 'POST', { code: c, password: acc[c] }); await P('password', 'POST', { current: acc[c], password: 'new-password-' + c }, l.body.token); return (await P('login', 'POST', { code: c, password: 'new-password-' + c })).body.token; };
  const tM = await login(cM), tR = await login(cR);
  await api('users', 'POST', { username: 'hrperson', password: 'password1', role: 'hr' }); await api('users', 'POST', { username: 'mgrperson', password: 'password1', role: 'manager' });
  await api('roles', 'POST', { name: 'clerk', perms: { employees: 'view', attendance: 'edit', leave: 'edit', overtime: 'edit', shifts: 'edit' } }); await api('users', 'POST', { username: 'clerk1', password: 'password1', role: 'clerk' });
  const hr = as(await S.login('hrperson', 'password1')), mg = as(await S.login('mgrperson', 'password1')), clerk = as(await S.login('clerk1', 'password1'));

  // ---- configuring
  const wf = (kind, b) => api('workflow/' + kind, 'PUT', b);
  await assert.rejects(wf('nope', { steps: [] }), /Unknown request type/); await assert.rejects(wf('leave', { enabled: true, steps: [] }), /at least one step/);
  await assert.rejects(wf('leave', { steps: [{ who: 'role:ghost' }] }), /Unknown approver/); await assert.rejects(wf('leave', { steps: [{ who: 'user:ghost' }] }), /Unknown approver/);
  await assert.rejects(wf('leave', { steps: Array(7).fill({ who: 'admin' }) }), /0 to 6 steps/); await assert.rejects(wf('leave', { steps: [{ who: 'manager', min_days: 0 }] }), /0.5 to 365/);
  await wf('leave', { enabled: true, steps: [{ who: 'manager' }, { who: 'role:hr' }, { who: 'admin', min_days: 3, label: 'the director' }] });
  const cfg = await api('workflow'); assert.equal(cfg.kinds.find(k => k.kind === 'leave').steps.length, 3); assert.ok(cfg.roles.includes('hr'));

  // ---- a one-day leave: the director step does not apply
  const leave = (emp, n, len = 1) => { while (len === 1 && new Date(day(n) + 'T00:00:00Z').getUTCDay() === 0) n++; return leaveOn(emp, n, len); };
  const leaveOn = (emp, n, len) => api('leaves', 'POST', { employee_id: emp.id, type: 'Errand', from_date: day(n), to_date: day(n + len - 1) });
  const l1 = await leave(R, 5); let inbox = await hr('workflow/inbox'); let it = inbox.body.find(x => x.id === l1.id); assert.equal(it.of, 2); assert.equal(it.step, 1); assert.equal(it.waiting_for, 'the manager'); assert.equal(it.mine, false);
  assert.ok((await P('team/pending', 'GET', undefined, tM)).body.leaves.some(l => l.id === l1.id), 'the manager sees it');
  assert.equal((await hr(`leaves/${l1.id}/approve`, 'POST', {})).status, 400, 'HR cannot jump the manager'); assert.match((await hr(`leaves/${l1.id}/approve`, 'POST', {})).body.error, /waiting for the manager \(step 1 of 2\)/);
  const a1 = await P(`team/leave/${l1.id}/approve`, 'POST', { note: 'fine by me' }, tM); assert.equal(a1.status, 200); assert.equal(a1.body.advanced, true); assert.equal(a1.body.step, 2); assert.equal(a1.body.waiting_for, 'the hr role');
  assert.equal((await api('leaves')).find(l => l.id === l1.id).status, 'pending', 'one step is not the end');
  assert.ok(!(await P('team/pending', 'GET', undefined, tM)).body.leaves.some(l => l.id === l1.id), 'it left the manager\'s list');
  assert.ok((await P('notifications', 'GET', undefined, tR)).body.items.some(i => /passed step 1 of 2/.test(i.title)), 'the employee is told'); assert.ok((await api('notifications')).items.some(i => /Waiting for the hr role/.test(i.title)), 'the next approver is told');
  assert.match((await mg(`leaves/${l1.id}/approve`, 'POST', {})).body.error, /waiting for the hr role/, 'a manager login cannot take the HR step');
  inbox = await hr('workflow/inbox'); assert.equal(inbox.body.find(x => x.id === l1.id).mine, true); assert.equal(inbox.body.find(x => x.id === l1.id).history[0].by, 'emp:' + cM);
  const a2 = await hr(`leaves/${l1.id}/approve`, 'POST', {}); assert.equal(a2.status, 200); assert.equal(a2.body.advanced, undefined); const done = (await api('leaves')).find(l => l.id === l1.id); assert.equal(done.status, 'approved'); assert.equal(done.decided_by, 'hrperson');
  assert.ok(!(await hr('workflow/inbox')).body.some(x => x.id === l1.id), 'finished requests leave the inbox');

  // ---- a three-day leave needs all three steps; the admin can take any step but each is a step
  const l3 = await leave(R, 20, 4); assert.equal((await hr('workflow/inbox')).body.find(x => x.id === l3.id).of, 3);
  let r = await api(`leaves/${l3.id}/approve`, 'POST', {}); assert.equal(r.advanced, true); assert.equal(r.step, 2); r = await api(`leaves/${l3.id}/approve`, 'POST', {}); assert.equal(r.advanced, true); assert.equal(r.waiting_for, 'the director');
  await api(`leaves/${l3.id}/approve`, 'POST', {}); assert.equal((await api('leaves')).find(l => l.id === l3.id).status, 'approved');
  // a person with no manager: that step is skipped
  const ln = await leave(N, 30); assert.equal((await hr('workflow/inbox')).body.find(x => x.id === ln.id).waiting_for, 'the hr role'); assert.equal((await hr('workflow/inbox')).body.find(x => x.id === ln.id).of, 1);
  // rejecting at any step ends it
  const lr = await leave(R, 40); const rej = await P(`team/leave/${lr.id}/reject`, 'POST', { note: 'no' }, tM); assert.equal(rej.status, 200); assert.equal((await api('leaves')).find(l => l.id === lr.id).status, 'rejected'); assert.ok(!(await hr('workflow/inbox')).body.some(x => x.id === lr.id));
  // employees cancel their own requests whatever the workflow says
  const lc = await leave(R, 50); assert.equal((await P(`leaves/${lc.id}/cancel`, 'POST', {}, tR)).status, 200);

  // ---- attendance requests with one HR step, and a workflow switched off again
  await wf('attendance', { enabled: true, steps: [{ who: 'role:hr', label: 'HR' }] });
  const a = await api('attendance/requests', 'POST', { employee_id: R.id, date: day(-2), kind: 'add_punch', time: '09:00', reason: 'forgot' });
  assert.match((await clerk(`attendance/requests/${a.id}/approve`, 'POST', {})).body.error, /waiting for HR \(step 1 of 1\)/); assert.equal((await hr(`attendance/requests/${a.id}/approve`, 'POST', {})).status, 200); assert.equal((await api('attendance/requests?status=approved')).some(x => x.id === a.id), true);
  const a2b = await api('attendance/requests', 'POST', { employee_id: R.id, date: day(-3), kind: 'add_punch', time: '09:00', reason: 'forgot' }); await wf('attendance', { enabled: false, steps: [{ who: 'role:hr' }] });
  assert.equal((await clerk(`attendance/requests/${a2b.id}/approve`, 'POST', {})).status, 200, 'with the workflow off, the usual rules apply');

  // ---- an automation rule is an explicit override
  const l4 = await leave(R, 60); await sleep(300); // pending, workflow on
  await api('automations', 'POST', { name: 'Approve errands', trigger: 'leave.requested', config: { leave_type: 'Errand', max_days: 1 }, actions: [{ type: 'approve' }] });
  const l5 = await leave(R, 70); await sleep(700); assert.equal((await api('leaves')).find(l => l.id === l5.id).status, 'approved', 'automation completes the request despite the steps'); assert.equal((await api('leaves')).find(l => l.id === l4.id).status, 'pending');
  // permissions: only settings access edits workflows
  assert.equal((await mg('workflow/leave', 'PUT', { enabled: false, steps: [] })).status, 403); assert.equal((await mg('workflow/inbox')).status, 200);
  console.log('e2e-workflow passed: multi-step approval (manager, role, admin), skipped steps, portal manager step, rejection, cancel, automation override, permissions');
} catch (e) { console.error('E2E-WORKFLOW FAILED:', (e.stack || '').split('\n').filter(l => /e2e-workflow.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
