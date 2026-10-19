// Attendance > Setup / Rule / Shift / Schedule / Approvals / Benefit / Configuration pages of the ZKT-style menu.
// Everything under /api/att/*. Existing concepts are reused (shifts, schedules, leaves, attendance_requests, overtime_requests,
// shift_requests, holidays, pay_codes, breaks, leave_policies, emp_groups); new tables are created here.
import express from 'express';
import { db, getSettings, setSettings } from './db.js';
import { addDays, dateStr, dayMin } from './dates.js';
import { setRoster, shiftResolver, createShiftRequest } from './shifts.js';
import { createAttendanceRequest } from './requests.js';
import { applyLeave } from './leave.js';
import { attendanceReport } from './report.js';
import { syncOvertimeRequests } from './overtime.js';
import { bustCodes } from './paycodes.js';
import { scopeClause } from './rbac.js';

export const attSetupRouter = express.Router();
const R = attSetupRouter;
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const DATE = /^\d{4}-\d\d-\d\d$/;
const stamp = () => new Date().toLocaleString('sv');
const txt = (v, n = 80) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const normT = (v) => { const m = String(v ?? '').trim().match(/^(\d{1,2}):(\d\d)(:\d\d)?$/); if (!m || +m[1] > 23 || +m[2] > 59) return null; return String(+m[1]).padStart(2, '0') + ':' + m[2]; };
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const json = (s, d = {}) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const addCol = (t, c, d) => { if (!colsOf(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
const dayRange = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; };
const splitName = (n) => { const s = String(n ?? ''), i = s.indexOf(' '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const parseCsv = (csv) => String(csv ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => l.split(',').map(x => x.trim()));
const firstLine = (rows, re) => (rows.length && re.test(rows[0].join(',')) ? rows.slice(1) : rows);

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS att_fixed_codes(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, format TEXT NOT NULL DEFAULT 'HH:MM', symbol TEXT, round_off TEXT DEFAULT 'Round Off', min_val REAL DEFAULT 0.1, color TEXT);
CREATE TABLE IF NOT EXISTS att_rules(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, target_id INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}', UNIQUE(scope, target_id));
CREATE TABLE IF NOT EXISTS att_timetables(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'normal', in_time TEXT, out_time TEXT, out_cross INTEGER DEFAULT 0,
  work_min INTEGER DEFAULT 480, break_id INTEGER, work_day REAL DEFAULT 1, work_type INTEGER DEFAULT 0, overtime INTEGER DEFAULT 0, color TEXT, compensate INTEGER DEFAULT 0, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS att_dept_sched(id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, shift_id INTEGER NOT NULL REFERENCES shifts(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS att_group_sched(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES emp_groups(id) ON DELETE CASCADE, shift_id INTEGER NOT NULL REFERENCES shifts(id), start_date TEXT NOT NULL, end_date TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS att_temp_sched(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, date TEXT NOT NULL, timetable_id INTEGER NOT NULL REFERENCES att_timetables(id), shift_id INTEGER, UNIQUE(employee_id, date));
CREATE TABLE IF NOT EXISTS att_training(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, pay_code TEXT, start_time TEXT NOT NULL, end_time TEXT NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending', created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')), decided_by TEXT, decided_at TEXT, decision_note TEXT);
CREATE TABLE IF NOT EXISTS att_holidays(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 1, color TEXT, ot_enable INTEGER DEFAULT 0, ot TEXT, department_id INTEGER, group_id INTEGER);
CREATE TABLE IF NOT EXISTS att_calc_batch(id INTEGER PRIMARY KEY, started TEXT, task TEXT, started_by TEXT, result TEXT, employees INTEGER, spent_ms INTEGER, att_from TEXT, att_to TEXT, run_group TEXT, details TEXT, processed_by TEXT);`);
for (const [t, c, d] of [['pay_codes', 'ptype', 'TEXT'], ['pay_codes', 'unit', 'TEXT'], ['pay_codes', 'symbol', 'TEXT'], ['pay_codes', 'ord', 'INTEGER'], ['pay_codes', 'descr', 'TEXT'], ['pay_codes', 'color', 'TEXT'],
  ['pay_codes', 'display', 'INTEGER DEFAULT 1'], ['pay_codes', 'fixed_hours', 'REAL DEFAULT 8'], ['pay_codes', 'round_off', 'TEXT'], ['pay_codes', 'min_val', 'REAL DEFAULT 0.1'], ['pay_codes', 'custom', 'INTEGER DEFAULT 0'],
  ['emp_groups', 'code', 'TEXT'], ['leave_policies', 'code', 'TEXT'],
  ['breaks', 'calc_type', 'INTEGER DEFAULT 0'], ['breaks', 'duration', 'INTEGER'], ['breaks', 'with_salary', 'INTEGER DEFAULT 0'], ['breaks', 'extra', 'TEXT'],
  ['shifts', 'timetable_id', 'INTEGER'], ['shifts', 'shift_unit', "TEXT DEFAULT 'Week'"], ['shifts', 'shift_cycle', 'INTEGER DEFAULT 1'], ['shifts', 'auto_shift', 'INTEGER DEFAULT 0'], ['shifts', 'att_extra', 'TEXT'], ['shifts', 'att_hidden', 'INTEGER DEFAULT 0'],
  ['holidays', 'att_holiday_id', 'INTEGER'],
  ['attendance_requests', 'punch_state', 'INTEGER'], ['attendance_requests', 'work_code', 'TEXT'],
  ['overtime_requests', 'start_time', 'TEXT'], ['overtime_requests', 'end_time', 'TEXT'], ['overtime_requests', 'pay_code', 'TEXT'],
  ['shift_requests', 'prev_shift', 'TEXT']]) addCol(t, c, d);

// ---------------------------------------------------------------- common helpers
const OT_CODES = ['Regular', 'Normal OT', 'Weekend OT', 'Holiday OT', 'OT1', 'OT2', 'OT3', 'Compensatory'];
const STATES = ['Check In', 'Check Out', 'Break Out', 'Break In', 'Overtime In', 'Overtime Out'];
const EMPSEL = `e.id AS employee_id, e.code, e.name, d.name AS dept, des.name AS position, CASE WHEN e.photo IS NOT NULL THEN 1 ELSE 0 END AS has_photo`;
const EMPJOIN = `JOIN employees e ON e.id=X.employee_id LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations des ON des.id=e.designation_id`;
const empShape = (r) => { const [first, last] = splitName(r.name); return { ...r, first_name: first, last_name: last }; };
// employees for a bulk action: ticked ids, a list of codes, or everyone active in a department / area / group
function pickEmployees(b) {
  const sc = scopeClause('e'), out = new Set();
  const byIds = (ids) => { if (ids.length) for (const r of db.prepare(`SELECT e.id FROM employees e WHERE e.active=1 AND e.id IN (${ids.map(() => '?')})${sc.sql}`).all(...ids, ...sc.args)) out.add(r.id); };
  if (Array.isArray(b?.employee_ids)) byIds(b.employee_ids.map(Number).filter(Number.isFinite).slice(0, 3000));
  const codes = String(b?.codes ?? '').split(/[\s,;]+/).filter(Boolean).slice(0, 3000);
  if (codes.length) for (const r of db.prepare(`SELECT e.id FROM employees e WHERE e.active=1 AND e.code IN (${codes.map(() => '?')})${sc.sql}`).all(...codes, ...sc.args)) out.add(r.id);
  const col = { dept: 'department_id', area: 'branch_id', group: 'group_id' }[b?.by];
  if (col && b.target_id) for (const r of db.prepare(`SELECT e.id FROM employees e WHERE e.active=1 AND e.${col}=?${sc.sql}`).all(Number(b.target_id), ...sc.args)) out.add(r.id);
  return [...out];
}
const statusLabel = (s) => ({ pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Revoked' }[s] ?? s);
// run fn for each employee, collecting errors
function eachEmployee(ids, fn) {
  let added = 0; const errors = [];
  for (const id of ids) { const e = db.prepare('SELECT code, name FROM employees WHERE id=?').get(id); const r = fn(id); if (r?.error) errors.push(`${e?.code}: ${r.error}`); else added++; }
  return { added, errors: errors.slice(0, 20), skipped: errors.length };
}

// ---------------------------------------------------------------- pay codes (reuses pay_codes: one row per attendance status)
const PC_DEFAULT = { Present: ['Regular', 'Hour'], Late: ['Exception', 'Minute'], 'Half Day': ['Exception', 'Hour'], Absent: ['Exception', 'Hour'], Leave: ['Leave', 'Hour'], 'Unpaid Leave': ['Leave', 'Hour'], 'Weekly Off': ['Regular', 'Hour'],
  Holiday: ['Regular', 'Hour'], 'On Duty': ['Regular', 'Hour'], 'Work From Home': ['Regular', 'Hour'], Training: ['Training', 'Hour'], 'Missing Out': ['Exception', 'Minute'], 'Short Hours': ['Exception', 'Minute'], 'In progress': ['Exception', 'Hour'], Pending: ['Exception', 'Hour'] };
function seedPayCodes() {
  const rows = db.prepare('SELECT rowid AS rid, * FROM pay_codes ORDER BY rowid').all();
  rows.forEach((r, i) => {
    if (r.ptype && r.ord != null) return;
    const [t, u] = PC_DEFAULT[r.status] ?? ['Regular', 'Hour'];
    db.prepare('UPDATE pay_codes SET ptype=COALESCE(ptype,?), unit=COALESCE(unit,?), symbol=COALESCE(symbol,code), ord=COALESCE(ord,?), round_off=COALESCE(round_off,?) WHERE rowid=?').run(t, u, i + 1, 'Round Off', r.rid);
  });
}
seedPayCodes();
const PC_TYPES = ['Regular', 'Overtime', 'Leave', 'Exception', 'Training'], PC_UNITS = ['Minute', 'Hour', 'Workday', 'HH:MM'], PC_ROUND = ['Round Off', 'Round Up', 'Round Down'];
R.get('/att/paycodes', (_q, res) => { seedPayCodes(); res.json(db.prepare('SELECT rowid AS id, status, code, COALESCE(label, status) AS name, pay_factor, ptype, unit, symbol, ord, descr, color, display, fixed_hours, round_off, min_val, custom FROM pay_codes ORDER BY ord, rowid').all()); });
function cleanPc(b, old) {
  const o = {}; const g = (k, d) => (k in b ? b[k] : old?.[k] ?? d);
  o.code = String(g('code', '')).trim().toUpperCase(); if (!/^[A-Z0-9+\-]{1,6}$/.test(o.code)) return { error: 'A code is 1 to 6 letters or digits' };
  o.label = txt(g('name', old?.name), 60); if (!o.label) return { error: 'Name required' };
  o.ptype = g('ptype', 'Regular'); if (!PC_TYPES.includes(o.ptype)) return { error: 'Unknown type' };
  o.unit = g('unit', 'Hour'); if (!PC_UNITS.includes(o.unit)) return { error: 'Unknown unit' };
  o.round_off = g('round_off', 'Round Off'); if (!PC_ROUND.includes(o.round_off)) return { error: 'Unknown round off' };
  o.min_val = Number(g('min_val', 0.1)); if (!(o.min_val >= 0)) return { error: 'Minimum must be 0 or more' };
  o.fixed_hours = Number(g('fixed_hours', 8)); if (!(o.fixed_hours > 0 && o.fixed_hours <= 24)) return { error: 'Working fixed hours must be 1 to 24' };
  o.pay_factor = Number(g('pay_factor', 1)); if (!(o.pay_factor >= 0 && o.pay_factor <= 1)) return { error: 'Pay share is from 0 to 1' };
  if (old && ['Present', 'Weekly Off', 'Holiday'].includes(old.status) && o.pay_factor !== 1) return { error: `${old.status} is always paid in full` };
  o.symbol = txt(g('symbol', ''), 4); o.ord = Number(g('ord', 999)); if (!Number.isFinite(o.ord)) return { error: 'Display order must be a number' };
  o.descr = txt(g('descr', ''), 200); o.color = txt(g('color', ''), 20); o.display = flag(g('display', 1));
  return { o };
}
R.post('/att/paycodes', (req, res) => {
  const { o, error } = cleanPc(req.body ?? {}, null); if (error) return fail(res, error);
  if (db.prepare('SELECT 1 FROM pay_codes WHERE code=?').get(o.code)) return fail(res, 'Another pay code already uses this code');
  if (db.prepare('SELECT 1 FROM pay_codes WHERE status=?').get(o.label)) return fail(res, 'A pay code with this name exists');
  const r = db.prepare('INSERT INTO pay_codes(status, code, pay_factor, label, ptype, unit, symbol, ord, descr, color, display, fixed_hours, round_off, min_val, custom) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(o.label, o.code, o.pay_factor, o.label, o.ptype, o.unit, o.symbol, o.ord, o.descr, o.color, o.display, o.fixed_hours, o.round_off, o.min_val);
  bustCodes(); res.json({ id: Number(r.lastInsertRowid) });
});
R.put('/att/paycodes/:id', (req, res) => {
  const old = db.prepare('SELECT rowid AS id, *, COALESCE(label, status) AS name FROM pay_codes WHERE rowid=?').get(req.params.id); if (!old) return fail(res, 'No such pay code', 404);
  const { o, error } = cleanPc(req.body ?? {}, old); if (error) return fail(res, error);
  if (db.prepare('SELECT 1 FROM pay_codes WHERE code=? AND rowid!=?').get(o.code, old.id)) return fail(res, 'Another pay code already uses this code');
  db.prepare('UPDATE pay_codes SET code=?, pay_factor=?, label=?, ptype=?, unit=?, symbol=?, ord=?, descr=?, color=?, display=?, fixed_hours=?, round_off=?, min_val=? WHERE rowid=?')
    .run(o.code, o.pay_factor, o.label, o.ptype, o.unit, o.symbol, o.ord, o.descr, o.color, o.display, o.fixed_hours, o.round_off, o.min_val, old.id);
  bustCodes(); res.json({ ok: true });
});
R.delete('/att/paycodes/:id', (req, res) => {
  const old = db.prepare('SELECT rowid AS id, * FROM pay_codes WHERE rowid=?').get(req.params.id); if (!old) return res.json({ ok: true });
  if (!old.custom) return fail(res, `${old.label || old.status} is a built-in attendance status and cannot be deleted`);
  db.prepare('DELETE FROM pay_codes WHERE rowid=?').run(old.id); bustCodes(); res.json({ ok: true });
});

// ---------------------------------------------------------------- fixed codes (report column formats)
const FIXED = ['Duration', 'Duty Duration', 'Total Hours', 'Worked Hours', 'Break Duration', 'Break Total Hours', 'Break Hours', 'Approval Hours', 'Early In', 'Late Out', 'Unscheduled', 'Remaining', 'Total OT', 'Rule Total OT', 'Total Leaves'];
if (!db.prepare('SELECT 1 FROM att_fixed_codes').get()) for (const n of FIXED) db.prepare('INSERT INTO att_fixed_codes(name, format, symbol, round_off, min_val) VALUES(?,?,?,?,?)').run(n, n === 'Total Leaves' ? 'Hour' : 'HH:MM', '', 'Round Off', 0.1);
const FX_FORMATS = ['HH:MM', 'Hour', 'Minute', 'Workday'];
function cleanFixed(b) {
  const name = txt(b.name, 40); if (!name) return { error: 'Name required' };
  const format = b.format ?? 'HH:MM'; if (!FX_FORMATS.includes(format)) return { error: `Format must be one of ${FX_FORMATS.join(', ')}` };
  const round_off = b.round_off ?? 'Round Off'; if (!PC_ROUND.includes(round_off)) return { error: 'Unknown round off' };
  const min_val = Number(b.min_val ?? 0.1); if (!(min_val >= 0)) return { error: 'Minimum must be 0 or more' };
  return { o: { name, format, symbol: txt(b.symbol, 4) ?? '', round_off, min_val, color: txt(b.color, 20) } };
}
R.get('/att/fixedcodes', (_q, res) => res.json(db.prepare('SELECT * FROM att_fixed_codes ORDER BY id').all()));
R.post('/att/fixedcodes', (req, res) => {
  const { o, error } = cleanFixed(req.body ?? {}); if (error) return fail(res, error);
  try { res.json({ id: Number(db.prepare('INSERT INTO att_fixed_codes(name, format, symbol, round_off, min_val, color) VALUES(?,?,?,?,?,?)').run(o.name, o.format, o.symbol, o.round_off, o.min_val, o.color).lastInsertRowid) }); } catch { fail(res, 'A fixed code with this name exists'); }
});
R.put('/att/fixedcodes/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM att_fixed_codes WHERE id=?').get(req.params.id)) return fail(res, 'No such fixed code', 404);
  const { o, error } = cleanFixed(req.body ?? {}); if (error) return fail(res, error);
  try { db.prepare('UPDATE att_fixed_codes SET name=?, format=?, symbol=?, round_off=?, min_val=?, color=? WHERE id=?').run(o.name, o.format, o.symbol, o.round_off, o.min_val, o.color, req.params.id); res.json({ ok: true }); } catch { fail(res, 'A fixed code with this name exists'); }
});
R.delete('/att/fixedcodes/:id', (req, res) => { db.prepare('DELETE FROM att_fixed_codes WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------- attendance groups (emp_groups)
const nextCode = (table) => String(1 + Math.max(0, ...db.prepare(`SELECT code FROM ${table} WHERE code GLOB '[0-9]*'`).all().map(r => Number(r.code) || 0)));
for (const r of db.prepare('SELECT id FROM emp_groups WHERE code IS NULL ORDER BY id').all()) db.prepare('UPDATE emp_groups SET code=? WHERE id=?').run(nextCode('emp_groups'), r.id);
const groupRows = () => db.prepare('SELECT g.id, g.code, g.name, (SELECT COUNT(*) FROM employees e WHERE e.group_id=g.id AND e.active=1) AS employees FROM emp_groups g ORDER BY CAST(g.code AS INTEGER), g.name').all();
R.get('/att/groups', (_q, res) => {
  for (const r of db.prepare('SELECT id FROM emp_groups WHERE code IS NULL').all()) db.prepare('UPDATE emp_groups SET code=? WHERE id=?').run(nextCode('emp_groups'), r.id);
  res.json(groupRows());
});
R.get('/att/groups/next-code', (_q, res) => res.json({ code: nextCode('emp_groups') }));
R.post('/att/groups', (req, res) => {
  const code = txt(req.body?.code, 20) ?? nextCode('emp_groups'), name = txt(req.body?.name, 60); if (!name) return fail(res, 'Group name required');
  if (db.prepare('SELECT 1 FROM emp_groups WHERE code=?').get(code)) return fail(res, `The code ${code} is already used`);
  try { res.json({ id: Number(db.prepare('INSERT INTO emp_groups(name, code) VALUES(?,?)').run(name, code).lastInsertRowid) }); } catch { fail(res, 'A group with this name exists'); }
});
R.put('/att/groups/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM emp_groups WHERE id=?').get(req.params.id)) return fail(res, 'No such group', 404);
  const code = txt(req.body?.code, 20), name = txt(req.body?.name, 60); if (!name || !code) return fail(res, 'Group code and name required');
  if (db.prepare('SELECT 1 FROM emp_groups WHERE code=? AND id!=?').get(code, req.params.id)) return fail(res, `The code ${code} is already used`);
  try { db.prepare('UPDATE emp_groups SET name=?, code=? WHERE id=?').run(name, code, req.params.id); res.json({ ok: true }); } catch { fail(res, 'A group with this name exists'); }
});
R.delete('/att/groups/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM employees WHERE group_id=?').get(req.params.id).n; if (n) return fail(res, `${n} employee(s) are still in this group`);
  db.prepare('DELETE FROM emp_groups WHERE id=?').run(req.params.id); res.json({ ok: true });
});
R.post('/att/groups/transfer', (req, res) => { // Personnel Transfer: move people into a group (empty = take them out of any group)
  const gid = req.body?.group_id ? Number(req.body.group_id) : null;
  if (gid && !db.prepare('SELECT 1 FROM emp_groups WHERE id=?').get(gid)) return fail(res, 'Choose the group to move people into');
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose the employees to move');
  tx(() => { for (const id of ids) db.prepare('UPDATE employees SET group_id=? WHERE id=?').run(gid, id); });
  res.json({ moved: ids.length });
});

// ---------------------------------------------------------------- global / department / group rules
const TIERS = (p) => [1, 2, 3].flatMap(i => [[`${p}${i}_pay_code`, ''], [`${p}${i}_hrs_from`, 0], [`${p}${i}_hrs_to`, 0]]);
const RULE_OT = [['ot_pay_code', ''], ['overtime_policy', -1], ['enable_daily_ot', false], ...TIERS('d'), ['use_ot', 1], ['enable_compensatory', false], ['enable_weekend_ot', false], ...TIERS('w1'), ['enable_holiday_ot', false], ...TIERS('h'), ['enable_weekly_ot', false], ...TIERS('t')];
const RULE_BASIC = [['weekend1', 7], ['weekend2', 7], ['punch_period', 1], ['max_hrs', 12], ['day_change', '00:00:00'], ['paring_rule', 1]];
const GLOBAL_DEFAULTS = Object.fromEntries([['weekend1', 7], ['weekend2', 7], ['global_weekend1_color_setting', ''], ['global_weekend2_color_setting', ''], ['punch_period', 1], ['start_of_week', 0], ['max_hrs', 12], ['day_change', '00:00:00'], ['paring_rule', 1],
  ...RULE_OT, ['late_in2absence', 0], ['early_out2absence', 100], ['miss_in', 1], ['late_in_hrs', 60], ['miss_out', 1], ['early_out_hrs', 60], ['require_capture', false], ['require_work_code', false], ['require_punch_state', false],
  ['max_late_in', 0], ['max_early_out', 0], ['max_absent', 0], ['global_frequency', 0], ['global_send_day', 0], ['email_send_time', '00:00:00'], ['sending_day', 0], ['bot_uid', '']]);
const RULE_DEFAULTS = Object.fromEntries([...RULE_BASIC, ['weekend1_color_setting', ''], ['weekend2_color_setting', ''], ...RULE_OT.filter(([k]) => k !== 'use_ot' && k !== 'enable_compensatory')]);
function cleanRuleData(b, defaults, old = {}) {
  const o = {};
  for (const [k, d] of Object.entries(defaults)) {
    let v = k in b ? b[k] : (k in old ? old[k] : d);
    if (typeof d === 'boolean') v = !!flag(v);
    else if (typeof d === 'number') { v = Number(v === '' || v == null ? d : v); if (!Number.isFinite(v)) return { error: `${k} must be a number` }; }
    else v = String(v ?? '').slice(0, 60);
    o[k] = v;
  }
  if (!(o.punch_period >= 0 && o.punch_period <= 1440)) return { error: 'Duplicate punch interval must be 0 to 1440 minutes' };
  if (!(o.max_hrs > 0 && o.max_hrs <= 48)) return { error: 'Max work hour must be above 0 and at most 48' };
  const dc = normT(o.day_change); if (!dc) return { error: 'Day change time must be HH:MM' }; o.day_change = dc + ':00';
  if (![1, 2, 3].includes(o.paring_rule)) return { error: 'Unknown paring rule' };
  if (![-1, 1, 2].includes(o.overtime_policy)) return { error: 'Unknown overtime approval policy' };
  for (const k of ['weekend1', 'weekend2']) if (!(o[k] >= 0 && o[k] <= 7)) return { error: 'Unknown weekend day' };
  for (const k of Object.keys(o)) if (/_hrs_(from|to)$/.test(k) && !(o[k] >= 0 && o[k] <= 200)) return { error: 'Work hours range must be 0 to 200' };
  for (const p of ['d', 'w1', 'h', 't']) for (const i of [1, 2, 3]) { const f = o[`${p}${i}_hrs_from`], t = o[`${p}${i}_hrs_to`]; if (t && t <= f) return { error: 'Work hours range: the end must be above the start' }; }
  return { o };
}
const GKEY = 'att_global_rule';
function readGlobal() {
  const S = getSettings(), blob = json(db.prepare('SELECT value FROM settings WHERE key=?').get(GKEY)?.value);
  const o = { ...GLOBAL_DEFAULTS, ...blob };
  o.punch_period = S.min_gap_min; o.late_in2absence = S.late_to_absent_min;
  o.overtime_policy = S.ot_approval > 0 ? 1 : (blob.overtime_policy === 1 ? -1 : blob.overtime_policy ?? -1);
  return o;
}
R.get('/att/globalrule', (_q, res) => res.json(readGlobal()));
R.put('/att/globalrule', (req, res) => {
  const b = req.body ?? {}, { o, error } = cleanRuleData(b, GLOBAL_DEFAULTS, readGlobal()); if (error) return fail(res, error);
  if (!(o.late_in2absence >= 0)) return fail(res, 'When late exceeds must be 0 or more');
  for (const k of ['late_in_hrs', 'early_out_hrs', 'early_out2absence', 'max_late_in', 'max_early_out', 'max_absent']) if (!(o[k] >= 0)) return fail(res, `${k} must be 0 or more`);
  if (![0, 1, 2, 3].includes(o.use_ot)) return fail(res, 'Unknown overtime rule');
  setSettings({ min_gap_min: o.punch_period, late_to_absent_min: o.late_in2absence, ot_approval: o.overtime_policy === 1 ? 1 : 0 });
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(GKEY, JSON.stringify(o));
  res.json(readGlobal());
});
const RULE_SCOPES = { dept: ['departments', 'Department'], group: ['emp_groups', 'Group'] };
function linkPolicy(scope, target, o) { // the duplicate-punch interval of a rule becomes an attendance policy the engine already honours
  const table = RULE_SCOPES[scope][0], t = db.prepare(`SELECT name, att_policy_id FROM ${table} WHERE id=?`).get(target), pname = `Rule: ${scope === 'dept' ? 'department' : 'group'} ${t.name}`.slice(0, 80);
  const cur = t.att_policy_id ? db.prepare('SELECT name FROM att_policies WHERE id=?').get(t.att_policy_id) : null;
  if (cur && cur.name !== pname) return; // another policy is already assigned by hand: leave it alone
  let p = db.prepare('SELECT id FROM att_policies WHERE name=?').get(pname);
  if (p) db.prepare('UPDATE att_policies SET min_gap_min=? WHERE id=?').run(o.punch_period, p.id);
  else p = { id: Number(db.prepare('INSERT INTO att_policies(name, min_gap_min) VALUES(?,?)').run(pname, o.punch_period).lastInsertRowid) };
  db.prepare(`UPDATE ${table} SET att_policy_id=? WHERE id=?`).run(p.id, target);
}
function unlinkPolicy(scope, target) {
  const table = RULE_SCOPES[scope][0], t = db.prepare(`SELECT name, att_policy_id FROM ${table} WHERE id=?`).get(target); if (!t?.att_policy_id) return;
  const p = db.prepare('SELECT id, name FROM att_policies WHERE id=?').get(t.att_policy_id);
  if (p && p.name === `Rule: ${scope === 'dept' ? 'department' : 'group'} ${t.name}`.slice(0, 80)) { db.prepare(`UPDATE ${table} SET att_policy_id=NULL WHERE id=?`).run(target); db.prepare('DELETE FROM att_policies WHERE id=?').run(p.id); }
}
for (const scope of Object.keys(RULE_SCOPES)) {
  const [table, label] = RULE_SCOPES[scope];
  R.get(`/att/rules/${scope}`, (_q, res) => res.json(db.prepare(`SELECT r.id, r.target_id, t.name AS target, r.data FROM att_rules r JOIN ${table} t ON t.id=r.target_id WHERE r.scope=? ORDER BY t.name`).all(scope).map(r => ({ ...r, ...RULE_DEFAULTS, ...json(r.data), data: undefined }))));
  R.post(`/att/rules/${scope}`, (req, res) => {
    const target = Number(req.body?.target_id); if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(target)) return fail(res, `Choose a ${label.toLowerCase()}`);
    if (db.prepare('SELECT 1 FROM att_rules WHERE scope=? AND target_id=?').get(scope, target)) return fail(res, `This ${label.toLowerCase()} already has a rule`);
    const { o, error } = cleanRuleData(req.body ?? {}, RULE_DEFAULTS); if (error) return fail(res, error);
    const id = tx(() => { const i = Number(db.prepare('INSERT INTO att_rules(scope, target_id, data) VALUES(?,?,?)').run(scope, target, JSON.stringify(o)).lastInsertRowid); linkPolicy(scope, target, o); return i; });
    res.json({ id });
  });
  R.put(`/att/rules/${scope}/:id`, (req, res) => {
    const r = db.prepare('SELECT * FROM att_rules WHERE id=? AND scope=?').get(req.params.id, scope); if (!r) return fail(res, 'No such rule', 404);
    const { o, error } = cleanRuleData(req.body ?? {}, RULE_DEFAULTS, json(r.data)); if (error) return fail(res, error);
    tx(() => { db.prepare('UPDATE att_rules SET data=? WHERE id=?').run(JSON.stringify(o), r.id); linkPolicy(scope, r.target_id, o); });
    res.json({ ok: true });
  });
  R.delete(`/att/rules/${scope}/:id`, (req, res) => {
    const r = db.prepare('SELECT * FROM att_rules WHERE id=? AND scope=?').get(req.params.id, scope); if (!r) return res.json({ ok: true });
    tx(() => { unlinkPolicy(scope, r.target_id); db.prepare('DELETE FROM att_rules WHERE id=?').run(r.id); }); res.json({ ok: true });
  });
}

// ---------------------------------------------------------------- attendance configuration
const CONFIG_DEFAULTS = { short_date: 1, short_time: 1, resign_emp: true, filter_by_hire_date: true, auto_calculate: true, calculate_time: '02:00:00', change_recalc_days: 30, change_recalc_month_floor: true };
const readConfig = () => ({ ...CONFIG_DEFAULTS, ...json(db.prepare("SELECT value FROM settings WHERE key='att_config'").get()?.value) });
R.get('/att/config', (_q, res) => res.json(readConfig()));
R.put('/att/config', (req, res) => {
  const b = req.body ?? {}, o = { ...readConfig() };
  for (const [k, d] of Object.entries(CONFIG_DEFAULTS)) if (k in b) o[k] = typeof d === 'boolean' ? !!flag(b[k]) : typeof d === 'number' ? Number(b[k]) : String(b[k]);
  if (!(o.short_date >= 1 && o.short_date <= 19) || !(o.short_time >= 1 && o.short_time <= 12)) return fail(res, 'Unknown date or time format');
  const ct = normT(o.calculate_time); if (!ct) return fail(res, 'Calculate time must be HH:MM'); o.calculate_time = ct + ':00';
  if (!(o.change_recalc_days >= 0 && o.change_recalc_days <= 366)) return fail(res, 'Days back must be 0 to 366');
  db.prepare("INSERT INTO settings(key,value) VALUES('att_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(o)); res.json(o);
});

// ---------------------------------------------------------------- break times (breaks table)
const BR_DEFAULT = { available_interval_type: 0, available_interval: 1, func_key: 0, multiple_punch: 0, end_margin: 60, minimum_duration: 0, profit_rule: false, min_early_in: 0, profit_code: '', loss_rule: false, min_late_in: 0, loss_code: '' };
function applyBreak(br) { // a paid break (with salary) is not deducted from worked time; an unpaid one is
  for (const s of db.prepare('SELECT id FROM shifts WHERE break_id=?').all(br.id)) db.prepare('UPDATE shifts SET break_start=?, break_end=? WHERE id=?').run(br.with_salary ? null : br.start, br.with_salary ? null : br.end, s.id);
}
function cleanBreak(b) {
  const name = txt(b.alias ?? b.name, 40); if (!name) return { error: 'Name required' };
  const start = normT(b.period_start ?? b.start), end = normT(b.period_end ?? b.end); if (!start || !end) return { error: 'Break start and end must be HH:MM' };
  if (start === end) return { error: 'The break must last some time' };
  const span = (toMin(end) - toMin(start) + 1440) % 1440, duration = b.duration == null || b.duration === '' ? span : Number(b.duration);
  if (!(duration > 0 && duration <= 1440)) return { error: 'Duration must be 1 to 1440 minutes' };
  const calc = Number(b.calc_type ?? 0); if (![0, 1].includes(calc)) return { error: 'Unknown calculation type' };
  const extra = {}; for (const [k, d] of Object.entries(BR_DEFAULT)) extra[k] = typeof d === 'boolean' ? !!flag(b[k] ?? d) : typeof d === 'number' ? Number(b[k] ?? d) : String(b[k] ?? d);
  return { o: { name, start, end, duration: Math.round(duration), with_salary: flag(b.with_salary), calc_type: calc, extra: JSON.stringify(extra) } };
}
R.get('/att/breaktimes', (_q, res) => res.json(db.prepare('SELECT * FROM breaks ORDER BY start, name').all().map(b => {
  const x = { ...BR_DEFAULT, ...json(b.extra) }, span = (toMin(b.end) - toMin(b.start) + 1440) % 1440;
  return { id: b.id, name: b.name, start: b.start, end: b.end, duration: b.duration ?? span, with_salary: b.with_salary, calc_type: b.calc_type, shifts: db.prepare('SELECT COUNT(*) n FROM shifts WHERE break_id=?').get(b.id).n, ...x };
})));
R.post('/att/breaktimes', (req, res) => {
  const { o, error } = cleanBreak(req.body ?? {}); if (error) return fail(res, error);
  try { const id = Number(db.prepare('INSERT INTO breaks(name, start, end, duration, with_salary, calc_type, extra) VALUES(?,?,?,?,?,?,?)').run(o.name, o.start, o.end, o.duration, o.with_salary, o.calc_type, o.extra).lastInsertRowid); res.json({ id }); }
  catch { fail(res, 'A break with this name exists'); }
});
R.put('/att/breaktimes/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM breaks WHERE id=?').get(req.params.id)) return fail(res, 'No such break', 404);
  const { o, error } = cleanBreak(req.body ?? {}); if (error) return fail(res, error);
  try { db.prepare('UPDATE breaks SET name=?, start=?, end=?, duration=?, with_salary=?, calc_type=?, extra=? WHERE id=?').run(o.name, o.start, o.end, o.duration, o.with_salary, o.calc_type, o.extra, req.params.id); } catch { return fail(res, 'A break with this name exists'); }
  applyBreak({ id: Number(req.params.id), start: o.start, end: o.end, with_salary: o.with_salary }); syncTimetablesUsingBreak(Number(req.params.id)); res.json({ ok: true });
});
R.delete('/att/breaktimes/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM att_timetables WHERE break_id=?').get(req.params.id).n; if (n) return fail(res, `${n} timetable(s) still use this break`);
  db.prepare('UPDATE shifts SET break_id=NULL WHERE break_id=?').run(req.params.id); db.prepare('DELETE FROM breaks WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// ---------------------------------------------------------------- timetables (ZKT "time interval") -> composed into shifts
const WORK_TYPES = ['Normal Work', 'Day Off', 'Weekend'];
const TT_DEFAULT = { pay_code: 'Regular', begin_in: '08:00', end_in: '10:00', begin_out: '17:00', end_out: '19:00', enable_early_in: false, early_in_min: 60, enable_late_out: false, late_out_min: 60, max_ot_limit: 0, ot_tiers: [] };
function ttWorkMin(t) {
  if (t.type === 'flexible') return t.work_min;
  const br = t.break_id ? db.prepare('SELECT * FROM breaks WHERE id=?').get(t.break_id) : null;
  const span = (toMin(t.out_time) + 1440 * t.out_cross - toMin(t.in_time)); // minutes between check-in and check-out
  return Math.max(0, span - (br && !br.with_salary ? (br.duration ?? (toMin(br.end) - toMin(br.start) + 1440) % 1440) : 0));
}
function cleanTimetable(b, type, old) {
  const name = txt(b.alias ?? b.name, 40); if (!name) return { error: 'Name required' };
  const o = { name, type, color: txt(b.color_setting ?? b.color ?? old?.color, 20) };
  o.in_time = normT(b.in_time ?? b.check_in ?? old?.in_time); o.out_time = normT(b.out_time ?? b.check_out ?? old?.out_time);
  if (!o.in_time || !o.out_time) return { error: 'Check-in and check-out must be HH:MM' };
  o.out_cross = Number(b.out_time_cross_days ?? b.out_cross ?? (type === 'flexible' ? 1 : (toMin(o.out_time) <= toMin(o.in_time) ? 1 : 0)));
  if (![0, 1, 2, 3].includes(o.out_cross)) return { error: 'Check-out can cross 0 to 3 days' };
  if (type === 'normal' && o.out_cross === 0 && toMin(o.out_time) <= toMin(o.in_time)) return { error: 'Check-out must be after check-in (or cross a day)' };
  o.work_day = Number(b.work_day ?? 1); if (!(o.work_day > 0 && o.work_day <= 3)) return { error: 'WorkDay must be above 0 and at most 3' };
  o.work_type = Number(b.work_type ?? 0); if (![0, 1, 2].includes(o.work_type)) return { error: 'Unknown work type' };
  const bid = 'break_id' in b ? b.break_id : old?.break_id; o.break_id = bid ? Number(bid) : null; if (o.break_id && !db.prepare('SELECT 1 FROM breaks WHERE id=?').get(o.break_id)) return { error: 'Unknown break time' };
  o.work_min = type === 'flexible' ? Number(b.work_time_duration ?? b.work_min ?? 480) : 0;
  if (type === 'flexible' && !(o.work_min >= 60 && o.work_min <= 1440)) return { error: 'Work time must be 60 to 1440 minutes' };
  o.overtime = flag(b.enable_overtime ?? b.overtime ?? old?.overtime); o.compensate = Number(b.compensate_duration ?? b.compensate ?? old?.compensate ?? 0); if (!(o.compensate >= 0)) return { error: 'Compensate duration must be 0 or more' };
  const d = { ...TT_DEFAULT, ...(old ? json(old.data) : {}) };
  for (const k of ['pay_code', 'begin_in', 'end_in', 'begin_out', 'end_out']) if (k in b) d[k] = String(b[k]).slice(0, 20);
  for (const k of ['begin_in', 'end_in', 'begin_out', 'end_out']) { const n = normT(d[k]); if (!n) return { error: `${k.replace('_', ' ')} must be HH:MM` }; d[k] = n; }
  d.enable_early_in = !!flag(b.enable_early_in ?? d.enable_early_in); d.enable_late_out = !!flag(b.enable_late_out ?? d.enable_late_out);
  d.early_in_min = Number(b.min_early_in ?? d.early_in_min); d.late_out_min = Number(b.min_late_out ?? d.late_out_min); d.max_ot_limit = Number(b.max_ot_limit ?? d.max_ot_limit);
  if (![d.early_in_min, d.late_out_min, d.max_ot_limit].every(v => v >= 0)) return { error: 'Minimums must be 0 or more' };
  d.ot_tiers = [1, 2, 3].map(i => ({ pay_code: String(b[`t${i}_pay_code`] ?? d.ot_tiers?.[i - 1]?.pay_code ?? ''), from: Number(b[`t${i}_hrs_from`] ?? d.ot_tiers?.[i - 1]?.from ?? 0), to: Number(b[`t${i}_hrs_to`] ?? d.ot_tiers?.[i - 1]?.to ?? 0) }));
  o.data = JSON.stringify(d);
  return { o };
}
function syncShiftFromTimetable(shiftId) {
  const s = db.prepare('SELECT id, timetable_id FROM shifts WHERE id=?').get(shiftId), t = s?.timetable_id ? db.prepare('SELECT * FROM att_timetables WHERE id=?').get(s.timetable_id) : null; if (!t) return;
  const br = t.break_id ? db.prepare('SELECT * FROM breaks WHERE id=?').get(t.break_id) : null, unpaid = br && !br.with_salary;
  if (t.type === 'flexible') db.prepare("UPDATE shifts SET start=?, end=?, type='flexible', required_min=?, break_id=?, break_start=NULL, break_end=NULL WHERE id=?").run(t.in_time, t.out_time, t.work_min, t.break_id, s.id);
  else db.prepare("UPDATE shifts SET start=?, end=?, type='fixed', required_min=NULL, break_id=?, break_start=?, break_end=? WHERE id=?").run(t.in_time, t.out_time, t.break_id, unpaid ? br.start : null, unpaid ? br.end : null, s.id);
}
const syncTimetable = (id) => { for (const s of db.prepare('SELECT id FROM shifts WHERE timetable_id=?').all(id)) syncShiftFromTimetable(s.id); };
function syncTimetablesUsingBreak(breakId) { for (const t of db.prepare('SELECT id FROM att_timetables WHERE break_id=?').all(breakId)) syncTimetable(t.id); }
// every plain shift gets a timetable of the same name so the Timetable page lists what the shifts really use
function ensureTimetables() {
  for (const s of db.prepare("SELECT * FROM shifts WHERE timetable_id IS NULL AND IFNULL(att_hidden,0)=0 AND IFNULL(type,'fixed')!='split'").all()) {
    let name = s.name, n = 1; while (db.prepare('SELECT 1 FROM att_timetables WHERE name=?').get(name)) name = `${s.name} (${++n})`;
    const cross = toMin(s.end) <= toMin(s.start) ? 1 : 0;
    const id = Number(db.prepare('INSERT INTO att_timetables(name, type, in_time, out_time, out_cross, work_min, break_id, data) VALUES(?,?,?,?,?,?,?,?)')
      .run(name, s.type === 'flexible' ? 'flexible' : 'normal', s.start, s.end, s.type === 'flexible' ? 1 : cross, s.required_min || 480, s.break_id ?? null, '{}').lastInsertRowid);
    db.prepare('UPDATE shifts SET timetable_id=? WHERE id=?').run(id, s.id);
  }
}
ensureTimetables();
const ttRow = (t) => {
  const br = t.break_id ? db.prepare('SELECT * FROM breaks WHERE id=?').get(t.break_id) : null, w = ttWorkMin(t);
  return { id: t.id, name: t.name, type: t.type === 'flexible' ? 'Flexible' : 'Normal', type_key: t.type, check_in: t.in_time + ':00', check_out: t.out_time + ':00', out_cross: t.out_cross, work_time: w, break_time: br ? (br.duration ?? (toMin(br.end) - toMin(br.start) + 1440) % 1440) : 0,
    break_id: t.break_id, work_day: t.work_day, work_type: WORK_TYPES[t.work_type], work_type_key: t.work_type, overtime: t.overtime ? 'Yes' : 'No', color: t.color ?? '', compensate: t.compensate, ...TT_DEFAULT, ...json(t.data) };
};
R.get('/att/timetables', (_q, res) => { ensureTimetables(); res.json(db.prepare("SELECT * FROM att_timetables WHERE name NOT LIKE 'Temp: %' OR id IN (SELECT timetable_id FROM shifts WHERE IFNULL(att_hidden,0)=0) ORDER BY id").all().map(ttRow)); });
const ttSave = (type) => (req, res) => {
  const { o, error } = cleanTimetable(req.body ?? {}, type, null); if (error) return fail(res, error);
  const cols = Object.keys(o);
  try { res.json({ id: Number(db.prepare(`INSERT INTO att_timetables(${cols}) VALUES(${cols.map(() => '?')})`).run(...cols.map(c => o[c])).lastInsertRowid) }); } catch { fail(res, 'A timetable with this name exists'); }
};
R.post('/att/timetables/normal', ttSave('normal'));
R.post('/att/timetables/flexible', ttSave('flexible'));
R.post('/att/timetables', (req, res) => ttSave(req.body?.type === 'flexible' ? 'flexible' : 'normal')(req, res));
R.put('/att/timetables/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM att_timetables WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such timetable', 404);
  const { o, error } = cleanTimetable(req.body ?? {}, old.type, old); if (error) return fail(res, error);
  const cols = Object.keys(o);
  try { db.prepare(`UPDATE att_timetables SET ${cols.map(c => c + '=?')} WHERE id=?`).run(...cols.map(c => o[c]), old.id); } catch { return fail(res, 'A timetable with this name exists'); }
  syncTimetable(old.id); res.json({ ok: true });
});
R.delete('/att/timetables/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT name FROM shifts WHERE timetable_id=? AND IFNULL(att_hidden,0)=0').get(id); if (used) return fail(res, `This timetable is used by the shift ${used.name}`);
  if (db.prepare('SELECT 1 FROM att_temp_sched WHERE timetable_id=?').get(id)) return fail(res, 'This timetable is used by a temporary schedule');
  for (const s of db.prepare('SELECT id FROM shifts WHERE timetable_id=?').all(id)) { try { db.prepare('DELETE FROM shifts WHERE id=?').run(s.id); } catch { return fail(res, 'This timetable is still used on the roster'); } }
  db.prepare('DELETE FROM att_timetables WHERE id=?').run(id); res.json({ ok: true });
});
// import: normal = name,check_in,check_out[,work_day] ; flexible = name,work_minutes,check_in,check_out ; mode ignore|overwrite
R.post('/att/timetables/import', (req, res) => {
  const type = req.body?.type === 'flexible' ? 'flexible' : 'normal', overwrite = req.body?.mode === 'overwrite', rows = firstLine(parseCsv(req.body?.csv), /name|alias/i);
  if (!rows.length) return fail(res, 'Paste at least one row'); let added = 0, updated = 0; const errors = [];
  rows.slice(0, 500).forEach((r, i) => {
    const b = type === 'flexible' ? { name: r[0], work_time_duration: r[1], in_time: r[2] || '00:00', out_time: r[3] || '00:00', out_time_cross_days: 1 } : { name: r[0], in_time: r[1], out_time: r[2], work_day: r[3] || 1 };
    const old = db.prepare('SELECT * FROM att_timetables WHERE name=?').get(String(b.name ?? '').trim());
    const { o, error } = cleanTimetable(b, type, old && old.type === type ? old : null); if (error) return errors.push(`Row ${i + 1}: ${error}`);
    const cols = Object.keys(o);
    if (old) { if (!overwrite) return; db.prepare(`UPDATE att_timetables SET ${cols.map(c => c + '=?')} WHERE id=?`).run(...cols.map(c => o[c]), old.id); syncTimetable(old.id); updated++; }
    else { db.prepare(`INSERT INTO att_timetables(${cols}) VALUES(${cols.map(() => '?')})`).run(...cols.map(c => o[c])); added++; }
  });
  res.json({ added, updated, skipped: rows.length - added - updated, errors: errors.slice(0, 20) });
});

// ---------------------------------------------------------------- shifts (a shift is built from a timetable)
const SH_UNITS = ['Day', 'Week', 'Month'];
const shRow = (s) => {
  const t = s.timetable_id ? db.prepare('SELECT name FROM att_timetables WHERE id=?').get(s.timetable_id) : null, x = json(s.att_extra, { enable: false, tiers: [] });
  return { id: s.id, name: s.name, code: s.code, timetable_id: s.timetable_id, timetable: t?.name ?? (s.type === 'split' ? `${s.start}-${s.end}, ${s.seg2_start}-${s.seg2_end}` : `${s.start}-${s.end}`), unit: s.shift_unit || 'Week', cycle: s.shift_cycle || 1,
    auto_shift: s.auto_shift ? 'Yes' : 'No', auto_shift_key: s.auto_shift, weekly_ot: x.enable ? 'Yes' : 'No', weekly_ot_key: x.enable ? 1 : 0, tiers: x.tiers ?? [], workdays: s.workdays, grace_min: s.grace_min, start: s.start, end: s.end, type: s.type };
};
R.get('/att/shiftdefs', (_q, res) => { ensureTimetables(); res.json(db.prepare('SELECT * FROM shifts WHERE IFNULL(att_hidden,0)=0 ORDER BY id').all().map(shRow)); });
function cleanShiftDef(b, old) {
  const name = txt(b.alias ?? b.name ?? old?.name, 60); if (!name) return { error: 'Shift name required' };
  const tid = Number(b.timetable_id ?? old?.timetable_id); const t = tid ? db.prepare('SELECT * FROM att_timetables WHERE id=?').get(tid) : null;
  if (!t && !(old && old.type === 'split')) return { error: 'Choose a timetable' };
  const unit = b.unit ?? old?.shift_unit ?? 'Week'; if (!SH_UNITS.includes(unit)) return { error: 'Unit must be Day, Week or Month' };
  const cycle = Number(b.cycle ?? old?.shift_cycle ?? 1); if (!(Number.isInteger(cycle) && cycle >= 1 && cycle <= 31)) return { error: 'Cycle must be 1 to 31' };
  const workdays = String(b.workdays ?? old?.workdays ?? '1,2,3,4,5,6').replace(/\s/g, ''); if (!/^[0-6](,[0-6])*$/.test(workdays)) return { error: 'Work days: numbers 0 (Sunday) to 6 (Saturday), comma separated' };
  const grace = Number(b.grace_min ?? old?.grace_min ?? 10); if (!(grace >= 0)) return { error: 'Grace must be 0 or more' };
  const ox = json(old?.att_extra, { enable: false, tiers: [] });
  const tiers = [1, 2, 3].map(i => ({ pay_code: String(b[`t${i}_pay_code`] ?? ox.tiers?.[i - 1]?.pay_code ?? ''), from: Number(b[`t${i}_hrs_from`] ?? ox.tiers?.[i - 1]?.from ?? 0), to: Number(b[`t${i}_hrs_to`] ?? ox.tiers?.[i - 1]?.to ?? 0) }));
  for (const x of tiers) if (!(x.from >= 0 && x.to >= 0) || (x.to && x.to <= x.from)) return { error: 'Weekly overtime hours: the end must be above the start' };
  return { o: { name, code: txt(b.code ?? old?.code, 4), timetable_id: t?.id ?? old?.timetable_id ?? null, shift_unit: unit, shift_cycle: cycle, auto_shift: flag(b.auto_shift ?? old?.auto_shift), workdays, grace_min: Math.round(grace), att_extra: JSON.stringify({ enable: !!flag(b.enable_ot_rule ?? b.weekly_ot_key ?? ox.enable), tiers }) } };
}
R.post('/att/shiftdefs', (req, res) => {
  const { o, error } = cleanShiftDef(req.body ?? {}, null); if (error) return fail(res, error);
  const t = db.prepare('SELECT * FROM att_timetables WHERE id=?').get(o.timetable_id), cols = [...Object.keys(o), 'start', 'end', 'type'], vals = [...Object.values(o), t.in_time, t.out_time, t.type === 'flexible' ? 'flexible' : 'fixed'];
  const id = tx(() => { const i = Number(db.prepare(`INSERT INTO shifts(${cols}) VALUES(${cols.map(() => '?')})`).run(...vals).lastInsertRowid); syncShiftFromTimetable(i); return i; });
  res.json({ id });
});
R.put('/att/shiftdefs/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM shifts WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such shift', 404);
  const { o, error } = cleanShiftDef(req.body ?? {}, old); if (error) return fail(res, error);
  const cols = Object.keys(o); tx(() => { db.prepare(`UPDATE shifts SET ${cols.map(c => c + '=?')} WHERE id=?`).run(...cols.map(c => o[c]), old.id); syncShiftFromTimetable(old.id); });
  res.json({ ok: true });
});
R.delete('/att/shiftdefs/:id', (req, res) => {
  const id = req.params.id;
  for (const [t, c, label] of [['employees', 'shift_id', 'employees'], ['schedules', 'shift_id', 'roster entries'], ['rotation_steps', 'shift_id', 'rotations'], ['departments', 'shift_id', 'departments'], ['employee_shifts', 'shift_id', 'employees (alternate shifts)'], ['shift_requests', 'shift_id', 'shift requests'], ['att_dept_sched', 'shift_id', 'department schedules'], ['att_group_sched', 'shift_id', 'group schedules']])
    if (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(id).n) return fail(res, `This shift is still used by ${label}`);
  db.prepare('DELETE FROM shifts WHERE id=?').run(id); res.json({ ok: true });
});

// ---------------------------------------------------------------- schedule assignment
const deptCount = `(SELECT COUNT(*) FROM employees e WHERE e.department_id=d.id AND e.active=1)`;
R.get('/att/deptsched', (_q, res) => res.json(db.prepare(`SELECT s.id, s.department_id, d.code AS dept_code, d.name AS dept_name, ${deptCount} AS employees, s.shift_id, sh.name AS shift, s.start_date, s.end_date FROM att_dept_sched s JOIN departments d ON d.id=s.department_id JOIN shifts sh ON sh.id=s.shift_id ORDER BY d.name, s.start_date`).all()));
R.get('/att/grpsched', (_q, res) => res.json(db.prepare(`SELECT s.id, s.group_id, g.code AS group_code, g.name AS group_name, (SELECT COUNT(*) FROM employees e WHERE e.group_id=g.id AND e.active=1) AS employees, s.shift_id, sh.name AS shift, s.start_date, s.end_date FROM att_group_sched s JOIN emp_groups g ON g.id=s.group_id JOIN shifts sh ON sh.id=s.shift_id ORDER BY g.name, s.start_date`).all()));
for (const [path, table, col, ptable, label] of [['deptsched', 'att_dept_sched', 'department_id', 'departments', 'department'], ['grpsched', 'att_group_sched', 'group_id', 'emp_groups', 'group']]) {
  const clean = (b, id) => {
    const target = Number(b[col] ?? b.target_id); if (!db.prepare(`SELECT 1 FROM ${ptable} WHERE id=?`).get(target)) return { error: `Choose a ${label}` };
    const shift = Number(b.shift_id); if (!db.prepare('SELECT 1 FROM shifts WHERE id=? AND IFNULL(att_hidden,0)=0').get(shift)) return { error: 'Choose a shift' };
    if (!DATE.test(b.start_date ?? '') || !DATE.test(b.end_date ?? '') || b.end_date < b.start_date) return { error: 'Valid start and end dates required (end not before start)' };
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${col}=? AND end_date>=? AND start_date<=? AND id IS NOT ?`).get(target, b.start_date, b.end_date, id ?? null)) return { error: `This ${label} already has a schedule in those dates` };
    return { o: { [col]: target, shift_id: shift, start_date: b.start_date, end_date: b.end_date } };
  };
  R.post(`/att/${path}`, (req, res) => { const { o, error } = clean(req.body ?? {}, null); if (error) return fail(res, error); res.json({ id: Number(db.prepare(`INSERT INTO ${table}(${col}, shift_id, start_date, end_date) VALUES(?,?,?,?)`).run(o[col], o.shift_id, o.start_date, o.end_date).lastInsertRowid) }); });
  R.put(`/att/${path}/:id`, (req, res) => {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(req.params.id)) return fail(res, 'No such schedule', 404);
    const { o, error } = clean(req.body ?? {}, Number(req.params.id)); if (error) return fail(res, error);
    db.prepare(`UPDATE ${table} SET ${col}=?, shift_id=?, start_date=?, end_date=? WHERE id=?`).run(o[col], o.shift_id, o.start_date, o.end_date, req.params.id); res.json({ ok: true });
  });
  R.delete(`/att/${path}/:id`, (req, res) => { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
}
// employee schedule = roster
R.get('/att/empsched', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT s.id, s.from_date AS start_date, s.to_date AS end_date, s.shift_id, sh.name AS shift, ${EMPSEL} FROM schedules s ${EMPJOIN.replace(/X\./g, 's.')} JOIN shifts sh ON sh.id=s.shift_id WHERE 1=1${sc.sql} ORDER BY s.from_date DESC, e.code LIMIT 2000`).all(...sc.args).map(empShape));
});
function addRoster(employeeId, shiftId, from, to, cover) {
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || to < from) return { error: 'Valid start and end dates required (end not before start)' };
  if (!db.prepare('SELECT 1 FROM shifts WHERE id=?').get(shiftId)) return { error: 'Choose a shift' };
  if (!cover && db.prepare('SELECT 1 FROM schedules WHERE employee_id=? AND to_date>=? AND from_date<=?').get(employeeId, from, to)) return { error: 'Already scheduled in those dates (tick "Cover existing schedule")' };
  setRoster(employeeId, from, to, shiftId); return {};
}
R.post('/att/empsched', (req, res) => {
  const b = req.body ?? {}, ids = b.employee_id ? [Number(b.employee_id)] : pickEmployees(b); if (!ids.length) return fail(res, 'Choose at least one employee');
  const cover = b.schedule_cover === undefined ? true : !!flag(b.schedule_cover), single = ids.length === 1 && b.employee_id;
  if (single) { const e = db.prepare('SELECT active FROM employees WHERE id=?').get(ids[0]); if (!e) return fail(res, 'Choose an employee'); }
  const r = tx(() => eachEmployee(ids, (id) => addRoster(id, Number(b.shift_id), b.start_date, b.end_date, cover)));
  if (single && r.errors.length) return fail(res, r.errors[0].replace(/^[^:]*: /, ''));
  if (!r.added) return fail(res, r.errors[0]?.replace(/^[^:]*: /, '') ?? 'Nothing added');
  res.json(r);
});
R.put('/att/empsched/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such schedule', 404);
  const b = req.body ?? {}, shift = Number(b.shift_id ?? old.shift_id), from = b.start_date ?? old.from_date, to = b.end_date ?? old.to_date;
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || to < from) return fail(res, 'Valid start and end dates required (end not before start)');
  if (!db.prepare('SELECT 1 FROM shifts WHERE id=?').get(shift)) return fail(res, 'Choose a shift');
  if (!db.prepare('SELECT 1 FROM schedules WHERE employee_id=? AND id!=? AND to_date>=? AND from_date<=?').get(old.employee_id, old.id, from, to)) { // nothing else in those dates: edit in place
    db.prepare('UPDATE schedules SET shift_id=?, from_date=?, to_date=? WHERE id=?').run(shift, from, to, old.id); return res.json({ ok: true });
  }
  tx(() => { db.prepare('DELETE FROM schedules WHERE id=?').run(old.id); addRoster(old.employee_id, shift, from, to, true); }); res.json({ ok: true });
});
R.delete('/att/empsched/:id', (req, res) => { db.prepare('DELETE FROM schedules WHERE id=?').run(req.params.id); res.json({ ok: true }); });
R.post('/att/empsched/import', (req, res) => { // emp_code,shift name,start,end
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i), cover = req.body?.mode === 'overwrite' || req.body?.mode === undefined; if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0, skipped = 0; const errors = [];
  tx(() => rows.slice(0, 2000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args), s = db.prepare('SELECT id FROM shifts WHERE name=?').get(r[1] ?? '');
    const x = !e ? { error: 'unknown employee' } : !s ? { error: `unknown shift ${r[1]}` } : addRoster(e.id, s.id, r[2], r[3], cover);
    x.error ? (skipped++, errors.push(`Row ${i + 1}: ${x.error}`)) : added++;
  }));
  res.json({ added, skipped, errors: errors.slice(0, 20) });
});
// temporary schedule = a one-day timetable override for one person (rides on the roster through a hidden shift per timetable)
function shiftForTimetable(ttId) {
  const t = db.prepare('SELECT * FROM att_timetables WHERE id=?').get(ttId);
  let s = db.prepare('SELECT id FROM shifts WHERE timetable_id=? AND att_hidden=1').get(ttId);
  if (!s) { s = { id: Number(db.prepare("INSERT INTO shifts(name, start, end, workdays, att_hidden, timetable_id, type) VALUES(?,?,?,?,1,?,?)").run(`Temp: ${t.name}`.slice(0, 60), t.in_time, t.out_time, '0,1,2,3,4,5,6', ttId, t.type === 'flexible' ? 'flexible' : 'fixed').lastInsertRowid) }; }
  syncShiftFromTimetable(s.id); db.prepare("UPDATE shifts SET workdays='0,1,2,3,4,5,6' WHERE id=?").run(s.id); return s.id;
}
R.get('/att/tempsched', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT s.id, s.date, s.timetable_id, t.name AS timetable, t.in_time, t.out_time, ${EMPSEL} FROM att_temp_sched s ${EMPJOIN.replace(/X\./g, 's.')} JOIN att_timetables t ON t.id=s.timetable_id WHERE 1=1${sc.sql} ORDER BY s.date DESC, e.code LIMIT 2000`).all(...sc.args)
    .map(r => empShape({ ...r, check_in: r.in_time + ':00', check_out: r.out_time + ':00' })));
});
function addTemp(employeeId, ttId, date) {
  if (!DATE.test(date ?? '')) return { error: 'Date required' };
  if (!db.prepare('SELECT 1 FROM att_timetables WHERE id=?').get(ttId)) return { error: 'Choose a timetable' };
  const sid = shiftForTimetable(ttId); setRoster(employeeId, date, date, sid);
  db.prepare('INSERT INTO att_temp_sched(employee_id, date, timetable_id, shift_id) VALUES(?,?,?,?) ON CONFLICT(employee_id, date) DO UPDATE SET timetable_id=excluded.timetable_id, shift_id=excluded.shift_id').run(employeeId, date, ttId, sid); return {};
}
R.post('/att/tempsched', (req, res) => {
  const b = req.body ?? {}, ids = b.employee_id ? [Number(b.employee_id)] : pickEmployees(b); if (!ids.length) return fail(res, 'Choose at least one employee');
  const from = b.date ?? b.start_date, to = b.end_date ?? from; if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || to < from) return fail(res, 'Valid date required');
  if (dayRange(from, to).length > 62) return fail(res, 'At most 62 days at a time');
  const days = dayRange(from, to), single = b.employee_id && days.length === 1;
  const r = tx(() => eachEmployee(ids, (id) => { for (const d of days) { const x = addTemp(id, Number(b.timetable_id), d); if (x.error) return x; } return {}; }));
  if (single && r.errors.length) return fail(res, r.errors[0].replace(/^[^:]*: /, ''));
  if (!r.added) return fail(res, r.errors[0]?.replace(/^[^:]*: /, '') ?? 'Nothing added');
  res.json(r);
});
R.put('/att/tempsched/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM att_temp_sched WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such temporary schedule', 404);
  const date = req.body?.date ?? old.date, tt = Number(req.body?.timetable_id ?? old.timetable_id);
  const r = tx(() => { removeTemp(old); return addTemp(old.employee_id, tt, date); }); r.error ? fail(res, r.error) : res.json({ ok: true });
});
function removeTemp(t) { db.prepare('DELETE FROM schedules WHERE employee_id=? AND from_date=? AND to_date=? AND shift_id=?').run(t.employee_id, t.date, t.date, t.shift_id); db.prepare('DELETE FROM att_temp_sched WHERE id=?').run(t.id); }
R.delete('/att/tempsched/:id', (req, res) => { const t = db.prepare('SELECT * FROM att_temp_sched WHERE id=?').get(req.params.id); if (t) removeTemp(t); res.json({ ok: true }); });
R.post('/att/tempsched/import', (req, res) => { // emp_code,date,timetable name
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i); if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0, skipped = 0; const errors = [];
  tx(() => rows.slice(0, 2000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args), t = db.prepare('SELECT id FROM att_timetables WHERE name=?').get(r[2] ?? '');
    const x = !e ? { error: 'unknown employee' } : !t ? { error: `unknown timetable ${r[2]}` } : addTemp(e.id, t.id, r[1]);
    x.error ? (skipped++, errors.push(`Row ${i + 1}: ${x.error}`)) : added++;
  }));
  res.json({ added, skipped, errors: errors.slice(0, 20) });
});
// View by Person: what an employee works every day of a month
R.get('/att/personsched', (req, res) => {
  const e = db.prepare('SELECT e.id, e.code, e.name, e.shift_id, e.department_id, e.group_id, e.rotation_id, e.rotation_anchor FROM employees e WHERE e.id=?').get(req.query.employee_id); if (!e) return fail(res, 'Choose an employee');
  const sc = scopeClause('e'); if (sc.sql && !db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${sc.sql}`).get(e.id, ...sc.args)) return fail(res, 'That employee is outside your access', 403);
  const m = /^\d{4}-\d\d$/.test(req.query.month ?? '') ? req.query.month : dateStr(new Date()).slice(0, 7), days = dayRange(m + '-01', addDays(addMonth(m), -1));
  const resolve = shiftResolver(days[0], days.at(-1)), hol = new Map(db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(days[0], days.at(-1)).map(h => [h.date, h.name]));
  const leaves = db.prepare("SELECT type, from_date, to_date FROM leaves WHERE employee_id=? AND status='approved' AND to_date>=? AND from_date<=?").all(e.id, days[0], days.at(-1));
  res.json({ employee: { id: e.id, code: e.code, name: e.name }, month: m, days: days.map(d => {
    const R0 = resolve(e, d), sh = R0.sh, wd = (sh?.workdays ?? '1,2,3,4,5,6').split(',').map(Number), dow = new Date(dayMin(d) * 60000).getUTCDay(), lv = leaves.find(l => l.from_date <= d && d <= l.to_date);
    const off = R0.off || (sh && !R0.fromRotation && !wd.includes(dow));
    return { date: d, dow, holiday: hol.get(d) ?? null, leave: lv?.type ?? null, off: !!off, shift: sh?.name ?? null, start: sh?.start ?? null, end: sh?.end ?? null, source: R0.source };
  }) });
});
function addMonth(m) { const y = +m.slice(0, 4), mo = +m.slice(5, 7); return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`; }

// ---------------------------------------------------------------- approvals: manual log (attendance_requests)
const PUNCH_TIME = /^(\d{4}-\d\d-\d\d)[ T]([01]\d|2[0-3]):([0-5]\d)(?::\d\d)?$/;
R.get('/att/manuallog', (req, res) => {
  const sc = scopeClause('e'), w = [], a = [];
  if (req.query.status) { w.push('r.status=?'); a.push(req.query.status); }
  if (req.query.from) { w.push('r.date>=?'); a.push(req.query.from); }
  if (req.query.to) { w.push('r.date<=?'); a.push(req.query.to); }
  res.json(db.prepare(`SELECT r.*, ${EMPSEL} FROM attendance_requests r ${EMPJOIN.replace(/X\./g, 'r.')} WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT 1000`).all(...sc.args, ...a).map(r => empShape({
    id: r.id, employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, has_photo: r.has_photo, kind: r.kind, status: r.status,
    punch_time: r.kind === 'add_punch' ? `${r.date} ${r.time}:00` : `${r.date} ${r.status_text}`, punch_state: r.kind === 'add_punch' ? STATES[r.punch_state ?? 0] ?? String(r.punch_state) : '', punch_state_key: r.punch_state ?? 0, work_code: r.work_code ?? '',
    reason: r.reason ?? '', apply_time: r.created, approval_status: statusLabel(r.status), decision_note: r.decision_note ?? '' })));
});
function createManual(employeeId, b, actor) {
  const type = b.type ?? 'punch'; let date, time = null, status_text = null;
  if (type === 'punch') {
    const m = String(b.punch_time ?? '').match(PUNCH_TIME); if (!m) return { error: 'Punch time must be YYYY-MM-DD HH:MM' };
    date = m[1]; time = `${m[2]}:${m[3]}`;
  } else { date = String(b.punch_time ?? b.date ?? '').slice(0, 10); status_text = type; if (!DATE.test(date)) return { error: 'Date required' }; }
  const ps = Number(b.punch_state ?? 0); if (!Number.isInteger(ps) || ps < 0 || ps > 9) return { error: 'Unknown punch state' };
  const r = createAttendanceRequest({ employee_id: employeeId, date, kind: type === 'punch' ? 'add_punch' : 'on_duty', time, status_text, reason: txt(b.reason, 200) ?? (b.auto_approve ? null : 'Manual log'), auto_approve: !!flag(b.auto_approve) }, actor);
  if (!r.error) db.prepare('UPDATE attendance_requests SET punch_state=?, work_code=? WHERE id=?').run(type === 'punch' ? ps : null, txt(b.work_code, 20), r.id);
  return r;
}
R.post('/att/manuallog', (req, res) => { const r = createManual(Number(req.body?.employee_id), req.body ?? {}, req.user); r.error ? fail(res, r.error) : res.json(r); });
R.post('/att/manuallog/bulk', (req, res) => {
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose at least one employee');
  const r = eachEmployee(ids, (id) => createManual(id, req.body, req.user)); if (!r.added) return fail(res, r.errors[0] ?? 'Nothing added'); res.json(r);
});
R.post('/att/manuallog/import', (req, res) => { // emp_code,YYYY-MM-DD HH:MM[,punch state number,reason]
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i); if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0; const errors = [];
  rows.slice(0, 2000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args);
    const x = e ? createManual(e.id, { punch_time: r[1], punch_state: r[2] || 0, reason: r[3], auto_approve: req.body?.auto_approve }, req.user) : { error: 'unknown employee' };
    x.error ? errors.push(`Row ${i + 1}: ${x.error}`) : added++;
  });
  res.json({ added, skipped: errors.length, errors: errors.slice(0, 20) });
});
function undoRequest(q) { // take back what an approved attendance request did
  if (q.status !== 'approved') return;
  const e = db.prepare('SELECT code FROM employees WHERE id=?').get(q.employee_id);
  if (q.kind === 'add_punch') db.prepare("DELETE FROM logs WHERE emp_code=? AND ts=? AND source='manual'").run(e.code, `${q.date} ${q.time}:00`);
  else db.prepare('DELETE FROM day_overrides WHERE employee_id=? AND date=? AND status=?').run(q.employee_id, q.date, q.status_text);
}
R.post('/att/manuallog/:id/revoke', (req, res) => {
  const q = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(req.params.id); if (!q) return fail(res, 'No such request', 404);
  if (!['pending', 'approved'].includes(q.status)) return fail(res, 'Only pending or approved requests can be revoked');
  tx(() => { undoRequest(q); db.prepare("UPDATE attendance_requests SET status='cancelled', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(req.user, stamp(), txt(req.body?.note, 200) ?? 'Revoked', q.id); db.prepare("DELETE FROM wf_progress WHERE kind='attendance' AND ref_id=?").run(q.id); });
  res.json({ ok: true });
});
R.delete('/att/manuallog/:id', (req, res) => {
  const q = db.prepare('SELECT * FROM attendance_requests WHERE id=?').get(req.params.id); if (!q) return res.json({ ok: true });
  tx(() => { undoRequest(q); db.prepare("DELETE FROM wf_progress WHERE kind='attendance' AND ref_id=?").run(q.id); db.prepare('DELETE FROM attendance_requests WHERE id=?').run(q.id); }); res.json({ ok: true });
});

// ---------------------------------------------------------------- approvals: leave (leaves)
R.get('/att/leavelist', (req, res) => {
  const sc = scopeClause('e'), w = [], a = [];
  if (req.query.status) { w.push('l.status=?'); a.push(req.query.status); }
  if (req.query.from) { w.push('l.to_date>=?'); a.push(req.query.from); }
  if (req.query.to) { w.push('l.from_date<=?'); a.push(req.query.to); }
  res.json(db.prepare(`SELECT l.*, ${EMPSEL} FROM leaves l ${EMPJOIN.replace(/X\./g, 'l.')} WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.from_date DESC, l.id DESC LIMIT 1000`).all(...sc.args, ...a).map(r => empShape({
    id: r.id, employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, has_photo: r.has_photo, status: r.status, start_time: r.from_date + (r.half ? ' (half day)' : ''), end_time: r.to_date, days: r.days, reason: r.note ?? '', apply_time: r.applied_at ?? '', pay_code: r.type,
    approval_status: statusLabel(r.status), decision_note: r.decision_note ?? '' })));
});
const leaveBody = (employeeId, b) => ({ employee_id: employeeId, from_date: String(b.start_time ?? b.from_date ?? '').slice(0, 10), to_date: String(b.end_time ?? b.to_date ?? b.start_time ?? '').slice(0, 10), type: b.pay_code ?? b.type, half: !!flag(b.half), note: txt(b.reason, 200), auto_approve: !!flag(b.auto_approve) });
R.post('/att/leavelist/bulk', (req, res) => {
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose at least one employee');
  const r = eachEmployee(ids, (id) => applyLeave(leaveBody(id, req.body), req.user)); if (!r.added) return fail(res, r.errors[0] ?? 'Nothing added'); res.json(r);
});
R.post('/att/leavelist/import', (req, res) => { // emp_code,leave type,from,to,reason
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i); if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0; const errors = [];
  rows.slice(0, 1000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args);
    const x = e ? applyLeave(leaveBody(e.id, { pay_code: r[1], from_date: r[2], to_date: r[3], reason: r[4], auto_approve: req.body?.auto_approve }), req.user) : { error: 'unknown employee' };
    x.error ? errors.push(`Row ${i + 1}: ${x.error}`) : added++;
  });
  res.json({ added, skipped: errors.length, errors: errors.slice(0, 20) });
});

