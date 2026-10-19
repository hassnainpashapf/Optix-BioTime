import express from 'express';
import { db } from './db.js';
import { attendanceReport, summarize, PRESENT, dayList } from './report.js';
import { dateStr, addDays } from './dates.js';
import { payroll } from './payroll.js';
import { leaveReport, balancesOf } from './leave.js';
import { overtimeReport } from './overtime.js';
import { allowedCodes, scopeClause } from './rbac.js';
import { toCsvCols } from './csv.js';
import { shiftCalendar } from './shifts.js';
import { makeXlsx } from './xlsx.js';
import { makePdf } from './pdf.js';
import { codeMap } from './paycodes.js';

export const reportsRouter = express.Router();
const DATE = /^\d{4}-\d\d-\d\d$/;
const C = (key, label, type = 'text') => ({ key, label, type });
const round1 = (n) => Math.round(n * 10) / 10;
const hrs = (m) => Math.round((m / 60) * 100) / 100;

const DAILY = [C('date', 'Date'), C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('shift', 'Shift'), C('in', 'In'), C('out', 'Out'),
  C('worked_min', 'Worked (min)', 'number'), C('late_min', 'Late (min)', 'number'), C('early_min', 'Early out (min)', 'number'), C('overtime_min', 'Overtime (min)', 'number'),
  C('ot_approved_min', 'Payable OT (min)', 'number'), C('status', 'Status'), C('note', 'Note')];
const pick = (keys) => keys.map(k => DAILY.find(c => c.key === k));

function filters(q) {
  return { departmentId: q.department_id || null, branchId: q.branch_id || null, designationId: q.designation_id || null, groupId: q.group_id || null, employeeId: q.employee_id || null };
}
function range(q) {
  const to = DATE.test(q.to ?? '') ? q.to : dateStr(new Date());
  let from = DATE.test(q.from ?? '') ? q.from : to.slice(0, 8) + '01';
  if (from > to) from = to;
  if (from < addDays(to, -400)) from = addDays(to, -400); // keeps one request bounded
  return [from, to];
}
const daily = (q) => attendanceReport(...range(q), filters(q)).filter(r => r.status);


