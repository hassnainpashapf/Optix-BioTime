import { db, getSettings } from './db.js';
import { attendanceReport, addDays, dayList, dateStr, PRESENT } from './report.js';
import { shiftPaidHours } from './shifts.js';
import { policyResolver } from './policy.js';
import { factorMap } from './paycodes.js';
import { salaryMap, taxableShare, monthlyTax, statutory, slabs } from './paycalc.js';
import { loadFormulas } from './payformula.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Monthly salary / working days of the month = day rate. Deductions: absent, half days, unpaid leave, optional late penalty.
// Monthly adjustments (allowance, bonus add; deduction, advance subtract) come from payroll_items.
// Overtime is paid at day rate / shift hours * multiplier (by day type). A mid-month joiner is paid only for days since joining.
// A custom period (period.from/period.to, at most 62 days) is paid at the day rate of the month it starts in; tax, EOBI and social security are scaled to the part of the month it covers.
export function payroll(month, filter = {}, period = null) {
  const S = getSettings();
  const mFrom = month + '-01';
  let mTo = mFrom; while (addDays(mTo, 1).startsWith(month)) mTo = addDays(mTo, 1);
  const custom = !!(period?.from && period?.to && (period.from !== mFrom || period.to !== mTo));
  const from = custom ? period.from : mFrom, to = custom ? period.to : mTo;
  const rows = attendanceReport(from, to, filter);
  const info = new Map(db.prepare(`SELECT e.id, e.code, e.salary, e.tax_exempt, e.eobi, e.social_scheme, e.group_id, e.department_id, e.branch_id, e.att_policy_id, s.start, s.end, s.workdays, s.type, s.required_min, s.break_start, s.break_end, s.seg2_start, s.seg2_end FROM employees e LEFT JOIN shifts s ON s.id=COALESCE(e.shift_id, (SELECT shift_id FROM departments WHERE id=e.department_id))`).all().map(r => [r.code, { ...r, salary: r.salary }]));
  const polOf = policyResolver(S), sal = salaryMap(month), table = S.tax_enabled ? slabs() : [];
  const holidays = new Set(db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(mFrom < from ? mFrom : from, mTo > to ? mTo : to).map(h => h.date));
  const adj = new Map(); // code -> { allowance, bonus, deduction, advance }
  for (const i of db.prepare('SELECT e.code, i.kind, i.amount FROM payroll_items i JOIN employees e ON e.id=i.employee_id WHERE i.month=?').all(month)) {
    const a = adj.get(i.code) ?? { allowance: 0, bonus: 0, deduction: 0, advance: 0 };
    a[i.kind] += i.amount; adj.set(i.code, a);
  }
  const exemptOf = new Map(db.prepare('SELECT employee_id, SUM(amount) AS a FROM pay_exemptions WHERE year=? GROUP BY employee_id').all(Number(month.slice(0, 4))).map(r => [r.employee_id, r.a])); // expense exemptions: the year's amount is taken off the taxable income, a twelfth each month
  const FM = loadFormulas(), FBY = new Map(Object.values(FM).flat().map(f => [f.id, f])); // formulas from Payroll > Formula; each person uses the ones chosen in their salary structure
  const byEmp = new Map();
  for (const r of rows) { if (!byEmp.has(r.code)) byEmp.set(r.code, []); byEmp.get(r.code).push(r); }

  const out = [];
  for (const [code, list] of byEmp) {
    const e = info.get(code);
    const wd = (e.workdays ?? '1,2,3,4,5,6').split(',').map(Number);
    const isWork = (d) => !holidays.has(d) && wd.includes(new Date(d + 'T00:00:00Z').getUTCDay());
    const fullDays = dayList(mFrom, mTo).filter(isWork).length, periodDays = custom ? dayList(from, to).filter(isWork).length : fullDays, frac = fullDays ? periodDays / fullDays : 1;
    const st = sal.get(e.id), salary = st ? st.gross : (Number(e.salary) || 0), basic = st ? st.basic : salary;
    const perDay = fullDays ? salary / fullDays : 0;
    const count = (s) => list.filter(r => r.status === s).length;
    const lates = count('Late');
    const lpd = polOf(e).lates_per_deduction, latePenalty = lpd ? Math.floor(lates / lpd) : 0;
    const fac = factorMap(); // the share of a day that is paid for each status (Pay codes page); Absent 0, Half Day 0.5, Unpaid Leave 0 by default
    const absentDays = list.reduce((a, r) => a + (r.status in fac && fac[r.status] < 1 ? 1 - fac[r.status] : 0), 0) + latePenalty;
    const payableDays = list.filter(r => r.day_type === 'work').length;
    const base = perDay * payableDays;
    const deduction = Math.min(base, perDay * absentDays);
    const hourly = perDay / shiftPaidHours(e.start ? e : null);
    let otMin = 0, otPay = 0; const otBy = { work: [0, 0], weekend: [0, 0], holiday: [0, 0] }; // day type -> [hours, pay]
    for (const r of list) { const p = (r.ot_approved_min / 60) * hourly * r.ot_mult; otMin += r.ot_approved_min; otPay += p; const o = otBy[r.day_type] ?? otBy.work; o[0] += r.ot_approved_min / 60; o[1] += p; }
    const leaveBy = {}; for (const r of list) if ((r.status === 'Leave' || r.status === 'Unpaid Leave') && r.note) leaveBy[r.note] = (leaveBy[r.note] ?? 0) + 1;
    const a = adj.get(code) ?? { allowance: 0, bonus: 0, deduction: 0, advance: 0 };
    const pick = (col) => (st && st[col] ? [FBY.get(st[col])].filter(Boolean) : []);
    if (['f_overtime', 'f_exception', 'f_deduction', 'f_increment', 'f_leave'].some(c => pick(c).length)) { // what the chosen formulas work out for this person: overtime replaces the default overtime pay; exception and deduction formulas take money off; increment adds
      const lv = (t) => list.filter(r => (r.status === 'Leave' || r.status === 'Unpaid Leave') && r.note === t).length, ot = (dt) => list.filter(r => r.day_type === dt).reduce((x, r) => x + r.ot_approved_min / 60, 0);
      const full = list.filter(r => PRESENT.includes(r.status) && !r.late_min && !r.early_min);
      const V = { 'Basic Salary': basic, 'Schedule Days': periodDays, 'Schedule Period': dayList(from, to).length, 'Duty Duration': periodDays * shiftPaidHours(e.start ? e : null), 'Worked Hrs': list.reduce((x, r) => x + r.worked_min / 60, 0),
        'Full Attendance': !count('Absent') && !lates && !list.some(r => r.early_min) && payableDays ? 1 : 0, 'Full Attendance Days': full.length, 'Full Attendance Hours': full.reduce((x, r) => x + r.worked_min / 60, 0),
        'Late In': list.reduce((x, r) => x + r.late_min, 0), 'Early Out': list.reduce((x, r) => x + r.early_min, 0), 'Absence': count('Absent'),
        'Annual Leave': lv('Annual'), 'Sick Leave': lv('Sick'), 'Casual Leave': lv('Casual'), 'Maternity Leave': lv('Maternity'), 'Compassionate Leave': 0, 'Business Trip': count('On Duty'), 'Compensatory': 0, 'Compensatory Leave': lv('Compensatory Leave'),
        'Normal OT': ot('work'), 'Weekend OT': ot('weekend'), 'Holiday OT': ot('holiday'), OT1: 0, OT2: 0, OT3: 0 };
      const sum = (arr) => arr.reduce((x, f) => x + Math.max(0, f.run(V)), 0);
      if (pick('f_overtime').length) otPay = sum(pick('f_overtime'));
      a.deduction += sum(pick('f_exception')) + sum(pick('f_leave')) + sum(pick('f_deduction')); a.bonus += sum(pick('f_increment'));
    }
    // income tax on this month's taxable pay (earned salary share + overtime + allowances + bonus), annualised through the slabs; EOBI employee share; social security is an employer cost
    const earned = base - deduction, taxable = Math.max(0, earned * taxableShare(st) + otPay + a.bonus + a.allowance - (exemptOf.get(e.id) ?? 0) / 12);
    const stat = statutory(e, S), social = round2(stat.social(salary) * frac), pool = Math.max(0, earned + otPay + a.allowance + a.bonus); // tax and EOBI never take more than was earned
    const tax = Math.min(pool, S.tax_enabled && !e.tax_exempt ? round2(monthlyTax(taxable / (frac || 1), S, table) * frac) : 0), eobiEmp = Math.min(pool - tax, round2(stat.eobi.employee * frac));
    out.push({ code, name: list[0].name, dept: list[0].dept, salary, basic: round2(basic), gross: round2(salary), working_days: payableDays, present: list.filter(r => PRESENT.includes(r.status)).length,
      absent: count('Absent'), half_day: count('Half Day'), unpaid_leave: count('Unpaid Leave'), late: lates, deduction_days: round2(absentDays),
      period_from: from, period_to: to, late_min: list.reduce((x, r) => x + r.late_min, 0), early_min: list.reduce((x, r) => x + r.early_min, 0),
      ot_normal_h: round2(otBy.work[0]), ot_weekend_h: round2(otBy.weekend[0]), ot_holiday_h: round2(otBy.holiday[0]), ot_normal_pay: round2(otBy.work[1]), ot_weekend_pay: round2(otBy.weekend[1]), ot_holiday_pay: round2(otBy.holiday[1]), leave_days: leaveBy,
      overtime_hours: round2(otMin / 60), base: round2(base), deduction: round2(deduction), overtime_pay: round2(otPay),
      allowances: round2(a.allowance), bonus: round2(a.bonus), other_deductions: round2(a.deduction), advances: round2(a.advance),
      tax, taxable_income: round2(taxable), eobi_employee: eobiEmp, eobi_employer: round2(stat.eobi.employer * frac), social_employer: social,
      net: round2(base - deduction + otPay + a.allowance + a.bonus - a.deduction - a.advance - tax - eobiEmp),
      final: to < dateStr(new Date()) });
  }
  return out;
}
