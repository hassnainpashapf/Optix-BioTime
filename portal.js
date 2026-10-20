import express from 'express';
import { randomBytes } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { db, hash, verify, getSettings } from './db.js';
import { attendanceReport, summarize } from './report.js';
import { dateStr, addDays } from './dates.js';
import { applyLeave, decideLeave, balancesOf, empInfo } from './leave.js';
import { createAttendanceRequest, decideAttendanceRequest } from './requests.js';
import { createShiftRequest, decideShiftRequest, shiftCalendar } from './shifts.js';
import { decideOvertime } from './overtime.js';
import { notify, feedFor, unreadFor, ownerOf } from './notify.js';
import { mountAlertRoutes } from './alerts.js';
import { upcoming } from './hrx.js';
import { waitingOnManager, takeAdvance } from './workflow.js';
import { makePairCode, phonesOf, removePhone, serverInfo } from './mobile.js';
import { emit } from './events.js';
import { scopeClause } from './rbac.js';

const fail = (res, msg, code = 400, extra = {}) => res.status(code).json({ error: msg, ...extra });
const stamp = () => new Date().toLocaleString('sv');
const hhmm = (ts) => ts.slice(11, 16);

// ================= employee side: /api/portal/* (its own login, never a staff token) =================
export const portalRouter = express.Router();
const sessions = new Map(); // token -> { id, exp }
const ipFails = new Map();  // ip -> { n, reset }
const DAY = 86400000;

portalRouter.post('/login', (req, res) => {
  const now = Date.now(), f = ipFails.get(req.ip) ?? { n: 0, reset: now + 10 * 60000 };
  if (f.reset < now) { f.n = 0; f.reset = now + 10 * 60000; }
  if (f.n >= 20) return fail(res, 'Too many attempts from this device. Try again in a few minutes.', 429);
  const b = typeof req.body === 'object' && req.body ? req.body : {};
  const e = db.prepare(`SELECT e.*, a.pass, a.must_change, a.enabled, a.fails, a.locked_until FROM employees e JOIN employee_accounts a ON a.employee_id=e.id WHERE e.code=?`).get(String(b.code ?? '').trim());
  const bad = () => { f.n++; ipFails.set(req.ip, f); return fail(res, 'Wrong ID or password', 401); };
  if (!e || !e.enabled || !e.active) return bad();
  if (e.locked_until && e.locked_until > stamp()) return fail(res, 'Too many wrong passwords. This account is locked for 15 minutes.', 429);
  if (!verify(String(b.password ?? ''), e.pass)) {
    const fails = (e.fails ?? 0) + 1;
    if (fails >= 5) db.prepare('UPDATE employee_accounts SET fails=0, locked_until=? WHERE employee_id=?').run(new Date(now + 15 * 60000).toLocaleString('sv'), e.id);
    else db.prepare('UPDATE employee_accounts SET fails=? WHERE employee_id=?').run(fails, e.id);
    return bad();
  }
  db.prepare('UPDATE employee_accounts SET fails=0, locked_until=NULL, last_login=? WHERE employee_id=?').run(stamp(), e.id);
  const token = randomBytes(24).toString('hex');
  sessions.set(token, { id: e.id, exp: now + (b.remember ? 30 * DAY : 12 * 3600000) });
  res.json({ token, must_change: !!e.must_change, name: e.name });
});

// everything below needs a signed-in employee
portalRouter.use((req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', ''), s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return fail(res, 'Please sign in', 401); }
  const e = db.prepare(`SELECT e.*, a.must_change, a.enabled, a.mobile_enabled FROM employees e JOIN employee_accounts a ON a.employee_id=e.id WHERE e.id=?`).get(s.id);
  if (!e || !e.enabled || !e.active) { sessions.delete(t); return fail(res, 'This account is switched off', 401); }
  req.me = e; req.token = t;
  if (req.method !== 'GET') res.on('finish', () => { // employees' own actions go into the same audit trail as staff actions
    if (res.statusCode >= 400) return;
    try { const b = { ...(typeof req.body === 'object' && req.body ? req.body : {}) }; for (const k of ['current', 'password', 'lat', 'lng']) if (k in b) b[k] = '[hidden]';
      db.prepare('INSERT INTO audit_log(user, method, path, summary) VALUES(?,?,?,?)').run(`emp:${e.code}`, req.method, '/api/portal' + req.path, JSON.stringify(b).slice(0, 400)); } catch {}
  });
  if (e.must_change && !['/password', '/me', '/logout'].includes(req.path)) return fail(res, 'Choose a new password first', 403, { must_change: true });
  next();
});
const actor = (req) => `emp:${req.me.code}`;
portalRouter.post('/logout', (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });
portalRouter.post('/password', (req, res) => {
  const { current, password } = req.body ?? {}, a = db.prepare('SELECT pass FROM employee_accounts WHERE employee_id=?').get(req.me.id);
  if (!verify(String(current ?? ''), a.pass)) return fail(res, 'Your current password is wrong');
  if (String(password ?? '').length < 8) return fail(res, 'The new password needs at least 8 characters');
  if (password === current || password === req.me.code) return fail(res, 'Choose a password that is different from the old one and from your ID');
  db.prepare('UPDATE employee_accounts SET pass=?, must_change=0 WHERE employee_id=?').run(hash(String(password)), req.me.id);
  for (const [t, s] of sessions) if (s.id === req.me.id && t !== req.token) sessions.delete(t);
  res.json({ ok: true });
});

