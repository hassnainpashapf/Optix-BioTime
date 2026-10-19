import { db, getSettings } from './db.js';
import { attendanceReport, addDays, dayList, dateStr, PRESENT } from './report.js';
import { shiftPaidHours } from './shifts.js';
import { policyResolver } from './policy.js';
import { factorMap } from './paycodes.js';
import { salaryMap, taxableShare, monthlyTax, statutory, slabs } from './paycalc.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Monthly salary / working days of the month = day rate. Deductions: absent, half days, unpaid leave, optional late penalty.
// Monthly adjustments (allowance, bonus add; deduction, advance subtract) come from payroll_items.
// Overtime is paid at day rate / shift hours * multiplier (by day type). A mid-month joiner is paid only for days since joining.
export function payroll(month, filter = {}) {
  const S = getSettings();
  const from = month + '-01';
  let to = from; while (addDays(to, 1).startsWith(month)) to = addDays(to, 1);
  const rows = attendanceReport(from, to, filter);
  const info = new Map(db.prepare(`SELECT e.id, e.code, e.salary, e.tax_exempt, e.eobi, e.social_scheme, e.group_id, e.department_id, e.branch_id, e.att_policy_id, s.start, s.end, s.workdays, s.type, s.required_min, s.break_start, s.break_end, s.seg2_start, s.seg2_end FROM employees e LEFT JOIN shifts s ON s.id=COALESCE(e.shift_id, (SELECT shift_id FROM departments WHERE id=e.department_id))`).all().map(r => [r.code, { ...r, salary: r.salary }]));
  const polOf = policyResolver(S), sal = salaryMap(month), table = S.tax_enabled ? slabs() : [];
  const holidays = new Set(db.prepare('SELECT date FROM holidays WHERE date BETWEEN ? AND ?').all(from, to).map(h => h.date));
  const adj = new Map(); // code -> { allowance, bonus, deduction, advance }
  for (const i of db.prepare('SELECT e.code, i.kind, i.amount FROM payroll_items i JOIN employees e ON e.id=i.employee_id WHERE i.month=?').all(month)) {
    const a = adj.get(i.code) ?? { allowance: 0, bonus: 0, deduction: 0, advance: 0 };
    a[i.kind] += i.amount; adj.set(i.code, a);
  }
  const byEmp = new Map();
  for (const r of rows) { if (!byEmp.has(r.code)) byEmp.set(r.code, []); byEmp.get(r.code).push(r); }

  const out = [];
  for (const [code, list] of byEmp) {
    const e = info.get(code);
    const wd = (e.workdays ?? '1,2,3,4,5,6').split(',').map(Number);
    const fullDays = dayList(from, to).filter(d => !holidays.has(d) && wd.includes(new Date(d + 'T00:00:00Z').getUTCDay())).length;
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
    let otMin = 0, otPay = 0;
    for (const r of list) { otMin += r.ot_approved_min; otPay += (r.ot_approved_min / 60) * hourly * r.ot_mult; }
    const a = adj.get(code) ?? { allowance: 0, bonus: 0, deduction: 0, advance: 0 };
    // income tax on this month's taxable pay (earned salary share + overtime + allowances + bonus), annualised through the slabs; EOBI employee share; social security is an employer cost
    const earned = base - deduction, taxable = earned * taxableShare(st) + otPay + a.bonus + a.allowance;
    const stat = statutory(e, S), social = stat.social(salary), pool = Math.max(0, earned + otPay + a.allowance + a.bonus); // tax and EOBI never take more than was earned
    const tax = Math.min(pool, S.tax_enabled && !e.tax_exempt ? monthlyTax(taxable, S, table) : 0), eobiEmp = Math.min(pool - tax, stat.eobi.employee);
    out.push({ code, name: list[0].name, dept: list[0].dept, salary, basic: round2(basic), gross: round2(salary), working_days: payableDays, present: list.filter(r => PRESENT.includes(r.status)).length,
      absent: count('Absent'), half_day: count('Half Day'), unpaid_leave: count('Unpaid Leave'), late: lates, deduction_days: round2(absentDays),
      overtime_hours: round2(otMin / 60), base: round2(base), deduction: round2(deduction), overtime_pay: round2(otPay),
      allowances: round2(a.allowance), bonus: round2(a.bonus), other_deductions: round2(a.deduction), advances: round2(a.advance),
      tax, taxable_income: round2(taxable), eobi_employee: eobiEmp, eobi_employer: stat.eobi.employer, social_employer: social,
      net: round2(base - deduction + otPay + a.allowance + a.bonus - a.deduction - a.advance - tax - eobiEmp),
      final: to < dateStr(new Date()) });
  }
  return out;
}
