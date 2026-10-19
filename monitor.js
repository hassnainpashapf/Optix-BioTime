import express from 'express';
import { db, getSettings } from './db.js';
import { attendanceReport, PRESENT } from './report.js';
import { dateStr, addDays } from './dates.js';
import { scopeClause } from './rbac.js';
import { pushOnline } from './devices.js';

export const monitorRouter = express.Router();
const OFF = ['Weekly Off', 'Holiday'], LEAVE = ['Leave', 'Unpaid Leave'], WAITING = ['Pending', 'Absent'];

// Live view across all branches: who is in, who is not in yet, the latest punches, and whether each branch's devices are up.
monitorRouter.get('/monitor', (req, res) => {
  const t = dateStr(new Date()), S = getSettings(), rows = attendanceReport(t, t), by = new Map(), blank = () => ({ employees: 0, present: 0, late: 0, not_in: 0, on_leave: 0, devices: 0, devices_online: 0 });
  const slot = (name) => { if (!by.has(name)) by.set(name, { name, ...blank() }); return by.get(name); };
  for (const r of rows) {
    if (OFF.includes(r.status)) continue; const b = slot(r.branch || '(no branch)'); b.employees++;
    if (PRESENT.includes(r.status)) b.present++; if (r.status === 'Late') b.late++; if (WAITING.includes(r.status)) b.not_in++; if (LEAVE.includes(r.status)) b.on_leave++;
  }
  const nowMs = Date.now();
  for (const d of db.prepare("SELECT d.*, g.branch_id, br.name AS branch FROM devices d LEFT JOIN device_groups g ON g.id=d.group_id LEFT JOIN branches br ON br.id=g.branch_id WHERE d.approved=1").all()) {
    const b = slot(d.branch || '(no branch)'); b.devices++; if (d.sn ? (d.last_seen && pushOnline(d, nowMs, S)) : d.online) b.devices_online++;
  }
  const sc = scopeClause('e');
  const feed = db.prepare(`SELECT l.id, l.ts, l.emp_code AS code, e.id AS employee_id, e.photo IS NOT NULL AS has_photo, e.name, br.name AS branch, l.source, v.name AS device, l.temp_c FROM logs l ${sc.sql ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code
    LEFT JOIN branches br ON br.id=e.branch_id LEFT JOIN devices v ON v.id=l.device_id WHERE l.ts>=? AND l.ts<?${sc.sql} ORDER BY l.id DESC LIMIT ?`).all(t + ' 00:00:00', addDays(t, 1) + ' 00:00:00', ...sc.args, Math.min(100, Number(req.query.limit) || 30));
  if (!feed.length && req.query.recent) feed.push(...db.prepare(`SELECT l.id, l.ts, l.emp_code AS code, e.id AS employee_id, e.photo IS NOT NULL AS has_photo, e.name, br.name AS branch, l.source, v.name AS device, l.temp_c FROM logs l ${sc.sql ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code
    LEFT JOIN branches br ON br.id=e.branch_id LEFT JOIN devices v ON v.id=l.device_id WHERE 1=1${sc.sql} ORDER BY l.id DESC LIMIT ?`).all(...sc.args, Math.min(100, Number(req.query.limit) || 30)));
  const branches = [...by.values()].sort((a, b) => a.name.localeCompare(b.name)), sum = (k) => branches.reduce((s, b) => s + b[k], 0);
  res.json({ now: new Date().toLocaleString('sv'), totals: Object.fromEntries(Object.keys(blank()).map(k => [k, sum(k)])), branches, feed });
});

// Mask & Temperature Detection (MTD): punches with the body temperature and mask flag the device reported. Abnormal = temperature at or above the alert temperature, or no mask (mask=0).
monitorRouter.get('/mtd/records', (req, res) => {
  const S = getSettings(), thr = Number(S.temp_alert_c) || 0, t = dateStr(new Date()), from = /^\d{4}-\d\d-\d\d$/.test(req.query.from ?? '') ? req.query.from : t, to = /^\d{4}-\d\d-\d\d$/.test(req.query.to ?? '') ? req.query.to : t, sc = scopeClause('e');
  const rows = db.prepare(`SELECT l.id, l.ts, l.emp_code AS code, e.id AS employee_id, e.photo IS NOT NULL AS has_photo, e.name, d.name AS department, br.name AS branch, v.name AS device, l.temp_c, l.mask FROM logs l ${sc.sql ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code LEFT JOIN departments d ON d.id=e.department_id
    LEFT JOIN branches br ON br.id=e.branch_id LEFT JOIN devices v ON v.id=l.device_id WHERE l.ts>=? AND l.ts<?${sc.sql} ORDER BY l.id DESC LIMIT ?`).all(from + ' 00:00:00', addDays(to, 1) + ' 00:00:00', ...sc.args, Math.min(500, Number(req.query.limit) || 100))
    .map(r => ({ ...r, abnormal: !!((thr && r.temp_c != null && r.temp_c >= thr) || r.mask === 0), hot: !!(thr && r.temp_c != null && r.temp_c >= thr) }));
  res.json({ threshold: thr, from, to, rows, abnormal: rows.filter(r => r.abnormal).length, total: rows.length });
});

