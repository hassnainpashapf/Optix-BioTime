import express from 'express';
import { db } from './db.js';
import { scopeClause } from './rbac.js';

// ---------- the kinds of alert a person can switch on or off ----------
// for: s = staff logins, e = employees (managers get the team ones). def: on by default?
export const CATALOG = [
  { kind: 'punch', label: 'Arrivals and departures', desc: 'Someone punched in or out (use the watch list to follow only some people)', for: 'se', def: 0, group: 'Attendance' },
  { kind: 'late', label: 'Late arrivals', desc: 'Someone arrived after their grace time', for: 'se', def: 1, group: 'Attendance' },
  { kind: 'absent_summary', label: 'Not in yet', desc: 'Daily summary of people who have not punched in', for: 's', def: 1, group: 'Attendance' },
  { kind: 'missing_punch', label: 'Missing punch-out', desc: 'You forgot to punch out', for: 'e', def: 1, group: 'Attendance' },
  { kind: 'my_punch', label: 'My punches', desc: 'A confirmation each time your punch is recorded', for: 'e', def: 1, group: 'Attendance' },
  { kind: 'leave_request', label: 'Leave requests', desc: 'Someone asked for leave and it needs a decision', for: 'se', def: 1, group: 'Requests' },
  { kind: 'attendance_request', label: 'Attendance requests', desc: 'Someone asked to add a punch or mark on-duty', for: 'se', def: 1, group: 'Requests' },
  { kind: 'shift_request', label: 'Shift requests', desc: 'Shift change and swap requests', for: 'se', def: 1, group: 'Requests' },
  { kind: 'leave_pending', label: 'Requests waiting too long', desc: 'Leave requests still waiting after 2 days', for: 'se', def: 1, group: 'Requests' },
  { kind: 'approval', label: 'Approvals waiting for me', desc: 'A request reached your step in an approval workflow', for: 'se', def: 1, group: 'Requests' },
  { kind: 'leave_decision', label: 'My leave decisions', desc: 'Your leave was approved, rejected or cancelled', for: 'e', def: 1, group: 'My requests' },
  { kind: 'request_decision', label: 'My attendance request decisions', desc: 'Your attendance request was decided', for: 'e', def: 1, group: 'My requests' },
  { kind: 'shift_decision', label: 'My shift decisions', desc: 'Your shift change or swap was decided', for: 'e', def: 1, group: 'My requests' },
  { kind: 'overtime_decision', label: 'My overtime decisions', desc: 'Your overtime was approved or rejected', for: 'e', def: 1, group: 'My requests' },
  { kind: 'contract', label: 'Contract and probation ending', desc: 'A contract or probation period ends soon', for: 'se', def: 1, group: 'Employees' },
  { kind: 'meeting', label: 'Meetings', desc: 'Invitations and changes', for: 'e', def: 1, group: 'Other' },
  { kind: 'visitor', label: 'Visitors', desc: 'A visitor arrived (staff: any visitor, employees: your own)', for: 'se', def: 1, group: 'Other' },
  { kind: 'access', label: 'Door entry outside policy', desc: 'Someone went through a door the access rules do not allow at that time', for: 's', def: 1, group: 'Devices' },
  { kind: 'device_status', label: 'Device offline / back online', desc: 'A device stopped or resumed talking to the server', for: 's', def: 1, group: 'Devices' },
  { kind: 'device_service', label: 'Device maintenance', desc: 'Service due or warranty ending', for: 's', def: 1, group: 'Devices' },
  { kind: 'high_temp', label: 'High temperature', desc: 'A device measured a temperature above the limit', for: 's', def: 1, group: 'Devices' },
  { kind: 'automation', label: 'Automation messages', desc: 'Messages sent by your automation rules', for: 'se', def: 1, group: 'Other' },
];
export const KINDS = new Map(CATALOG.map(c => [c.kind, c]));
export const TEAM_KINDS = ['punch', 'late']; // alerts about someone else's arrival: filtered by the watch list

// In-app notifications. audience 'admin' = every staff login; 'employee' + employee_id = that person;
// 'feed' = live events (punches) shown only in the alerts feed/phone, with employee_id = who it is about.
export function notify({ audience = 'admin', employee_id = null, title, body = '', link = '', kind = null }) {
  db.prepare('INSERT INTO notifications(audience, employee_id, title, body, link, kind) VALUES(?,?,?,?,?,?)').run(audience, employee_id, title, body, link, kind);
}
// Tell the employee's reporting manager (if any) that something needs their decision.
export function notifyManager(employeeId, title, body = '', link = '', kind = null) {
  const m = db.prepare('SELECT manager_id FROM employees WHERE id=?').get(employeeId)?.manager_id;
  if (m) notify({ audience: 'employee', employee_id: m, title, body, link, kind });
}

