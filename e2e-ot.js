// Overtime approvals and attendance correction requests through the API.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const logs = (lines) => api('logs/import', 'POST', { csv: lines.join('\n') });
try {
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const pol = (await api('ot_policies', 'POST', { name: 'Needs approval', post: 1, pre: 0, weekend: 1, holiday: 1, min_minutes: 30, round_minutes: 15, mult_work: 1.5, mult_weekend: 2, mult_holiday: 2, daily_max: 0, monthly_max: 0, approval: 1 })).id;
  const mk = async (name, extra = {}) => { const r = await api('employees', 'POST', { name, shift_id: shift, join_date: '2026-07-01', salary: 23000, ...extra }); return { id: r.id, code: r.code }; };
  const A = await mk('Approver case', { ot_policy_id: pol }), B = await mk('Auto case');
  await assert.rejects(api('employees', 'POST', { name: 'X', ot_policy_id: 999 }), /Unknown/);

  // Mon 6 Jul and Tue 7 Jul 2026
  await logs([`${A.code},2026-07-06 09:00`, `${A.code},2026-07-06 19:00`, `${A.code},2026-07-07 09:00`, `${A.code},2026-07-07 19:30`,
              `${B.code},2026-07-06 09:00`, `${B.code},2026-07-06 19:00`]);
  const range = 'from=2026-07-01&to=2026-07-31';
  const reqs = await api('overtime/requests?' + range);
  assert.equal(reqs.length, 2, 'only the employee whose policy needs approval gets requests');
  assert.ok(reqs.every(r => r.status === 'pending' && r.employee === 'Approver case'));
  const d6 = reqs.find(r => r.date === '2026-07-06'), d7 = reqs.find(r => r.date === '2026-07-07');
  assert.equal(d6.calc_minutes, 60); assert.equal(d7.calc_minutes, 90);
  assert.equal((await api('dashboard')).pending_overtime, 2);

  const daily = async (emp) => (await api(`report/daily?${range}&employee_id=${emp.id}`));
  assert.equal((await daily(A)).find(r => r.date === '2026-07-06').ot_approved_min, 0, 'not payable before approval');
  assert.equal((await daily(B)).find(r => r.date === '2026-07-06').ot_approved_min, 60, 'no approval needed for the default policy');

  await assert.rejects(api(`overtime/${d6.id}/approve`, 'POST', { minutes: 90 }), /between 1 and 60/);
  await api(`overtime/${d6.id}/approve`, 'POST', { minutes: 45 });                  // approve less than calculated
  await assert.rejects(api(`overtime/${d6.id}/approve`, 'POST', {}), /Only pending/);
  await api(`overtime/${d7.id}/reject`, 'POST', { note: 'Not authorised' });
  const A6 = (await daily(A)).find(r => r.date === '2026-07-06'), A7 = (await daily(A)).find(r => r.date === '2026-07-07');
  assert.equal(A6.ot_approved_min, 45); assert.equal(A6.ot_status, 'approved'); assert.equal(A7.ot_approved_min, 0); assert.equal(A7.ot_status, 'rejected');
  assert.equal((await api('dashboard')).pending_overtime, 0);

  // payroll pays approved minutes only: 45 min x (1000/9) x 1.5
  const pay = (await api('report/payroll?month=2026-07')).rows.find(r => r.code === A.code);
  assert.equal(pay.overtime_hours, 0.75); assert.equal(pay.overtime_pay, 125);

  // bulk approve and bulk errors
  await logs([`${A.code},2026-07-08 09:00`, `${A.code},2026-07-08 18:45`, `${A.code},2026-07-09 09:00`, `${A.code},2026-07-09 18:45`]);
  const more = (await api('overtime/requests?status=pending&' + range)).map(r => r.id);
  assert.equal(more.length, 2);
  const bulk = await api('overtime/bulk', 'POST', { ids: [...more, d6.id], action: 'approve' });
  assert.equal(bulk.done, 2); assert.equal(bulk.errors.length, 1);
  await assert.rejects(api('overtime/bulk', 'POST', { ids: [], action: 'approve' }), /required/);

  // manual overtime (weekend) is payable at the weekend multiplier and can be removed
  await api('overtime/manual', 'POST', { employee_id: B.id, date: '2026-07-11', minutes: 120, note: 'Inventory count' });
  const sat = (await daily(B)).find(r => r.date === '2026-07-11'); assert.equal(sat.ot_manual_min, 120); assert.equal(sat.ot_mult, 2);
  await assert.rejects(api('overtime/manual', 'POST', { employee_id: B.id, date: '2026-07-11', minutes: 0 }), /Minutes/);
  const manualId = (await api('overtime/requests?kind=manual&' + range))[0].id;
  const rep = await api('report/overtime?' + range);
  const repB = rep.employees.find(e => e.code === B.code); assert.equal(repB.manual_min, 120); assert.equal(repB.approved_min, 180);
  assert.equal(rep.months[0].month, '2026-07'); assert.ok(rep.departments.length >= 1);
  await api('overtime/' + manualId, 'DELETE');
  await assert.rejects(api('overtime/' + d6.id, 'DELETE'), /manual/);
  await assert.rejects(api('ot_policies/' + pol, 'DELETE'), /Assigned/);

  // ---- attendance requests: missed punch-out, on duty
  await logs([`${B.code},2026-07-13 09:00`]);                                          // Monday, no punch-out
  const ex = await api('report/exceptions?' + range);
  assert.ok(ex.rows.some(r => r.code === B.code && r.date === '2026-07-13' && r.status === 'Missing Out'));
  assert.ok(ex.counts['Absent'] > 0);
  assert.ok((await api('report/exceptions?kind=Missing%20Out&' + range)).rows.every(r => r.status === 'Missing Out'));
  await assert.rejects(api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-13', kind: 'add_punch', time: '25:00', reason: 'x' }), /HH:MM/);
  await assert.rejects(api('attendance/requests', 'POST', { employee_id: B.id, date: '2999-01-01', kind: 'add_punch', time: '18:00', reason: 'x' }), /future/);
  await assert.rejects(api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-13', kind: 'add_punch', time: '18:00' }), /reason/);
  const rq = await api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-13', kind: 'add_punch', time: '18:02', reason: 'Forgot to scan' });
  assert.equal(rq.status, 'pending');
  await assert.rejects(api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-13', kind: 'add_punch', time: '18:02', reason: 'again' }), /already waiting/);
  assert.equal((await api('dashboard')).pending_requests, 1);
  const stillMissing = (await daily(B)).find(r => r.date === '2026-07-13'); assert.equal(stillMissing.status, 'Missing Out', 'a pending request changes nothing');
  await api(`attendance/requests/${rq.id}/approve`, 'POST', {});
  const fixed = (await daily(B)).find(r => r.date === '2026-07-13'); assert.equal(fixed.status, 'Present'); assert.equal(fixed.out, '18:02');
  assert.equal((await api('logs?date=2026-07-13')).find(l => l.emp_code === B.code && l.ts.endsWith('18:02:00')).source, 'manual');
  await assert.rejects(api(`attendance/requests/${rq.id}/approve`, 'POST', {}), /Only pending/);

  // on duty / work from home
  assert.equal((await daily(B)).find(r => r.date === '2026-07-14').status, 'Absent');
  await assert.rejects(api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-14', kind: 'on_duty', status_text: 'Vacation', reason: 'x' }), /Status must be/);
  const od = await api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-14', kind: 'on_duty', status_text: 'Work From Home', reason: 'Internet repair visit' });
  const rj = await api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-15', kind: 'on_duty', status_text: 'On Duty', reason: 'Client' });
  await api(`attendance/requests/${rj.id}/reject`, 'POST', { note: 'No proof' });
  await api(`attendance/requests/${od.id}/approve`, 'POST', {});
  assert.equal((await daily(B)).find(r => r.date === '2026-07-14').status, 'Work From Home');
  assert.equal((await daily(B)).find(r => r.date === '2026-07-15').status, 'Absent', 'a rejected request changes nothing');
  const sumB = (await api('report/summary?' + range)).find(s => s.code === B.code); assert.ok(sumB.present >= 3);
  const ovr = await api('attendance/overrides'); assert.equal(ovr.length, 1);
  await api('attendance/overrides/' + ovr[0].id, 'DELETE');
  assert.equal((await daily(B)).find(r => r.date === '2026-07-14').status, 'Absent');
  assert.deepEqual((await api('attendance/requests?status=rejected')).map(r => r.decision_note), ['No proof']);
  const direct = await api('attendance/requests', 'POST', { employee_id: B.id, date: '2026-07-16', kind: 'on_duty', status_text: 'On Duty', auto_approve: true });
  assert.equal(direct.status, 'approved');

  // read-only users can look but not decide
  await api('users', 'POST', { username: 'boss', password: 'viewonly1', role: 'viewer' });
  const vt = await S.login('boss', 'viewonly1');
  assert.equal((await S.raw('overtime/requests?' + range, 'GET', undefined, vt)).status, 200);
  assert.equal((await S.raw(`overtime/${d6.id}/approve`, 'POST', {}, vt)).status, 403);
  assert.equal((await S.raw('attendance/requests', 'POST', {}, vt)).status, 403);
  console.log('e2e-ot passed: overtime policy, approval, limits, manual entry, requests, on-duty, exceptions');
} catch (e) { console.error('E2E-OT FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); }