// MTD dashboard numbers: today's status by person, by department, and the month day by day.
monitorRouter.get('/mtd/summary', (req, res) => {
  const S = getSettings(), thr = Number(S.temp_alert_c) || 0, t = dateStr(new Date()), month = /^\d{4}-\d\d$/.test(req.query.month ?? '') ? req.query.month : t.slice(0, 7), sc = scopeClause('e');
  const emps = db.prepare(`SELECT e.id, e.code, COALESCE(d.name,'(no department)') AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql}`).all(...sc.args);
  const kindOf = (r) => !r ? 'unchecked' : (thr && r.temp_c != null && r.temp_c >= thr) ? 'abnormal' : r.mask === 0 ? 'nomask' : (r.temp_c != null || r.mask != null) ? 'normal' : 'unchecked';
  const today = db.prepare("SELECT emp_code, temp_c, mask, ts FROM logs WHERE ts>=? AND ts<? AND (temp_c IS NOT NULL OR mask IS NOT NULL) ORDER BY ts").all(t + ' 00:00:00', addDays(t, 1) + ' 00:00:00'), last = new Map();
  for (const r of today) { const o = last.get(r.emp_code); if (!o || (kindOf(o) !== 'abnormal' && kindOf(r) === 'abnormal') || (kindOf(o) === 'normal' && kindOf(r) === 'nomask') || kindOf(o) === kindOf(r) || kindOf(o) === 'unchecked') last.set(r.emp_code, r); }
  const daily = { abnormal: 0, nomask: 0, unchecked: 0, normal: 0, total: emps.length, date: t }, dept = new Map();
  for (const e of emps) { const k = kindOf(last.get(e.code)); daily[k]++; const d = dept.get(e.dept) ?? { dept: e.dept, abnormal: 0, nomask: 0, unchecked: 0, normal: 0 }; d[k]++; dept.set(e.dept, d); }
  const from = month + '-01'; let to = from; while (addDays(to, 1).startsWith(month)) to = addDays(to, 1);
  const logs = db.prepare(`SELECT l.ts, l.temp_c, l.mask FROM logs l ${sc.sql ? 'JOIN employees e ON e.code=l.emp_code' : ''} WHERE l.ts>=? AND l.ts<?${sc.sql ? sc.sql.replace(/e\./g, 'e.') : ''}`).all(from + ' 00:00:00', addDays(to, 1) + ' 00:00:00', ...sc.args);
  const days = new Map(); for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, { date: d, temps: [], abnormal: 0, nomask: 0 });
  for (const r of logs) { const x = days.get(r.ts.slice(0, 10)); if (!x) continue; if (r.temp_c != null) { x.temps.push(r.temp_c); if (thr && r.temp_c >= thr) x.abnormal++; } if (r.mask === 0) x.nomask++; }
  res.json({ threshold: thr, daily, departments: [...dept.values()], month, monthly: [...days.values()].map(x => ({ date: x.date, avg_temp: x.temps.length ? Math.round(x.temps.reduce((a, b) => a + b, 0) / x.temps.length * 10) / 10 : null, max_temp: x.temps.length ? Math.max(...x.temps) : null, abnormal: x.abnormal, nomask: x.nomask, future: x.date > t })) });
});

// Total worked hours and overtime hours this month, by department (the "Monthly summary" on the dashboard).
monitorRouter.get('/dashboard/monthly', (req, res) => {
  const t = dateStr(new Date()), month = /^\d{4}-\d\d$/.test(req.query.month ?? '') ? req.query.month : t.slice(0, 7), from = month + '-01';
  let to = from; while (addDays(to, 1).startsWith(month)) to = addDays(to, 1); if (to > t) to = t;
  const by = new Map();
  for (const r of attendanceReport(from, to)) { const k = r.dept || 'No department', e = by.get(k) ?? { dept: k, worked_h: 0, ot_h: 0, people: new Set() }; e.worked_h += r.worked_min / 60; e.ot_h += r.overtime_min / 60; if (r.worked_min) e.people.add(r.code); by.set(k, e); }
  res.json({ month, rows: [...by.values()].map(e => ({ dept: e.dept, worked_h: Math.round(e.worked_h * 10) / 10, ot_h: Math.round(e.ot_h * 10) / 10, people: e.people.size })).sort((a, b) => b.worked_h - a.worked_h) });
});

// ---------- dashboard widgets each person can switch on, off and reorder ----------
export const WIDGETS = { pending: 'Waiting for your approval', not_in: 'Not in yet today', late_today: 'Late today', on_leave: 'Away today (leave, on duty)', live: 'Latest punches', trend7: 'Last 7 days', devices: 'Device status',
  birthdays: 'Birthdays in the next 14 days', anniversaries: 'Work anniversaries in the next 14 days', headcount: 'People by department' };
