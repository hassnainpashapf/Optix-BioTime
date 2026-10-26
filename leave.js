import express from 'express';
import { db, getSettings } from './db.js';
import { addDays, dateStr, dayList, attendanceReport } from './report.js';
import { gate, takeAdvance } from './workflow.js';
import { notify, notifyManager } from './notify.js';
import { emit } from './events.js';
import { scopeClause } from './rbac.js';

export const leaveRouter = express.Router();
const DATE = /^\d{4}-\d\d-\d\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const dowOf = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

// ---------- day counting: only the employee's working days that are not public holidays count against leave ----------
export function empInfo(id) {
  return db.prepare('SELECT e.*, s.workdays FROM employees e LEFT JOIN shifts s ON s.id=e.shift_id WHERE e.id=?').get(id);
}
export function leaveDaysByYear(emp, from, to, half) {
  const wd = (emp.workdays ?? '1,2,3,4,5,6').split(',').map(Number);
  const hol = new Set(db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map(h => h.date));
  const out = new Map();
  for (const d of dayList(from, to)) {
    if (!wd.includes(dowOf(d)) || hol.has(d)) continue;
    const y = +d.slice(0, 4);
    out.set(y, (out.get(y) ?? 0) + (half && from === to ? 0.5 : 1));
  }
  return out;
}

// ---------- entitlement, accrual, carry forward ----------
const typeRule = (emp, type) => {
  const it = emp.leave_policy_id ? db.prepare('SELECT quota, accrual, carry_max FROM leave_policy_items WHERE policy_id=? AND type_id=?').get(emp.leave_policy_id, type.id) : null;
  return it ?? { quota: type.quota, accrual: type.accrual, carry_max: type.carry_max };
};
function accrued(rule, year, join, now) {
  if (!rule.quota || year > now.y) return 0;
  const jy = join ? +join.slice(0, 4) : 0;
  if (jy > year) return 0;
  const start = jy === year ? +join.slice(5, 7) : 1, end = year < now.y ? 12 : now.m;
  if (rule.accrual === 'monthly') return round((rule.quota / 12) * Math.max(0, end - start + 1));
  return Math.round(rule.quota * (13 - start) / 12 * 2) / 2; // yearly grant, prorated by months in service, nearest half day
}
// Compensatory Leave is earned, not granted: overtime of an employee with Enable Compensatory = Yes becomes days off (hours-per-day and expiry are in Settings).
export const COMP = 'Compensatory Leave';
db.prepare('INSERT OR IGNORE INTO leave_types(name, paid) VALUES(?,1)').run(COMP);
function compBalance(emp, type, today) {
  const S = getSettings(), hpd = Number(S.comp_hours_per_day) > 0 ? Number(S.comp_hours_per_day) : 8, exp = Number(S.comp_expiry_days) || 0;
  const from = exp > 0 ? addDays(today, -exp) : addDays(today, -730);
  const earnedMin = emp.enable_comp === 1 ? attendanceReport(from, today, { employeeId: emp.id }).filter(r => r.ot_status === 'compensatory').reduce((s, r) => s + r.overtime_min, 0) : 0;
  const earned = Math.floor(earnedMin / (hpd * 60) * 2) / 2;
  const leaves = db.prepare("SELECT status, days FROM leaves WHERE employee_id=? AND type=? AND to_date>=? AND status IN ('approved','pending')").all(emp.id, type.name, from);
  const used = leaves.filter(l => l.status === 'approved').reduce((s, l) => s + (l.days ?? 0), 0), pending = leaves.filter(l => l.status === 'pending').reduce((s, l) => s + (l.days ?? 0), 0);
  return { type: type.name, type_id: type.id, paid: type.paid, tracked: true, quota: 0, accrual: 'overtime', accrued: earned, carry_forward: 0, used, pending, available: round(earned - used - pending) };
}
export function balanceFor(emp, type, year, today = dateStr(new Date())) {
  if (type.name === COMP) return compBalance(emp, type, today);
  const rule = typeRule(emp, type), now = { y: +today.slice(0, 4), m: +today.slice(5, 7) };
  const leaves = db.prepare("SELECT * FROM leaves WHERE employee_id=? AND type=? AND status IN ('approved','pending')").all(emp.id, type.name);
  const used = (y, status) => leaves.filter(l => l.status === status).reduce((s, l) => s + (leaveDaysByYear(emp, l.from_date, l.to_date, l.half).get(y) ?? 0), 0);
  const firstYear = Math.max(year - 10, emp.join_date ? +emp.join_date.slice(0, 4) : year);
  const carryIn = (y) => (rule.carry_max > 0 && y > firstYear ? Math.min(rule.carry_max, Math.max(0, closing(y - 1))) : 0);
  const closing = (y) => accrued(rule, y, emp.join_date, now) + carryIn(y) - used(y, 'approved');
  const acc = accrued(rule, year, emp.join_date, now), carry = carryIn(year), u = used(year, 'approved'), p = used(year, 'pending');
  return { type: type.name, type_id: type.id, paid: type.paid, tracked: rule.quota > 0, quota: rule.quota, accrual: rule.accrual, accrued: acc, carry_forward: round(carry), used: u, pending: p, available: round(acc + carry - u - p) };
}
export const balancesOf = (emp, year) => db.prepare('SELECT * FROM leave_types ORDER BY id').all().map(t => balanceFor(emp, t, year));

