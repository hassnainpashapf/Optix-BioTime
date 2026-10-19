import express from 'express';
import { db } from './db.js';
import { onEvent } from './events.js';
import { attendanceReport } from './report.js';
import { notify, CATALOG, prefsOf, optsOf, feedFor, ownerOf, KINDS } from './notify.js';

const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- the same preference screens for staff logins and for employees ----------
// who: 's' staff, 'e' employee. ctx(req) -> { owner, staff, employeeId }. canWatch(req, id) limits who can be put on a watch list.
export function mountAlertRoutes(router, who, ctx, canWatch = () => true) {
  router.get('/alerts', (req, res) => {
    const c = ctx(req), o = optsOf(c.owner);
    res.json({ prefs: prefsOf(c.owner, who), options: { quiet_start: o.quiet_start, quiet_end: o.quiet_end, watch_mode: o.watch_mode },
      watch: o.watch.map(id => db.prepare('SELECT id, code, name FROM employees WHERE id=?').get(id)).filter(Boolean) });
  });
  router.put('/alerts/prefs', (req, res) => {
    const c = ctx(req), { kind, enabled } = req.body ?? {}, k = KINDS.get(kind);
    if (!k || !k.for.includes(who)) return fail(res, 'Unknown alert');
    db.prepare('INSERT INTO alert_prefs(owner, kind, enabled) VALUES(?,?,?) ON CONFLICT(owner, kind) DO UPDATE SET enabled=excluded.enabled').run(c.owner, kind, enabled ? 1 : 0);
    res.json({ ok: true });
  });
  router.put('/alerts/options', (req, res) => {
    const c = ctx(req), b = req.body ?? {}, cur = optsOf(c.owner);
    const qs = 'quiet_start' in b ? (b.quiet_start || null) : cur.quiet_start, qe = 'quiet_end' in b ? (b.quiet_end || null) : cur.quiet_end, wm = 'watch_mode' in b ? b.watch_mode : cur.watch_mode;
    for (const t of [qs, qe]) if (t && !HHMM.test(t)) return fail(res, 'Quiet hours must be HH:MM');
    if (!!qs !== !!qe) return fail(res, 'Give both the start and the end of quiet hours, or neither');
    if (!['all', 'watch'].includes(wm)) return fail(res, 'Arrivals can be for everyone or only the watch list');
    db.prepare('INSERT INTO alert_opts(owner, quiet_start, quiet_end, watch_mode) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET quiet_start=excluded.quiet_start, quiet_end=excluded.quiet_end, watch_mode=excluded.watch_mode').run(c.owner, qs, qe, wm);
    res.json({ ok: true });
  });
  router.post('/alerts/watch', (req, res) => {
    const c = ctx(req), id = Number(req.body?.employee_id);
    if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(id) || !canWatch(req, id)) return fail(res, 'You cannot watch this person');
    db.prepare('INSERT OR IGNORE INTO alert_watch(owner, employee_id) VALUES(?,?)').run(c.owner, id); res.json({ ok: true });
  });
  router.delete('/alerts/watch/:id', (req, res) => { db.prepare('DELETE FROM alert_watch WHERE owner=? AND employee_id=?').run(ctx(req).owner, req.params.id); res.json({ ok: true }); });
  router.get('/alerts/feed', (req, res) => { const c = ctx(req); res.json(feedFor(c.owner, { staff: c.staff, employeeId: c.employeeId, since: Number(req.query.since) || 0, limit: req.query.limit })); });
  router.post('/alerts/test', (req, res) => { // a test alert to yourself, so you can see how it arrives
    const c = ctx(req);
    if (c.staff) notify({ title: 'Test alert', body: `Sent by ${req.user} at ${new Date().toLocaleTimeString('en-GB').slice(0, 5)}`, kind: 'automation' });
    else notify({ audience: 'employee', employee_id: c.employeeId, title: 'Test alert', body: 'If you can read this, alerts reach you.', kind: 'automation' });
    res.json({ ok: true });
  });
}
export const alertsRouter = express.Router();
mountAlertRoutes(alertsRouter, 's', (req) => ({ owner: ownerOf.staff(req.user), staff: true }));

// ---------- live punch alerts: who arrived, who left, who is late ----------
const hhmm = (ts) => String(ts).slice(11, 16);
export function punchAlerts(punches, now = Date.now()) {
  for (const p of (punches ?? []).slice(0, 200)) {
    const t = Date.parse(String(p.time).replace(' ', 'T')); if (!t || t < now - 3 * 3600000 || t > now + 10 * 60000) continue; // old punches synced from a device are not news
    const e = db.prepare('SELECT e.id, e.name, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.code=?').get(String(p.code)); if (!e) continue;
    const day = String(p.time).slice(0, 10), first = db.prepare('SELECT MIN(ts) m FROM logs WHERE emp_code=? AND substr(ts,1,10)=?').get(String(p.code), day).m, isIn = !first || p.time <= first;
    const dev = p.device_id ? db.prepare('SELECT name FROM devices WHERE id=?').get(p.device_id)?.name : (p.source === 'mobile' ? 'Phone' : '');
    notify({ audience: 'feed', employee_id: e.id, kind: 'punch', title: `${e.name} punched ${isIn ? 'in' : 'out'} at ${hhmm(p.time)}`, body: [dev, e.dept].filter(Boolean).join(' · '), link: 'Attendance' });
    notify({ audience: 'employee', employee_id: e.id, kind: 'my_punch', title: `Punch recorded at ${hhmm(p.time)}`, body: isIn ? 'Have a good day.' : 'See you tomorrow.' });
    if (isIn) {
      const r = attendanceReport(day, day, { employeeId: e.id })[0];
      if (r?.status === 'Late') notify({ audience: 'feed', employee_id: e.id, kind: 'late', title: `${e.name} is late: ${r.late_min} min`, body: `In at ${r.in}${r.shift ? ' · ' + r.shift : ''}`, link: 'Exceptions' });
    }
  }
}
onEvent((event, data) => { if (event === 'punch.created') punchAlerts(data.punches); });