// ---------- per-person preferences ----------
export const ownerOf = { staff: (u) => 'u:' + u, emp: (id) => 'e:' + id };
export function prefsOf(owner, who) { // who: 's' or 'e'
  const rows = new Map(db.prepare('SELECT kind, enabled FROM alert_prefs WHERE owner=?').all(owner).map(r => [r.kind, !!r.enabled]));
  return CATALOG.filter(c => c.for.includes(who)).map(c => ({ ...c, enabled: rows.has(c.kind) ? rows.get(c.kind) : !!c.def }));
}
export const optsOf = (owner) => ({ quiet_start: null, quiet_end: null, watch_mode: 'all', ...(db.prepare('SELECT * FROM alert_opts WHERE owner=?').get(owner) ?? {}), watch: db.prepare('SELECT employee_id FROM alert_watch WHERE owner=?').all(owner).map(r => r.employee_id) });
const off = (owner) => { const on = new Map(db.prepare('SELECT kind, enabled FROM alert_prefs WHERE owner=?').all(owner).map(r => [r.kind, !!r.enabled])); return CATALOG.filter(c => !(on.has(c.kind) ? on.get(c.kind) : !!c.def)).map(c => c.kind); };
const KIND_SQL = (owner) => { const o = off(owner); return { sql: o.length ? ` AND (kind IS NULL OR kind NOT IN (${o.map(() => '?')}))` : '', args: o }; };
const inQuiet = (opts, ts) => { const { quiet_start: a, quiet_end: b } = opts; if (!a || !b || a === b) return false; const t = String(ts).slice(11, 16); return a < b ? t >= a && t < b : t >= a || t < b; };

// What one person should see: their own kinds, minus whatever they switched off, minus punches of people not on their watch list.
// Staff see the shared 'admin' and 'feed' rows inside their scope; an employee sees their own rows plus (as a manager) their team's feed rows.
export function feedFor(owner, { staff = false, employeeId = null, since = 0, limit = 100 } = {}) {
  const opts = optsOf(owner), K = KIND_SQL(owner), lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const watch = opts.watch_mode === 'watch' ? ` AND (kind NOT IN ('punch','late') OR employee_id IN (${opts.watch.length ? opts.watch.map(() => '?') : 'NULL'}))` : '', wa = opts.watch_mode === 'watch' ? opts.watch : [];
  let where, args;
  if (staff) { const sc = scopeClause('e'); where = `audience IN ('admin','feed') AND (employee_id IS NULL OR employee_id IN (SELECT e.id FROM employees e WHERE 1=1${sc.sql}))`; args = sc.args; }
  else where = `((audience='employee' AND employee_id=?) OR (audience='feed' AND kind IN ('punch','late') AND employee_id IN (SELECT id FROM employees WHERE manager_id=?)))`, args = [employeeId, employeeId];
  const rows = db.prepare(`SELECT id, created, audience, kind, title, body, link, is_read FROM notifications WHERE ${where} AND id>?${K.sql}${watch} ORDER BY id DESC LIMIT ${lim}`).all(...args, since, ...K.args, ...wa);
  return rows.map(r => ({ ...r, label: KINDS.get(r.kind)?.label ?? 'Notice', silent: inQuiet(opts, r.created), is_read: !!r.is_read }));
}
export function unreadFor(owner, { staff = false, employeeId = null } = {}) { return feedFor(owner, { staff, employeeId, limit: 300 }).filter(r => !r.is_read && r.audience !== 'feed').length; }

export const notifyRouter = express.Router();
// A notice about one employee is shown only to logins whose scope includes that employee. Switched-off kinds are hidden.
const visible = (user) => { const sc = scopeClause('e'), K = KIND_SQL(ownerOf.staff(user)); return { sql: `audience='admin' AND (employee_id IS NULL OR employee_id IN (SELECT e.id FROM employees e WHERE 1=1${sc.sql}))${K.sql}`, args: [...sc.args, ...K.args] }; };
notifyRouter.get('/notifications', (req, res) => {
  const v = visible(req.user);
  res.json({ unread: db.prepare(`SELECT COUNT(*) n FROM notifications WHERE ${v.sql} AND is_read=0`).get(...v.args).n,
             items: db.prepare(`SELECT id, created, title, body, link, is_read, kind, read_time FROM notifications WHERE ${v.sql} ORDER BY id DESC LIMIT 100`).all(...v.args) });
});
// Marking as read is allowed for every staff role (a viewer may dismiss alerts).
notifyRouter.post('/notifications/read', (req, res) => {
  const v = visible(req.user);
  if (req.body?.id) db.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND ${v.sql}`).run(req.body.id, ...v.args);
  else db.prepare(`UPDATE notifications SET is_read=1 WHERE ${v.sql}`).run(...v.args);
  res.json({ ok: true });
});
