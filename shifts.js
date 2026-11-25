import express from 'express';
import { db } from './db.js';
import { addDays, dateStr, dayMin } from './dates.js';
import { gate, takeAdvance } from './workflow.js';
import { notify, notifyManager } from './notify.js';
import { scopeClause } from './rbac.js';

export const shiftsRouter = express.Router();
const DATE = /^\d{4}-\d\d-\d\d$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
export const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const dowOf = (day) => new Date(dayMin(day) * 60000).getUTCDay();
const stamp = () => new Date().toLocaleString('sv');

// ---------- helpers used by the report engine ----------
// "6:2,4;0:*" = Saturday off on the 2nd and 4th Saturday of the month, every Sunday off.
export const validAltOff = (s) => !s || String(s).split(';').every(r => /^[0-6]:(\*|[1-5](,[1-5])*)$/.test(r.trim()));
export function altOffDay(sh, day) {
  if (!sh?.alt_off) return false;
  const d = new Date(dayMin(day) * 60000), occ = Math.ceil(d.getUTCDate() / 7);
  return String(sh.alt_off).split(';').some(r => { const [w, o] = r.trim().split(':'); return +w === d.getUTCDay() && (o === '*' || o.split(',').map(Number).includes(occ)); });
}
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
// Minutes between first and last punch that are not paid work: a split shift's gap, or the shift's break window.
export function breakMinutes(sh, d0, overnight, pts, inM, outM) {
  if (sh.type === 'split' && sh.seg2_start) {
    if (pts.length >= 4) return Math.max(0, pts[2] - pts[1]);          // real gap between the 2nd and 3rd punch
    return overlap(inM, outM, d0 + toMin(sh.end), d0 + toMin(sh.seg2_start)); // otherwise the scheduled gap
  }
  if (sh.break_start && sh.break_end && sh.type !== 'flexible') {
    let a = d0 + toMin(sh.break_start), b = d0 + toMin(sh.break_end);
    if (overnight && toMin(sh.break_start) < toMin(sh.start)) { a += 1440; b += 1440; }
    if (b <= a) b += 1440;
    return overlap(inM, outM, a, b);
  }
  return 0;
}

// Paid hours in a day for this shift (used for the overtime hourly rate).
export function shiftPaidHours(s) {
  if (!s?.start) return 8;
  if (s.type === 'flexible') return (s.required_min || 480) / 60;
  const span = (a, b) => (toMin(b) - toMin(a) + 1440) % 1440;
  if (s.type === 'split' && s.seg2_start) return (span(s.start, s.end) + span(s.seg2_start, s.seg2_end)) / 60;
  const total = span(s.start, s.end) || 480, brk = s.break_start && s.break_end ? span(s.break_start, s.break_end) : 0;
  return (total - brk) / 60;
}