leaveRouter.get('/leave/balances', (req, res) => {
  const emp = empInfo(req.query.employee_id);
  if (!emp) return fail(res, 'No such employee', 404);
  const year = +req.query.year || +dateStr(new Date()).slice(0, 4);
  res.json({ employee: emp.name, year, balances: balancesOf(emp, year) });
});

// ---------- applications ----------
// Apply for leave. Used by the staff screen and by the employee portal (which never auto-approves).
export function applyLeave(body, actor, allowAuto = true) {
  const { employee_id, from_date, to_date, type, half, note } = body ?? {}, auto_approve = allowAuto && body?.auto_approve;
  const emp = empInfo(employee_id);
  if (!emp) return { error: 'Choose an employee' };
  if (!emp.active) return { error: 'Employee is not active' };
  if (!DATE.test(from_date ?? '') || !DATE.test(to_date ?? '')) return { error: 'From and to dates required' };
  if (to_date < from_date) return { error: 'To date is before from date' };
  if (half && from_date !== to_date) return { error: 'A half day leave must be a single day' };
  if (to_date > addDays(from_date, 365)) return { error: 'A leave cannot be longer than a year' };
  const t = db.prepare('SELECT * FROM leave_types WHERE name=?').get(type ?? '');
  if (!t) return { error: 'Unknown leave type' };
  if (t.gender !== 'any' && emp.gender && emp.gender !== t.gender) return { error: `${t.name} leave is only for ${t.gender} employees` };
  if (db.prepare("SELECT 1 FROM leaves WHERE employee_id=? AND status IN ('pending','approved') AND from_date<=? AND to_date>=?").get(emp.id, to_date, from_date))
    return { error: 'This employee already has leave in that period' };
  const byYear = leaveDaysByYear(emp, from_date, to_date, half);
  const days = [...byYear.values()].reduce((a, b) => a + b, 0);
  if (!days) return { error: 'No working days in that range (weekly off or holidays only)' };
  for (const [y, d] of byYear) {
    const b = balanceFor(emp, t, y);
    if (b.tracked && d > b.available + 1e-9) return { error: `Not enough ${t.name} leave: ${b.available} day(s) left in ${y}, requested ${d}` };
  }
  const status = t.approval && !auto_approve ? 'pending' : 'approved';
  const now = new Date().toLocaleString('sv');
  const r = db.prepare('INSERT INTO leaves(employee_id, from_date, to_date, type, note, status, days, half, applied_by, applied_at, decided_by, decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(emp.id, from_date, to_date, t.name, note ?? null, status, days, half ? 1 : 0, actor, now, status === 'approved' ? actor : null, status === 'approved' ? now : null);
  if (status === 'pending') {
    const msg = `${t.name}, ${from_date} to ${to_date} (${days} day${days === 1 ? '' : 's'})`;
    notify({ employee_id: emp.id, title: `Leave request: ${emp.name}`, body: msg, link: 'Leaves' , kind: 'leave_request'});
    notifyManager(emp.id, `Leave request: ${emp.name}`, msg, 'Team', 'leave_request');
    emit('leave.requested', { id: Number(r.lastInsertRowid), code: emp.code, name: emp.name, type: t.name, from: from_date, to: to_date, days });
  }
  return { id: Number(r.lastInsertRowid), status, days };
}
leaveRouter.post('/leaves', (req, res) => { const r = applyLeave(req.body, req.user); r.error ? fail(res, r.error) : res.json(r); });

// Approve, reject or cancel. Returns an error message, or null when done.
export function decideLeave(id, status, note, actor) {
  const label = { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' }[status];
  const l = db.prepare('SELECT * FROM leaves WHERE id=?').get(id);
  if (!l) return 'No such leave';
  const ok = status === 'cancelled' ? ['pending', 'approved'] : ['pending'];
  if (!ok.includes(l.status)) return `Only ${ok.join(' or ')} leave can be ${label}`;
  if (status !== 'cancelled') { const g = gate('leave', l, status === 'approved' ? 'approve' : 'reject', actor, note); if (g.error) return g.error; if (g.advanced) return null; } // approval workflow: more steps may follow
  db.prepare('UPDATE leaves SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?').run(status, actor, new Date().toLocaleString('sv'), note ?? null, l.id);
  emit('leave.decided', { id: l.id, code: db.prepare('SELECT code FROM employees WHERE id=?').get(l.employee_id)?.code, type: l.type, from: l.from_date, to: l.to_date, status, decided_by: actor });
  notify({ audience: 'employee', employee_id: l.employee_id, title: `Your ${l.type} leave was ${label}`, body: `${l.from_date} to ${l.to_date}${note ? ' - ' + note : ''}`, link: 'Leaves' , kind: 'leave_decision'});
  return null;
}
const decide = (status) => (req, res) => { const e = decideLeave(req.params.id, status, req.body?.note, req.user); e ? fail(res, e, e === 'No such leave' ? 404 : 400) : res.json({ ok: true, ...takeAdvance() }); };
leaveRouter.post('/leaves/:id/approve', decide('approved'));
leaveRouter.post('/leaves/:id/reject', decide('rejected'));
leaveRouter.post('/leaves/:id/cancel', decide('cancelled'));
leaveRouter.delete('/leaves/:id', (req, res) => { db.prepare('DELETE FROM leaves WHERE id=?').run(req.params.id); res.json({ ok: true }); });

leaveRouter.get('/leaves', (req, res) => {
  const w = [], a = [];
  if (req.query.status) { w.push('l.status=?'); a.push(req.query.status); }
  if (req.query.employee_id) { w.push('l.employee_id=?'); a.push(req.query.employee_id); }
  if (req.query.type) { w.push('l.type=?'); a.push(req.query.type); }
  if (req.query.year) { w.push('l.from_date<=? AND l.to_date>=?'); a.push(req.query.year + '-12-31', req.query.year + '-01-01'); }
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT l.*, e.name AS employee, e.code FROM leaves l JOIN employees e ON e.id=l.employee_id WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''}
                       ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC LIMIT 500`).all(...sc.args, ...a));
});

// ---------- calendar and report ----------
leaveRouter.get('/leaves/calendar', (req, res) => {
  const m = /^\d{4}-\d\d$/.test(req.query.month ?? '') ? req.query.month : dateStr(new Date()).slice(0, 7);
  const from = m + '-01'; let to = from; while (addDays(to, 1).startsWith(m)) to = addDays(to, 1);
  const sc = scopeClause('e');
  const rows = db.prepare(`SELECT l.*, e.name AS employee FROM leaves l JOIN employees e ON e.id=l.employee_id
                           WHERE l.status IN ('pending','approved') AND l.from_date<=? AND l.to_date>=?${sc.sql}`).all(to, from, ...sc.args);
  const hol = db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(from, to);
  const days = {};
  for (const l of rows) for (const d of dayList(l.from_date < from ? from : l.from_date, l.to_date > to ? to : l.to_date))
    (days[d] ??= []).push({ employee: l.employee, type: l.type, status: l.status, half: l.half });
  res.json({ month: m, days, holidays: hol });
});

export function leaveReport(q) {
  const to = q.to || dateStr(new Date()), from = q.from || to.slice(0, 4) + '-01-01';
  const sc = scopeClause('e');
  const w = ["l.status='approved'", 'l.from_date<=?', 'l.to_date>=?'], a = [to, from];
  for (const [p, c] of [['department_id', 'e.department_id'], ['branch_id', 'e.branch_id'], ['employee_id', 'e.id']]) if (q[p]) { w.push(`${c}=?`); a.push(q[p]); }
  const ls = db.prepare(`SELECT l.*, e.code, e.name, d.name AS dept FROM leaves l JOIN employees e ON e.id=l.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE ${w.join(' AND ')}${sc.sql}`).all(...a, ...sc.args);
  const per = new Map(), dept = new Map();
  for (const l of ls) {
    const emp = empInfo(l.employee_id);
    const days = [...leaveDaysByYear(emp, l.from_date < from ? from : l.from_date, l.to_date > to ? to : l.to_date, l.half && l.from_date === l.to_date).values()].reduce((x, y) => x + y, 0);
    const r = per.get(l.code) ?? { code: l.code, name: l.name, dept: l.dept ?? '-', total: 0, types: {} };
    r.types[l.type] = (r.types[l.type] ?? 0) + days; r.total += days; per.set(l.code, r);
    const dd = dept.get(l.dept ?? '-') ?? { dept: l.dept ?? '-', total: 0, employees: new Set() };
    dd.total += days; dd.employees.add(l.code); dept.set(l.dept ?? '-', dd);
  }
  return { from, to, employees: [...per.values()], departments: [...dept.values()].map(d => ({ dept: d.dept, total: d.total, employees: d.employees.size })) };
}
leaveRouter.get('/report/leave', (req, res) => res.json(leaveReport(req.query)));

// ---------- leave policies ----------
leaveRouter.get('/leave/policy-items', (req, res) =>
  res.json(db.prepare(`SELECT i.*, t.name AS type FROM leave_policy_items i JOIN leave_types t ON t.id=i.type_id WHERE i.policy_id=? ORDER BY i.id`).all(req.query.policy_id)));
leaveRouter.post('/leave/policy-items', (req, res) => {
  const { policy_id, type_id, quota, accrual, carry_max } = req.body ?? {};
  if (!db.prepare('SELECT 1 FROM leave_policies WHERE id=?').get(policy_id) || !db.prepare('SELECT 1 FROM leave_types WHERE id=?').get(type_id)) return fail(res, 'Unknown policy or leave type');
  if (!(Number(quota) >= 0) || !['yearly', 'monthly'].includes(accrual ?? 'yearly') || !(Number(carry_max ?? 0) >= 0)) return fail(res, 'Quota, accrual (yearly/monthly) and carry forward must be valid');
  db.prepare(`INSERT INTO leave_policy_items(policy_id, type_id, quota, accrual, carry_max) VALUES(?,?,?,?,?)
              ON CONFLICT(policy_id, type_id) DO UPDATE SET quota=excluded.quota, accrual=excluded.accrual, carry_max=excluded.carry_max`).run(policy_id, type_id, Number(quota), accrual ?? 'yearly', Number(carry_max ?? 0));
  res.json({ ok: true });
});
leaveRouter.delete('/leave/policy-items/:id', (req, res) => { db.prepare('DELETE FROM leave_policy_items WHERE id=?').run(req.params.id); res.json({ ok: true }); });
