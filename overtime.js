import express from 'express';
import { db, getSettings } from './db.js';
import { attendanceReport, dateStr, addDays } from './report.js';
import { gate, takeAdvance } from './workflow.js';
import { notify } from './notify.js';
import { scopeClause } from './rbac.js';

export const overtimeRouter = express.Router();
const DATE = /^\d{4}-\d\d-\d\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const stamp = () => new Date().toLocaleString('sv');

// Create a pending request for every day whose calculated overtime still needs approval (idempotent; refreshes pending amounts).
export function syncOvertimeRequests(from, to, filter = {}) {
  const ins = db.prepare("INSERT OR IGNORE INTO overtime_requests(employee_id, date, kind, day_type, calc_minutes, minutes, status) VALUES(?,?,'auto',?,?,?,'pending')");
  const upd = db.prepare("UPDATE overtime_requests SET calc_minutes=?, minutes=?, day_type=? WHERE employee_id=? AND date=? AND kind='auto' AND status='pending'");
  let created = 0;
  for (const r of attendanceReport(from, to, filter)) {
    if (r.ot_status !== 'pending' && r.ot_status !== 'pending+manual') continue;
    created += Number(ins.run(r.employee_id, r.date, r.day_type, r.ot_calc_min, r.ot_calc_min).changes);
    upd.run(r.ot_calc_min, r.ot_calc_min, r.day_type, r.employee_id, r.date);
  }
  return created;
}
export const needsOtApproval = () => getSettings().ot_approval > 0 || !!db.prepare('SELECT 1 FROM ot_policies WHERE approval=1').get();

overtimeRouter.get('/overtime/requests', (req, res) => {
  const to = req.query.to || dateStr(new Date()), from = req.query.from || addDays(to, -30);
  if (!DATE.test(from) || !DATE.test(to)) return fail(res, 'from/to must be YYYY-MM-DD');
  syncOvertimeRequests(from, to);
  const sc = scopeClause('e');
  const w = ['q.date BETWEEN ? AND ?'], a = [from, to];
  for (const [p, c] of [['status', 'q.status'], ['employee_id', 'q.employee_id'], ['department_id', 'e.department_id'], ['kind', 'q.kind']]) if (req.query[p]) { w.push(`${c}=?`); a.push(req.query[p]); }
  res.json(db.prepare(`SELECT q.*, e.code, e.name AS employee, d.name AS dept FROM overtime_requests q JOIN employees e ON e.id=q.employee_id
                       LEFT JOIN departments d ON d.id=e.department_id WHERE ${w.join(' AND ')}${sc.sql}
                       ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.date DESC, e.code LIMIT 1000`).all(...a, ...sc.args));
});

