// BioTime-style attendance report pages (Transaction / Daily / Weekly / Monthly / Summary / Custom).
// One generic engine: every report is a column list (zk-reports-spec.js, titles as on the reference app) plus a row builder.
// Rows are objects keyed by column title, so a report is "which titles" + "which builder". All numbers come from our own
// engine (attendanceReport, leave balances, logs); the same rows feed the screen, CSV, Excel, PDF and TXT exports.
import express from 'express';
import { db } from './db.js';
import { attendanceReport, dayList, shiftHours, PRESENT } from './report.js';
import { dateStr, addDays } from './dates.js';
import { scopeClause } from './rbac.js';
import { balancesOf } from './leave.js';
import { toCsvCols } from './csv.js';
import { makeXlsx } from './xlsx.js';
import { makePdf } from './pdf.js';
import SPEC from './zk-reports-spec.js';

export const zkReportsRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const pad = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round(n * 100) / 100;
const h2 = (min) => r2(min / 60);
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const tmin = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dowName = (d) => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
const DATE = /^\d{4}-\d\d-\d\d$/;

// ---------- the report catalogue ----------
// kind: which row builder; month: day columns across the range (monthly grids)
const MONTH_REPORTS = { monthlyStatusReport: 'status', monthlyPunchReport: 'punch', monthlyWorkHoursReport: 'hours', monthlyOvertimeReport: 'ot' };
const KIND = {
  transactionReport: 'txn', timeCardReport: 'timecard', firstLastReport: 'firstlast', firstInLastOutReport: 'firstlast',
  totalTimeCardReportV2: 'day', dailyActivityReport: 'day', dailyOvertimeReport: 'day', dailyLeaveReport: 'day', dailyLateInReport: 'day', dailyEarlyOutReport: 'day',
  dailyAbsentReport: 'day', dailyExceptionReport: 'day', scheduledPunchReport: 'sched', punchParingReport: 'pair', dailyMultiplePunchParingReport: 'multi', dailyMultipleBreakParingReport: 'break',
  weeklyWorkedHoursReport: 'week', weeklyOvertimeReport: 'week', monthlyStatusReport: 'month', monthlyPunchReport: 'month', monthlyWorkHoursReport: 'month', monthlyOvertimeReport: 'month', monthlyAbsenceReport: 'monthabs',
  empSummaryReport: 'emp', employeeOvertimeReport: 'emp', employeeLeaveReport: 'emp', departmentSummaryReport: 'dept', departmentOvertimeReport: 'dept', groupSummaryReport: 'group', groupOvertimeReport: 'group',
  leaveBalanceSummaryReport: 'leavebal' };
const LABEL = { transactionReport: 'Transaction', timeCardReport: 'Time Card', firstLastReport: 'First & Last', firstInLastOutReport: 'First In Last Out', totalTimeCardReportV2: 'Total Time Card', dailyActivityReport: 'Worked Hrs',
  dailyOvertimeReport: 'Overtime Report', dailyLeaveReport: 'Leave Report', dailyLateInReport: 'Late In Report', dailyEarlyOutReport: 'Early Out Report', dailyAbsentReport: 'Absent Report', dailyExceptionReport: 'Exception Report',
  scheduledPunchReport: 'Scheduled Log', punchParingReport: 'Paired Punch', dailyMultiplePunchParingReport: 'Multiple Worked Hrs', dailyMultipleBreakParingReport: 'Multiple Break Time', weeklyWorkedHoursReport: 'Weekly Worked Hrs',
  weeklyOvertimeReport: 'Weekly Overtime', monthlyStatusReport: 'Monthly Status', monthlyPunchReport: 'Monthly Check-in&out', monthlyWorkHoursReport: 'Monthly Worked Hrs', monthlyOvertimeReport: 'Monthly Overtime',
  monthlyAbsenceReport: 'Monthly Absence', empSummaryReport: 'Employee Attendance', employeeOvertimeReport: 'Employee Overtime', employeeLeaveReport: 'Employee Leave', departmentSummaryReport: 'Department Attendance',
  departmentOvertimeReport: 'Department Overtime', groupSummaryReport: 'Group Attendance', groupOvertimeReport: 'Group Overtime', leaveBalanceSummaryReport: 'Leave Balance' };
const REPORTS = Object.keys(KIND);
// A report is "in the leave module" or "in the overtime module" for permissions: see rbac.js
const LEGEND = 'P:Regular, L:Late In, E:Early Out, A:Absence,';

// ---------- pay-code columns (hours/minutes per day, summed by the summary reports) ----------
const LEAVE_FIXED = [['Annual Leave(H)', 'lv_annual', 'annual'], ['Sick Leave(H)', 'lv_sick', 'sick'], ['Casual Leave(H)', 'lv_casual', 'casual'], ['Maternity Leave(H)', 'lv_maternity', 'matern'],
  ['Compassionate Leave(H)', 'lv_compassionate', 'compass'], ['Business Trip(H)', 'lv_trip', 'trip'], ['Compensatory Leave(H)', 'lv_comp', 'compensat']];