// ---------------------------------------------------------------- approvals: overtime (overtime_requests)
const dayTypeCode = { work: 'Normal OT', weekend: 'Weekend OT', holiday: 'Holiday OT' };
R.get('/att/otlist', (req, res) => {
  const to = req.query.to || dateStr(new Date()), from = req.query.from || to.slice(0, 8) + '01';
  if (!DATE.test(from) || !DATE.test(to)) return fail(res, 'from/to must be YYYY-MM-DD');
  syncOvertimeRequests(from, to);
  const sc = scopeClause('e'), w = ['q.date BETWEEN ? AND ?'], a = [from, to]; if (req.query.status) { w.push('q.status=?'); a.push(req.query.status); }
  res.json(db.prepare(`SELECT q.*, ${EMPSEL} FROM overtime_requests q ${EMPJOIN.replace(/X\./g, 'q.')} WHERE ${w.join(' AND ')}${sc.sql} ORDER BY CASE q.status WHEN 'pending' THEN 0 ELSE 1 END, q.date DESC, e.code LIMIT 1000`).all(...a, ...sc.args).map(r => empShape({
    id: r.id, employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, has_photo: r.has_photo, kind: r.kind, status: r.status, pay_code: r.pay_code ?? dayTypeCode[r.day_type] ?? 'Normal OT',
    start_time: r.start_time ?? r.date, end_time: r.end_time ?? `${r.date} (${r.status === 'pending' ? r.calc_minutes : r.minutes} min)`, minutes: r.minutes, calc_minutes: r.calc_minutes, reason: r.note ?? (r.kind === 'auto' ? 'Calculated from punches' : ''),
    apply_time: r.created, approval_status: statusLabel(r.status) })));
});
function createOt(employeeId, b, actor) {
  const e = db.prepare('SELECT id, active FROM employees WHERE id=?').get(employeeId); if (!e) return { error: 'Choose an employee' };
  const s = String(b.start_time ?? '').match(PUNCH_TIME), t = String(b.end_time ?? '').match(PUNCH_TIME); if (!s || !t) return { error: 'Start and end time must be YYYY-MM-DD HH:MM' };
  const a0 = dayMin(s[1]) + +s[2] * 60 + +s[3], a1 = dayMin(t[1]) + +t[2] * 60 + +t[3], mins = a1 - a0;
  if (!(mins >= 1 && mins <= 1440)) return { error: 'End must be after start, at most 24 hours later' };
  const code = b.pay_code || 'Normal OT'; if (!OT_CODES.includes(code)) return { error: 'Unknown pay code' };
  db.prepare(`INSERT INTO overtime_requests(employee_id, date, kind, calc_minutes, minutes, status, note, decided_by, decided_at, start_time, end_time, pay_code) VALUES(?,?,'manual',?,?,'approved',?,?,?,?,?,?)
              ON CONFLICT(employee_id, date, kind) DO UPDATE SET minutes=excluded.minutes, calc_minutes=excluded.calc_minutes, note=excluded.note, decided_by=excluded.decided_by, decided_at=excluded.decided_at, start_time=excluded.start_time, end_time=excluded.end_time, pay_code=excluded.pay_code`)
    .run(employeeId, s[1], mins, mins, txt(b.reason, 200), actor, stamp(), `${s[1]} ${s[2]}:${s[3]}`, `${t[1]} ${t[2]}:${t[3]}`, code);
  return { minutes: mins };
}
R.post('/att/otlist', (req, res) => { const r = createOt(Number(req.body?.employee_id), req.body ?? {}, req.user); r.error ? fail(res, r.error) : res.json({ ok: true, ...r }); });
R.post('/att/otlist/bulk', (req, res) => {
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose at least one employee');
  const r = eachEmployee(ids, (id) => createOt(id, req.body, req.user)); if (!r.added) return fail(res, r.errors[0] ?? 'Nothing added'); res.json(r);
});
R.post('/att/otlist/import', (req, res) => { // emp_code,start,end,pay code,reason
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i); if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0; const errors = [];
  rows.slice(0, 1000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args);
    const x = e ? createOt(e.id, { start_time: r[1], end_time: r[2], pay_code: r[3] || 'Normal OT', reason: r[4] }, req.user) : { error: 'unknown employee' };
    x.error ? errors.push(`Row ${i + 1}: ${x.error}`) : added++;
  });
  res.json({ added, skipped: errors.length, errors: errors.slice(0, 20) });
});
R.post('/att/otlist/:id/revoke', (req, res) => { // an approved calculated overtime goes back to waiting; a manual entry is removed
  const q = db.prepare('SELECT * FROM overtime_requests WHERE id=?').get(req.params.id); if (!q) return fail(res, 'No such overtime request', 404);
  if (q.kind === 'manual') { db.prepare('DELETE FROM overtime_requests WHERE id=?').run(q.id); return res.json({ ok: true }); }
  if (q.status === 'pending') return fail(res, 'This request is already waiting');
  db.prepare("UPDATE overtime_requests SET status='pending', minutes=calc_minutes, decided_by=NULL, decided_at=NULL WHERE id=?").run(q.id); db.prepare("DELETE FROM wf_progress WHERE kind='overtime' AND ref_id=?").run(q.id); res.json({ ok: true });
});

