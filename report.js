import { db, getSettings } from './db.js';
import { dateStr, dayMin, addDays } from './dates.js';
import { scopeClause } from './rbac.js';
import { shiftResolver, altOffDay, breakMinutes } from './shifts.js';
import { policyResolver } from './policy.js';
export { dateStr, addDays };

const pad = (n) => String(n).padStart(2, '0');
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
// Naive local time as minutes since epoch, so shifts that cross midnight are plain arithmetic.
const tsMin = (ts) => dayMin(ts) + +ts.slice(11, 13) * 60 + +ts.slice(14, 16);
const dow = (day) => new Date(dayMin(day) * 60000).getUTCDay();
const hhmm = (m) => { const x = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
export const dayList = (from, to) => { const o = []; for (let d = from; d <= to; d = addDays(d, 1)) o.push(d); return o; };
export const shiftHours = (s, e) => { if (!s) return 8; const d = (toMin(e) - toMin(s) + 1440) % 1440; return d ? d / 60 : 8; };

// Overtime policy for an employee: their own policy, else the global defaults from Settings.
export function otPolicy(S, row) {
  if (row) return row;
  return { name: 'Default', post: 1, pre: S.ot_pre_shift, weekend: 1, holiday: 1, min_minutes: S.ot_min_minutes, round_minutes: S.ot_round_minutes,
    mult_work: S.ot_mult_work, mult_weekend: S.ot_mult_weekend, mult_holiday: S.ot_mult_holiday, daily_max: S.ot_daily_max_min, monthly_max: S.ot_monthly_max_min, approval: S.ot_approval };
}

// One row per employee per day. A shift that ends before it starts is overnight: its punches belong to the day it started.
// With a monthly overtime cap the month is computed from its first day (so the cap is right), then trimmed to the range.
export function attendanceReport(from, to, opts = {}) {
  const S = getSettings();
  const capped = S.ot_monthly_max_min > 0 || db.prepare('SELECT 1 FROM ot_policies WHERE monthly_max>0').get();
  const start = capped ? from.slice(0, 8) + '01' : from;
  const rows = computeReport(start, to, opts, S);
  return start === from ? rows : rows.filter(r => r.date >= from);
}

function computeReport(from, to, { departmentId, employeeId, branchId, groupId, designationId, employeeIds } = {}, S) {
  // Inactive staff stay in the report for the part of the range they were employed (resigned/terminated on or after `from`).
  let sql = `SELECT e.id, e.code, e.name, e.join_date, e.shift_id, e.ot_policy_id, e.department_id, e.rotation_id, e.rotation_anchor, e.group_id, e.branch_id, e.att_policy_id, d.name AS dept, br.name AS branch_name
             FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches br ON br.id=e.branch_id
             WHERE (e.active=1 OR e.id IN (SELECT employee_id FROM emp_history WHERE kind IN ('resignation','termination') AND date>=?))`;
  const args = [from];
  for (const [v, col] of [[departmentId, 'e.department_id'], [employeeId, 'e.id'], [branchId, 'e.branch_id'], [groupId, 'e.group_id'], [designationId, 'e.designation_id']])
    if (v) { sql += ` AND ${col}=?`; args.push(v); }
  if (employeeIds) { sql += ` AND e.id IN (${employeeIds.length ? employeeIds.map(() => '?') : 'NULL'})`; args.push(...employeeIds); }
  const sc = scopeClause('e'); sql += sc.sql; args.push(...sc.args); // a scoped login only ever sees its own employees
  const emps = db.prepare(sql + ' ORDER BY e.code').all(...args);

  const holidays = new Map(db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map(h => [h.date, h.name]));
  const leaves = db.prepare(`SELECT l.*, COALESCE(t.paid,1) AS paid FROM leaves l LEFT JOIN leave_types t ON t.name=l.type
                             WHERE l.status='approved' AND l.to_date>=? AND l.from_date<=?`).all(from, to);
  const resolve = shiftResolver(from, to), polOf = policyResolver(S);
  const pm = new Map();
  for (const p of db.prepare('SELECT emp_code, ts FROM logs WHERE ts>=? AND ts<? AND (device_id IS NULL OR device_id NOT IN (SELECT id FROM devices WHERE att_device=0)) ORDER BY ts')
                    .all(addDays(from, -1) + ' 00:00:00', addDays(to, 2) + ' 00:00:00')) {
    if (!pm.has(p.emp_code)) pm.set(p.emp_code, []);
    pm.get(p.emp_code).push(tsMin(p.ts));
  }
  const firstDay = new Map(db.prepare('SELECT emp_code, MIN(substr(ts,1,10)) AS d FROM logs GROUP BY emp_code').all().map(r => [r.emp_code, r.d]));
  const today = dateStr(new Date()), nowM = tsMin(new Date().toLocaleString('sv')); // current local time, in the same units as the punches
  const events = new Map(); // employee_id -> exits/rejoins in date order
  for (const ev of db.prepare("SELECT employee_id, kind, date FROM emp_history WHERE kind IN ('resignation','termination','rejoin') ORDER BY date, id").all()) {
    if (!events.has(ev.employee_id)) events.set(ev.employee_id, []);
    events.get(ev.employee_id).push(ev);
  }
  // Works through the exit date itself; counted again from the rejoin date.
  const employedOn = (id, day) => { let on = true; for (const ev of events.get(id) ?? []) { if (ev.kind === 'rejoin') { if (day >= ev.date) on = true; } else if (day > ev.date) on = false; } return on; };
  const policies = new Map(db.prepare('SELECT * FROM ot_policies').all().map(p => [p.id, p]));
  const otReq = new Map(db.prepare("SELECT * FROM overtime_requests WHERE date BETWEEN ? AND ?").all(from, to).map(q => [`${q.employee_id}|${q.date}|${q.kind}`, q]));
  const overrides = new Map(db.prepare('SELECT * FROM day_overrides WHERE date BETWEEN ? AND ?').all(from, to).map(o => [`${o.employee_id}|${o.date}`, o]));
  const rows = [], rowP = new Map(); // rowP: the overtime policy that applied to each row (it can differ by day when the shift differs)

  for (const e of emps) {
    const mine_rows_start = rows.length;
    const employedFrom = e.join_date || firstDay.get(e.code) || today;
    const mine = pm.get(e.code) ?? [], PE = polOf(e); // this employee's attendance rules (policy, else Settings)

    for (const day of dayList(from, to)) {
      if (day < employedFrom || !employedOn(e.id, day)) continue; // not employed / no history yet: never count as absent
      const d0 = dayMin(day);
      const first = mine.find(m => m >= d0 && m < d0 + 1440);
      const R = resolve(e, day, first === undefined ? null : first - d0); // roster > rotation > own shift (or the alternate nearest the arrival) > department shift
      const sh = R.sh, type = sh?.type || 'fixed';
      const P = otPolicy(S, e.ot_policy_id ? policies.get(e.ot_policy_id) : (sh?.ot_policy_id ? policies.get(sh.ot_policy_id) : null));
      const workdays = (sh?.workdays ?? '1,2,3,4,5,6').split(',').map(Number);
      const overnight = !!sh && type !== 'split' && toMin(sh.end) <= toMin(sh.start);
      const [w0, w1] = overnight ? [d0 + toMin(sh.start) - 180, d0 + 1440 + toMin(sh.end) + 180] : [d0, d0 + 1440];
      const pts = mine.filter(m => m >= w0 && m < w1);
      const worksToday = R.fromRotation ? !R.off : workdays.includes(dow(day)) && !altOffDay(sh, day);
      const dayType = holidays.has(day) ? 'holiday' : worksToday ? 'work' : 'weekend';
      const leave = leaves.find(l => l.employee_id === e.id && l.from_date <= day && day <= l.to_date);
      const r = { employee_id: e.id, code: e.code, name: e.name, dept: e.dept, branch: e.branch_name ?? '', shift: sh?.name ?? '', date: day, day_type: dayType, in: null, out: null,
                  late_min: 0, early_min: 0, overtime_min: 0, ot_calc_min: 0, ot_pre_min: 0, ot_manual_min: 0, ot_approved_min: 0, ot_status: '',
                  ot_mult: dayType === 'work' ? P.mult_work : dayType === 'holiday' ? P.mult_holiday : P.mult_weekend, worked_min: 0, status: '', note: '' };
      rowP.set(r, P);

      if (pts.length) {
        const inM = pts[0];
        const outM = pts.length > 1 && pts.at(-1) - inM >= PE.min_gap_min ? pts.at(-1) : null;
        r.in = hhmm(inM);
        if (outM) { r.out = hhmm(outM) + (outM >= d0 + 1440 ? ' +1' : ''); r.worked_min = Math.max(0, outM - inM - (sh ? breakMinutes(sh, d0, overnight, pts, inM, outM) : 0)); } // unpaid break / split gap is not work
        let otRaw = 0, preRaw = 0;
        if (dayType !== 'work') { otRaw = P[dayType === 'holiday' ? 'holiday' : 'weekend'] ? r.worked_min : 0; r.status = 'Present'; r.note = dayType === 'holiday' ? 'Worked on holiday' : 'Worked on weekly off'; }
        else {
          let dayEnds = null; // when today's shift is over: before that, one punch just means "in progress", not "forgot to punch out"
          if (sh) {
            dayEnds = d0 + toMin(sh.end) + (type === 'split' ? 0 : overnight ? 1440 : 0); if (type === 'split') dayEnds = d0 + toMin(sh.seg2_end);
            if (type === 'flexible') { // hours matter, not the clock: no late, short days are flagged, extra hours are overtime
              const req = sh.required_min || 480;
              if (outM) { if (r.worked_min < req) r.early_min = req - r.worked_min; else if (P.post) otRaw = r.worked_min - req; }
            } else {
              const sStart = d0 + toMin(sh.start), sEnd = type === 'split' ? d0 + toMin(sh.seg2_end) : d0 + toMin(sh.end) + (overnight ? 1440 : 0);
              if (inM - sStart > sh.grace_min + (PE.grace_extra_min || 0)) r.late_min = inM - sStart;
              if (P.pre && sStart - inM > 0) preRaw = sStart - inM;
              if (outM) { if (sEnd - outM > 0) r.early_min = sEnd - outM; else if (P.post) otRaw = outM - sEnd; }
            }
          }
          const lateAbsent = sh?.late_to_absent_min ?? PE.late_to_absent_min, halfDay = sh?.half_day_min ?? PE.half_day_min; // a shift can have its own rules
          if (lateAbsent && r.late_min > lateAbsent) { r.status = 'Absent'; r.note = 'Too late'; }
          else if (!outM) { if (day === today && dayEnds !== null && nowM < dayEnds) { r.status = r.late_min ? 'Late' : 'Present'; r.note = 'In progress'; } else { r.status = PE.missing_out_as && PE.missing_out_as !== 'Missing Out' ? PE.missing_out_as : 'Missing Out'; if (r.status !== 'Missing Out') r.note = 'No punch-out'; } }
          else if (halfDay && r.worked_min < halfDay) r.status = 'Half Day';
          else if (type === 'flexible' && r.early_min > 0) { r.status = 'Short Hours'; r.note = `Short by ${r.early_min} min`; }
          else r.status = r.late_min ? 'Late' : 'Present';
        }
        const q = (m) => (m > 0 && m >= P.min_minutes ? (P.round_minutes ? Math.floor(m / P.round_minutes) * P.round_minutes : m) : 0);
        r.ot_pre_min = q(preRaw);
        r.ot_calc_min = (outM ? q(otRaw) : 0) + r.ot_pre_min;
        if (P.daily_max > 0 && r.ot_calc_min > P.daily_max) { r.ot_calc_min = P.daily_max; r.ot_pre_min = Math.min(r.ot_pre_min, P.daily_max); r.note = (r.note ? r.note + '. ' : '') + 'Daily overtime limit'; }
      } else if (overrides.has(`${e.id}|${day}`)) { const o = overrides.get(`${e.id}|${day}`); r.status = o.status; r.note = o.note ?? ''; }
      else if (dayType === 'holiday') { r.status = 'Holiday'; r.note = holidays.get(day) ?? ''; }
      else if (dayType === 'weekend') r.status = 'Weekly Off';
      else if (leave) { r.status = leave.paid ? 'Leave' : 'Unpaid Leave'; r.note = leave.type; }
      else r.status = day > today ? '' : day === today ? 'Pending' : 'Absent';
      rows.push(r);
    }
    // Monthly cap, then approval and manual entries decide what is payable.
    const month = new Map();
    for (const r of rows.slice(mine_rows_start)) {
      const P = rowP.get(r);
      if (P.monthly_max > 0 && r.ot_calc_min > 0) {
        const used = month.get(r.date.slice(0, 7)) ?? 0, allowed = Math.max(0, P.monthly_max - used);
        if (r.ot_calc_min > allowed) { r.ot_calc_min = allowed; r.ot_pre_min = Math.min(r.ot_pre_min, allowed); r.note = (r.note ? r.note + '. ' : '') + 'Monthly overtime limit'; }
        month.set(r.date.slice(0, 7), used + r.ot_calc_min);
      }
      const auto = otReq.get(`${e.id}|${r.date}|auto`), man = otReq.get(`${e.id}|${r.date}|manual`);
      r.ot_manual_min = man?.status === 'approved' ? man.minutes : 0;
      if (P.approval) {
        r.ot_status = r.ot_calc_min ? (auto?.status ?? 'pending') : '';
        r.ot_approved_min = auto?.status === 'approved' ? Math.min(auto.minutes, r.ot_calc_min) : 0;
      } else { r.ot_status = r.ot_calc_min ? 'auto' : ''; r.ot_approved_min = r.ot_calc_min; }
      if (r.ot_manual_min) r.ot_status = r.ot_status ? r.ot_status + '+manual' : 'manual';
      r.ot_approved_min += r.ot_manual_min;
      r.overtime_min = r.ot_calc_min + r.ot_manual_min;
    }
  }
  return rows;
}

// Statuses that count as a day worked (On Duty / Work From Home come from approved attendance requests).
export const PRESENT = ['Present', 'Missing Out', 'Late', 'Half Day', 'Short Hours', 'On Duty', 'Work From Home', 'Training'];
export function summarize(rows) {
  const m = new Map();
  for (const r of rows) {
    const s = m.get(r.code) ?? { code: r.code, name: r.name, dept: r.dept, present: 0, late: 0, half_day: 0, absent: 0, leave: 0,
      unpaid_leave: 0, holiday: 0, late_min: 0, overtime_min: 0, overtime_approved_min: 0, worked_min: 0 };
    if (PRESENT.includes(r.status)) s.present++;
    if (r.status === 'Late') s.late++;
    if (r.status === 'Half Day') s.half_day++;
    if (r.status === 'Absent') s.absent++;
    if (r.status === 'Leave') s.leave++;
    if (r.status === 'Unpaid Leave') s.unpaid_leave++;
    if (r.status === 'Holiday') s.holiday++;
    s.late_min += r.late_min; s.overtime_min += r.overtime_min; s.overtime_approved_min += r.ot_approved_min; s.worked_min += r.worked_min;
    m.set(r.code, s);
  }
  return [...m.values()];
}