// Which shift applies to this employee on this day? Roster entry > rotation > employee's shift (or the alternate nearest the first punch) > department's shift.
export function shiftResolver(from, to) {
  const shifts = new Map(db.prepare('SELECT * FROM shifts').all().map(s => [s.id, s]));
  const deptShift = new Map(db.prepare('SELECT id, shift_id FROM departments').all().map(d => [d.id, d.shift_id]));
  const roster = new Map();
  for (const r of db.prepare('SELECT * FROM schedules WHERE to_date>=? AND from_date<=?').all(from, to)) { if (!roster.has(r.employee_id)) roster.set(r.employee_id, []); roster.get(r.employee_id).push(r); }
  const rot = new Map();
  for (const st of db.prepare('SELECT * FROM rotation_steps ORDER BY rotation_id, seq').all()) { const r = rot.get(st.rotation_id) ?? { steps: [], cycle: 0 }; r.steps.push(st); r.cycle += st.days; rot.set(st.rotation_id, r); }
  const extras = new Map();
  for (const x of db.prepare('SELECT * FROM employee_shifts').all()) { if (!extras.has(x.employee_id)) extras.set(x.employee_id, []); extras.get(x.employee_id).push(x.shift_id); }
  // department / group schedules with dates (Attendance > Schedule Assignment); the tables belong to zk-attsetup.js and may not exist yet
  const ranged = (t, key) => { const m = new Map(); try { for (const r of db.prepare(`SELECT * FROM ${t} WHERE end_date>=? AND start_date<=? ORDER BY id`).all(from, to)) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } } catch { /* no table */ } return m; };
  const grpSched = ranged('att_group_sched', 'group_id'), deptSched = ranged('att_dept_sched', 'department_id');
  const inRange = (list, day) => (list ?? []).findLast(x => x.start_date <= day && day <= x.end_date);
  const kids = new Map(); for (const s of shifts.values()) if (s.child_of) { if (!kids.has(s.child_of)) kids.set(s.child_of, new Map()); kids.get(s.child_of).set(s.timetable_id, s); }
  const pats = new Map(); for (const s of shifts.values()) if (kids.has(s.id)) { try { pats.set(s.id, JSON.parse(s.pattern)); } catch { /* ignore */ } }
  // a grid shift with several timetables: the cell of this day (Week: Sun..Sat by week of cycle; Month: day of month; Day: day of cycle) picks the child shift, an empty cell is a day off
  const cell = (sh, day) => {
    const pat = pats.get(sh.id); if (!pat) return undefined;
    const t = new Date(dayMin(day) * 60000), days = Math.floor(dayMin(day) / 1440), n = pat.length, u = sh.shift_unit || 'Week';
    const [r, c] = u === 'Week' ? [Math.floor((days + 4) / 7) % n, t.getUTCDay()] : u === 'Month' ? [(t.getUTCFullYear() * 12 + t.getUTCMonth()) % n, t.getUTCDate() - 1] : [days % n, 0];
    const tid = pat[r]?.[c]; return tid ? { sh: kids.get(sh.id).get(tid) ?? null, off: false, fromRotation: true, source: 'grid' } : { sh: null, off: true, fromRotation: true, source: 'grid' };
  };
  const base = (e, day, firstPunchTod) => {
    const sch = (roster.get(e.id) ?? []).find(x => x.from_date <= day && day <= x.to_date);
    if (sch) return { sh: shifts.get(sch.shift_id) ?? null, off: false, fromRotation: false, source: 'roster' };
    const R = e.rotation_id && e.rotation_anchor ? rot.get(e.rotation_id) : null;
    if (R && R.cycle > 0) {
      let i = (((dayMin(day) - dayMin(e.rotation_anchor)) / 1440) % R.cycle + R.cycle) % R.cycle;
      for (const st of R.steps) { if (i < st.days) return st.shift_id ? { sh: shifts.get(st.shift_id) ?? null, off: false, fromRotation: true, source: 'rotation' } : { sh: null, off: true, fromRotation: true, source: 'rotation' }; i -= st.days; }
    }
    const cands = [e.shift_id, ...(extras.get(e.id) ?? [])].filter(Boolean).map(id => shifts.get(id)).filter(Boolean);
    if (cands.length > 1 && firstPunchTod !== null) { // several allowed shifts: the one starting closest to when they actually arrived
      const dist = (s) => { const d = Math.abs(toMin(s.start) - firstPunchTod); return Math.min(d, 1440 - d); };
      return { sh: cands.reduce((a, b) => (dist(b) < dist(a) ? b : a)), off: false, fromRotation: false, source: 'employee' };
    }
    if (cands.length) return { sh: cands[0], off: false, fromRotation: false, source: 'employee' };
    const gsr = e.group_id ? inRange(grpSched.get(e.group_id), day) : null;
    if (gsr && shifts.get(gsr.shift_id)) return { sh: shifts.get(gsr.shift_id), off: false, fromRotation: false, source: 'group' };
    const dsr = e.department_id ? inRange(deptSched.get(e.department_id), day) : null;
    if (dsr && shifts.get(dsr.shift_id)) return { sh: shifts.get(dsr.shift_id), off: false, fromRotation: false, source: 'department' };
    const ds = e.department_id ? shifts.get(deptShift.get(e.department_id)) : null;
    return { sh: ds ?? null, off: false, fromRotation: false, source: ds ? 'department' : 'none' };
  };
  return (e, day, firstPunchTod = null) => { const r = base(e, day, firstPunchTod); return (r.sh && cell(r.sh, day)) || r; };
}