// ---------------------------------------------------------------- approvals: training (own table, approved training marks the days "Training")
const trSel = `SELECT t.*, ${EMPSEL} FROM att_training t ${EMPJOIN.replace(/X\./g, 't.')}`;
R.get('/att/training', (req, res) => {
  const sc = scopeClause('e'), w = [], a = []; if (req.query.status) { w.push('t.status=?'); a.push(req.query.status); }
  res.json(db.prepare(`${trSel} WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY CASE t.status WHEN 'pending' THEN 0 ELSE 1 END, t.id DESC LIMIT 1000`).all(...sc.args, ...a).map(r => empShape({
    id: r.id, employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, has_photo: r.has_photo, status: r.status, pay_code: r.pay_code ?? 'Training', start_time: r.start_time, end_time: r.end_time, reason: r.reason ?? '', apply_time: r.created, approval_status: statusLabel(r.status) })));
});
function applyTraining(t) { for (const d of dayRange(t.start_time.slice(0, 10), t.end_time.slice(0, 10))) db.prepare('INSERT INTO day_overrides(employee_id, date, status, note) VALUES(?,?,?,?) ON CONFLICT(employee_id, date) DO UPDATE SET status=excluded.status, note=excluded.note').run(t.employee_id, d, 'Training', `Training #${t.id}`); }
const undoTraining = (t) => db.prepare('DELETE FROM day_overrides WHERE employee_id=? AND note=?').run(t.employee_id, `Training #${t.id}`);
function createTraining(employeeId, b, actor) {
  const e = db.prepare('SELECT id, active FROM employees WHERE id=?').get(employeeId); if (!e || !e.active) return { error: 'Choose an active employee' };
  const s = String(b.start_time ?? '').match(PUNCH_TIME), t = String(b.end_time ?? '').match(PUNCH_TIME); if (!s || !t) return { error: 'Start and end time must be YYYY-MM-DD HH:MM' };
  const start = `${s[1]} ${s[2]}:${s[3]}`, end = `${t[1]} ${t[2]}:${t[3]}`; if (end <= start) return { error: 'End must be after start' };
  if (dayMin(t[1]) - dayMin(s[1]) > 366 * 1440) return { error: 'A training cannot be longer than a year' };
  const id = Number(db.prepare('INSERT INTO att_training(employee_id, pay_code, start_time, end_time, reason, status, created_by) VALUES(?,?,?,?,?,?,?)').run(employeeId, txt(b.pay_code, 30) ?? 'Training', start, end, txt(b.reason, 200), 'pending', actor).lastInsertRowid);
  if (flag(b.auto_approve)) { applyTraining({ id, employee_id: employeeId, start_time: start, end_time: end }); db.prepare("UPDATE att_training SET status='approved', decided_by=?, decided_at=? WHERE id=?").run(actor, stamp(), id); }
  return { id };
}
R.post('/att/training', (req, res) => { const r = createTraining(Number(req.body?.employee_id), req.body ?? {}, req.user); r.error ? fail(res, r.error) : res.json(r); });
R.put('/att/training/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM att_training WHERE id=?').get(req.params.id); if (!t) return fail(res, 'No such training', 404);
  if (t.status !== 'pending') return fail(res, 'Only pending trainings can be edited');
  const s = String(req.body?.start_time ?? t.start_time).match(PUNCH_TIME), e = String(req.body?.end_time ?? t.end_time).match(PUNCH_TIME); if (!s || !e) return fail(res, 'Start and end time must be YYYY-MM-DD HH:MM');
  const start = `${s[1]} ${s[2]}:${s[3]}`, end = `${e[1]} ${e[2]}:${e[3]}`; if (end <= start) return fail(res, 'End must be after start');
  db.prepare('UPDATE att_training SET start_time=?, end_time=?, reason=?, pay_code=? WHERE id=?').run(start, end, txt(req.body?.reason ?? t.reason, 200), txt(req.body?.pay_code ?? t.pay_code, 30), t.id); res.json({ ok: true });
});
const trDecide = (action) => (req, res) => {
  const t = db.prepare('SELECT * FROM att_training WHERE id=?').get(req.params.id); if (!t) return fail(res, 'No such training', 404);
  if (t.status !== 'pending') return fail(res, 'Only pending trainings can be decided');
  tx(() => { if (action === 'approve') applyTraining(t); db.prepare('UPDATE att_training SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?').run(action === 'approve' ? 'approved' : 'rejected', req.user, stamp(), txt(req.body?.note, 200), t.id); });
  res.json({ ok: true });
};
R.post('/att/training/:id/approve', trDecide('approve')); R.post('/att/training/:id/reject', trDecide('reject'));
R.post('/att/training/:id/revoke', (req, res) => {
  const t = db.prepare('SELECT * FROM att_training WHERE id=?').get(req.params.id); if (!t) return fail(res, 'No such training', 404);
  if (!['pending', 'approved'].includes(t.status)) return fail(res, 'Only pending or approved trainings can be revoked');
  tx(() => { undoTraining(t); db.prepare("UPDATE att_training SET status='cancelled', decided_by=?, decided_at=? WHERE id=?").run(req.user, stamp(), t.id); }); res.json({ ok: true });
});
R.delete('/att/training/:id', (req, res) => { const t = db.prepare('SELECT * FROM att_training WHERE id=?').get(req.params.id); if (t) tx(() => { undoTraining(t); db.prepare('DELETE FROM att_training WHERE id=?').run(t.id); }); res.json({ ok: true }); });
R.post('/att/training/bulk', (req, res) => {
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose at least one employee');
  const r = eachEmployee(ids, (id) => createTraining(id, req.body, req.user)); if (!r.added) return fail(res, r.errors[0] ?? 'Nothing added'); res.json(r);
});
R.post('/att/training/import', (req, res) => { // emp_code,start,end,pay code,reason
  const rows = firstLine(parseCsv(req.body?.csv), /code|employee/i); if (!rows.length) return fail(res, 'Paste at least one row');
  const sc = scopeClause('e'); let added = 0; const errors = [];
  rows.slice(0, 1000).forEach((r, i) => {
    const e = db.prepare(`SELECT e.id FROM employees e WHERE e.code=?${sc.sql}`).get(r[0], ...sc.args);
    const x = e ? createTraining(e.id, { start_time: r[1], end_time: r[2], pay_code: r[3], reason: r[4], auto_approve: req.body?.auto_approve }, req.user) : { error: 'unknown employee' };
    x.error ? errors.push(`Row ${i + 1}: ${x.error}`) : added++;
  });
  res.json({ added, skipped: errors.length, errors: errors.slice(0, 20) });
});