// ---------- location ----------
export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180, dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Work locations this employee may punch from: assigned to them, their branch's, or open to everyone.
export const allowedSites = (e) => db.prepare(`SELECT * FROM geo_sites WHERE active=1 AND (all_employees=1 OR (branch_id IS NOT NULL AND branch_id=?) OR id IN (SELECT site_id FROM employee_sites WHERE employee_id=?))`).all(e.branch_id ?? -1, e.id);

function todayInfo(e) {
  const t = dateStr(new Date()), row = attendanceReport(t, t, { employeeId: e.id })[0] ?? null;
  const punches = db.prepare('SELECT id, ts, source FROM logs WHERE emp_code=? AND ts>=? AND ts<? ORDER BY ts').all(e.code, t + ' 00:00:00', addDays(t, 1) + ' 00:00:00');
  return { date: t, row, punches: punches.map(p => ({ time: hhmm(p.ts), source: p.source })) };
}
portalRouter.get('/me', (req, res) => {
  const e = req.me, S = getSettings(), td = todayInfo(e);
  const lookup = (t, id) => (id ? db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(id)?.name ?? null : null);
  res.json({ employee: { id: e.id, code: e.code, name: e.name, dept: lookup('departments', e.department_id), branch: lookup('branches', e.branch_id), designation: lookup('designations', e.designation_id), email: e.email, phone: e.phone, join_date: e.join_date, manager: lookup('employees', e.manager_id), has_photo: !!e.photo },
    must_change: !!e.must_change, today: td, shift_today: td.row?.shift ?? null, gps_policy: S.portal_gps,
    can_punch: !!e.mobile_enabled, sites: allowedSites(e).map(s => ({ name: s.name, radius_m: s.radius_m })),
    is_manager: !!db.prepare('SELECT 1 FROM employees WHERE manager_id=? AND active=1').get(e.id),
    unread: db.prepare("SELECT COUNT(*) n FROM notifications WHERE audience='employee' AND employee_id=? AND is_read=0").get(e.id).n });
});
portalRouter.get('/photo', (req, res) => req.me.photo ? res.sendFile(resolve(process.env.UPLOAD_DIR || 'uploads', 'photos', basename(req.me.photo))) : fail(res, 'No photo', 404));