// Put `shiftId` on the roster for an employee for [from, to], cutting any older roster entries that overlap.
export function setRoster(employeeId, from, to, shiftId) {
  const ins = db.prepare('INSERT INTO schedules(employee_id, shift_id, from_date, to_date) VALUES(?,?,?,?)');
  for (const r of db.prepare('SELECT * FROM schedules WHERE employee_id=? AND to_date>=? AND from_date<=?').all(employeeId, from, to)) {
    db.prepare('DELETE FROM schedules WHERE id=?').run(r.id);
    if (r.from_date < from) ins.run(employeeId, r.shift_id, r.from_date, addDays(from, -1));
    if (r.to_date > to) ins.run(employeeId, r.shift_id, addDays(to, 1), r.to_date);
  }
  ins.run(employeeId, shiftId, from, to);
}
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// ---------- shift definitions ----------
const SHIFT_FIELDS = ['name', 'code', 'type', 'start', 'end', 'grace_min', 'workdays', 'required_min', 'break_start', 'break_end', 'seg2_start', 'seg2_end', 'alt_off', 'late_to_absent_min', 'half_day_min', 'ot_policy_id', 'break_id'];
function cleanShift(b, partial) {
  const o = {};
  for (const f of SHIFT_FIELDS) if (f in b) o[f] = b[f] === '' ? null : b[f];
  const g = (f) => (f in o ? o[f] : null);
  if (!partial || 'name' in o) if (!String(o.name ?? '').trim()) return { error: 'Name required' };
  const type = o.type ?? (partial ? undefined : 'fixed');
  if (type !== undefined && !['fixed', 'flexible', 'split'].includes(type)) return { error: 'Type must be fixed, flexible or split' };
  for (const f of ['start', 'end', 'break_start', 'break_end', 'seg2_start', 'seg2_end']) if (o[f] && !TIME.test(o[f])) return { error: `${f} must be HH:MM` };
  if (!partial) { if (!o.start || !o.end) return { error: 'Start and end time required' }; }
  if (type === 'flexible' && !partial && !(Number(o.required_min) >= 60 && Number(o.required_min) <= 1440)) return { error: 'A flexible shift needs the hours to work (1 to 24)' };
  if (type === 'split' && !partial) {
    if (!o.seg2_start || !o.seg2_end) return { error: 'A split shift needs both parts' };
    if (!(toMin(o.start) < toMin(o.end) && toMin(o.end) < toMin(o.seg2_start) && toMin(o.seg2_start) < toMin(o.seg2_end))) return { error: 'Split shift parts must be in order: part 1 start < part 1 end < part 2 start < part 2 end' };
  }
  if (!!g('break_start') !== !!g('break_end') && ('break_start' in o || 'break_end' in o) && !partial) return { error: 'Give both break start and break end, or neither' };
  if ('grace_min' in o && !(Number(o.grace_min) >= 0)) return { error: 'Grace must be 0 or more' };
  if ('workdays' in o && !/^[0-6](,[0-6])*$/.test(String(o.workdays ?? ''))) return { error: 'Work days: numbers 0 (Sunday) to 6 (Saturday), comma separated' };
  if ('alt_off' in o && !validAltOff(o.alt_off)) return { error: 'Alternate off days look like 6:2,4 (Saturday on the 2nd and 4th week) or 0:*' };
  for (const f of ['required_min', 'late_to_absent_min', 'half_day_min']) if (o[f] !== null && o[f] !== undefined && !(Number(o[f]) >= 0)) return { error: `${f} must be a number` };
  if (o.ot_policy_id && !db.prepare('SELECT 1 FROM ot_policies WHERE id=?').get(o.ot_policy_id)) return { error: 'Unknown overtime policy' };
  if (o.break_id) { const br = db.prepare('SELECT * FROM breaks WHERE id=?').get(o.break_id); if (!br) return { error: 'Unknown break time' }; o.break_start = br.start; o.break_end = br.end; } // a saved break supplies the times
  if (o.code) o.code = String(o.code).trim().slice(0, 4);
  return { o };
}
// ---------- saved break times ----------
const brClean = (b) => {
  const name = String(b.name ?? '').trim().slice(0, 40); if (!name) return { error: 'Name required' };
  if (!TIME.test(b.start ?? '') || !TIME.test(b.end ?? '')) return { error: 'Break start and end must be HH:MM' };
  if (b.start === b.end) return { error: 'The break must last some time' };
  return { o: { name, start: b.start, end: b.end } };
};
shiftsRouter.get('/breaks', (_q, res) => res.json(db.prepare('SELECT b.*, (SELECT COUNT(*) FROM shifts s WHERE s.break_id=b.id) AS shifts FROM breaks b ORDER BY b.start, b.name').all()));
shiftsRouter.post('/breaks', (req, res) => { const { o, error } = brClean(req.body ?? {}); if (error) return fail(res, error); try { res.json({ id: Number(db.prepare('INSERT INTO breaks(name, start, end) VALUES(?,?,?)').run(o.name, o.start, o.end).lastInsertRowid) }); } catch { fail(res, 'A break with this name exists'); } });
shiftsRouter.put('/breaks/:id', (req, res) => { // changing a break changes it for every shift that uses it
  if (!db.prepare('SELECT 1 FROM breaks WHERE id=?').get(req.params.id)) return fail(res, 'No such break', 404);
  const { o, error } = brClean(req.body ?? {}); if (error) return fail(res, error);
  try { db.prepare('UPDATE breaks SET name=?, start=?, end=? WHERE id=?').run(o.name, o.start, o.end, req.params.id); } catch { return fail(res, 'A break with this name exists'); }
  db.prepare('UPDATE shifts SET break_start=?, break_end=? WHERE break_id=?').run(o.start, o.end, req.params.id); res.json({ ok: true });
});
shiftsRouter.delete('/breaks/:id', (req, res) => { db.prepare('UPDATE shifts SET break_id=NULL WHERE break_id=?').run(req.params.id); db.prepare('DELETE FROM breaks WHERE id=?').run(req.params.id); res.json({ ok: true }); }); // shifts keep the times they had
shiftsRouter.get('/shifts', (_q, res) => res.json(db.prepare('SELECT * FROM shifts ORDER BY id').all()));
shiftsRouter.post('/shifts', (req, res) => {
  const { o, error } = cleanShift(req.body ?? {}, false); if (error) return fail(res, error);
  const cols = Object.keys(o);
  try { const r = db.prepare(`INSERT INTO shifts(${cols}) VALUES(${cols.map(() => '?')})`).run(...cols.map(c => o[c])); res.json({ id: Number(r.lastInsertRowid) }); }
  catch (e) { fail(res, e.message); }
});
shiftsRouter.put('/shifts/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such shift', 404);
  const merged = { ...old, ...req.body };
  const chk = cleanShift({ ...merged, type: merged.type ?? 'fixed' }, false); if (chk.error) return fail(res, chk.error);
  const cols = Object.keys(req.body ?? {}).filter(c => SHIFT_FIELDS.includes(c)); if (!cols.length) return res.json({ ok: true });
  if (cols.includes('break_id') && chk.o.break_id) for (const f of ['break_start', 'break_end']) if (!cols.includes(f)) cols.push(f);
  db.prepare(`UPDATE shifts SET ${cols.map(c => c + '=?')} WHERE id=?`).run(...cols.map(c => (chk.o[c] ?? null)), old.id); res.json({ ok: true });
});
shiftsRouter.delete('/shifts/:id', (req, res) => {
  const id = req.params.id;
  for (const [t, c, label] of [['employees', 'shift_id', 'employees'], ['schedules', 'shift_id', 'roster entries'], ['rotation_steps', 'shift_id', 'rotations'], ['departments', 'shift_id', 'departments'], ['employee_shifts', 'shift_id', 'employees (alternate shifts)'], ['shift_requests', 'shift_id', 'shift requests']])
    if (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(id).n) return fail(res, `This shift is still used by ${label}`);
  db.prepare('DELETE FROM shifts WHERE id=?').run(id); res.json({ ok: true });
});