const PC_NUM = ['Regular(H)', 'Late In(M)', 'Early Out(M)', 'Absence(H)', 'Normal OT(H)', 'Weekend OT(H)', 'Holiday OT(H)', 'OT1(H)', 'OT2(H)', 'OT3(H)', 'Compensatory(H)', ...LEAVE_FIXED.map(l => l[0])];
// Leave types we have that the reference has no fixed column for (Paternity, Unpaid...) get their own column after Compensatory Leave.
const typeKey = (name) => { const n = name.toLowerCase(); const f = LEAVE_FIXED.find(l => n.includes(l[2]) || (l[2] === 'trip' && n.includes('business'))); return f ? f[1] : null; };
let EXTRA = null, EXTRA_AT = 0; // leave types can be edited, so re-read every few seconds
const extraLeaveTypes = () => { if (!EXTRA || Date.now() - EXTRA_AT > 3000) { EXTRA = db.prepare('SELECT name FROM leave_types ORDER BY id').all().map(t => t.name).filter(n => !typeKey(n)); EXTRA_AT = Date.now(); } return EXTRA; };
const extraTitle = (n) => /leave$/i.test(n) ? `${n}(H)` : `${n} Leave(H)`;
const leaveKeyOf = (type) => typeKey(type) ?? extraTitle(type);
const leaveTitleOfKey = (k) => LEAVE_FIXED.find(l => l[1] === k)?.[0] ?? k;

// ---------- request parsing ----------
function range(q, maxDays = 400) {
  const to = DATE.test(q.end_date ?? '') ? q.end_date : dateStr(new Date());
  let from = DATE.test(q.start_date ?? '') ? q.start_date : to.slice(0, 8) + '01';
  if (from > to) from = to;
  if (from < addDays(to, -(maxDays - 1))) from = addDays(to, -(maxDays - 1));
  return [from, to];
}
const idList = (v) => { const a = String(v ?? '').split(',').map(Number).filter(n => Number.isFinite(n) && n > 0); return a.length ? a : null; };
// The employees a request is about: tree selection (departments / areas / groups) and the Employee picker, always inside the login's scope.
function pickEmps(q) {
  let sql = `SELECT e.id, e.code, e.name, e.last_name, e.gender, e.department_id, e.branch_id, e.group_id, e.leave_policy_id, e.join_date, e.designation_id, e.shift_id,
             d.name AS dept, d.code AS dept_code, g.name AS grp, ds.name AS pos, ds.code AS pos_code, lp.name AS lgroup
             FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN emp_groups g ON g.id=e.group_id LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN leave_policies lp ON lp.id=e.leave_policy_id WHERE 1=1`;
  const args = [];
  for (const [k, col] of [['departments', 'e.department_id'], ['areas', 'e.branch_id'], ['groups', 'e.group_id'], ['employees', 'e.id'], ['leave_groups', 'e.leave_policy_id']]) {
    const ids = idList(q[k]); if (ids) { sql += ` AND ${col} IN (${ids.map(() => '?')})`; args.push(...ids); }
  }
  const sc = scopeClause('e'); sql += sc.sql; args.push(...sc.args);
  return db.prepare(sql + ' ORDER BY e.code').all(...args);
}
const empBase = (e) => ({ 'Employee ID': e.code, 'First Name': e.name, 'Last Name': '', 'Nick Name': '', 'Gender': e.gender ? e.gender[0].toUpperCase() + e.gender.slice(1) : '',
  'Department Code': e.dept_code ?? '', 'Department': e.dept ?? '', 'Position Code': e.pos_code ?? '', 'Position': e.pos ?? '' });

// ---------- shared lookups for one request ----------
function context(q, from, to) {
  const emps = pickEmps(q), byCode = new Map(emps.map(e => [e.code, e])), filtered = !!(idList(q.departments) || idList(q.areas) || idList(q.groups) || idList(q.employees) || idList(q.leave_groups));
  const X = { from, to, emps, byCode, filtered };
  X.shifts = new Map(db.prepare('SELECT s.*, b.start AS b_start, b.end AS b_end FROM shifts s LEFT JOIN breaks b ON b.id=s.break_id').all().map(s => [s.name, s]));
  X.leaves = db.prepare("SELECT * FROM leaves WHERE status='approved' AND to_date>=? AND from_date<=?").all(from, to);
  X.devices = new Map(db.prepare('SELECT id, name, sn, location, dtype FROM devices').all().map(d => [d.id, d]));
  X._days = null; X._punch = null;
  X.days = () => (X._days ??= attendanceReport(from, to, X.filtered ? { employeeIds: emps.map(e => e.id) } : {}).filter(r => r.status && X.byCode.has(r.code)));
  X.dayMap = () => (X._dm ??= new Map(X.days().map(r => [r.code + '|' + r.date, r])));
  // punches by employee code, then by day
  X.punches = () => {
    if (X._punch) return X._punch;
    const m = new Map();
    for (const p of db.prepare('SELECT emp_code, ts, device_id, source FROM logs WHERE ts>=? AND ts<=? ORDER BY ts').all(from + ' 00:00:00', to + ' 23:59:59')) {
      if (!X.byCode.has(p.emp_code)) continue;
      const k = p.emp_code + '|' + p.ts.slice(0, 10); if (!m.has(k)) m.set(k, []); m.get(k).push(p);
    }
    return (X._punch = m);
  };
  return X;
}
const breakMin = (sh) => { if (!sh) return 0; const a = sh.break_start || sh.b_start, b = sh.break_end || sh.b_end; return a && b ? (tmin(b) - tmin(a) + 1440) % 1440 : 0; };
const dutyHours = (sh) => !sh ? 0 : sh.type === 'flexible' ? r2((sh.required_min || 480) / 60) : sh.type === 'split' && sh.seg2_end ? r2(shiftHours(sh.start, sh.seg2_end)) : r2(shiftHours(sh.start, sh.end));
const stripOver = (t) => (t ?? '').replace(' +1', '');
const devName = (X, id) => { const d = X.devices.get(id); return d ? (d.name || d.sn || '') : ''; };

