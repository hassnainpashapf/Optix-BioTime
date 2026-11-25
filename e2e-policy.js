// Attendance policies: rules by department / group / branch / employee, and their effect on the report and payroll.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const iso = (d) => d.toISOString().slice(0, 10);
try {
  let day = new Date(Date.now() - 3 * 864e5); while (day.getDay() === 0) day = new Date(+day - 864e5); const D = iso(day), month = D.slice(0, 7);
  await api('shifts', 'POST', { name: 'Office', code: 'O', start: '09:00', end: '17:00', grace_min: 5, workdays: '1,2,3,4,5,6' });
  const sh = (await api('shifts')).at(-1).id;
  const sales = (await api('departments', 'POST', { name: 'Sales' })).id, vip = (await api('emp_groups', 'POST', { name: 'VIP' })).id;
  const mk = (name, extra = {}) => api('employees', 'POST', { name, join_date: '2026-01-01', shift_id: sh, salary: 30000, ...extra });
  const plain = await mk('Plain'), s1 = await mk('Sales One', { department_id: sales }), s2 = await mk('Sales Two', { department_id: sales }), s3 = await mk('Sales Three', { department_id: sales }), v1 = await mk('Vip One', { department_id: sales, group_id: vip });
  const code = async (r) => (await api('employees')).find(e => e.id === r.id).code;
  const [cp, c1, c2, c3, cv] = await Promise.all([plain, s1, s2, s3, v1].map(code));
  const L = [`${cp},${D} 09:12`, `${cp},${D} 17:00`, `${c1},${D} 09:12`, `${c1},${D} 17:00`, `${c2},${D} 09:45`, `${c2},${D} 17:00`, `${c3},${D} 09:00`, `${cv},${D} 09:45`, `${cv},${D} 17:00`];
  await api('logs/import', 'POST', { csv: L.join('\n') });
  const status = async () => Object.fromEntries((await api(`report/daily?from=${D}&to=${D}`)).map(r => [r.code, r]));
  let r = await status(); assert.equal(r[cp].status, 'Late'); assert.equal(r[c1].status, 'Late'); assert.equal(r[c3].status, 'Missing Out');

  // ---- a policy for the Sales department
  await assert.rejects(api('att_policies', 'POST', { name: '' }), /Name/); await assert.rejects(api('att_policies', 'POST', { name: 'x', half_day_min: -1 }), /0 to 1440/);
  await assert.rejects(api('att_policies', 'POST', { name: 'x', missing_out_as: 'Present' }), /Missing Out, Half Day or Absent/);
  const pol = (await api('att_policies', 'POST', { name: 'Sales rules', grace_extra_min: 10, late_to_absent_min: 30, missing_out_as: 'Half Day', lates_per_deduction: 2 })).id;
  await assert.rejects(api('att_policies', 'POST', { name: 'Sales rules' }), /exists/);
  await api('att_policies/assign', 'POST', { type: 'department', target_id: sales, policy_id: pol });
  r = await status();
  assert.equal(r[cp].status, 'Late', 'people outside the department keep the global rules');
  assert.equal(r[c1].status, 'Present', '12 min is inside 5 + 10 grace'); assert.equal(r[c1].late_min, 0);
  assert.equal(r[c2].status, 'Absent'); assert.equal(r[c2].note, 'Too late');
  assert.equal(r[c3].status, 'Half Day'); assert.equal(r[c3].note, 'No punch-out');
  const why = await api('att_policies/for/' + s1.id); assert.equal(why.via, 'the department'); assert.equal(why.policy.name, 'Sales rules');

  // ---- a group policy beats the department; an employee policy beats the group
  const strict = (await api('att_policies', 'POST', { name: 'Strict', grace_extra_min: 0, late_to_absent_min: 60, missing_out_as: 'Absent' })).id;
  await api('att_policies/assign', 'POST', { type: 'group', target_id: vip, policy_id: strict });
  r = await status(); assert.equal(r[cv].status, 'Late', 'group policy: no extra grace, 45 min is not over 60'); assert.equal((await api('att_policies/for/' + v1.id)).via, 'the group');
  await api('att_policies/assign', 'POST', { type: 'employee', target_id: s1.id, policy_id: strict });
  r = await status(); assert.equal(r[c1].status, 'Late'); assert.equal((await api('att_policies/for/' + s1.id)).via, 'the employee');
  await api('att_policies/assign', 'POST', { type: 'employee', target_id: s1.id, policy_id: null }); assert.equal((await status())[c1].status, 'Present', 'removing it goes back to the department');

  // ---- payroll: lates per deduction comes from the policy (2 lates = 1 day for Sales)
  let d2 = new Date(+day - 864e5); while (d2.getDay() === 0) d2 = new Date(+d2 - 864e5); const D2 = iso(d2); assert.equal(D2.slice(0, 7), month, 'test dates are in one month');
  const s4 = await mk('Sales Four', { department_id: sales }), c4 = await code(s4);
  await api('logs/import', 'POST', { csv: [`${c4},${D} 09:20`, `${c4},${D} 17:00`, `${c4},${D2} 09:20`, `${c4},${D2} 17:00`].join('\n') });
  const row = (await api('report/payroll?month=' + month)).rows.find(x => x.code === c4);
  assert.equal(row.late, 2); assert.equal(row.deduction_days, row.absent + 0.5 * row.half_day + row.unpaid_leave + 1, '2 lates cost 1 day because the Sales policy says so (global setting is off)');
  const shown = (await api('att_policies')).find(p => p.id === pol); assert.deepEqual(shown.assigned.map(a => a.name), ['Sales']);
  // deleting a policy detaches it everywhere
  await api('att_policies/' + pol, 'DELETE'); assert.equal((await status())[c1].status, 'Late'); assert.equal((await api('att_policies/for/' + s1.id)).policy, null);
  // only users with settings access can touch policies
  await api('users', 'POST', { username: 'viewer1', password: 'password1', role: 'viewer' });
  const vr = await S.raw('att_policies', 'POST', { name: 'nope' }, await S.login('viewer1', 'password1')); assert.equal(vr.status, 403);
  console.log('e2e-policy passed: policies by department/group/employee, precedence, grace/absent/half-day/missing-out rules, payroll, permissions');
} catch (e) { console.error('E2E-POLICY FAILED:', (e.stack || '').split('\n').filter(l => /e2e-policy.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