// roster entries (date-range shift for one employee)
shiftsRouter.post('/schedules', (req, res) => {
  const { employee_id, shift_id, from_date, to_date } = req.body ?? {};
  if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(employee_id)) return fail(res, 'Choose an employee');
  if (!db.prepare('SELECT 1 FROM shifts WHERE id=?').get(shift_id)) return fail(res, 'Choose a shift');
  if (!DATE.test(from_date ?? '') || !DATE.test(to_date ?? '') || to_date < from_date) return fail(res, 'Valid from and to dates required');
  tx(() => setRoster(Number(employee_id), from_date, to_date, Number(shift_id)));
  res.json({ ok: true });
});

// ---------- rotations ----------
const rotationSteps = (id) => db.prepare('SELECT s.seq, s.shift_id, s.days, sh.name AS shift FROM rotation_steps s LEFT JOIN shifts sh ON sh.id=s.shift_id WHERE s.rotation_id=? ORDER BY s.seq').all(id);
function cleanSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 30) return 'Add 1 to 30 steps';
  for (const s of steps) {
    if (!(Number.isInteger(+s.days) && +s.days >= 1 && +s.days <= 60)) return 'Each step lasts 1 to 60 days';
    if (s.shift_id && !db.prepare('SELECT 1 FROM shifts WHERE id=?').get(s.shift_id)) return 'Unknown shift in a step';
  }
  return null;
}
const saveSteps = (id, steps) => { db.prepare('DELETE FROM rotation_steps WHERE rotation_id=?').run(id); steps.forEach((s, i) => db.prepare('INSERT INTO rotation_steps(rotation_id, seq, shift_id, days) VALUES(?,?,?,?)').run(id, i, s.shift_id || null, +s.days)); };
shiftsRouter.get('/rotations', (_q, res) => res.json(db.prepare('SELECT * FROM rotations ORDER BY name').all().map(r => ({ ...r, steps: rotationSteps(r.id), employees: db.prepare('SELECT COUNT(*) n FROM employees WHERE rotation_id=?').get(r.id).n }))));
shiftsRouter.post('/rotations', (req, res) => {
  const name = String(req.body?.name ?? '').trim(), err = cleanSteps(req.body?.steps);
  if (!name) return fail(res, 'Name required'); if (err) return fail(res, err);
  if (db.prepare('SELECT 1 FROM rotations WHERE name=?').get(name)) return fail(res, 'A rotation with this name exists');
  const id = tx(() => { const i = Number(db.prepare('INSERT INTO rotations(name) VALUES(?)').run(name).lastInsertRowid); saveSteps(i, req.body.steps); return i; });
  res.json({ id });
});
shiftsRouter.put('/rotations/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM rotations WHERE id=?').get(req.params.id)) return fail(res, 'No such rotation', 404);
  const err = cleanSteps(req.body?.steps); if (err) return fail(res, err);
  tx(() => saveSteps(req.params.id, req.body.steps)); res.json({ ok: true });
});
shiftsRouter.delete('/rotations/:id', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM employees WHERE rotation_id=?').get(req.params.id).n) return fail(res, 'Employees are still on this rotation');
  db.prepare('DELETE FROM rotations WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// department default shift, employee alternate shifts
shiftsRouter.put('/departments/:id/shift', (req, res) => {
  const sid = req.body?.shift_id || null;
  if (sid && !db.prepare('SELECT 1 FROM shifts WHERE id=?').get(sid)) return fail(res, 'Unknown shift');
  db.prepare('UPDATE departments SET shift_id=? WHERE id=?').run(sid, req.params.id); res.json({ ok: true });
});
shiftsRouter.get('/employees/:id/shifts', (req, res) => res.json(db.prepare('SELECT shift_id FROM employee_shifts WHERE employee_id=?').all(req.params.id).map(r => r.shift_id)));
shiftsRouter.put('/employees/:id/shifts', (req, res) => {
  const ids = [...new Set((req.body?.shift_ids ?? []).map(Number))];
  for (const s of ids) if (!db.prepare('SELECT 1 FROM shifts WHERE id=?').get(s)) return fail(res, 'Unknown shift');
  tx(() => { db.prepare('DELETE FROM employee_shifts WHERE employee_id=?').run(req.params.id); for (const s of ids) db.prepare('INSERT INTO employee_shifts(employee_id, shift_id) VALUES(?,?)').run(req.params.id, s); });
  res.json({ ok: true });
});

// ---------- shift calendar: who works which shift on which day ----------
export function shiftCalendar(q) {
  const m = /^\d{4}-\d\d$/.test(q.month ?? '') ? q.month : dateStr(new Date()).slice(0, 7);
  const days = []; for (let d = m + '-01'; d.startsWith(m); d = addDays(d, 1)) days.push(d);
  const hol = new Set(db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(days[0], days.at(-1)).map(h => h.date));
  const w = [], a = []; for (const [p, c] of [['department_id', 'e.department_id'], ['branch_id', 'e.branch_id'], ['employee_id', 'e.id']]) if (q[p]) { w.push(`AND ${c}=?`); a.push(q[p]); }
  const sc = scopeClause('e');
  const emps = db.prepare(`SELECT e.id, e.code, e.name, e.shift_id, e.department_id, e.group_id, e.rotation_id, e.rotation_anchor, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id
                           WHERE e.active=1 ${w.join(' ')}${sc.sql} ORDER BY e.code LIMIT 500`).all(...a, ...sc.args);
  const resolve = shiftResolver(days[0], days.at(-1)), short = (s) => (s.code || s.name[0] || '?').toUpperCase();
  return { month: m, days, shifts: db.prepare('SELECT id, name, code, start, end, type FROM shifts ORDER BY id').all().map(s => ({ ...s, short: short(s) })),
    rows: emps.map(e => ({ employee_id: e.id, code: e.code, name: e.name, dept: e.dept, cells: days.map(d => {
      const R = resolve(e, d), wd = (R.sh?.workdays ?? '1,2,3,4,5,6').split(',').map(Number);
      if (hol.has(d)) return { c: 'H', label: 'Holiday', source: R.source };
      if (R.off || (R.sh && !R.fromRotation && (!wd.includes(dowOf(d)) || altOffDay(R.sh, d)))) return { c: 'OFF', label: 'Weekly off', source: R.source };
      return R.sh ? { c: short(R.sh), label: R.sh.name, source: R.source } : { c: '-', label: 'No shift', source: 'none' };
    }) })) };
}
shiftsRouter.get('/shifts/calendar', (req, res) => res.json(shiftCalendar(req.query)));

// ---------- suggest a shift from how people actually punch ----------
shiftsRouter.post('/shifts/auto-assign', (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.body?.days) || 30)), minDays = Math.max(3, Number(req.body?.min_days) || 5), tol = Number(req.body?.tolerance_min) || 120;
  const shifts = db.prepare("SELECT * FROM shifts WHERE type != 'flexible'").all();
  if (!shifts.length) return fail(res, 'Create some shifts first');
  const sc = scopeClause('e'), since = addDays(dateStr(new Date()), -days) + ' 00:00:00';
  const emps = db.prepare(`SELECT e.id, e.code, e.name, e.department_id FROM employees e WHERE e.active=1 AND e.shift_id IS NULL AND e.rotation_id IS NULL
                           AND (e.department_id IS NULL OR (SELECT shift_id FROM departments WHERE id=e.department_id) IS NULL)${sc.sql} ORDER BY e.code`).all(...sc.args);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const out = [];
  for (const e of emps) {
    const byDay = new Map();
    for (const l of db.prepare('SELECT ts FROM logs WHERE emp_code=? AND ts>=? ORDER BY ts').all(e.code, since)) { const d = l.ts.slice(0, 10), t = toMin(l.ts.slice(11, 16)); const x = byDay.get(d) ?? { f: t, l: t }; x.l = t; byDay.set(d, x); }
    if (byDay.size < minDays) { out.push({ employee_id: e.id, code: e.code, name: e.name, samples: byDay.size, suggestion: null, reason: `Only ${byDay.size} days of punches` }); continue; }
    const mIn = median([...byDay.values()].map(x => x.f)), mOut = median([...byDay.values()].map(x => x.l));
    const dist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1440 - d); };
    const best = shifts.map(s => ({ s, d: dist(toMin(s.start), mIn) + 0.5 * dist(toMin(s.type === 'split' ? s.seg2_end : s.end), mOut) })).sort((a, b) => a.d - b.d)[0];
    const close = dist(toMin(best.s.start), mIn) <= tol;
    out.push({ employee_id: e.id, code: e.code, name: e.name, samples: byDay.size, median_in: `${String(Math.floor(mIn / 60)).padStart(2, '0')}:${String(mIn % 60).padStart(2, '0')}`, median_out: `${String(Math.floor(mOut / 60)).padStart(2, '0')}:${String(mOut % 60).padStart(2, '0')}`,
      suggestion: close ? best.s.name : null, shift_id: close ? best.s.id : null, reason: close ? '' : 'No shift starts near their usual arrival time' });
  }
  let applied = 0;
  if (req.body?.apply) for (const r of out) if (r.shift_id) { db.prepare('UPDATE employees SET shift_id=? WHERE id=?').run(r.shift_id, r.employee_id); applied++; }
  res.json({ applied, results: out });
});