// ---------- BioTime-style daily / weekly / monthly / summary extras ----------
let CODEC = null, CODEAT = 0; // short codes: editable on the Pay codes page, re-read every few seconds
const CODE = new Proxy({}, { get: (_t, k) => { if (!CODEC || Date.now() - CODEAT > 3000) { CODEC = codeMap(); CODEAT = Date.now(); } return CODEC[k]; } });
const monthOf = (q) => /^\d{4}-\d\d$/.test(q.month ?? '') ? q.month : (/^\d{4}-\d\d/.test(q.from ?? '') ? q.from.slice(0, 7) : dateStr(new Date()).slice(0, 7));
const empMeta = () => new Map(db.prepare('SELECT e.code, g.name AS grp FROM employees e LEFT JOIN emp_groups g ON g.id=e.group_id').all().map(r => [r.code, r.grp || 'No group']));
// Employee x day grid for one month; `cell` makes the text of one cell and `total` (optional) adds a last column.
function monthGrid(q, cell, total) {
  const month = monthOf(q), from = month + '-01', to = month + '-' + String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0');
  const by = new Map(), days = dayList(from, to).map(d => d.slice(8));
  for (const r of attendanceReport(from, to, filters(q)).filter(r => r.status)) { const e = by.get(r.code) ?? { code: r.code, name: r.name, dept: r.dept, cells: {} }; e.cells[r.date.slice(8)] = r; by.set(r.code, e); }
  return { subtitle: month, columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), ...days.map(d => C('d' + d, d)), ...(total ? [C('total', total.label, 'number')] : [])],
    rows: [...by.values()].map(e => { const o = { code: e.code, name: e.name, dept: e.dept }; let t = 0; for (const d of days) { const r = e.cells[d]; o['d' + d] = r ? cell(r) : ''; if (total && r) t += total.fn(r); } if (total) o.total = round1(t); return o; }) };
}
// Employee x week grid over a date range (weeks start on Monday).
function weekGrid(q, fn, label) {
  const [from, to] = range(q), wk = (d) => { const x = new Date(d + 'T00:00:00Z'); return addDays(d, -((x.getUTCDay() + 6) % 7)); };
  const weeks = [...new Set(dayList(from, to).map(wk))], by = new Map();
  for (const r of attendanceReport(from, to, filters(q)).filter(r => r.status)) { const e = by.get(r.code) ?? { code: r.code, name: r.name, dept: r.dept, w: {} }; const k = wk(r.date); e.w[k] = (e.w[k] ?? 0) + fn(r); by.set(r.code, e); }
  return { subtitle: `${from} to ${to} - ${label}`, columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), ...weeks.map(w => C('w' + w, 'Week of ' + w.slice(5), 'number')), C('total', 'Total', 'number')],
    rows: [...by.values()].map(e => ({ code: e.code, name: e.name, dept: e.dept, ...Object.fromEntries(weeks.map(w => ['w' + w, round1(e.w[w] ?? 0)])), total: round1(Object.values(e.w).reduce((a, b) => a + b, 0)) })) };
}
function punchDays(q) {
  const [from, to] = range(q), sc = scopeClause('e'), f = filters(q), w = [], a = [from + ' 00:00:00', to + ' 23:59:59'];
  for (const [v, col] of [[f.departmentId, 'e.department_id'], [f.branchId, 'e.branch_id'], [f.designationId, 'e.designation_id'], [f.groupId, 'e.group_id'], [f.employeeId, 'e.id']]) if (v) { w.push(`AND ${col}=?`); a.push(v); }
  const rows = db.prepare(`SELECT substr(l.ts,1,10) AS date, l.emp_code AS code, e.name, d.name AS dept, l.ts FROM logs l JOIN employees e ON e.code=l.emp_code LEFT JOIN departments d ON d.id=e.department_id
                           WHERE l.ts BETWEEN ? AND ? ${w.join(' ')}${sc.sql} ORDER BY l.emp_code, l.ts LIMIT 50000`).all(...a, ...sc.args), by = new Map();
  for (const r of rows) { const k = r.code + '|' + r.date, x = by.get(k) ?? { date: r.date, code: r.code, name: r.name, dept: r.dept, times: [] }; x.times.push(r.ts.slice(11, 16)); by.set(k, x); }
  return [...by.values()].sort((x, y) => x.date.localeCompare(y.date) || x.code.localeCompare(y.code));
}
function groupRollup(q, keyOf, withOt) {
  const g = empMeta(), m = new Map();
  for (const r of attendanceReport(...range(q), filters(q)).filter(r => r.status)) {
    const k = keyOf(r, g), d = m.get(k) ?? { name: k, emps: new Set(), present: 0, late: 0, absent: 0, leave: 0, ot: 0, worked: 0 };
    d.emps.add(r.code); if (PRESENT.includes(r.status)) d.present++; if (r.status === 'Late') d.late++; if (r.status === 'Absent') d.absent++; if (['Leave', 'Unpaid Leave'].includes(r.status)) d.leave++; d.ot += r.overtime_min; d.worked += r.worked_min; m.set(k, d);
  }
  const rows = [...m.values()].map(d => ({ name: d.name, employees: d.emps.size, present: d.present, late: d.late, absent: d.absent, leave: d.leave, worked: hrs(d.worked), ot: hrs(d.ot) }));
  return withOt ? { columns: [C('name', 'Name'), C('employees', 'Employees', 'number'), C('ot', 'Overtime (h)', 'number')], rows } : { columns: [C('name', 'Name'), C('employees', 'Employees', 'number'), C('present', 'Present days', 'number'), C('late', 'Late days', 'number'), C('absent', 'Absent days', 'number'), C('leave', 'Leave days', 'number'), C('worked', 'Worked (h)', 'number'), C('ot', 'Overtime (h)', 'number')], rows };
}
const EXTRA = {
  time_card: { group: 'Daily', title: 'Time card', desc: 'Every punch of each employee, day by day', run: (q) => {
    const sh = new Map(daily(q).map(r => [r.code + '|' + r.date, r]));
    return { columns: [C('date', 'Date'), C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('shift', 'Shift'), C('punches', 'Punches'), C('count', 'Count', 'number'), C('worked', 'Worked (min)', 'number'), C('status', 'Status')],
      rows: punchDays(q).map(x => { const r = sh.get(x.code + '|' + x.date); return { date: x.date, code: x.code, name: x.name, dept: x.dept, shift: r?.shift ?? '', punches: x.times.join('  '), count: x.times.length, worked: r?.worked_min ?? 0, status: r?.status ?? '' }; }) };
  } },
  first_last: { group: 'Daily', title: 'First and last punch', desc: 'Earliest and latest punch of every day', run: (q) => ({ columns: [C('date', 'Date'), C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('first', 'First punch'), C('last', 'Last punch'), C('count', 'Punches', 'number')],
    rows: punchDays(q).map(x => ({ date: x.date, code: x.code, name: x.name, dept: x.dept, first: x.times[0], last: x.times.at(-1), count: x.times.length })) }) },
  paired: { group: 'Daily', title: 'Paired punches', desc: 'Punches paired as in/out, with the time between each pair', run: (q) => {
    const pairs = (t) => t.reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []);
    const mins = (a, b) => (+b.slice(0, 2) * 60 + +b.slice(3)) - (+a.slice(0, 2) * 60 + +a.slice(3));
    return { columns: [C('date', 'Date'), C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('pairs', 'In - Out pairs'), C('total', 'Time between pairs (min)', 'number')],
      rows: punchDays(q).map(x => { const p = pairs(x.times); return { date: x.date, code: x.code, name: x.name, dept: x.dept, pairs: p.map(([a, b]) => b ? `${a}-${b}` : `${a}-?`).join('  '), total: p.reduce((s, [a, b]) => s + (b ? mins(a, b) : 0), 0) }; }) };
  } },
  daily_overtime: { group: 'Daily', title: 'Daily overtime', desc: 'Days with overtime', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'shift', 'in', 'out', 'overtime_min', 'ot_approved_min']), rows: daily(q).filter(r => r.overtime_min > 0) }) },
  daily_leave: { group: 'Daily', title: 'Daily leave', desc: 'Employees on leave, per day', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'status', 'note']), rows: daily(q).filter(r => ['Leave', 'Unpaid Leave'].includes(r.status)) }) },
  weekly_hours: { group: 'Weekly', title: 'Weekly worked hours', desc: 'Hours worked per employee per week', run: (q) => weekGrid(q, r => r.worked_min / 60, 'hours') },
  weekly_overtime: { group: 'Weekly', title: 'Weekly overtime', desc: 'Overtime hours per employee per week', run: (q) => weekGrid(q, r => r.overtime_min / 60, 'overtime hours') },
  monthly_status: { group: 'Monthly', title: 'Monthly status', desc: 'One cell per day: P present, LT late, A absent, LV leave, W weekly off, H holiday', needs: ['month'], run: (q) => monthGrid(q, r => CODE[r.status] ?? r.status) },
  monthly_punch: { group: 'Monthly', title: 'Monthly punch', desc: 'First in - last out for each day', needs: ['month'], run: (q) => monthGrid(q, r => r.in ? `${r.in}-${r.out ?? ''}` : '') },
  monthly_hours: { group: 'Monthly', title: 'Monthly worked hours', desc: 'Hours worked each day, with the month total', needs: ['month'], run: (q) => monthGrid(q, r => r.worked_min ? round1(r.worked_min / 60) : '', { label: 'Total (h)', fn: r => r.worked_min / 60 }) },
  monthly_overtime: { group: 'Monthly', title: 'Monthly overtime', desc: 'Overtime hours each day, with the month total', needs: ['month'], run: (q) => monthGrid(q, r => r.overtime_min ? round1(r.overtime_min / 60) : '', { label: 'Total (h)', fn: r => r.overtime_min / 60 }) },
  monthly_absence: { group: 'Monthly', title: 'Monthly absence', desc: 'Absent days, with the month count', needs: ['month'], run: (q) => monthGrid(q, r => r.status === 'Absent' ? 'A' : '', { label: 'Absent days', fn: r => r.status === 'Absent' ? 1 : 0 }) },
  group_summary: { group: 'Summary', title: 'Group summary', desc: 'Attendance totals per employee group', run: (q) => groupRollup(q, (r, g) => g.get(r.code) ?? 'No group') },
  department_overtime: { group: 'Summary', title: 'Department overtime', desc: 'Overtime hours per department', run: (q) => groupRollup(q, (r) => r.dept || 'No department', true) },
  group_overtime: { group: 'Summary', title: 'Group overtime', desc: 'Overtime hours per employee group', run: (q) => groupRollup(q, (r, g) => g.get(r.code) ?? 'No group', true) },
  leave_balance: { group: 'Summary', title: 'Leave balance', desc: 'Entitlement, used and remaining days for each leave type', run: (q) => {
    const year = +(String(q.to ?? '').slice(0, 4) || new Date().getFullYear()), types = db.prepare('SELECT name FROM leave_types ORDER BY id').all().map(t => t.name), sc = scopeClause('e'), f = filters(q);
    const emps = attendanceReport(dateStr(new Date()), dateStr(new Date()), f).map(r => r.code), seen = new Set(), rows = [];
    for (const e of db.prepare(`SELECT e.* , d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql} ORDER BY e.code`).all(...sc.args)) {
      if (!emps.includes(e.code) || seen.has(e.code)) continue; seen.add(e.code);
      const b = balancesOf(e, year), o = { code: e.code, name: e.name, dept: e.dept };
      for (const x of b) { o['u_' + x.type] = x.used ?? 0; o['r_' + x.type] = x.tracked ? x.available : ''; } rows.push(o);
    }
    return { subtitle: String(year), columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), ...types.flatMap(t => [C('u_' + t, t + ' used', 'number'), C('r_' + t, t + ' left', 'number')])], rows };
  } },
};
// ---------- the catalog: every report is {title, columns, rows}; the same data feeds screen, CSV, Excel and PDF ----------
export const CATALOG = {
  daily: { title: 'Daily attendance', desc: 'One row per employee per day', run: (q) => ({ columns: DAILY, rows: daily(q) }) },
  summary: { title: 'Attendance summary', desc: 'Totals per employee for the period', run: (q) => ({
    columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('present', 'Present', 'number'), C('late', 'Late', 'number'), C('half_day', 'Half day', 'number'), C('absent', 'Absent', 'number'),
      C('leave', 'Leave', 'number'), C('unpaid_leave', 'Unpaid leave', 'number'), C('late_min', 'Late (min)', 'number'), C('overtime_min', 'Overtime (min)', 'number'), C('worked_min', 'Worked (min)', 'number')],
    rows: summarize(attendanceReport(...range(q), filters(q))) }) },
  late: { title: 'Late arrivals', desc: 'Days an employee arrived after the grace time', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'shift', 'in', 'late_min', 'status']), rows: daily(q).filter(r => r.late_min > 0) }) },
  early: { title: 'Early departures', desc: 'Days an employee left before shift end', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'shift', 'out', 'early_min']), rows: daily(q).filter(r => r.early_min > 0) }) },
  absent: { title: 'Absentees', desc: 'Days with no punch and no approved leave, holiday or duty', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'shift', 'note']), rows: daily(q).filter(r => r.status === 'Absent') }) },
  missing: { title: 'Missing punches', desc: 'Days with a punch-in but no punch-out', run: (q) => ({ columns: pick(['date', 'code', 'name', 'dept', 'shift', 'in']), rows: daily(q).filter(r => r.status === 'Missing Out') }) },
  workhours: { title: 'Working hours', desc: 'Hours worked per employee', run: (q) => {
    const m = new Map();
    for (const r of daily(q)) { const e = m.get(r.code) ?? { code: r.code, name: r.name, dept: r.dept, days: 0, hours: 0, ot: 0 }; if (r.worked_min > 0) { e.days++; e.hours += r.worked_min / 60; } e.ot += r.overtime_min / 60; m.set(r.code, e); }
    return { columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('days', 'Days worked', 'number'), C('hours', 'Total hours', 'number'), C('avg', 'Average hours/day', 'number'), C('ot', 'Overtime hours', 'number')],
      rows: [...m.values()].map(e => ({ ...e, hours: Math.round(e.hours * 100) / 100, avg: e.days ? Math.round((e.hours / e.days) * 100) / 100 : 0, ot: Math.round(e.ot * 100) / 100 })) };
  } },
  transactions: { title: 'Punch transactions', desc: 'Every raw punch with its source', run: (q) => {
    const [from, to] = range(q), sc = scopeClause('e'), f = filters(q), w = [], a = [from + ' 00:00:00', to + ' 23:59:59'];
    for (const [v, col] of [[f.departmentId, 'e.department_id'], [f.branchId, 'e.branch_id'], [f.designationId, 'e.designation_id'], [f.groupId, 'e.group_id'], [f.employeeId, 'e.id']]) if (v) { w.push(`AND ${col}=?`); a.push(v); }
    const rows = db.prepare(`SELECT l.ts AS time, l.emp_code AS code, e.name, d.name AS dept, COALESCE(v.name, v.sn, '') AS device, l.source, l.temp_c AS temp
                             FROM logs l ${sc.sql || w.length ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN devices v ON v.id=l.device_id
                             WHERE l.ts BETWEEN ? AND ? ${w.join(' ')}${sc.sql} ORDER BY l.ts LIMIT 20000`).all(a[0], a[1], ...a.slice(2), ...sc.args);
    return { columns: [C('time', 'Time'), C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('device', 'Device'), C('source', 'Source'), C('temp', 'Temp (°C)', 'number')], rows };
  } },
  shift: { title: 'Shift report', desc: 'Attendance grouped by shift', run: (q) => {
    const m = new Map();
    for (const r of attendanceReport(...range(q), filters(q)).filter(r => r.status)) {
      const k = r.shift || 'No shift', s = m.get(k) ?? { shift: k, emps: new Set(), present: 0, late: 0, absent: 0, half: 0, leave: 0, ot: 0, worked: 0 };
      s.emps.add(r.code); if (PRESENT.includes(r.status)) s.present++; if (r.status === 'Late') s.late++; if (r.status === 'Absent') s.absent++; if (r.status === 'Half Day') s.half++; if (['Leave', 'Unpaid Leave'].includes(r.status)) s.leave++;
      s.ot += r.overtime_min; s.worked += r.worked_min; m.set(k, s);
    }
    return { columns: [C('shift', 'Shift'), C('employees', 'Employees', 'number'), C('present', 'Present days', 'number'), C('late', 'Late days', 'number'), C('half', 'Half days', 'number'), C('absent', 'Absent days', 'number'), C('leave', 'Leave days', 'number'), C('ot', 'Overtime hours', 'number'), C('worked', 'Worked hours', 'number')],
      rows: [...m.values()].map(s => ({ shift: s.shift, employees: s.emps.size, present: s.present, late: s.late, half: s.half, absent: s.absent, leave: s.leave, ot: hrs(s.ot), worked: hrs(s.worked) })) };
  } },
  department: { title: 'Department attendance', desc: 'Attendance rate per department', run: (q) => {
    const m = new Map();
    for (const r of attendanceReport(...range(q), filters(q)).filter(r => r.status)) {
      const k = r.dept || 'No department', d = m.get(k) ?? { dept: k, emps: new Set(), present: 0, late: 0, absent: 0, leave: 0 };
      d.emps.add(r.code); if (PRESENT.includes(r.status)) d.present++; if (r.status === 'Late') d.late++; if (r.status === 'Absent') d.absent++; if (['Leave', 'Unpaid Leave'].includes(r.status)) d.leave++; m.set(k, d);
    }
    return { columns: [C('dept', 'Department'), C('employees', 'Employees', 'number'), C('present', 'Present days', 'number'), C('late', 'Late days', 'number'), C('absent', 'Absent days', 'number'), C('leave', 'Leave days', 'number'), C('rate', 'Attendance %', 'number')],
      rows: [...m.values()].map(d => ({ dept: d.dept, employees: d.emps.size, present: d.present, late: d.late, absent: d.absent, leave: d.leave, rate: d.present + d.absent ? round1((d.present / (d.present + d.absent)) * 100) : 100 })) };
  } },
  employee: { title: 'Employee attendance', desc: 'Day by day for one employee', needs: ['employee_id'], run: (q) => {
    if (!q.employee_id) throw Object.assign(new Error('Choose an employee'), { status: 400 });
    return { columns: DAILY.filter(c => !['code', 'name', 'dept'].includes(c.key)), rows: daily(q) };
  } },
  leave: { title: 'Leave report', desc: 'Approved leave days per employee and type', run: (q) => {
    const r = leaveReport(q), types = [...new Set(r.employees.flatMap(e => Object.keys(e.types)))];
    return { columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), ...types.map(t => C('t_' + t, t, 'number')), C('total', 'Total days', 'number')],
      rows: r.employees.map(e => ({ ...e, ...Object.fromEntries(types.map(t => ['t_' + t, e.types[t] ?? 0])) })) };
  } },
  overtime: { title: 'Overtime report', desc: 'Calculated and payable overtime per employee', run: (q) => ({
    columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('days', 'Days', 'number'), C('calc', 'Calculated (h)', 'number'), C('manual', 'Manual (h)', 'number'), C('pay', 'Payable (h)', 'number'), C('wait', 'Waiting (h)', 'number')],
    rows: overtimeReport(q).employees.map(e => ({ ...e, calc: hrs(e.calculated_min), manual: hrs(e.manual_min), pay: hrs(e.approved_min), wait: hrs(e.pending_min) })) }) },
  payroll: { title: 'Payroll', desc: 'Salary calculation for one month', needs: ['month'], run: (q) => {
    const month = /^\d{4}-\d\d$/.test(q.month ?? '') ? q.month : dateStr(new Date()).slice(0, 7);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(month), ok = allowedCodes();
    const rows = (run ? JSON.parse(run.data) : payroll(month, filters(q))).filter(r => !ok || ok.has(r.code));
    return { subtitle: `${month}${run ? ' (' + run.status + ')' : ' (draft)'}`, columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), C('salary', 'Gross salary', 'number'), C('basic', 'Basic', 'number'), C('working_days', 'Work days', 'number'), C('absent', 'Absent', 'number'), C('half_day', 'Half days', 'number'),
      C('unpaid_leave', 'Unpaid leave', 'number'), C('late', 'Late', 'number'), C('base', 'Base', 'number'), C('deduction', 'Absence deduction', 'number'), C('overtime_hours', 'OT hours', 'number'), C('overtime_pay', 'OT pay', 'number'),
      C('allowances', 'Allowances', 'number'), C('bonus', 'Bonus', 'number'), C('other_deductions', 'Deductions', 'number'), C('advances', 'Advances', 'number'), C('tax', 'Income tax', 'number'), C('eobi_employee', 'EOBI', 'number'), C('net', 'Net pay', 'number')], rows };
  } },
  shift_calendar: { title: 'Shift calendar', desc: 'Which shift each employee works on each day of a month', needs: ['month'], run: (q) => {
    const m = shiftCalendar({ ...q, month: q.month || (q.from ? q.from.slice(0, 7) : undefined) });
    return { subtitle: m.month, columns: [C('code', 'ID'), C('name', 'Name'), C('dept', 'Department'), ...m.days.map(d => C('d' + d.slice(8), d.slice(8)))],
      rows: m.rows.map(r => ({ code: r.code, name: r.name, dept: r.dept, ...Object.fromEntries(r.cells.map((c, i) => ['d' + m.days[i].slice(8), c.c])) })) };
  } },
  visitors: { title: 'Visitor log', desc: 'Everyone who visited in the period, with host, times and badge', run: (q) => {
    const [from, to] = range(q);
    const rows = db.prepare(`SELECT v.name, v.company, v.phone, v.id_no, v.purpose, h.name AS host, COALESCE(substr(v.checked_in,1,10), v.expected_date) AS day, substr(v.checked_in,12,5) AS time_in, substr(v.checked_out,12,5) AS time_out, v.badge_no AS badge, v.status
      FROM visitors v LEFT JOIN employees h ON h.id=v.host_id WHERE COALESCE(substr(v.checked_in,1,10), v.expected_date, substr(v.created,1,10)) BETWEEN ? AND ? ORDER BY day, v.checked_in`).all(from, to);
    return { columns: [C('day', 'Date'), C('name', 'Visitor'), C('company', 'Company'), C('phone', 'Phone'), C('id_no', 'ID no.'), C('purpose', 'Purpose'), C('host', 'Host'), C('time_in', 'In'), C('time_out', 'Out'), C('badge', 'Badge'), C('status', 'Status')], rows };
  } },
  custom: { title: 'Custom report', desc: 'Pick your own columns and status filter', run: (q) => {
    const keys = String(q.columns ?? '').split(',').filter(k => DAILY.some(c => c.key === k)), want = String(q.statuses ?? '').split(',').filter(Boolean);
    const rows = daily(q).filter(r => !want.length || want.includes(r.status));
    return { columns: pick(keys.length ? keys : ['date', 'code', 'name', 'status']), rows };
  } },
};
Object.assign(CATALOG, EXTRA);
const GROUPS = { daily: 'Daily', late: 'Daily', early: 'Daily', absent: 'Daily', missing: 'Daily', transactions: 'Daily', workhours: 'Summary', summary: 'Summary', shift: 'Summary', department: 'Summary', employee: 'Summary', leave: 'Summary', overtime: 'Summary', payroll: 'Payroll', shift_calendar: 'Schedule', visitors: 'Other', custom: 'Other' };
for (const [id, d] of Object.entries(CATALOG)) d.group ??= GROUPS[id] ?? 'Other';

