// Break times (saved, shared by shifts), pay codes (short code + pay share per status, used by payroll and grids), Training requests.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const near = (a, b, t = 0.001) => assert.ok(Math.abs(a - b) <= t, `${a} is not ${b}`);
try {
  const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - 1); const M = d0.toLocaleDateString('sv').slice(0, 7), first = M + '-01';
  const day = (n) => `${M}-${String(n).padStart(2, '0')}`;

  // ---- break times
  await assert.rejects(api('breaks', 'POST', { name: '', start: '13:00', end: '14:00' }), /Name/); await assert.rejects(api('breaks', 'POST', { name: 'x', start: '1pm', end: '14:00' }), /HH:MM/); await assert.rejects(api('breaks', 'POST', { name: 'x', start: '13:00', end: '13:00' }), /some time/);
  const lunch = (await api('breaks', 'POST', { name: 'Lunch', start: '13:00', end: '14:00' })).id; await assert.rejects(api('breaks', 'POST', { name: 'Lunch', start: '12:00', end: '13:00' }), /exists/);
  const sid = (await api('shifts', 'POST', { name: 'Day', code: 'D', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6', break_id: lunch })).id;
  let sh = (await api('shifts')).find(s => s.id === sid); assert.equal(sh.break_start, '13:00'); assert.equal(sh.break_end, '14:00'); assert.equal(sh.break_id, lunch);
  await assert.rejects(api('shifts', 'POST', { name: 'Bad', start: '09:00', end: '18:00', break_id: 999 }), /Unknown break/);
  const emp = await api('employees', 'POST', { name: 'Worker', shift_id: sid, join_date: first, salary: 30000 }); const code = (await api('employees')).find(e => e.id === emp.id).code;
  const L = []; for (let i = 1; i <= 28; i++) L.push(`${code},${day(i)} 09:00`, `${code},${day(i)} 17:00`); // present all day, including through the break
  // ... but on days 5 and 6 a late arrival (after grace)
  L.splice(8, 4, `${code},${day(5)} 09:30`, `${code},${day(5)} 17:00`, `${code},${day(6)} 09:30`, `${code},${day(6)} 17:00`);
  await api('logs/import', 'POST', { csv: L.join('\n') });
  const row = async (d) => (await api(`report/daily?from=${d}&to=${d}`)).find(r => r.code === code);
  near((await row(day(10))).worked_min, 8 * 60 - 60, 0.001); // 09:00-17:00 minus the 1 hour lunch
  assert.equal((await api('breaks')).find(b => b.id === lunch).shifts, 1);
  await api('breaks/' + lunch, 'PUT', { name: 'Lunch', start: '12:00', end: '14:00' }); sh = (await api('shifts')).find(s => s.id === sid); assert.equal(sh.break_start, '12:00', 'a saved break updates every shift that uses it'); near((await row(day(10))).worked_min, 8 * 60 - 120);
  await api('shifts/' + sid, 'PUT', { break_id: null, break_start: '13:00', break_end: '13:30' }); sh = (await api('shifts')).find(s => s.id === sid); assert.equal(sh.break_id, null); assert.equal(sh.break_end, '13:30', 'custom times when no saved break is chosen'); near((await row(day(10))).worked_min, 8 * 60 - 30);
  await api('shifts/' + sid, 'PUT', { break_id: lunch }); await api('breaks/' + lunch, 'DELETE'); sh = (await api('shifts')).find(s => s.id === sid); assert.equal(sh.break_id, null); assert.equal(sh.break_start, '12:00', 'deleting a break leaves the shifts with the times they had');

  // ---- pay codes
  const codes = await api('pay_codes'); const by = Object.fromEntries(codes.map(c => [c.status, c])); assert.equal(by.Absent.code, 'A'); assert.equal(by['Half Day'].pay_factor, 0.5); assert.equal(by.Training.code, 'TR'); assert.equal(by.Late.pay_factor, 1);
  await assert.rejects(api('pay_codes/Nope', 'PUT', { code: 'X' }), /Unknown status/); await assert.rejects(api('pay_codes/Late', 'PUT', { code: 'A' }), /already uses/); await assert.rejects(api('pay_codes/Late', 'PUT', { code: 'TOOLONG' }), /1 to 4/);
  await assert.rejects(api('pay_codes/Late', 'PUT', { pay_factor: 1.5 }), /from 0/); await assert.rejects(api('pay_codes/Present', 'PUT', { pay_factor: 0.5 }), /always paid/);
  const pay = async () => (await api('report/payroll?month=' + M)).rows.find(r => r.code === code);
  const base = await pay(); assert.equal(base.late, 2); const d0v = base.deduction_days;
  await api('pay_codes/Late', 'PUT', { pay_factor: 0.9 }); near((await pay()).deduction_days, d0v + 0.2, 0.01);
  await api('pay_codes/Late', 'PUT', { pay_factor: 1 }); near((await pay()).deduction_days, d0v, 0.001);
  await api('pay_codes/Absent', 'PUT', { pay_factor: 0.25 }); const half = await pay(); assert.ok(half.deduction_days < d0v || base.absent === 0, 'a lower share means less is deducted for Absent'); await api('pay_codes/Absent', 'PUT', { pay_factor: 0 });
  // the short codes are used by the monthly grid
  await api('pay_codes/Late', 'PUT', { code: 'LAT' }); await new Promise(r => setTimeout(r, 3200)); // grids re-read the codes every few seconds
  const grid = await api(`reports/monthly_status?month=${M}`); const g = grid.rows.find(r => r.code === code); assert.equal(g['d05'], 'LAT'); assert.equal(g['d10'], 'P');
  await api('pay_codes/Late', 'PUT', { code: 'LT' });

  // ---- training requests: approved like any on-duty request, counts as a day worked and is paid
  const t = await api('attendance/requests', 'POST', { employee_id: emp.id, date: day(29 <= new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate() ? 29 : 28), kind: 'on_duty', status_text: 'Training', reason: 'Safety course' });
  assert.equal(t.status, 'pending'); await assert.rejects(api('attendance/requests', 'POST', { employee_id: emp.id, date: day(28), kind: 'on_duty', status_text: 'Picnic', reason: 'x' }), /Status must be one of: On Duty, Work From Home, Training/);
  const tr = (await api('attendance/requests?status=pending')).find(r => r.status_text === 'Training'); await api(`attendance/requests/${tr.id}/approve`, 'POST', {});
  const dd = tr.date; const trow = (await api(`report/daily?from=${dd}&to=${dd}`)).find(r => r.code === code); assert.equal(trow.status, 'Training');
  const sum = (await api(`report/summary?from=${first}&to=${day(28)}`)).find(r => r.code === code); assert.ok(sum.present >= 28, 'a training day counts as present');
  assert.equal((await api('report/payroll?month=' + M)).rows.find(r => r.code === code).absent, base.absent - (base.absent > 0 && dd >= day(1) ? 1 : 0), 'the training day is no longer absent');
  // permissions
  await api('users', 'POST', { username: 'viewer4', password: 'password1', role: 'viewer' }); const vt = await S.login('viewer4', 'password1');
  assert.equal((await S.raw('breaks', 'POST', { name: 'x', start: '10:00', end: '10:10' }, vt)).status, 403); assert.equal((await S.raw('pay_codes/Late', 'PUT', { code: 'Z' }, vt)).status, 403);
  console.log('e2e-codes passed: saved break times (shared, propagate), pay codes (code + pay share, payroll, grids), Training requests');
} catch (e) { console.error('E2E-CODES FAILED:', (e.stack || '').split('\n').filter(l => /e2e-codes.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
