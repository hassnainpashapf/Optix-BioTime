// Compensatory time off: overtime of an employee with Enable Compensatory = Yes earns Compensatory Leave days (hours per day and expiry are settings).
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
const logs = (lines) => api('logs/import', 'POST', { csv: lines.join('\n') });
const ymd = (d) => d.toLocaleDateString('sv');
try {
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '17:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const pol = (await api('ot_policies', 'POST', { name: 'Auto', post: 1, pre: 0, weekend: 1, holiday: 1, min_minutes: 30, round_minutes: 15, mult_work: 1.5, mult_weekend: 2, mult_holiday: 2, daily_max: 0, monthly_max: 0, approval: 0 })).id;
  const join = ymd(new Date(Date.now() - 60 * 864e5));
  const mk = async (name) => { const r = await api('employees', 'POST', { name, shift_id: shift, ot_policy_id: pol, join_date: join, salary: 30000 }); return { id: r.id, code: (await api('employees')).find(x => x.id === r.id).code }; };
  const A = await mk('Comp person'), B = await mk('Paid OT person');
  // two recent weekdays, each with 2 hours after the shift
  const days = []; for (let i = 1; days.length < 2 && i < 14; i++) { const d = new Date(Date.now() - i * 864e5); if (d.getDay() >= 1 && d.getDay() <= 5) days.push(ymd(d)); }
  await logs(days.flatMap(d => [`${A.code},${d} 09:00`, `${A.code},${d} 19:00`, `${B.code},${d} 09:00`, `${B.code},${d} 19:00`]));
  const bal = async (e) => (await api(`leave/balances?employee_id=${e.id}`)).balances.find(b => b.type === 'Compensatory Leave');
  assert.equal((await bal(A)).available, 0, 'nothing earned while Enable Compensatory is No');
  await api(`zkp/employees/${A.id}/extra`, 'PUT', { enable_comp: 1 });
  await api('settings', 'PUT', { comp_hours_per_day: 4 });
  let b = await bal(A); assert.equal(b.accrued, 1, '2 days x 2 h = 4 h = 1 day off: ' + JSON.stringify(b)); assert.equal(b.available, 1);
  assert.equal((await bal(B)).available, 0);
  const row = (await api(`report/daily?from=${days.at(-1)}&to=${days[0]}&employee_id=${A.id}`)).find(r => r.date === days[0]); assert.equal(row.ot_approved_min, 0, 'compensatory overtime is not paid'); assert.equal(row.ot_status, 'compensatory');
  const tomorrow = ymd(new Date(Date.now() + 864e5)); const next = new Date(Date.now() + 864e5); while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  const r = await api('leaves', 'POST', { employee_id: A.id, from_date: ymd(next), to_date: ymd(next), type: 'Compensatory Leave', auto_approve: true }); assert.ok(r.id);
  assert.equal((await bal(A)).available, 0, 'the day off is taken from the balance');
  await assert.rejects(api('leaves', 'POST', { employee_id: A.id, from_date: ymd(new Date(next.getTime() + 864e5 * (next.getDay() === 5 ? 3 : 1))), to_date: ymd(new Date(next.getTime() + 864e5 * (next.getDay() === 5 ? 3 : 1))), type: 'Compensatory Leave', auto_approve: true }), /Not enough/);
  console.log('e2e-comp passed: overtime earns compensatory days off, taken from a balance, not paid');
} finally { S.stop(); }