const DEFAULT_WIDGETS = ['pending', 'not_in', 'late_today', 'live'];
const prefsOf = (u) => { try { const w = JSON.parse(u.dash_prefs ?? 'null')?.widgets; return Array.isArray(w) ? w.filter(x => WIDGETS[x]) : DEFAULT_WIDGETS; } catch { return DEFAULT_WIDGETS; } };
monitorRouter.get('/dashboard/prefs', (req, res) => res.json({ widgets: prefsOf(req.userRow), available: Object.entries(WIDGETS).map(([id, title]) => ({ id, title })) }));
monitorRouter.put('/dashboard/prefs', (req, res) => {
  const w = [...new Set(req.body?.widgets ?? [])];
  if (!Array.isArray(req.body?.widgets) || w.some(x => !WIDGETS[x])) return res.status(400).json({ error: 'Unknown widget' });
  db.prepare('UPDATE users SET dash_prefs=? WHERE id=?').run(JSON.stringify({ widgets: w }), req.userRow.id); res.json({ ok: true });
});
const upcoming = (md, days) => { const t = new Date(); for (let i = 0; i <= days; i++) { const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i); if (`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === md) return i; } return null; };
monitorRouter.get('/dashboard/widgets', (req, res) => {
  if ((req.perms?.attendance ?? 'none') === 'none') return res.json({}); // these widgets show people, so they follow the attendance permission
  const t = dateStr(new Date()), want = String(req.query.ids ?? '').split(',').filter(x => WIDGETS[x]), out = {}, sc = scopeClause('e');
  const need = (...k) => k.some(x => want.includes(x)), today = need('not_in', 'late_today', 'on_leave') ? attendanceReport(t, t) : [];
  if (want.includes('not_in')) out.not_in = today.filter(r => WAITING.includes(r.status)).slice(0, 15).map(r => ({ name: r.name, dept: r.dept, shift: r.shift }));
  if (want.includes('late_today')) out.late_today = today.filter(r => r.status === 'Late').slice(0, 15).map(r => ({ name: r.name, dept: r.dept, in: r.in, late_min: r.late_min }));
  if (want.includes('on_leave')) out.on_leave = today.filter(r => [...LEAVE, 'On Duty', 'Work From Home', 'Training'].includes(r.status)).slice(0, 15).map(r => ({ name: r.name, dept: r.dept, status: r.status, note: r.note }));
  if (want.includes('live')) out.live = db.prepare(`SELECT l.ts, e.name, l.emp_code AS code, l.source FROM logs l ${sc.sql ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code WHERE l.ts>=?${sc.sql} ORDER BY l.id DESC LIMIT 8`).all(t + ' 00:00:00', ...sc.args);
  if (want.includes('trend7')) { const from = addDays(t, -6), m = new Map(); for (const r of attendanceReport(from, t)) { if (!r.status || OFF.includes(r.status) || r.status === 'Pending') continue; const x = m.get(r.date) ?? { date: r.date, present: 0, absent: 0 }; if (PRESENT.includes(r.status)) x.present++; else if (r.status === 'Absent') x.absent++; m.set(r.date, x); } out.trend7 = [...m.values()].sort((a, b) => a.date.localeCompare(b.date)); }
  if (want.includes('devices')) { const S = getSettings(), now = Date.now(); const ds = db.prepare('SELECT * FROM devices WHERE approved=1').all(); out.devices = { total: ds.length, online: ds.filter(d => d.sn ? d.last_seen && pushOnline(d, now, S) : d.online).length, waiting: db.prepare('SELECT COUNT(*) n FROM devices WHERE approved=0').get().n }; }
  if (need('birthdays', 'anniversaries')) {
    const emps = db.prepare(`SELECT e.name, e.dob, e.join_date FROM employees e WHERE e.active=1${sc.sql}`).all(...sc.args);
    if (want.includes('birthdays')) out.birthdays = emps.filter(e => e.dob).map(e => ({ name: e.name, in_days: upcoming(e.dob.slice(5), 14), date: e.dob.slice(5) })).filter(e => e.in_days !== null).sort((a, b) => a.in_days - b.in_days).slice(0, 12);
    if (want.includes('anniversaries')) out.anniversaries = emps.filter(e => e.join_date && +e.join_date.slice(0, 4) < new Date().getFullYear()).map(e => ({ name: e.name, in_days: upcoming(e.join_date.slice(5), 14), years: new Date().getFullYear() - +e.join_date.slice(0, 4) })).filter(e => e.in_days !== null).sort((a, b) => a.in_days - b.in_days).slice(0, 12);
  }
  if (want.includes('headcount')) out.headcount = db.prepare(`SELECT COALESCE(d.name,'(no department)') AS dept, COUNT(*) AS n FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql} GROUP BY d.name ORDER BY n DESC`).all(...sc.args);
  if (want.includes('pending')) { const c = (tb, w) => db.prepare(`SELECT COUNT(*) n FROM ${tb} t JOIN employees e ON e.id=t.employee_id WHERE ${w}${sc.sql}`).get(...sc.args).n; out.pending = { leaves: c('leaves', "t.status='pending'"), overtime: c('overtime_requests', "t.status='pending' AND t.kind='auto'"), requests: c('attendance_requests', "t.status='pending'"), shifts: c('shift_requests', "t.status='pending'") }; }
  res.json(out);
});
