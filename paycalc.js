import { db } from './db.js';

export const round2 = (n) => Math.round(n * 100) / 100;
export const slabs = () => db.prepare('SELECT lower, upper, fixed, rate FROM tax_slabs ORDER BY lower').all();

// Annual income tax from the slabs: fixed amount of the slab + rate on the part above the slab's lower limit. Surcharge on the tax above a threshold.
export function annualTax(income, S, table = slabs()) {
  if (!(income > 0)) return 0;
  let s = table.find(x => income > x.lower && (x.upper === null || income <= x.upper)) ?? table.at(-1);
  if (!s) return 0;
  let tax = s.fixed + (income - s.lower) * s.rate / 100;
  if (S.tax_surcharge_over > 0 && income > S.tax_surcharge_over) tax += tax * S.tax_surcharge_pct / 100;
  return Math.max(0, tax);
}
export const monthlyTax = (taxableMonthly, S, table) => round2(annualTax(taxableMonthly * 12, S, table) / 12);

// The salary structure in force for a month: the latest revision that starts on or before the 1st. Null = use employees.salary as a plain amount.
export function salaryMap(month) {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM emp_salary WHERE effective_from<=? ORDER BY effective_from DESC, id DESC').all(month + '-01'))
    if (!m.has(r.employee_id)) m.set(r.employee_id, { ...r, components: JSON.parse(r.components || '[]') });
  return m;
}
// Share of the gross that is taxable (basic and taxable allowances); 1 when there is no structure.
export const taxableShare = (st) => !st || !(st.gross > 0) ? 1 : (st.basic + st.components.filter(c => c.taxable).reduce((a, c) => a + c.amount, 0)) / st.gross;

export function statutory(emp, S) { // monthly fixed contributions
  const eobi = emp.eobi ? { employee: round2(S.eobi_wage * S.eobi_rate_employee / 100), employer: round2(S.eobi_wage * S.eobi_rate_employer / 100) } : { employee: 0, employer: 0 };
  return { eobi, social: (gross) => emp.social_scheme === 'SESSI' ? round2(Math.min(gross, S.sessi_ceiling) * S.sessi_rate / 100) : emp.social_scheme === 'PESSI' ? round2(Math.min(gross, S.pessi_ceiling) * S.pessi_rate / 100) : 0 };
}

// ---- revisions
export const firstOf = (d) => String(d).slice(0, 7) + '-01';
const thisMonth = () => new Date().toLocaleDateString('sv').slice(0, 7);
export function addRevision(empId, { effective_from, basic, components = [], note = null }, actor) {
  const gross = round2(basic + components.reduce((a, c) => a + c.amount, 0)), from = firstOf(effective_from);
  db.prepare('DELETE FROM emp_salary WHERE employee_id=? AND effective_from=?').run(empId, from); // one revision per month: the last one wins
  const id = Number(db.prepare('INSERT INTO emp_salary(employee_id, effective_from, basic, components, gross, note, created_by) VALUES(?,?,?,?,?,?,?)').run(empId, from, round2(basic), JSON.stringify(components), gross, note, actor).lastInsertRowid);
  syncSalary(empId); return { id, gross };
}
// employees.salary mirrors the salary in force this month, so the employee list and API stay right.
export function syncSalary(empId) {
  const st = salaryMap(thisMonth()).get(empId); if (st) db.prepare('UPDATE employees SET salary=? WHERE id=?').run(st.gross, empId);
}
export function syncSalaries() { const m = salaryMap(thisMonth()); for (const [id, st] of m) db.prepare('UPDATE employees SET salary=? WHERE id=? AND IFNULL(salary,-1)!=?').run(st.gross, id, st.gross); }
// Someone typed a new gross on the employee form: when there is a structure, scale it so basic and allowances stay in proportion.
export function salaryEdited(oldSalary, emp, actor) {
  const now = Number(emp.salary) || 0, was = Number(oldSalary) || 0; if (now === was) return;
  const st = salaryMap(thisMonth()).get(emp.id); if (!st || !(st.gross > 0)) return;
  const k = now / st.gross; addRevision(emp.id, { effective_from: thisMonth() + '-01', basic: st.basic * k, components: st.components.map(c => ({ ...c, amount: round2(c.amount * k) })), note: 'Gross changed on the employee form' }, actor);
}