// ---------------------------------------------------------------- approvals: schedule adjustment (shift_requests)
R.get('/att/schedadj', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT r.*, s.name AS shift, o.name AS other, ${EMPSEL} FROM shift_requests r ${EMPJOIN.replace(/X\./g, 'r.')} LEFT JOIN shifts s ON s.id=r.shift_id LEFT JOIN employees o ON o.id=r.other_employee_id WHERE 1=1${sc.sql} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC LIMIT 1000`).all(...sc.args).map(r => empShape({
    id: r.id, employee_id: r.employee_id, code: r.code, name: r.name, dept: r.dept, has_photo: r.has_photo, status: r.status, date: r.from_date + (r.to_date !== r.from_date ? ` - ${r.to_date}` : ''), previous: r.prev_shift ?? '',
    new_schedule: r.kind === 'swap' ? `Swap with ${r.other}` : r.shift ?? '', reason: r.reason ?? '', apply_time: r.created, approval_status: statusLabel(r.status), decision_note: r.decision_note ?? '' })));
});
R.post('/att/schedadj', (req, res) => {
  const b = req.body ?? {}, date = String(b.date ?? b.att_date ?? '').slice(0, 10), emp = db.prepare('SELECT * FROM employees WHERE id=?').get(b.employee_id);
  if (!emp) return fail(res, 'Choose an employee'); if (!DATE.test(date)) return fail(res, 'Date required');
  const prev = shiftResolver(date, date)(emp, date), r = createShiftRequest({ kind: 'change', employee_id: emp.id, shift_id: b.shift_id, from_date: date, to_date: b.end_date && DATE.test(b.end_date) ? b.end_date : date, reason: txt(b.reason ?? b.apply_reason, 200), auto_approve: !!flag(b.auto_approve) }, req.user);
  if (r.error) return fail(res, r.error);
  db.prepare('UPDATE shift_requests SET prev_shift=? WHERE id=?').run(prev.off ? 'Off' : prev.sh?.name ?? 'No shift', r.id); res.json(r);
});
R.delete('/att/schedadj/:id', (req, res) => { db.prepare("DELETE FROM wf_progress WHERE kind='shift' AND ref_id=?").run(req.params.id); db.prepare('DELETE FROM shift_requests WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------- benefit management: leave groups (leave_policies) and holidays
for (const r of db.prepare('SELECT id FROM leave_policies WHERE code IS NULL ORDER BY id').all()) db.prepare('UPDATE leave_policies SET code=? WHERE id=?').run(nextCode('leave_policies'), r.id);
R.get('/att/leavegroups', (_q, res) => {
  for (const r of db.prepare('SELECT id FROM leave_policies WHERE code IS NULL').all()) db.prepare('UPDATE leave_policies SET code=? WHERE id=?').run(nextCode('leave_policies'), r.id);
  res.json(db.prepare('SELECT p.id, p.code, p.name, (SELECT COUNT(*) FROM employees e WHERE e.leave_policy_id=p.id AND e.active=1) AS employees, (SELECT COUNT(*) FROM leave_policy_items i WHERE i.policy_id=p.id) AS items FROM leave_policies p ORDER BY CAST(p.code AS INTEGER), p.name').all());
});
R.get('/att/leavegroups/next-code', (_q, res) => res.json({ code: nextCode('leave_policies') }));
R.post('/att/leavegroups', (req, res) => {
  const code = txt(req.body?.code, 20) ?? nextCode('leave_policies'), name = txt(req.body?.name, 60); if (!name) return fail(res, 'Name required');
  if (db.prepare('SELECT 1 FROM leave_policies WHERE code=?').get(code)) return fail(res, `The code ${code} is already used`);
  try { res.json({ id: Number(db.prepare('INSERT INTO leave_policies(name, code) VALUES(?,?)').run(name, code).lastInsertRowid) }); } catch { fail(res, 'A leave group with this name exists'); }
});
R.put('/att/leavegroups/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM leave_policies WHERE id=?').get(req.params.id)) return fail(res, 'No such leave group', 404);
  const code = txt(req.body?.code, 20), name = txt(req.body?.name, 60); if (!code || !name) return fail(res, 'Code and name required');
  if (db.prepare('SELECT 1 FROM leave_policies WHERE code=? AND id!=?').get(code, req.params.id)) return fail(res, `The code ${code} is already used`);
  try { db.prepare('UPDATE leave_policies SET name=?, code=? WHERE id=?').run(name, code, req.params.id); res.json({ ok: true }); } catch { fail(res, 'A leave group with this name exists'); }
});
R.delete('/att/leavegroups/:id', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM employees WHERE leave_policy_id=?').get(req.params.id).n; if (n) return fail(res, `${n} employee(s) are still in this leave group`);
  db.prepare('DELETE FROM leave_policies WHERE id=?').run(req.params.id); res.json({ ok: true });
});
R.post('/att/leavegroups/assign', (req, res) => {
  const pid = Number(req.body?.policy_id); if (!db.prepare('SELECT 1 FROM leave_policies WHERE id=?').get(pid)) return fail(res, 'Choose a leave group');
  const ids = pickEmployees(req.body); if (!ids.length) return fail(res, 'Choose the employees to assign');
  tx(() => { for (const id of ids) db.prepare('UPDATE employees SET leave_policy_id=? WHERE id=?').run(pid, id); }); res.json({ assigned: ids.length });
});
R.post('/att/groups/remove', (req, res) => {
  const ids = (Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : []).map(Number).filter(Boolean); if (!ids.length) return fail(res, 'Choose the employees to remove');
  tx(() => { for (const id of ids) db.prepare('UPDATE employees SET group_id=NULL WHERE id=?').run(id); }); res.json({ removed: ids.length });
});
R.post('/att/leavegroups/remove', (req, res) => {
  const ids = (Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : []).map(Number).filter(Boolean); if (!ids.length) return fail(res, 'Choose the employees to remove');
  tx(() => { for (const id of ids) db.prepare('UPDATE employees SET leave_policy_id=NULL WHERE id=?').run(id); }); res.json({ removed: ids.length });
});
// holidays: att_holidays is the master (name, duration, scope); the dates it covers are written to the `holidays` table the engine reads
function migrateHolidays() {
  for (const h of db.prepare('SELECT * FROM holidays WHERE att_holiday_id IS NULL ORDER BY date').all()) {
    const id = Number(db.prepare('INSERT INTO att_holidays(name, start_date, duration) VALUES(?,?,1)').run(h.name || 'Holiday', h.date).lastInsertRowid); db.prepare('UPDATE holidays SET att_holiday_id=? WHERE id=?').run(id, h.id);
  }
}
migrateHolidays();
function syncHoliday(id) {
  const h = db.prepare('SELECT * FROM att_holidays WHERE id=?').get(id);
  db.prepare('DELETE FROM holidays WHERE att_holiday_id=?').run(id); if (!h || h.department_id || h.group_id) return;
  for (let i = 0; i < h.duration; i++) db.prepare('INSERT INTO holidays(date, name, att_holiday_id) VALUES(?,?,?)').run(addDays(h.start_date, i), h.name, id);
}
const holRow = (h) => ({ id: h.id, name: h.name, start_date: h.start_date, end_date: addDays(h.start_date, h.duration - 1), duration: h.duration, overtime: h.ot_enable ? 'Yes' : 'No', ot_enable: h.ot_enable, color: h.color ?? '', department_id: h.department_id, group_id: h.group_id,
  department: h.department_id ? db.prepare('SELECT name FROM departments WHERE id=?').get(h.department_id)?.name ?? '' : '', group: h.group_id ? db.prepare('SELECT name FROM emp_groups WHERE id=?').get(h.group_id)?.name ?? '' : '', ...(json(h.ot, {})) });
R.get('/att/holidays', (_q, res) => { migrateHolidays(); res.json(db.prepare('SELECT * FROM att_holidays ORDER BY start_date DESC, id DESC').all().map(holRow)); });
function cleanHoliday(b, id) {
  const name = txt(b.alias ?? b.name, 80); if (!name) return { error: 'Name required' };
  if (!DATE.test(b.start_date ?? '')) return { error: 'Start date required' };
  const duration = Number(b.duration_day ?? b.duration ?? 1); if (!(Number.isInteger(duration) && duration >= 1 && duration <= 60)) return { error: 'Duration must be 1 to 60 days' };
  const department_id = b.department_id ? Number(b.department_id) : null, group_id = b.group_id ? Number(b.group_id) : null;
  if (department_id && !db.prepare('SELECT 1 FROM departments WHERE id=?').get(department_id)) return { error: 'Unknown department' };
  if (group_id && !db.prepare('SELECT 1 FROM emp_groups WHERE id=?').get(group_id)) return { error: 'Unknown attendance group' };
  const ot = {}; for (const i of [1, 2, 3]) { ot[`t${i}_pay_code`] = String(b[`t${i}_pay_code`] ?? ''); ot[`t${i}_hrs_from`] = Number(b[`t${i}_hrs_from`] ?? 0); ot[`t${i}_hrs_to`] = Number(b[`t${i}_hrs_to`] ?? 0); if (ot[`t${i}_hrs_to`] && ot[`t${i}_hrs_to`] <= ot[`t${i}_hrs_from`]) return { error: 'Overtime hours: the end must be above the start' }; }
  if (!department_id && !group_id) for (let i = 0; i < duration; i++) { // dates that only this holiday may use
    const d = addDays(b.start_date, i), clash = db.prepare('SELECT name, att_holiday_id FROM holidays WHERE date=?').get(d);
    if (clash && clash.att_holiday_id !== id) return { error: `${d} is already a holiday (${clash.name})` };
  }
  return { o: { name, start_date: b.start_date, duration, color: txt(b.color_setting ?? b.color, 20), ot_enable: flag(b.enable_ot_rule ?? b.ot_enable), ot: JSON.stringify(ot), department_id, group_id } };
}
R.post('/att/holidays', (req, res) => {
  const { o, error } = cleanHoliday(req.body ?? {}, null); if (error) return fail(res, error);
  const id = tx(() => { const i = Number(db.prepare('INSERT INTO att_holidays(name, start_date, duration, color, ot_enable, ot, department_id, group_id) VALUES(?,?,?,?,?,?,?,?)').run(o.name, o.start_date, o.duration, o.color, o.ot_enable, o.ot, o.department_id, o.group_id).lastInsertRowid); syncHoliday(i); return i; });
  res.json({ id });
});
R.put('/att/holidays/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM att_holidays WHERE id=?').get(req.params.id)) return fail(res, 'No such holiday', 404);
  const { o, error } = cleanHoliday(req.body ?? {}, Number(req.params.id)); if (error) return fail(res, error);
  tx(() => { db.prepare('UPDATE att_holidays SET name=?, start_date=?, duration=?, color=?, ot_enable=?, ot=?, department_id=?, group_id=? WHERE id=?').run(o.name, o.start_date, o.duration, o.color, o.ot_enable, o.ot, o.department_id, o.group_id, req.params.id); syncHoliday(Number(req.params.id)); });
  res.json({ ok: true });
});
R.delete('/att/holidays/:id', (req, res) => { tx(() => { db.prepare('DELETE FROM holidays WHERE att_holiday_id=?').run(req.params.id); db.prepare('DELETE FROM att_holidays WHERE id=?').run(req.params.id); }); res.json({ ok: true }); });

// ---------------------------------------------------------------- calculation: recalculate the chosen people and days
R.post('/att/calc', (req, res) => {
  const b = req.body ?? {}, to = b.end_date ?? b.to, from = b.start_date ?? b.from;
  if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || to < from) return fail(res, 'Valid start and end dates required (end not before start)');
  if (dayMin(to) - dayMin(from) > 366 * 1440) return fail(res, 'At most one year at a time');
  const ids = pickEmployees(b); if (!ids.length) return fail(res, 'Choose at least one employee');
  const t0 = Date.now(), rows = attendanceReport(from, to, { employeeIds: ids }); syncOvertimeRequests(from, to, { employeeIds: ids });
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const spent = Date.now() - t0, id = Number(db.prepare('INSERT INTO att_calc_batch(started, task, started_by, result, employees, spent_ms, att_from, att_to, run_group, details, processed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(stamp(), 'Manual calculation', req.user, 'Success', ids.length, spent, from, to, 'Manual', JSON.stringify(counts), req.user).lastInsertRowid);
  res.json({ id, employees: ids.length, days: rows.length, counts, spent_ms: spent });
});
R.get('/att/calcbatches', (_q, res) => res.json(db.prepare('SELECT * FROM att_calc_batch ORDER BY id DESC LIMIT 500').all().map(r => ({ ...r, details: json(r.details) }))));
R.delete('/att/calcbatches/:id', (req, res) => { db.prepare('DELETE FROM att_calc_batch WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------------------------------------------------------------- workbench quick setup: break + timetable + shift in one go
R.post('/att/quickset', (req, res) => {
  const b = req.body ?? {}, out = {};
  const r = tx(() => {
    let breakId = null;
    if (txt(b.break_name)) {
      const { o, error } = cleanBreak({ alias: b.break_name, period_start: b.break_start, period_end: b.break_end, with_salary: 0 }); if (error) throw new Error(error);
      breakId = Number(db.prepare('INSERT INTO breaks(name, start, end, duration, with_salary, calc_type, extra) VALUES(?,?,?,?,?,?,?)').run(o.name, o.start, o.end, o.duration, 0, 0, o.extra).lastInsertRowid); out.break_id = breakId;
    }
    const { o: tt, error: e2 } = cleanTimetable({ alias: b.timetable_name, in_time: b.check_in, out_time: b.check_out, break_id: breakId }, 'normal', null); if (e2) throw new Error(e2);
    const cols = Object.keys(tt); const ttId = Number(db.prepare(`INSERT INTO att_timetables(${cols}) VALUES(${cols.map(() => '?')})`).run(...cols.map(c => tt[c])).lastInsertRowid); out.timetable_id = ttId;
    const { o: sh, error: e3 } = cleanShiftDef({ name: b.shift_name || b.timetable_name, timetable_id: ttId, workdays: b.workdays || '1,2,3,4,5,6' }, null); if (e3) throw new Error(e3);
    const sc = [...Object.keys(sh), 'start', 'end', 'type'], sv = [...Object.values(sh), tt.in_time, tt.out_time, 'fixed'];
    out.shift_id = Number(db.prepare(`INSERT INTO shifts(${sc}) VALUES(${sc.map(() => '?')})`).run(...sv).lastInsertRowid); syncShiftFromTimetable(out.shift_id); return out;
  });
  res.json(r);
});
R.use('/att', (err, _q, res, next) => (err ? fail(res, err.message.includes('UNIQUE') ? 'That name or code already exists' : err.message) : next()));
