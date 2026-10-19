// Leave workflow through the API: apply, approve/reject/cancel, balances, calendar, report, policy, notifications, permissions.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const Y = new Date().getFullYear();
const mondayOnOrAfter = (iso) => { const d = new Date(iso + 'T00:00:00Z'); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; };
const iso = (d, plus = 0) => new Date(d.getTime() + plus * 86400000).toISOString().slice(0, 10);
const mon = mondayOnOrAfter(`${Y}-02-02`);            // a Monday in February of the current year
try {
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const mk = async (name, gender) => (await api('employees', 'POST', { name, gender, shift_id: shift, join_date: `${Y - 1}-01-01` }));
  const f = await mk('Fatima', 'female'), m = await mk('Murtaza', 'male');

  // gender-restricted types, validation
  await assert.rejects(api('leaves', 'POST', { employee_id: m.id ? (await api('employees')).find(e => e.code === m.code).id : 0, type: 'Maternity', from_date: iso(mon), to_date: iso(mon, 1) }), /only for female/);
  const fid = (await api('employees')).find(e => e.code === f.code).id, mid = (await api('employees')).find(e => e.code === m.code).id;
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Paternity', from_date: iso(mon), to_date: iso(mon) }), /only for male/);
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: iso(mon, 1), to_date: iso(mon) }), /before/);
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Nope', from_date: iso(mon), to_date: iso(mon) }), /Unknown leave type/);
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: iso(mon, 5), to_date: iso(mon, 6) }), /No working days/);
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: iso(mon), to_date: iso(mon, 1), half: true }), /half day/i);

  // apply -> pending -> approve; balance moves
  const bal = async (id, type) => (await api(`leave/balances?employee_id=${id}&year=${Y}`)).balances.find(b => b.type === type);
  assert.equal((await bal(fid, 'Casual')).available, 10);
  const a = await api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: iso(mon), to_date: iso(mon, 1), note: 'Family event' });
  assert.equal(a.status, 'pending'); assert.equal(a.days, 2);
  assert.equal((await bal(fid, 'Casual')).pending, 2); assert.equal((await bal(fid, 'Casual')).available, 8);
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Sick', from_date: iso(mon, 1), to_date: iso(mon, 2) }), /already has leave/);
  let n = await api('notifications'); assert.ok(n.unread >= 1); assert.match(n.items[0].title, /Fatima/);
  await api('leaves/' + a.id + '/approve', 'POST', {});
  assert.equal((await bal(fid, 'Casual')).used, 2); assert.equal((await bal(fid, 'Casual')).pending, 0);
  await assert.rejects(api('leaves/' + a.id + '/approve', 'POST', {}), /Only pending/);

  // insufficient balance, reject, cancel
  const wk = iso(mon, 7);                                // following Monday
  await assert.rejects(api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: wk, to_date: iso(mon, 28) }), /Not enough Casual leave/);
  const r = await api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: wk, to_date: wk });
  await api('leaves/' + r.id + '/reject', 'POST', { note: 'Busy week' });
  assert.equal((await bal(fid, 'Casual')).available, 8, 'rejected leave gives the day back');
  const r2 = await api('leaves', 'POST', { employee_id: fid, type: 'Casual', from_date: wk, to_date: wk, half: true, auto_approve: true });
  assert.equal(r2.status, 'approved'); assert.equal(r2.days, 0.5);
  assert.equal((await bal(fid, 'Casual')).used, 2.5);
  await api('leaves/' + r2.id + '/cancel', 'POST', {});
  assert.equal((await bal(fid, 'Casual')).used, 2, 'cancelling an approved leave restores it');
  assert.deepEqual((await api('leaves?status=rejected')).map(l => l.decision_note), ['Busy week']);
  await assert.rejects(api('leaves/' + r.id + '/cancel', 'POST', {}), /Only pending or approved/);

  // unpaid leave is not tracked, so it never runs out
  assert.equal((await bal(fid, 'Unpaid')).tracked, false);
  await api('leaves', 'POST', { employee_id: mid, type: 'Unpaid', from_date: iso(mon, 14), to_date: iso(mon, 25), auto_approve: true });
  await api('leaves', 'POST', { employee_id: mid, type: 'Paternity', from_date: iso(mon, 35), to_date: iso(mon, 36), auto_approve: true });

  // attendance report: approved leave excuses the day, pending does not
  const rep = await api(`report/daily?from=${iso(mon)}&to=${iso(mon, 1)}&employee_id=${fid}`);
  assert.deepEqual(rep.map(x => x.status), ['Leave', 'Leave']);
  const p = await api('leaves', 'POST', { employee_id: mid, type: 'Casual', from_date: iso(mon, 2), to_date: iso(mon, 2) });
  assert.equal((await api(`report/daily?from=${iso(mon, 2)}&to=${iso(mon, 2)}&employee_id=${mid}`))[0].status, 'Absent', 'pending leave is not an excuse yet');
  await api('leaves/' + p.id + '/approve', 'POST', {});

  // calendar + department report
  const cal = await api('leaves/calendar?month=' + iso(mon).slice(0, 7));
  assert.equal(cal.days[iso(mon)][0].employee, 'Fatima');
  const lr = await api(`report/leave?from=${Y}-01-01&to=${Y}-12-31`);
  const fat = lr.employees.find(e => e.name === 'Fatima'); assert.equal(fat.total, 2); assert.equal(fat.types.Casual, 2);
  assert.ok(lr.departments.length >= 1);

  // policy override and assignment
  const pol = (await api('leave_policies', 'POST', { name: 'Senior staff' })).id;
  const casual = (await api('leave_types')).find(t => t.name === 'Casual').id;
  await api('leave/policy-items', 'POST', { policy_id: pol, type_id: casual, quota: 20, accrual: 'yearly', carry_max: 0 });
  await api('employees/' + fid, 'PUT', { leave_policy_id: pol });
  assert.equal((await bal(fid, 'Casual')).quota, 20); assert.equal((await bal(fid, 'Casual')).available, 18);
  assert.equal((await api('leave/policy-items?policy_id=' + pol)).length, 1);
  await assert.rejects(api('leave/policy-items', 'POST', { policy_id: pol, type_id: casual, quota: -1 }), /valid/);
  await assert.rejects(api('employees/' + fid, 'PUT', { leave_policy_id: 999 }), /Unknown/);

  // leave type with history cannot be deleted; types are editable
  await assert.rejects(api('leave_types/' + casual, 'DELETE'), /use this type/);
  const lt = (await api('leave_types', 'POST', { name: 'Study', paid: 1, quota: 5, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 })).id;
  await api('leave_types/' + lt, 'PUT', { quota: 6 }); await api('leave_types/' + lt, 'DELETE');

  // notifications: staff can read and dismiss them even with a read-only login
  await api('users', 'POST', { username: 'boss', password: 'viewonly1', role: 'viewer' });
  const vt = await S.login('boss', 'viewonly1');
  assert.equal((await S.raw('leaves', 'GET', undefined, vt)).status, 200);
  assert.equal((await S.raw('leaves', 'POST', { employee_id: fid }, vt)).status, 403);
  assert.equal((await S.raw('leaves/1/approve', 'POST', {}, vt)).status, 403);
  assert.equal((await S.raw('notifications/read', 'POST', {}, vt)).status, 200);
  assert.equal((await api('notifications')).unread, 0);
  console.log('e2e-leave passed: types, balances, accrual, workflow, calendar, report, policy, notifications');
} catch (e) { console.error('E2E-LEAVE FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); }