// One attendance day -> every column title the day-based reports can show.
function dayObj(X, r) {
  const e = X.byCode.get(r.code), sh = X.shifts.get(r.shift), work = r.day_type === 'work', duty = dutyHours(sh), brk = breakMin(sh), worked = r.worked_min;
  const punches = X.punches().get(r.code + '|' + r.date) ?? [];
  const lv = X.leaves.find(l => l.employee_id === r.employee_id && l.from_date <= r.date && r.date <= l.to_date);
  const o = { ...empBase(e), 'Date': r.date, 'Weekday': dowName(r.date), 'Timetable': r.shift || '', 'Check In': work && sh ? sh.start : '', 'Check Out': work && sh ? sh.end : '',
    'Clock In': r.in ?? '', 'Clock Out': stripOver(r.out), 'Duty Duration': work ? duty : 0, 'Break Duration': work ? h2(brk) : 0, 'Work Day': work ? 1 : 0, 'Worked Hrs': h2(worked),
    'Total Hrs': h2(worked + (r.out && worked && work ? brk : 0)), 'Break Out': work && sh ? (sh.break_start || sh.b_start || '') : '', 'Break In': work && sh ? (sh.break_end || sh.b_end || '') : '',
    'Break Hrs': work && r.out ? h2(brk) : 0, 'Total Hrs of Break': work && r.out ? h2(brk) : 0, 'Total OT': h2(r.overtime_min), 'Rule Total OT': h2(r.ot_calc_min), 'Unscheduled': !work ? h2(worked) : 0,
    'Remaining': work ? Math.max(0, r2(duty - h2(worked))) : 0, 'Attendance': r.status === 'Present' ? 'Yes' : '', 'Device[In]': punches.length ? devName(X, punches[0].device_id) : '', 'Device[Out]': punches.length > 1 ? devName(X, punches.at(-1).device_id) : '',
    'Work Code[In]': '', 'Work Code[Out]': '', 'Location[In]': '', 'Location[Out]': '' };
  const ex = [];
  if (r.status === 'Absent') ex.push('Absence'); else if (r.status === 'Missing Out') ex.push('Missing Check Out'); else if (r.status === 'Half Day') ex.push('Half Day');
  if (r.late_min > 0) ex.push(`Late In ${r.late_min}M`); if (r.early_min > 0) ex.push(`Early Out ${r.early_min}M`);
  o.Exception = ex.join(', '); o.Description = o.Exception; o._ex = ex.length > 0;
  const ot = r.overtime_min, lvH = (lv ? (lv.half && lv.from_date === lv.to_date ? 0.5 : 1) : 1) * duty;
  const absence = r.status === 'Absent' ? (duty || 8) : r.status === 'Half Day' ? Math.max(0, r2(duty - h2(worked))) : 0;
  Object.assign(o, { 'Regular(H)': h2(Math.max(0, worked - ot)), 'Late In(M)': r.late_min, 'Early Out(M)': r.early_min, 'Absence(H)': absence,
    'Normal OT(H)': r.day_type === 'work' ? h2(ot) : 0, 'Weekend OT(H)': r.day_type === 'weekend' ? h2(ot) : 0, 'Holiday OT(H)': r.day_type === 'holiday' ? h2(ot) : 0,
    'OT1(H)': h2(Math.min(ot, 120)), 'OT2(H)': h2(Math.min(Math.max(ot - 120, 0), 120)), 'OT3(H)': h2(Math.max(ot - 240, 0)), 'Compensatory(H)': 0 });
  for (const l of LEAVE_FIXED) o[l[0]] = 0;
  for (const t of extraLeaveTypes()) o[extraTitle(t)] = 0;
  if (['Leave', 'Unpaid Leave'].includes(r.status)) { const k = leaveKeyOf(r.note || lv?.type || ''); const t = k.startsWith('lv_') ? leaveTitleOfKey(k) : k; o[t] = r2(lvH); }
  if (r.status === 'On Duty') o['Business Trip(H)'] = r2(duty || 8);
  o['Total Leaves'] = r2(LEAVE_FIXED.reduce((s, l) => s + o[l[0]], 0) + extraLeaveTypes().reduce((s, t) => s + o[extraTitle(t)], 0));
  o._r = r;
  return o;
}
const numCols = () => [...PC_NUM, ...extraLeaveTypes().map(extraTitle)];
// sum the day objects into one row of totals
function sumDays(list) {
  const o = {}; for (const t of numCols()) o[t] = 0;
  let late = 0, early = 0, absent = 0;
  for (const d of list) { for (const t of numCols()) o[t] += d[t] ?? 0; if (d._r.late_min > 0) late++; if (d._r.early_min > 0) early++; if (d._r.status === 'Absent') absent++; }
  for (const t of numCols()) o[t] = r2(o[t]);
  return Object.assign(o, { 'Late(Times)': late, 'Early Leave(Times)': early, 'Absent(Times)': absent });
}

