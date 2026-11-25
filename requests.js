import express from 'express';
import { db } from './db.js';
import { attendanceReport, dateStr } from './report.js';
import { gate, takeAdvance } from './workflow.js';
import { notify, notifyManager } from './notify.js';
import { emit } from './events.js';
import { scopeClause } from './rbac.js';

export const requestsRouter = express.Router();
const DATE = /^\d{4}-\d\d-\d\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const stamp = () => new Date().toLocaleString('sv');
export const ON_DUTY_STATUSES = ['On Duty', 'Work From Home', 'Training'];

// ---------- requests: add a missed punch, or mark a day as on duty / work from home ----------
export function createAttendanceRequest(body, actor, allowAuto = true) {
  const { employee_id, date, kind, time, status_text, reason } = body ?? {}, auto_approve = allowAuto && body?.auto_approve;
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(employee_id);
  if (!e) return { error: 'Choose an employee' };
  if (!e.active) return { error: 'Employee is not active' };
  if (!DATE.test(date ?? '')) return { error: 'Date required' };
  if (!['add_punch', 'on_duty'].includes(kind)) return { error: 'Kind must be add_punch or on_duty' };
  const today = dateStr(new Date());
  if (kind === 'add_punch') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) return { error: 'Time must be HH:MM' };
    if (date > today) return { error: 'Cannot add a punch in the future' };
  } else if (!ON_DUTY_STATUSES.includes(status_text)) return { error: `Status must be one of: ${ON_DUTY_STATUSES.join(', ')}` };
  if (!String(reason ?? '').trim() && !auto_approve) return { error: 'A reason is required' };
  if (db.prepare("SELECT 1 FROM attendance_requests WHERE employee_id=? AND date=? AND kind=? AND IFNULL(time,'')=? AND status='pending'").get(e.id, date, kind, time ?? ''))
    return { error: 'The same request is already waiting for approval' };
  const r = db.prepare('INSERT INTO attendance_requests(employee_id, date, kind, time, status_text, reason, created_by) VALUES(?,?,?,?,?,?,?)')
    .run(e.id, date, kind, kind === 'add_punch' ? time : null, kind === 'on_duty' ? status_text : null, reason ?? null, actor);
  const id = Number(r.lastInsertRowid);
  if (auto_approve) { applyRequest(id, actor, 'Approved on entry'); return { id, status: 'approved' }; }
  const msg = kind === 'add_punch' ? `Add punch ${time} on ${date}` : `${status_text} on ${date}`;
  notify({ employee_id: e.id, title: `Attendance request: ${e.name}`, body: msg, link: 'Requests' , kind: 'attendance_request'});
  notifyManager(e.id, `Attendance request: ${e.name}`, msg, 'Team', 'attendance_request');
  emit('attendance_request.created', { id, code: e.code, kind, date, time: time ?? null, status_text: status_text ?? null });
  return { id, status: 'pending' };
}
requestsRouter.post('/attendance/requests', (req, res) => { const r = createAttendanceRequest(req.body, req.user); r.error ? fail(res, r.error) : res.json(r); });

function applyRequest(id, user, note) {
  const q = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(id);
  db.exec('BEGIN');
  try {
    if (q.kind === 'add_punch') db.prepare("INSERT OR IGNORE INTO logs(emp_code, ts, source) SELECT code, ?, 'manual' FROM employees WHERE id=?").run(`${q.date} ${q.time}:00`, q.employee_id);
    else db.prepare(`INSERT INTO day_overrides(employee_id, date, status, note) VALUES(?,?,?,?)
                     ON CONFLICT(employee_id, date) DO UPDATE SET status=excluded.status, note=excluded.note`).run(q.employee_id, q.date, q.status_text, q.reason);
    db.prepare("UPDATE attendance_requests SET status='approved', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(user, stamp(), note ?? null, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  notify({ audience: 'employee', employee_id: q.employee_id, title: 'Your attendance request was approved', body: `${q.date}`, link: 'Requests' , kind: 'request_decision'});
}
// action: approve | reject | cancel. Returns an error message, or null when done.
export function decideAttendanceRequest(id, action, note, actor) {
  const q = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(id);
  if (!q) return 'No such request';
  if (q.status !== 'pending') return 'Only pending requests can be decided';
  if (action !== 'cancel') { const g = gate('attendance', q, action, actor, note); if (g.error) return g.error; if (g.advanced) return null; }
  emit('attendance_request.decided', { id: q.id, code: db.prepare('SELECT code FROM employees WHERE id=?').get(q.employee_id)?.code, date: q.date, status: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled' });
  if (action === 'approve') applyRequest(q.id, actor, note);
  else {
    db.prepare('UPDATE attendance_requests SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?').run(action === 'reject' ? 'rejected' : 'cancelled', actor, stamp(), note ?? null, q.id);
    notify({ audience: 'employee', employee_id: q.employee_id, title: `Your attendance request was ${action === 'reject' ? 'rejected' : 'cancelled'}`, body: `${q.date}${note ? ' - ' + note : ''}`, link: 'Requests' , kind: 'request_decision'});
  }
  return null;
}
const decide = (action) => (req, res) => { const e = decideAttendanceRequest(req.params.id, action, req.body?.note, req.user); e ? fail(res, e, e === 'No such request' ? 404 : 400) : res.json({ ok: true, ...takeAdvance() }); };
requestsRouter.post('/attendance/requests/:id/approve', decide('approve'));
requestsRouter.post('/attendance/requests/:id/reject', decide('reject'));
requestsRouter.post('/attendance/requests/:id/cancel', decide('cancel'));

requestsRouter.get('/attendance/requests', (req, res) => {
  const sc = scopeClause('e');
  const w = [], a = [];
  for (const [p, c] of [['status', 'r.status'], ['employee_id', 'r.employee_id'], ['kind', 'r.kind']]) if (req.query[p]) { w.push(`${c}=?`); a.push(req.query[p]); }
  if (req.query.from) { w.push('r.date>=?'); a.push(req.query.from); }
  if (req.query.to) { w.push('r.date<=?'); a.push(req.query.to); }
  res.json(db.prepare(`SELECT r.*, e.code, e.name AS employee FROM attendance_requests r JOIN employees e ON e.id=r.employee_id WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''}
                       ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT 500`).all(...sc.args, ...a));
});
requestsRouter.get('/attendance/overrides', (req, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT o.*, e.code, e.name AS employee FROM day_overrides o JOIN employees e ON e.id=o.employee_id WHERE 1=1${sc.sql} ORDER BY o.date DESC LIMIT 300`).all(...sc.args));
});
requestsRouter.delete('/attendance/overrides/:id', (req, res) => { db.prepare('DELETE FROM day_overrides WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------- exceptions: days that need a human decision ----------
requestsRouter.get('/report/exceptions', (req, res) => {
  const to = req.query.to || dateStr(new Date()), from = req.query.from || to.slice(0, 8) + '01';
  const f = { departmentId: req.query.department_id || null, branchId: req.query.branch_id || null };
  const kinds = { 'Missing Out': 'Missing punch-out', Absent: 'Absent', 'Half Day': 'Half day', 'Short Hours': 'Worked fewer hours than required', Late: 'Late arrival' };
  const rows = attendanceReport(from, to, f).filter(r => kinds[r.status] && (!req.query.kind || r.status === req.query.kind))
    .map(r => ({ employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, date: r.date, in: r.in, out: r.out, status: r.status, reason: kinds[r.status], late_min: r.late_min, note: r.note }));
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  res.json({ from, to, counts, rows: rows.slice(0, 1000) });
});