function build(type, q) {
  const def = CATALOG[type]; if (!def) throw Object.assign(new Error('Unknown report'), { status: 404 });
  const out = def.run(q), [from, to] = range(q);
  const names = [];
  for (const [p, t] of [['department_id', 'departments'], ['branch_id', 'branches'], ['designation_id', 'designations'], ['group_id', 'emp_groups']]) if (q[p]) { const r = db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(q[p]); if (r) names.push(r.name); }
  const e = q.employee_id ? db.prepare('SELECT name FROM employees WHERE id=?').get(q.employee_id) : null; if (e) names.push(e.name);
  const subtitle = out.subtitle ?? `${from} to ${to}`;
  return { type, title: def.title, subtitle: [subtitle, ...names].join('  -  '), columns: out.columns, rows: out.rows };
}
const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status ?? 500).json({ error: e.status ? e.message : 'Report failed: ' + e.message }); } };

reportsRouter.get('/reports', (_q, res) => res.json(Object.entries(CATALOG).map(([id, d]) => ({ id, title: d.title, description: d.desc, group: d.group, needs: d.needs ?? [] }))));

// Saved (custom) report definitions
reportsRouter.get('/reports/saved', (_q, res) => res.json(db.prepare('SELECT id, name, type, params, created_by FROM saved_reports ORDER BY name').all().map(r => ({ ...r, params: JSON.parse(r.params) }))));
reportsRouter.post('/reports/saved', wrap((req, res) => {
  const { name, type, params } = req.body ?? {};
  if (!String(name ?? '').trim() || !CATALOG[type]) return res.status(400).json({ error: 'Name and a valid report type required' });
  const keep = {}; for (const k of ['department_id', 'branch_id', 'designation_id', 'group_id', 'employee_id', 'columns', 'statuses']) if (params?.[k]) keep[k] = String(params[k]).slice(0, 300);
  db.prepare(`INSERT INTO saved_reports(name, type, params, created_by) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET type=excluded.type, params=excluded.params`).run(String(name).trim().slice(0, 80), type, JSON.stringify(keep), req.user);
  res.json({ ok: true });
}));
reportsRouter.delete('/reports/saved/:id', (req, res) => { db.prepare('DELETE FROM saved_reports WHERE id=?').run(req.params.id); res.json({ ok: true }); });