// ---------- shift change and swap requests ----------
export function createShiftRequest(body, actor, allowAuto = true) {
  const { kind, employee_id, other_employee_id, shift_id, from_date, to_date, reason } = body ?? {}, auto_approve = allowAuto && body?.auto_approve;
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(employee_id);
  if (!e || !e.active) return { error: 'Choose an active employee' };
  if (!['change', 'swap'].includes(kind)) return { error: 'Kind must be change or swap' };
  if (!DATE.test(from_date ?? '') || !DATE.test(to_date ?? '') || to_date < from_date) return { error: 'Valid from and to dates required' };
  if (to_date > addDays(from_date, 92)) return { error: 'A request can cover at most 3 months' };
  if (from_date < dateStr(new Date()) && !auto_approve) return { error: 'Requests are for today or later' };
  if (!String(reason ?? '').trim() && !auto_approve) return { error: 'A reason is required' };
  let other = null;
  if (kind === 'change') { if (!db.prepare('SELECT 1 FROM shifts WHERE id=?').get(shift_id)) return { error: 'Choose the shift wanted' }; }
  else {
    other = db.prepare('SELECT * FROM employees WHERE id=?').get(other_employee_id);
    if (!other || !other.active || other.id === e.id) return { error: 'Choose a different active employee to swap with' };
    if (to_date > addDays(from_date, 31)) return { error: 'A swap can cover at most 31 days' };
  }
  const id = Number(db.prepare('INSERT INTO shift_requests(kind, employee_id, other_employee_id, shift_id, from_date, to_date, reason, created_by) VALUES(?,?,?,?,?,?,?,?)')
    .run(kind, e.id, other?.id ?? null, kind === 'change' ? shift_id : null, from_date, to_date, reason ?? null, actor).lastInsertRowid);
  if (auto_approve) { const err = applyShiftRequest(id, actor, 'Approved on entry'); if (err) { db.prepare('DELETE FROM shift_requests WHERE id=?').run(id); return { error: err }; } return { id, status: 'approved' }; }
  const msg = `${from_date} to ${to_date}${other ? ' with ' + other.name : ''}`;
  notify({ employee_id: e.id, title: `Shift ${kind} request: ${e.name}`, body: msg, link: 'Roster' , kind: 'shift_request'});
  notifyManager(e.id, `Shift ${kind} request: ${e.name}`, msg, 'Team', 'shift_request');
  return { id, status: 'pending' };
}
shiftsRouter.post('/shifts/requests', (req, res) => { const r = createShiftRequest(req.body, req.user); r.error ? fail(res, r.error) : res.json(r); });
function applyShiftRequest(id, user, note) {
  const q = db.prepare('SELECT * FROM shift_requests WHERE id=?').get(id), A = db.prepare('SELECT * FROM employees WHERE id=?').get(q.employee_id);
  try {
    tx(() => {
      if (q.kind === 'change') setRoster(A.id, q.from_date, q.to_date, q.shift_id);
      else {
        const B = db.prepare('SELECT * FROM employees WHERE id=?').get(q.other_employee_id), resolve = shiftResolver(q.from_date, q.to_date), plan = [];
        for (let d = q.from_date; d <= q.to_date; d = addDays(d, 1)) {
          const a = resolve(A, d), b = resolve(B, d);
          if (!a.sh || !b.sh) throw new Error(`Cannot swap on ${d}: ${!a.sh ? A.name : B.name} has no shift that day`);
          if (a.sh.id !== b.sh.id) plan.push([d, a.sh.id, b.sh.id]);
        }
        if (!plan.length) throw new Error('Both employees already work the same shifts on those days');
        for (const [d, sa, sb] of plan) { setRoster(A.id, d, d, sb); setRoster(B.id, d, d, sa); }
      }
      db.prepare("UPDATE shift_requests SET status='approved', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(user, stamp(), note ?? null, id);
    });
  } catch (e) { return e.message; }
  for (const emp of [q.employee_id, q.other_employee_id].filter(Boolean)) notify({ audience: 'employee', employee_id: emp, title: `Your shift ${q.kind} was approved`, body: `${q.from_date} to ${q.to_date}`, link: 'Roster' , kind: 'shift_decision'});
  return null;
}
// action: approve | reject | cancel. Returns an error message, or null when done.
export function decideShiftRequest(id, action, note, actor) {
  const q = db.prepare('SELECT * FROM shift_requests WHERE id=?').get(id);
  if (!q) return 'No such request';
  if (q.status !== 'pending') return 'Only pending requests can be decided';
  if (action !== 'cancel') { const g = gate('shift', q, action, actor, note); if (g.error) return g.error; if (g.advanced) return null; }
  if (action === 'approve') return applyShiftRequest(q.id, actor, note);
  db.prepare('UPDATE shift_requests SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?').run(action === 'reject' ? 'rejected' : 'cancelled', actor, stamp(), note ?? null, q.id);
  for (const emp of [q.employee_id, q.other_employee_id].filter(Boolean)) notify({ audience: 'employee', employee_id: emp, title: `Your shift ${q.kind} was ${action === 'reject' ? 'rejected' : 'cancelled'}`, body: `${q.from_date} to ${q.to_date}`, link: 'Roster' , kind: 'shift_decision'});
  return null;
}
const decideShift = (action) => (req, res) => { const e = decideShiftRequest(req.params.id, action, req.body?.note, req.user); e ? fail(res, e, e === 'No such request' ? 404 : 400) : res.json({ ok: true, ...takeAdvance() }); };
shiftsRouter.post('/shifts/requests/:id/approve', decideShift('approve'));
shiftsRouter.post('/shifts/requests/:id/reject', decideShift('reject'));
shiftsRouter.post('/shifts/requests/:id/cancel', decideShift('cancel'));
shiftsRouter.get('/shifts/requests', (req, res) => {
  const sc = scopeClause('e'), w = [], a = [];
  for (const [p, c] of [['status', 'r.status'], ['employee_id', 'r.employee_id']]) if (req.query[p]) { w.push(`AND ${c}=?`); a.push(req.query[p]); }
  res.json(db.prepare(`SELECT r.*, e.code, e.name AS employee, o.name AS other_employee, s.name AS shift FROM shift_requests r JOIN employees e ON e.id=r.employee_id
                       LEFT JOIN employees o ON o.id=r.other_employee_id LEFT JOIN shifts s ON s.id=r.shift_id WHERE 1=1${sc.sql} ${w.join(' ')}
                       ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT 300`).all(...sc.args, ...a));
});