// ---------- check in / check out from the phone ----------
portalRouter.post('/punch', (req, res) => {
  const e = req.me, S = getSettings(), b = req.body ?? {};
  if (!e.mobile_enabled) return fail(res, 'Phone attendance is not switched on for you. Ask HR.', 403);
  const lat = Number(b.lat), lng = Number(b.lng), acc = b.accuracy === undefined || b.accuracy === null ? NaN : Number(b.accuracy);
  const haveGps = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (S.portal_gps > 0 && !haveGps) return fail(res, 'Your location is needed to punch. Allow location access and try again.');
  const sites = allowedSites(e);
  let site = null, dist = null;
  if (haveGps) for (const s of sites) { const d = haversine(lat, lng, s.lat, s.lng); if (dist === null || d < dist) { dist = d; site = s; } }
  const inside = !!site && dist <= site.radius_m, accurate = !!site && Number.isFinite(acc) && acc <= site.max_accuracy_m;
  let flagged = 0, note = '';
  if (S.portal_gps === 2) { // strict
    if (!sites.length) return fail(res, 'No work location is assigned to you yet. Ask HR.', 403);
    if (!Number.isFinite(acc) || !accurate) return fail(res, `Your phone's location is not accurate enough${Number.isFinite(acc) ? ` (about ${Math.round(acc)} m, ${site.max_accuracy_m} m needed)` : ''}. Step outside or wait a moment, then try again.`, 422);
    if (!inside) return fail(res, `You are ${Math.round(dist)} m from ${site.name}. You must be within ${site.radius_m} m to punch.`, 403, { distance_m: Math.round(dist), site: site.name });
  } else if (S.portal_gps === 1) { // flag
    if (!sites.length) { flagged = 1; note = 'No work location assigned'; } else if (!inside) { flagged = 1; note = `${Math.round(dist)} m from ${site.name}`; } else if (!accurate) { flagged = 1; note = 'Location not accurate'; }
  }
  const dev = String(b.device_id ?? '').slice(0, 64), last = db.prepare("SELECT device_id FROM mobile_punches WHERE employee_id=? AND device_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(e.id);
  if (dev && last?.device_id && last.device_id !== dev && S.portal_gps > 0) { flagged = 1; note = (note ? note + '; ' : '') + 'New phone'; }
  const now = new Date(), ts = now.toLocaleString('sv'), recent = db.prepare('SELECT ts FROM logs WHERE emp_code=? ORDER BY ts DESC LIMIT 1').get(e.code);
  if (recent && (now - new Date(recent.ts.replace(' ', 'T'))) < S.portal_min_gap_min * 60000) return fail(res, `You already punched at ${hhmm(recent.ts)}. Wait ${S.portal_min_gap_min} minutes between punches.`, 429);
  db.exec('BEGIN');
  try {
    if (!Number(db.prepare("INSERT OR IGNORE INTO logs(emp_code, ts, source, lat, lng) VALUES(?,?,'mobile',?,?)").run(e.code, ts, haveGps ? lat : null, haveGps ? lng : null).changes)) { db.exec('ROLLBACK'); return fail(res, 'That punch was already recorded. Wait a moment before trying again.', 429); }
    const logId = db.prepare('SELECT id FROM logs WHERE emp_code=? AND ts=?').get(e.code, ts)?.id ?? null;
    db.prepare('INSERT INTO mobile_punches(log_id, employee_id, ts, lat, lng, accuracy, site_id, distance_m, inside, flagged, note, device_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(logId, e.id, ts, haveGps ? lat : null, haveGps ? lng : null, Number.isFinite(acc) ? acc : null, site?.id ?? null, dist === null ? null : Math.round(dist), inside ? 1 : 0, flagged, note || null, dev || null);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); return fail(res, 'Could not save the punch: ' + err.message, 500); }
  emit('punch.created', { punches: [{ code: e.code, time: ts, source: 'mobile' }], count: 1 });
  const n = todayInfo(e).punches.length;
  res.json({ ok: true, time: hhmm(ts), kind: n % 2 ? 'in' : 'out', site: site?.name ?? null, distance_m: dist === null ? null : Math.round(dist), flagged: !!flagged, note });
});

// ---------- my attendance, leave, requests, shifts, payslips ----------
const monthOf = (q) => (/^\d{4}-\d\d$/.test(q ?? '') ? q : dateStr(new Date()).slice(0, 7));
const lastDay = (m) => { let d = m + '-01'; while (addDays(d, 1).startsWith(m)) d = addDays(d, 1); return d; };
portalRouter.get('/history', (req, res) => {
  const m = monthOf(req.query.month), rows = attendanceReport(m + '-01', lastDay(m), { employeeId: req.me.id }).filter(r => r.status);
  const punches = db.prepare('SELECT ts, source FROM logs WHERE emp_code=? AND ts>=? AND ts<? ORDER BY ts').all(req.me.code, m + '-01 00:00:00', addDays(lastDay(m), 1) + ' 00:00:00');
  res.json({ month: m, summary: summarize(rows)[0] ?? null, days: rows.map(r => ({ date: r.date, status: r.status, in: r.in, out: r.out, worked_min: r.worked_min, late_min: r.late_min, overtime_min: r.ot_approved_min, note: r.note, shift: r.shift,
    punches: punches.filter(p => p.ts.startsWith(r.date)).map(p => ({ time: hhmm(p.ts), source: p.source })) })) });
});
portalRouter.get('/leave/balances', (req, res) => res.json({ year: +req.query.year || new Date().getFullYear(), balances: balancesOf(empInfo(req.me.id), +req.query.year || new Date().getFullYear()) }));
portalRouter.get('/leave/types', (_q, res) => res.json(db.prepare('SELECT name, paid FROM leave_types ORDER BY id').all()));
portalRouter.get('/leaves', (req, res) => res.json(db.prepare('SELECT id, type, from_date, to_date, days, half, status, note, decision_note, decided_by FROM leaves WHERE employee_id=? ORDER BY from_date DESC LIMIT 100').all(req.me.id)));
portalRouter.post('/leaves', (req, res) => { const r = applyLeave({ ...req.body, employee_id: req.me.id, auto_approve: false }, actor(req), false); r.error ? fail(res, r.error) : res.json(r); });
portalRouter.post('/leaves/:id/cancel', (req, res) => {
  const l = db.prepare('SELECT * FROM leaves WHERE id=? AND employee_id=?').get(req.params.id, req.me.id);
  if (!l) return fail(res, 'No such leave', 404);
  if (l.status !== 'pending') return fail(res, 'Only a leave that is still waiting can be cancelled here. Ask HR for the rest.');
  const e = decideLeave(l.id, 'cancelled', 'Cancelled by employee', actor(req)); e ? fail(res, e) : res.json({ ok: true });
});
portalRouter.get('/attendance/requests', (req, res) => res.json(db.prepare('SELECT id, date, kind, time, status_text, reason, status, decision_note FROM attendance_requests WHERE employee_id=? ORDER BY id DESC LIMIT 100').all(req.me.id)));
portalRouter.post('/attendance/requests', (req, res) => { const r = createAttendanceRequest({ ...req.body, employee_id: req.me.id, auto_approve: false }, actor(req), false); r.error ? fail(res, r.error) : res.json(r); });
portalRouter.post('/attendance/requests/:id/cancel', (req, res) => {
  const q = db.prepare('SELECT id FROM attendance_requests WHERE id=? AND employee_id=?').get(req.params.id, req.me.id);
  if (!q) return fail(res, 'No such request', 404);
  const e = decideAttendanceRequest(q.id, 'cancel', 'Cancelled by employee', actor(req)); e ? fail(res, e) : res.json({ ok: true });
});
portalRouter.get('/shifts/calendar', (req, res) => { const c = shiftCalendar({ month: req.query.month, employee_id: req.me.id }); res.json({ month: c.month, days: c.days, shifts: c.shifts, cells: c.rows[0]?.cells ?? [] }); });
portalRouter.get('/shifts/requests', (req, res) => res.json(db.prepare(`SELECT r.id, r.kind, r.from_date, r.to_date, r.reason, r.status, r.decision_note, o.name AS other_employee, s.name AS shift, r.employee_id=? AS mine
  FROM shift_requests r LEFT JOIN employees o ON o.id=r.other_employee_id LEFT JOIN shifts s ON s.id=r.shift_id WHERE r.employee_id=? OR r.other_employee_id=? ORDER BY r.id DESC LIMIT 100`).all(req.me.id, req.me.id, req.me.id)));
portalRouter.get('/shifts/list', (_q, res) => res.json(db.prepare('SELECT id, name, code, start, end FROM shifts ORDER BY id').all()));
portalRouter.get('/colleagues', (req, res) => res.json(db.prepare('SELECT id, code, name FROM employees WHERE active=1 AND id!=? ORDER BY name LIMIT 500').all(req.me.id)));
portalRouter.post('/shifts/requests', (req, res) => {
  const r = createShiftRequest({ ...req.body, employee_id: req.me.id, auto_approve: false }, actor(req), false);
  if (r.error) return fail(res, r.error);
  if (req.body?.kind === 'swap' && req.body.other_employee_id) notify({ audience: 'employee', employee_id: Number(req.body.other_employee_id), title: `${req.me.name} asked to swap shifts with you`, body: `${req.body.from_date} to ${req.body.to_date}`, link: 'Requests' , kind: 'shift_request'});
  res.json(r);
});
portalRouter.post('/shifts/requests/:id/cancel', (req, res) => {
  const q = db.prepare('SELECT id FROM shift_requests WHERE id=? AND employee_id=?').get(req.params.id, req.me.id);
  if (!q) return fail(res, 'No such request', 404);
  const e = decideShiftRequest(q.id, 'cancel', 'Cancelled by employee', actor(req)); e ? fail(res, e) : res.json({ ok: true });
});
// Payslips appear only once HR has finalized the month; an employee only ever gets their own row.
portalRouter.get('/payslips', (req, res) => { const sd = getSettings().slip_day, today = dateStr(new Date()); res.json(db.prepare('SELECT month, status, paid_at, data FROM payroll_runs ORDER BY month DESC LIMIT 24').all()
  .filter(r => { if (!sd) return true; const [y, m] = r.month.split('-').map(Number), ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; return today >= `${ny}-${String(nm).padStart(2, '0')}-${String(sd).padStart(2, '0')}`; })
  .map(r => { const row = JSON.parse(r.data).find(x => x.code === req.me.code); return row ? { month: r.month, status: r.status, paid_at: r.paid_at, ...row } : null; }).filter(Boolean)); });

// ---------- notifications and announcements ----------
portalRouter.get('/notifications', (req, res) => { const o = { employeeId: req.me.id }, own = ownerOf.emp(req.me.id), items = feedFor(own, { ...o, limit: 60 }); res.json({ unread: unreadFor(own, o), items }); });
mountAlertRoutes(portalRouter, 'e', (req) => ({ owner: ownerOf.emp(req.me.id), staff: false, employeeId: req.me.id }), (req, id) => !!db.prepare('SELECT 1 FROM employees WHERE id=? AND manager_id=?').get(id, req.me.id)); // an employee can watch only their own team
portalRouter.post('/notifications/read', (req, res) => { db.prepare("UPDATE notifications SET is_read=1 WHERE audience='employee' AND employee_id=?").run(req.me.id); res.json({ ok: true }); });
// Phones that receive this employee's alerts (the phone app pairs with a one-time code made here).
portalRouter.post('/mobile/pair-code', (req, res) => res.json(makePairCode('emp', req.me.id)));
portalRouter.get('/mobile/server-info', (req, res) => res.json(serverInfo(req)));
portalRouter.get('/mobile/devices', (req, res) => res.json(phonesOf('emp', req.me.id)));
portalRouter.delete('/mobile/devices/:id', (req, res) => removePhone('emp', req.me.id, req.params.id) ? res.json({ ok: true }) : fail(res, 'No such phone', 404));
// Company directory for colleagues: name, role, department, branch and work e-mail only (no phone, salary or personal details).
portalRouter.get('/directory', (req, res) => {
  const q = String(req.query.q ?? '').trim(), w = ['e.active=1'], a = [];
  if (q) { w.push('(e.name LIKE ? OR ds.name LIKE ? OR d.name LIKE ?)'); a.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  res.json({ people: db.prepare(`SELECT e.name, e.email, d.name AS dept, b.name AS branch, ds.name AS designation FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN designations ds ON ds.id=e.designation_id WHERE ${w.join(' AND ')} ORDER BY e.name LIMIT 100`).all(...a),
    upcoming: upcoming(14, false).map(({ name, kind, date, years }) => ({ name, kind, date, years })) });
});
portalRouter.get('/announcements', (req, res) => {
  const t = dateStr(new Date()), e = req.me;
  res.json(db.prepare(`SELECT id, title, body, pinned, created FROM announcements WHERE (starts IS NULL OR starts<=?) AND (ends IS NULL OR ends>=?)
    AND (audience='all' OR (audience='department' AND department_id=?) OR (audience='branch' AND branch_id=?)) ORDER BY pinned DESC, id DESC LIMIT 20`).all(t, t, e.department_id ?? -1, e.branch_id ?? -1));
});

// ---------- meetings I am invited to ----------
portalRouter.get('/meetings', (req, res) => res.json(db.prepare(`SELECT m.id, m.title, m.start_ts, m.end_ts, m.agenda, COALESCE(r.name, m.place) AS place, o.name AS organizer, a.rsvp FROM meeting_attendees a JOIN meetings m ON m.id=a.meeting_id
  LEFT JOIN rooms r ON r.id=m.room_id LEFT JOIN employees o ON o.id=m.organizer_id WHERE a.employee_id=? AND m.status='scheduled' AND m.end_ts>=? AND m.start_ts<=? ORDER BY m.start_ts LIMIT 50`).all(req.me.id, stamp().slice(0, 16), addDays(dateStr(new Date()), 60) + ' 23:59')));
portalRouter.post('/meetings/:id/rsvp', (req, res) => {
  if (!['yes', 'no'].includes(req.body?.rsvp)) return fail(res, 'Answer yes or no');
  const r = db.prepare("UPDATE meeting_attendees SET rsvp=? WHERE meeting_id=? AND employee_id=?").run(req.body.rsvp, req.params.id, req.me.id);
  r.changes ? res.json({ ok: true }) : fail(res, 'You are not invited to this meeting', 404);
});

// ---------- reporting manager: the team ----------
const team = (req) => db.prepare('SELECT id, code, name FROM employees WHERE manager_id=? AND active=1 ORDER BY name').all(req.me.id);
portalRouter.get('/team', (req, res) => {
  const t = dateStr(new Date()), members = team(req);
  const rows = new Map(attendanceReport(t, t, { employeeIds: members.map(m => m.id) }).map(r => [r.employee_id, r]));
  res.json({ date: t, members: members.map(m => ({ ...m, status: rows.get(m.id)?.status ?? '', in: rows.get(m.id)?.in ?? null, out: rows.get(m.id)?.out ?? null, shift: rows.get(m.id)?.shift ?? '' })) });
});
portalRouter.get('/team/pending', (req, res) => {
  const me = req.me.id, q = (sql) => db.prepare(sql).all(me), mine = (kind, table, rows) => rows.filter(r => { const full = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.id); return !full || waitingOnManager(kind, full); }); // with an approval workflow, only what is at the manager's step
  const P = {
    leaves: q("SELECT l.id, e.name AS employee, l.type, l.from_date, l.to_date, l.days, l.note FROM leaves l JOIN employees e ON e.id=l.employee_id WHERE e.manager_id=? AND l.status='pending' ORDER BY l.from_date"),
    attendance: q("SELECT r.id, e.name AS employee, r.date, r.kind, r.time, r.status_text, r.reason FROM attendance_requests r JOIN employees e ON e.id=r.employee_id WHERE e.manager_id=? AND r.status='pending' ORDER BY r.date"),
    shifts: q("SELECT r.id, e.name AS employee, o.name AS other_employee, s.name AS shift, r.kind, r.from_date, r.to_date, r.reason FROM shift_requests r JOIN employees e ON e.id=r.employee_id LEFT JOIN employees o ON o.id=r.other_employee_id LEFT JOIN shifts s ON s.id=r.shift_id WHERE e.manager_id=? AND r.status='pending' ORDER BY r.from_date"),
    overtime: q("SELECT r.id, e.name AS employee, r.date, r.calc_minutes FROM overtime_requests r JOIN employees e ON e.id=r.employee_id WHERE e.manager_id=? AND r.status='pending' AND r.kind='auto' ORDER BY r.date") };
  res.json({ leaves: mine('leave', 'leaves', P.leaves), attendance: mine('attendance', 'attendance_requests', P.attendance), shifts: mine('shift', 'shift_requests', P.shifts), overtime: mine('overtime', 'overtime_requests', P.overtime) });
});
const OWNER = { leave: "SELECT employee_id FROM leaves WHERE id=?", attendance: 'SELECT employee_id FROM attendance_requests WHERE id=?', shift: 'SELECT employee_id FROM shift_requests WHERE id=?', overtime: 'SELECT employee_id FROM overtime_requests WHERE id=?' };
portalRouter.post('/team/:kind/:id/:action', (req, res) => {
  const { kind, id, action } = req.params;
  if (!OWNER[kind] || !['approve', 'reject'].includes(action)) return fail(res, 'Unknown request');
  const o = db.prepare(OWNER[kind]).get(id);
  if (!o) return fail(res, 'No such request', 404);
  if (db.prepare('SELECT manager_id FROM employees WHERE id=?').get(o.employee_id)?.manager_id !== req.me.id) return fail(res, 'That request is not from someone who reports to you', 403);
  const note = req.body?.note ?? null, who = actor(req);
  const err = kind === 'leave' ? decideLeave(id, action === 'approve' ? 'approved' : 'rejected', note, who)
    : kind === 'attendance' ? decideAttendanceRequest(id, action, note, who)
    : kind === 'shift' ? decideShiftRequest(id, action, note, who)
    : decideOvertime(id, action, { note }, who);
  err ? fail(res, err) : res.json({ ok: true, ...takeAdvance() });
});

// ================= staff side (behind the normal staff login) =================
export const portalAdminRouter = express.Router();
const PW = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genPassword = () => Array.from(randomBytes(10), b => PW[b % PW.length]).slice(0, 10).join('');

portalAdminRouter.get('/portal-accounts', (req, res) => {
  const sc = scopeClause('e'), q = req.query.q ? `%${req.query.q}%` : '%';
  res.json(db.prepare(`SELECT e.id AS employee_id, e.code, e.name, e.active, a.employee_id IS NOT NULL AS has_account, a.enabled, a.mobile_enabled, a.must_change, a.last_login, a.locked_until
    FROM employees e LEFT JOIN employee_accounts a ON a.employee_id=e.id WHERE e.active=1 AND (e.name LIKE ? OR e.code LIKE ?)${sc.sql} ORDER BY CAST(e.code AS INTEGER), e.code LIMIT 1000`).all(q, q, ...sc.args));
});
// Create accounts (or reset passwords). The new passwords are returned once; they are stored only as hashes.
portalAdminRouter.post('/portal-accounts', (req, res) => {
  const sc = scopeClause('e'), b = req.body ?? {};
  let emps = db.prepare(`SELECT e.id, e.code, e.name FROM employees e WHERE e.active=1${sc.sql}`).all(...sc.args);
  if (!b.all) { const want = new Set((b.employee_ids ?? []).map(Number)); emps = emps.filter(e => want.has(e.id)); }
  const have = new Set(db.prepare('SELECT employee_id FROM employee_accounts').all().map(r => r.employee_id));
  const out = [];
  for (const e of emps) {
    if (have.has(e.id) && !b.reset) continue;
    const password = genPassword();
    db.prepare(`INSERT INTO employee_accounts(employee_id, pass, must_change) VALUES(?,?,1) ON CONFLICT(employee_id) DO UPDATE SET pass=excluded.pass, must_change=1, fails=0, locked_until=NULL`).run(e.id, hash(password));
    for (const [t, s] of sessions) if (s.id === e.id) sessions.delete(t);
    out.push({ employee_id: e.id, code: e.code, name: e.name, password });
  }
  res.json({ created: out.length, accounts: out });
});
portalAdminRouter.put('/portal-accounts/:employeeId', (req, res) => {
  const b = req.body ?? {}, a = db.prepare('SELECT 1 FROM employee_accounts WHERE employee_id=?').get(req.params.employeeId);
  if (!a) return fail(res, 'This employee has no portal account', 404);
  for (const k of ['enabled', 'mobile_enabled']) if (k in b) db.prepare(`UPDATE employee_accounts SET ${k}=? WHERE employee_id=?`).run(b[k] ? 1 : 0, req.params.employeeId);
  if (b.enabled === false || b.enabled === 0) for (const [t, s] of sessions) if (s.id === +req.params.employeeId) sessions.delete(t);
  res.json({ ok: true });
});
portalAdminRouter.delete('/portal-accounts/:employeeId', (req, res) => {
  db.prepare('DELETE FROM employee_accounts WHERE employee_id=?').run(req.params.employeeId);
  for (const [t, s] of sessions) if (s.id === +req.params.employeeId) sessions.delete(t);
  res.json({ ok: true });
});

// work locations
const siteBody = (b, partial) => {
  const o = {}, num = (k, lo, hi, label) => { if (k in b) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) return `${label} must be between ${lo} and ${hi}`; o[k] = v; } return null; };
  if (!partial || 'name' in b) { if (!String(b.name ?? '').trim()) return { error: 'Name required' }; o.name = String(b.name).trim().slice(0, 80); }
  for (const err of [num('lat', -90, 90, 'Latitude'), num('lng', -180, 180, 'Longitude'), num('radius_m', 10, 5000, 'Radius (m)'), num('max_accuracy_m', 10, 1000, 'Allowed GPS error (m)')]) if (err) return { error: err };
  if (!partial && (!('lat' in b) || !('lng' in b))) return { error: 'Latitude and longitude required' };
  if ('branch_id' in b) { if (b.branch_id && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(b.branch_id)) return { error: 'Unknown branch' }; o.branch_id = b.branch_id || null; }
  for (const k of ['all_employees', 'active']) if (k in b) o[k] = b[k] ? 1 : 0;
  return { o };
};
portalAdminRouter.get('/geo_sites', (_q, res) => res.json(db.prepare(`SELECT g.*, b.name AS branch, (SELECT COUNT(*) FROM employee_sites WHERE site_id=g.id) AS employees FROM geo_sites g LEFT JOIN branches b ON b.id=g.branch_id ORDER BY g.name`).all()));
portalAdminRouter.post('/geo_sites', (req, res) => {
  const { o, error } = siteBody(req.body ?? {}, false); if (error) return fail(res, error);
  const c = Object.keys(o);
  try { res.json({ id: Number(db.prepare(`INSERT INTO geo_sites(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); } catch { fail(res, 'A location with this name exists'); }
});
portalAdminRouter.put('/geo_sites/:id', (req, res) => {
  const { o, error } = siteBody(req.body ?? {}, true); if (error) return fail(res, error);
  const c = Object.keys(o); if (c.length) db.prepare(`UPDATE geo_sites SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id);
  res.json({ ok: true });
});
portalAdminRouter.delete('/geo_sites/:id', (req, res) => { db.prepare('DELETE FROM geo_sites WHERE id=?').run(req.params.id); res.json({ ok: true }); });
portalAdminRouter.get('/geo_sites/:id/employees', (req, res) => res.json(db.prepare('SELECT employee_id FROM employee_sites WHERE site_id=?').all(req.params.id).map(r => r.employee_id)));
portalAdminRouter.put('/geo_sites/:id/employees', (req, res) => {
  if (!db.prepare('SELECT 1 FROM geo_sites WHERE id=?').get(req.params.id)) return fail(res, 'No such location', 404);
  const sc = scopeClause('e'), ok = new Set(db.prepare(`SELECT e.id FROM employees e WHERE 1=1${sc.sql}`).all(...sc.args).map(r => r.id));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM employee_sites WHERE site_id=? AND employee_id IN (SELECT e.id FROM employees e WHERE 1=1' + sc.sql + ')').run(req.params.id, ...sc.args);
    for (const id of new Set((req.body?.employee_ids ?? []).map(Number))) if (ok.has(id)) db.prepare('INSERT OR IGNORE INTO employee_sites(employee_id, site_id) VALUES(?,?)').run(id, req.params.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return fail(res, e.message); }
  res.json({ ok: true });
});

// announcements
const annBody = (b) => {
  if (!String(b.title ?? '').trim()) return { error: 'Title required' };
  const audience = b.audience ?? 'all';
  if (!['all', 'department', 'branch'].includes(audience)) return { error: 'Audience must be all, department or branch' };
  if (audience === 'department' && !db.prepare('SELECT 1 FROM departments WHERE id=?').get(b.department_id)) return { error: 'Choose a department' };
  if (audience === 'branch' && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(b.branch_id)) return { error: 'Choose a branch' };
  for (const k of ['starts', 'ends']) if (b[k] && !/^\d{4}-\d\d-\d\d$/.test(b[k])) return { error: `${k} must be YYYY-MM-DD` };
  if (b.starts && b.ends && b.ends < b.starts) return { error: 'The end date is before the start date' };
  return { o: { title: String(b.title).trim().slice(0, 150), body: String(b.body ?? '').slice(0, 4000), audience, department_id: audience === 'department' ? b.department_id : null, branch_id: audience === 'branch' ? b.branch_id : null, starts: b.starts || null, ends: b.ends || null, pinned: b.pinned ? 1 : 0 } };
};
portalAdminRouter.get('/announcements', (_q, res) => res.json(db.prepare(`SELECT a.*, d.name AS department, b.name AS branch FROM announcements a LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN branches b ON b.id=a.branch_id ORDER BY a.pinned DESC, a.id DESC LIMIT 200`).all()));
portalAdminRouter.post('/announcements', (req, res) => {
  const { o, error } = annBody(req.body ?? {}); if (error) return fail(res, error);
  const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO announcements(${c}, created_by) VALUES(${c.map(() => '?')}, ?)`).run(...c.map(k => o[k]), req.user).lastInsertRowid) });
});
portalAdminRouter.put('/announcements/:id', (req, res) => {
  const { o, error } = annBody(req.body ?? {}); if (error) return fail(res, error);
  const c = Object.keys(o); db.prepare(`UPDATE announcements SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true });
});
portalAdminRouter.delete('/announcements/:id', (req, res) => { db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// review of phone punches
portalAdminRouter.get('/attendance/mobile', (req, res) => {
  const sc = scopeClause('e'), to = req.query.to || dateStr(new Date()), from = req.query.from || addDays(to, -7), w = [];
  if (req.query.flagged === '1') w.push('AND m.flagged=1');
  res.json(db.prepare(`SELECT m.id, m.log_id, m.ts, m.lat, m.lng, m.accuracy, m.distance_m, m.inside, m.flagged, m.note, e.code, e.name AS employee, s.name AS site
    FROM mobile_punches m JOIN employees e ON e.id=m.employee_id LEFT JOIN geo_sites s ON s.id=m.site_id WHERE m.ts>=? AND m.ts<?${sc.sql} ${w.join(' ')} ORDER BY m.ts DESC LIMIT 500`).all(from + ' 00:00:00', addDays(to, 1) + ' 00:00:00', ...sc.args));
});