export function decideOvertime(id, action, body, user) {
  const q = db.prepare('SELECT * FROM overtime_requests WHERE id=?').get(id);
  if (!q) return 'No such overtime request';
  if (q.kind !== 'auto') return 'Manual entries are not approved, only added or deleted';
  if (q.status !== 'pending') return 'Only pending requests can be decided';
  { const g = gate('overtime', q, action === 'approve' ? 'approve' : 'reject', user, body?.note); if (g.error) return g.error; if (g.advanced) return null; }
  let minutes = q.minutes;
  if (action === 'approve') {
    if (body?.minutes !== undefined && body.minutes !== null && body.minutes !== '') {
      minutes = Number(body.minutes);
      if (!(minutes > 0) || minutes > q.calc_minutes) return `Approved minutes must be between 1 and ${q.calc_minutes}`;
    }
  } else minutes = 0;
  db.prepare('UPDATE overtime_requests SET status=?, minutes=?, note=?, decided_by=?, decided_at=? WHERE id=?')
    .run(action === 'approve' ? 'approved' : 'rejected', minutes, body?.note ?? null, user, stamp(), id);
  notify({ audience: 'employee', employee_id: q.employee_id, title: `Overtime ${action === 'approve' ? 'approved' : 'rejected'}: ${q.date}`, body: action === 'approve' ? `${minutes} minutes` : (body?.note ?? ''), link: 'Overtime' , kind: 'overtime_decision'});
  return null;
}
overtimeRouter.post('/overtime/bulk', (req, res) => {
  const { ids, action } = req.body ?? {};
  if (!Array.isArray(ids) || !ids.length || !['approve', 'reject'].includes(action)) return fail(res, 'ids and action (approve/reject) required');
  let done = 0; const errors = [];
  for (const id of ids.slice(0, 500)) { const e = decideOvertime(id, action, req.body, req.user); e ? errors.push({ id, error: e }) : done++; }
  res.json({ done, errors });
});
overtimeRouter.post('/overtime/manual', (req, res) => {
  const { employee_id, date, minutes, note } = req.body ?? {};
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(employee_id);
  if (!e) return fail(res, 'Choose an employee');
  if (!DATE.test(date ?? '')) return fail(res, 'Date required');
  if (!(Number(minutes) >= 1 && Number(minutes) <= 1440)) return fail(res, 'Minutes must be between 1 and 1440');
  db.prepare(`INSERT INTO overtime_requests(employee_id, date, kind, calc_minutes, minutes, status, note, decided_by, decided_at) VALUES(?,?,'manual',?,?,'approved',?,?,?)
              ON CONFLICT(employee_id, date, kind) DO UPDATE SET minutes=excluded.minutes, calc_minutes=excluded.calc_minutes, note=excluded.note, decided_by=excluded.decided_by, decided_at=excluded.decided_at`)
    .run(e.id, date, Number(minutes), Number(minutes), note ?? null, req.user, stamp());
  res.json({ ok: true });
});
overtimeRouter.post('/overtime/:id/approve', (req, res) => { const e = decideOvertime(req.params.id, 'approve', req.body, req.user); e ? fail(res, e) : res.json({ ok: true, ...takeAdvance() }); });
overtimeRouter.post('/overtime/:id/reject', (req, res) => { const e = decideOvertime(req.params.id, 'reject', req.body, req.user); e ? fail(res, e) : res.json({ ok: true }); });
overtimeRouter.delete('/overtime/:id', (req, res) => {
  const r = db.prepare("DELETE FROM overtime_requests WHERE id=? AND kind='manual'").run(req.params.id);
  r.changes ? res.json({ ok: true }) : fail(res, 'Only manual entries can be deleted');
});

// Overtime report: per employee (calculated, payable, by day type), per department and per month.
export function overtimeReport(q) {
  const to = q.to || dateStr(new Date()), from = q.from || to.slice(0, 8) + '01';
  const f = { departmentId: q.department_id || null, branchId: q.branch_id || null, employeeId: q.employee_id || null, designationId: q.designation_id || null, groupId: q.group_id || null };
  const emp = new Map(), dept = new Map(), month = new Map();
  for (const r of attendanceReport(from, to, f)) {
    if (!r.overtime_min) continue;
    const e = emp.get(r.code) ?? { code: r.code, name: r.name, dept: r.dept ?? '-', calculated_min: 0, manual_min: 0, approved_min: 0, pending_min: 0, work_min: 0, weekend_min: 0, holiday_min: 0, days: 0 };
    e.calculated_min += r.ot_calc_min; e.manual_min += r.ot_manual_min; e.approved_min += r.ot_approved_min; e.days++;
    if (r.ot_status.startsWith('pending')) e.pending_min += r.ot_calc_min;
    e[`${r.day_type}_min`] += r.overtime_min; emp.set(r.code, e);
    const d = dept.get(e.dept) ?? { dept: e.dept, approved_min: 0, calculated_min: 0 }; d.approved_min += r.ot_approved_min; d.calculated_min += r.overtime_min; dept.set(e.dept, d);
    const mo = r.date.slice(0, 7), m = month.get(mo) ?? { month: mo, approved_min: 0, calculated_min: 0 }; m.approved_min += r.ot_approved_min; m.calculated_min += r.overtime_min; month.set(mo, m);
  }
  return { from, to, employees: [...emp.values()], departments: [...dept.values()], months: [...month.values()] };
}
overtimeRouter.get('/report/overtime', (req, res) => res.json(overtimeReport(req.query)));