// ---------- row builders ----------
const times = (list) => list.map(p => p.ts.slice(11, 19));
const state = (i) => (i % 2 ? 'Check Out' : 'Check In');
const dataSrc = (s) => ({ device: 'Device', manual: 'Manual Import', mobile: 'Mobile', adms: 'Device' }[s] ?? (s || 'Device'));
const pairsOf = (list) => { const out = []; for (let i = 0; i < list.length; i += 2) out.push([list[i], list[i + 1] ?? null]); return out; };
const gap = (a, b) => Math.max(0, tmin(b.ts.slice(11, 16)) - tmin(a.ts.slice(11, 16)));
const punchDays = (X) => [...X.punches().entries()].map(([k, list]) => { const [code, date] = k.split('|'); return { code, date, list, e: X.byCode.get(code) }; })
  .sort((a, b) => a.e.code.localeCompare(b.e.code, undefined, { numeric: true }) || a.date.localeCompare(b.date));
const areaOf = (X, p) => { const d = X.devices.get(p?.device_id); return d ? (d.location || d.name || d.sn || '') : ''; };

const BUILD = {
  txn: (X) => punchDays(X).flatMap(({ date, list, e }) => list.map((p, i) => ({ ...empBase(e), 'Date': date, 'Time': p.ts.slice(11, 19), 'Punch State': state(i),
    'Verification Type': p.source === 'device' ? (X.devices.get(p.device_id)?.dtype ?? '') : dataSrc(p.source), 'Work Code': '', 'Data Sources': dataSrc(p.source), 'Device Name': devName(X, p.device_id) }))),
  timecard: (X) => punchDays(X).map(({ date, list, e }) => ({ ...empBase(e), 'Date': date, 'Times': list.length, 'Time': times(list).map(t => t.slice(0, 5)).join('  ') })),
  firstlast: (X) => punchDays(X).map(({ date, list, e }) => { const f = list[0].ts.slice(11, 16), l = list.length > 1 ? list.at(-1).ts.slice(11, 16) : '';
    return { ...empBase(e), 'Date': date, 'Weekday': dowName(date), 'First Punch': f, 'Last Punch': l, 'Check In': f, 'Check Out': l, 'Total Time': l ? hm(tmin(l) - tmin(f)) : '' }; }),
  sched: (X) => punchDays(X).flatMap(({ date, list, e }) => { const sh = X.shifts.get(X.dayMap().get(e.code + '|' + date)?.shift);
    const mid = sh ? (tmin(sh.start) + tmin(sh.end) + (tmin(sh.end) <= tmin(sh.start) ? 1440 : 0)) / 2 : 12 * 60;
    return list.map((p, i) => ({ ...empBase(e), 'Date': date, 'Weekday': dowName(date), 'Work Code': '', 'Time': p.ts.slice(11, 19), 'Punch State': state(i), 'Correct State': tmin(p.ts.slice(11, 16)) < mid ? 'Check In' : 'Check Out' })); }),
  pair: (X) => punchDays(X).flatMap(({ date, list, e }) => pairsOf(list).map(([a, b]) => ({ ...empBase(e), 'Type': 'Check In/Out', 'Date': date, 'Weekday': dowName(date), 'In': a.ts.slice(11, 16), 'Out': b ? b.ts.slice(11, 16) : '', 'Total Hrs': b ? h2(gap(a, b)) : 0 }))),
  multi: (X) => punchDays(X).flatMap(({ date, list, e }) => { const ps = pairsOf(list), total = ps.reduce((s, [a, b]) => s + (b ? gap(a, b) : 0), 0);
    return [{ ...empBase(e), 'Date': date, 'Weekday': dowName(date), 'Total Time': hm(total), _p: 1 },
      ...ps.map(([a, b]) => ({ ...empBase(e), 'Check In': a.ts.slice(11, 16), 'Check Out': b ? b.ts.slice(11, 16) : '', 'area': areaOf(X, a), 'Total Time#2': b ? hm(gap(a, b)) : '' }))]; }),
  break: (X) => punchDays(X).flatMap(({ date, list, e }) => { const ps = pairsOf(list); if (ps.length < 2) return [];
    const gaps = ps.slice(1).map((p, i) => ({ from: ps[i][1], to: p[0] })).filter(g => g.from);
    const total = gaps.reduce((s, g) => s + gap(g.from, g.to), 0);
    return [{ ...empBase(e), 'Summary Time': hm(total), 'Date': date, 'Weekday': dowName(date), _p: 1 },
      ...gaps.map(g => ({ ...empBase(e), 'Clock In': g.to.ts.slice(11, 16), 'Clock Out': g.from.ts.slice(11, 16), 'area': areaOf(X, g.to), 'Total Time': hm(gap(g.from, g.to)) }))]; }),
  emp: (X) => { const by = groupBy(X.days().map(r => dayObj(X, r)), d => d._r.code);
    return [...by.values()].map(l => ({ ...empBase(X.byCode.get(l[0]._r.code)), ...sumDays(l) })); },
  dept: (X) => { const by = groupBy(X.days().map(r => dayObj(X, r)), d => X.byCode.get(d._r.code).department_id ?? 0);
    return [...by.values()].map(l => { const e = X.byCode.get(l[0]._r.code); return { 'Department Code': e.dept_code ?? '', 'Department': e.dept ?? 'No department', 'Employee Qty.': new Set(l.map(d => d._r.code)).size, ...sumDays(l) }; }); },
  group: (X) => { const by = groupBy(X.days().map(r => dayObj(X, r)).filter(d => X.byCode.get(d._r.code).group_id), d => X.byCode.get(d._r.code).group_id);
    return [...by.values()].map(l => { const e = X.byCode.get(l[0]._r.code); return { 'Group Code': String(e.group_id), 'Group Name': e.grp, 'Employee Qty.': new Set(l.map(d => d._r.code)).size, ...sumDays(l) }; }); },
  week: (X) => { const wk = (d) => { const x = new Date(d + 'T00:00:00Z'); return addDays(d, -((x.getUTCDay() + 6) % 7)); };
    const by = groupBy(X.days().map(r => dayObj(X, r)), d => d._r.code + '|' + wk(d._r.date));
    return [...by.entries()].map(([k, l]) => { const ws = k.split('|')[1], e = X.byCode.get(l[0]._r.code), jan = new Date(Date.UTC(+ws.slice(0, 4), 0, 1));
      return { ...empBase(e), 'Week': Math.floor((new Date(ws + 'T00:00:00Z') - jan) / 604800000) + 1, 'Week Start Date': ws, 'Week End Date': addDays(ws, 6), ...sumDays(l) }; }); },
  monthabs: (X) => { const by = groupBy(X.days(), r => r.code);
    return [...by.values()].map(l => { const e = X.byCode.get(l[0].code), need = l.filter(r => !['Weekly Off', 'Holiday', 'Pending'].includes(r.status)).length, present = l.filter(r => PRESENT.includes(r.status)).length, abs = l.filter(r => r.status === 'Absent').length;
      return { ...empBase(e), 'Need Present Days': need, 'Present Days': present, 'Absence Days': abs, 'Holiday Days': l.filter(r => r.status === 'Holiday').length,
        'Present Percentage': need ? r2(present / need * 100) + '%' : '0%', 'Absence Percentage': need ? r2(abs / need * 100) + '%' : '0%' }; }); },
};
function groupBy(list, f) { const m = new Map(); for (const x of list) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

// which day rows each daily report keeps
const DAY_FILTER = {
  dailyAbsentReport: d => d._r.status === 'Absent', dailyLateInReport: d => d._r.late_min > 0, dailyEarlyOutReport: d => d._r.early_min > 0, dailyOvertimeReport: d => d._r.overtime_min > 0,
  dailyLeaveReport: d => ['Leave', 'Unpaid Leave', 'On Duty'].includes(d._r.status), dailyExceptionReport: d => d._ex,
  dailyActivityReport: d => !['Pending'].includes(d._r.status) };

// Monthly grids: one row per employee, one column per day of the range.
const symbol = (r) => !r.status ? '' : r.status === 'Absent' ? 'A' : PRESENT.includes(r.status) ? (r.late_min > 0 && r.early_min > 0 ? 'LE' : r.late_min > 0 ? 'L' : r.early_min > 0 ? 'E' : 'P') : '';
const CELL = { status: (r) => symbol(r), punch: (r) => (r.in ? `${r.in}${r.out ? '-' + stripOver(r.out) : ''}` : ''), hours: (r) => (r.worked_min ? h2(r.worked_min) : ''), ot: (r) => (r.overtime_min ? h2(r.overtime_min) : '') };
function monthRows(X, mode) {
  const by = groupBy(X.days(), r => r.code), cell = CELL[mode];
  return [...by.values()].map(l => { const o = empBase(X.byCode.get(l[0].code)); for (const r of l) o['d' + r.date.slice(5).replace('-', '')] = cell(r); return o; });
}

// Leave balance: Total / Used / Remaining / Advance for each leave type, for one year.
const LB_GROUPS = [['Annual Leave(Days)', 'annual', 4], ['Sick Leave(Days)', 'sick', 4], ['Casual Leave(Days)', 'casual', 4], ['Maternity Leave(Days)', 'matern', 4], ['Compassionate Leave(Days)', 'compass', 4], ['Business Trip(Days)', 'trip', 4], ['Compensatory Leave(Hour(s))', 'compensat', 3]];
function leaveBalSpec() {
  const groups = [...LB_GROUPS.map(g => ({ label: g[0], match: g[1], n: g[2] })), ...extraLeaveTypes().map(n => ({ label: `${n} Leave(Days)`, name: n, n: 4 }))];
  const cols = [...SPEC_BASE.map(([t, h]) => ({ key: t, label: t, hide: h, rowspan: 2 })), { key: 'Leave Group', label: 'Leave Group', hide: 0, rowspan: 2 }];
  groups.forEach((g, gi) => ['Total', 'Used', 'Remaining', 'Advance'].slice(0, g.n).forEach(s => cols.push({ key: `g${gi}_${s}`, label: s, group: g.label, hide: 0, num: 1 })));
  return { cols, groups };
}
function leaveBalRows(X, q, groups) {
  const year = +(String(q.year || q.start_date || '').slice(0, 4)) || new Date().getFullYear();
  return X.emps.filter(e => db.prepare('SELECT 1 FROM employees WHERE id=? AND active=1').get(e.id)).map(e => {
    const bal = balancesOf(e, year), o = { ...empBase(e), 'Leave Group': e.lgroup ?? '' };
    groups.forEach((g, gi) => { const b = bal.find(x => g.name ? x.type === g.name : (x.type.toLowerCase().includes(g.match) || (g.match === 'trip' && x.type.toLowerCase().includes('business'))));
      const total = b ? r2(b.accrued + b.carry_forward) : 0, used = b?.used ?? 0, rem = b ? Math.max(0, b.available) : 0, adv = b && b.tracked ? Math.max(0, -b.available) : 0;
      Object.assign(o, { [`g${gi}_Total`]: b?.tracked ? total : 0, [`g${gi}_Used`]: used, [`g${gi}_Remaining`]: rem, [`g${gi}_Advance`]: adv }); });
    return o; });
}
const SPEC_BASE = SPEC.transactionReport.slice(0, 9);

// ---------- run a report: { columns, rows, legend } ----------
const specCols = (name) => {
  const out = []; for (const [t, h] of SPEC[name]) {
    out.push({ key: t, label: t.replace(/#\d+$/, ''), hide: h, num: /\((H|M)\)$|Qty|Times|Days$|Hrs$|Duration$/.test(t) ? 1 : 0 });
    if (t === 'Compensatory Leave(H)') for (const x of extraLeaveTypes()) out.push({ key: extraTitle(x), label: extraTitle(x), hide: 0, num: 1 });
  } return out; };
export function runReport(name, q) {
  if (!KIND[name]) throw Object.assign(new Error('Unknown report'), { status: 404 });
  const kind = KIND[name], leaveBal = kind === 'leavebal';
  const [from, to] = leaveBal ? range({ start_date: q.start_date, end_date: q.end_date }) : kind === 'month' ? range(q, 62) : range(q);
  const X = context(q, from, to);
  let columns, rows, legend = '';
  if (leaveBal) { const s = leaveBalSpec(); columns = s.cols; rows = leaveBalRows(X, q, s.groups); }
  else if (kind === 'month') {
    columns = [...specCols(name).slice(0, 9), ...dayList(from, to).map(d => ({ key: 'd' + d.slice(5).replace('-', ''), label: String(+d.slice(8)), hide: 0, day: 1 }))];
    rows = monthRows(X, MONTH_REPORTS[name]); if (name === 'monthlyStatusReport') legend = LEGEND;
  } else {
    columns = specCols(name);
    if (kind === 'day') rows = X.days().map(r => dayObj(X, r)).filter(DAY_FILTER[name] ?? (() => true));
    else rows = BUILD[kind](X);
  }
  return { name, label: LABEL[name], columns, rows, legend, from, to, year: leaveBal ? q.year || from.slice(0, 4) : undefined };
}

// ---------- export ----------
const clean = (rows) => rows.map(r => { const o = {}; for (const k in r) if (k[0] !== '_' || k === '_p') o[k] = r[k]; return o; });
function exportFile(res, rep, fmt, colIdx, options = {}) {
  let cols = rep.columns; if (colIdx) cols = colIdx.map(i => cols[i]).filter(Boolean); else cols = cols.filter(c => !c.hide);
  cols = cols.map(c => ({ key: c.key, label: c.group ? `${c.group} ${c.label}` : c.label }));
  const base = rep.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), rows = clean(rep.rows), sub = `${rep.from} to ${rep.to}`;
  const data = { title: rep.label, subtitle: sub, columns: cols, rows, pageSize: options.pageSize, orientation: options.orientation };
  if (fmt === 'csv') return res.type('text/csv').attachment(`${base}.csv`).send(toCsvCols(cols, rows));
  if (fmt === 'txt') return res.type('text/plain').attachment(`${base}.txt`).send([cols.map(c => c.label).join('\t'), ...rows.map(r => cols.map(c => String(r[c.key] ?? '')).join('\t'))].join('\n'));
  if (fmt === 'xlsx' || fmt === 'xls') return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${base}.xlsx`).send(makeXlsx(data));
  if (fmt === 'pdf') return res.type('application/pdf').attachment(`${base}.pdf`).send(makePdf(data));
  return fail(res, 'format must be csv, xlsx, pdf or txt');
}

const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Report failed: ' + e.message }); } };

// ---------- trees and the employee picker (scoped like every other report) ----------
zkReportsRouter.get('/zkrep/meta', (_q, res) => res.json({ reports: REPORTS.map(n => ({ name: n, label: LABEL[n], kind: KIND[n] })) }));
zkReportsRouter.get('/zkrep/tree/:kind', (req, res) => {
  const sc = scopeClause('e');
  const used = (col) => sc.sql ? new Set(db.prepare(`SELECT DISTINCT e.${col} AS v FROM employees e WHERE 1=1${sc.sql}`).all(...sc.args).map(r => r.v)) : null;
  if (req.params.kind === 'dept') { const ok = used('department_id'); return res.json(db.prepare('SELECT id, name, parent_id AS pid, code FROM departments ORDER BY name').all().filter(d => !ok || ok.has(d.id))); }
  // Keep every configured Area visible, even when it currently has no staff.
  // This lets an administrator select an empty area and then assign employees
  // to it instead of the picker appearing blank.
  if (req.params.kind === 'area') return res.json(db.prepare('SELECT id, name, NULL AS pid, code FROM branches ORDER BY name').all());
  if (req.params.kind === 'group') { const ok = used('group_id'); return res.json(db.prepare('SELECT id, name, NULL AS pid, id AS code FROM emp_groups ORDER BY name').all().filter(d => !ok || ok.has(d.id))); }
  if (req.params.kind === 'leavegroup') return res.json(db.prepare('SELECT id, name FROM leave_policies ORDER BY name').all());
  fail(res, 'Unknown tree');
});
zkReportsRouter.get('/zkrep/employees', (req, res) => {
  const s = String(req.query.search ?? '').trim().toLowerCase(), q = pickEmps({ departments: req.query.departments, areas: req.query.areas, groups: req.query.groups });
  res.json(q.filter(e => !s || e.code.toLowerCase().includes(s) || e.name.toLowerCase().includes(s)).slice(0, 2000).map(e => ({ id: e.id, code: e.code, name: e.name, last_name: e.last_name ?? '', dept: e.dept ?? '' })));
});

// ---------- Custom Report: saved column sets over the Total Time Card data ----------
db.exec(`CREATE TABLE IF NOT EXISTS zk_custom_reports (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, date_range TEXT NOT NULL, description TEXT, fields TEXT NOT NULL, created_by TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP)`);
const EMPF = [['emp_code', 'Employee ID', 'Employee ID'], ['first_name', 'First Name', 'First Name'], ['last_name', 'Last Name', 'Last Name'], ['nick_name', 'Nick Name', 'Nick Name'], ['gender', 'Gender', 'Gender'],
  ['dept_code', 'Department Code', 'Department Code'], ['dept_name', 'Department Name', 'Department'], ['position_code', 'Position Code', 'Position Code'], ['position_name', 'Position Name', 'Position']];
const DAYF = [['att_date', 'Date', 'Date'], ['weekday', 'Week Day', 'Weekday'], ['time_table_alias', 'Timetable', 'Timetable'], ['check_in', 'Check In', 'Check In'], ['check_out', 'Check Out', 'Check Out'], ['duty_duration', 'Duty Duration', 'Duty Duration'],
  ['break_duration', 'Break Duration', 'Break Duration'], ['work_day', 'Work Day', 'Work Day'], ['clock_in', 'Clock In', 'Clock In'], ['clock_out', 'Clock Out', 'Clock Out'], ['total_hrs', 'Total Hours', 'Total Hrs'], ['worked_hrs', 'Worked Hours', 'Worked Hrs'],
  ['break_out', 'Break Out', 'Break Out'], ['break_in', 'Break In', 'Break In'], ['break_hrs', 'Break Hours', 'Break Hrs'], ['break_total_hrs', 'Total Break Hours', 'Total Hrs of Break'], ['total_ot', 'Total OT', 'Total OT'], ['rule_total_ot', 'Rule Total OT', 'Rule Total OT'],
  ['total_leave', 'Total Leave', 'Total Leaves'], ['unschedule', 'Unschedule', 'Unscheduled'], ['remaining', 'Remaining', 'Remaining'], ['full_attendance', 'Full Attendance', 'Attendance'], ['device_in', 'Device In', 'Device[In]'], ['device_out', 'Device Out', 'Device[Out]'],
  ['work_code_in', 'Work Code In', 'Work Code[In]'], ['work_code_out', 'Work Code Out', 'Work Code[Out]'], ['gps_in', 'GPS In', 'Location[In]'], ['gps_out', 'GPS Out', 'Location[Out]'], ['att_exception', 'Attendance Exception', 'Exception']];
const customFields = () => [...EMPF, ...DAYF, ...PC_NUM.concat(extraLeaveTypes().map(extraTitle)).map((t, i) => [`paycode_${i + 1}`, t, t])];
export function periodOf(key, now = new Date()) {
  const d = (n) => dateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)), t = dateStr(now), dow = (now.getDay() + 6) % 7;
  const mon = (y, m) => dateStr(new Date(y, m, 1)), eom = (y, m) => dateStr(new Date(y, m + 1, 0));
  switch (key) {
    case 'today': return [t, t]; case 'yesterday': return [d(-1), d(-1)];
    case 'this_week': return [d(-dow), t]; case 'last_week': return [d(-dow - 7), d(-dow - 1)];
    case 'this_month': return [mon(now.getFullYear(), now.getMonth()), t]; case 'last_month': return [mon(now.getFullYear(), now.getMonth() - 1), eom(now.getFullYear(), now.getMonth() - 1)];
    case 'last_three_months': return [mon(now.getFullYear(), now.getMonth() - 3), eom(now.getFullYear(), now.getMonth() - 1)];
    case 'last_six_months': return [mon(now.getFullYear(), now.getMonth() - 6), eom(now.getFullYear(), now.getMonth() - 1)];
    case 'this_year': return [`${now.getFullYear()}-01-01`, t]; case 'last_year': return [`${now.getFullYear() - 1}-01-01`, `${now.getFullYear() - 1}-12-31`];
    default: return null;
  }
}
const customRow = (r) => ({ ...r, fields: JSON.parse(r.fields) });
function customRun(def, q) {
  const [from, to] = periodOf(def.date_range) ?? range({}), fields = def.fields, all = customFields();
  const cols = fields.map(id => all.find(f => f[0] === id)).filter(Boolean);
  const rep = runReport('totalTimeCardReportV2', { ...q, start_date: q.start_date || from, end_date: q.end_date || to });
  return { name: 'custom', label: def.name, from: q.start_date || from, to: q.end_date || to, legend: '', columns: cols.map(c => ({ key: c[2], label: c[1], hide: 0, num: /\(|Hrs|Duration|OT|Remaining|Leaves|Unscheduled|Work Day/.test(c[2]) ? 1 : 0 })), rows: rep.rows };
}
zkReportsRouter.get('/zkrep/custom', (_q, res) => res.json({ reports: db.prepare('SELECT * FROM zk_custom_reports ORDER BY name').all().map(customRow), fields: customFields().map(f => ({ id: f[0], label: f[1] })) }));
const readCustom = (b) => {
  const name = String(b?.name ?? '').trim().slice(0, 80), fields = Array.isArray(b?.fields) ? b.fields.map(String) : [], ok = new Set(customFields().map(f => f[0]));
  if (!name) return { error: 'Report Name is required' };
  if (!periodOf(b?.date_range)) return { error: 'Choose a Time Period' };
  if (!fields.length || fields.some(f => !ok.has(f))) return { error: 'Select at least one valid field' };
  return { name, date_range: b.date_range, description: String(b.description ?? '').slice(0, 300), fields: JSON.stringify([...new Set(fields)]) };
};
zkReportsRouter.post('/zkrep/custom', (req, res) => {
  const v = readCustom(req.body); if (v.error) return fail(res, v.error);
  if (db.prepare('SELECT 1 FROM zk_custom_reports WHERE name=?').get(v.name)) return fail(res, 'A report with this name already exists');
  const r = db.prepare('INSERT INTO zk_custom_reports(name, date_range, description, fields, created_by) VALUES(?,?,?,?,?)').run(v.name, v.date_range, v.description, v.fields, req.user ?? '');
  res.json({ id: Number(r.lastInsertRowid) });
});
zkReportsRouter.put('/zkrep/custom/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM zk_custom_reports WHERE id=?').get(req.params.id); if (!cur) return fail(res, 'Report not found', 404);
  const v = readCustom(req.body); if (v.error) return fail(res, v.error);
  if (db.prepare('SELECT 1 FROM zk_custom_reports WHERE name=? AND id!=?').get(v.name, cur.id)) return fail(res, 'A report with this name already exists');
  db.prepare('UPDATE zk_custom_reports SET name=?, date_range=?, description=?, fields=? WHERE id=?').run(v.name, v.date_range, v.description, v.fields, cur.id); res.json({ ok: true });
});
zkReportsRouter.delete('/zkrep/custom/:id', (req, res) => { const r = db.prepare('DELETE FROM zk_custom_reports WHERE id=?').run(req.params.id); if (!r.changes) return fail(res, 'Report not found', 404); res.json({ ok: true }); });
const customDef = (req) => { const d = db.prepare('SELECT * FROM zk_custom_reports WHERE id=?').get(req.params.id); return d ? customRow(d) : null; };
zkReportsRouter.get('/zkrep/custom/:id/data', wrap((req, res) => {
  const d = customDef(req); if (!d) return fail(res, 'Report not found', 404);
  const rep = customRun(d, req.query), page = Math.max(1, +req.query.page || 1), size = Math.min(20000, Math.max(1, +req.query.page_size || 20));
  res.json({ columns: rep.columns, count: rep.rows.length, rows: clean(rep.rows).slice((page - 1) * size, page * size), from: rep.from, to: rep.to, label: rep.label });
}));
zkReportsRouter.get('/zkrep/custom/:id/export', wrap((req, res) => {
  const d = customDef(req); if (!d) return fail(res, 'Report not found', 404);
  const q = { ...req.query }; if (q.dateRange && q.dateRange !== 'custom') { const p = periodOf(q.dateRange); if (p) [q.start_date, q.end_date] = p; } else { q.start_date = q.startDate; q.end_date = q.endDate; }
  const m = req.query.selectionMethod; if (req.query.ids) q[m === 'attGroup' ? 'groups' : m === 'area' ? 'areas' : 'departments'] = req.query.ids;
  exportFile(res, customRun(d, q), String(req.query.format ?? 'xls'));
}));

// ---------- the report endpoints ----------
zkReportsRouter.get('/zkrep/:name', wrap((req, res) => {
  const rep = runReport(req.params.name, req.query), page = Math.max(1, +req.query.page || 1), size = Math.min(20000, Math.max(1, +req.query.page_size || 20));
  res.json({ name: rep.name, label: rep.label, from: rep.from, to: rep.to, legend: rep.legend, columns: rep.columns, count: rep.rows.length, rows: clean(rep.rows).slice((page - 1) * size, page * size) });
}));
zkReportsRouter.get('/zkrep/:name/export', wrap((req, res) => {
  const rep = runReport(req.params.name, req.query);
  if (req.query.export_range === 'page') { const page = Math.max(1, +req.query.page || 1), size = Math.min(20000, Math.max(1, +req.query.page_size || 20)); rep.rows = rep.rows.slice((page - 1) * size, page * size); }
  const idx = req.query.cols ? String(req.query.cols).split(',').map(Number).filter(Number.isInteger) : null;
  exportFile(res, rep, String(req.query.format ?? 'csv'), idx, { pageSize: String(req.query.pdf_page_size || 'A4'), orientation: String(req.query.pdf_orientation || 'default') });
}));