reportsRouter.get('/reports/:type', wrap((req, res) => res.json(build(req.params.type, req.query))));
reportsRouter.get('/reports/:type/export', wrap((req, res) => {
  const r = build(req.params.type, req.query), fmt = String(req.query.format ?? 'csv'), base = r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (fmt === 'csv') return res.type('text/csv').attachment(`${base}.csv`).send(toCsvCols(r.columns, r.rows));
  if (fmt === 'xlsx') return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${base}.xlsx`).send(makeXlsx(r));
  if (fmt === 'pdf') return res.type('application/pdf').attachment(`${base}.pdf`).send(makePdf(r));
  res.status(400).json({ error: 'format must be csv, xlsx or pdf' });
}));

// ---------- statistics ----------
reportsRouter.get('/stats', wrap((req, res) => {
  const [from, to] = range(req.query), rows = attendanceReport(from, to, filters(req.query)).filter(r => r.status && !['Holiday', 'Weekly Off', 'Pending'].includes(r.status));
  const day = new Map(), dept = new Map(), emp = new Map(), dow = Array.from({ length: 7 }, () => ({ present: 0, absent: 0 }));
  let present = 0, absent = 0, late = 0, leave = 0, worked = 0, workedDays = 0, ot = 0;
  for (const r of rows) {
    const p = PRESENT.includes(r.status), a = r.status === 'Absent', l = ['Leave', 'Unpaid Leave'].includes(r.status);
    const d = day.get(r.date) ?? { date: r.date, present: 0, late: 0, absent: 0, leave: 0 }; if (p) d.present++; if (r.status === 'Late') d.late++; if (a) d.absent++; if (l) d.leave++; day.set(r.date, d);
    const dp = dept.get(r.dept || 'No department') ?? { dept: r.dept || 'No department', present: 0, absent: 0 }; if (p) dp.present++; if (a) dp.absent++; dept.set(dp.dept, dp);
    const e = emp.get(r.code) ?? { code: r.code, name: r.name, late: 0, absent: 0, ot: 0 }; if (r.status === 'Late') e.late++; if (a) e.absent++; e.ot += r.overtime_min; emp.set(r.code, e);
    const w = new Date(r.date + 'T00:00:00Z').getUTCDay(); if (p) dow[w].present++; if (a) dow[w].absent++;
    if (p) present++; if (a) absent++; if (r.status === 'Late') late++; if (l) leave++; if (r.worked_min > 0) { worked += r.worked_min; workedDays++; } ot += r.overtime_min;
  }
  const top = (k, min = 1) => [...emp.values()].filter(e => e[k] >= min).sort((a, b) => b[k] - a[k]).slice(0, 5);
  res.json({ from, to, totals: { employees: new Set(rows.map(r => r.code)).size, present_days: present, absent_days: absent, late_days: late, leave_days: leave,
    attendance_rate: present + absent ? round1((present / (present + absent)) * 100) : 100, punctuality_rate: present ? round1(((present - late) / present) * 100) : 100,
    avg_hours: workedDays ? Math.round((worked / workedDays / 60) * 10) / 10 : 0, overtime_hours: hrs(ot) },
    daily: [...day.values()].sort((a, b) => a.date.localeCompare(b.date)),
    departments: [...dept.values()].map(d => ({ dept: d.dept, rate: d.present + d.absent ? round1((d.present / (d.present + d.absent)) * 100) : 100, present: d.present, absent: d.absent })).sort((a, b) => b.rate - a.rate),
    weekdays: dow.map((d, i) => ({ day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i], rate: d.present + d.absent ? round1((d.present / (d.present + d.absent)) * 100) : null })),
    top_late: top('late'), top_absent: top('absent'), top_overtime: top('ot', 30).map(e => ({ ...e, ot: hrs(e.ot) })) });
}));
