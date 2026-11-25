import express from 'express';
import { createHash } from 'node:crypto';
import { db, getSettings, setSettings } from './db.js';
import { bgEnabled } from './zk-log.js';
import { payroll } from './payroll.js';
import { toCsv } from './csv.js';
import { scopeClause, isScoped } from './rbac.js';
import { addRevision, salaryMap, round2, firstOf, syncSalary, syncSalaries, annualTax, slabs } from './paycalc.js';

export const payrollxRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const thisMonth = () => new Date().toLocaleDateString('sv').slice(0, 7);
const nowStr = () => new Date().toLocaleString('sv');
const scoped = (res) => isScoped() ? (fail(res, 'This needs an account without a data scope', 403), true) : false;

// ---------- salary structure and revisions ----------
function cleanStructure(b) {
  const basic = Number(b.basic); if (!(basic > 0 && basic < 1e9)) return { error: 'Basic salary must be a number above 0' };
  const comps = Array.isArray(b.components) ? b.components : []; if (comps.length > 20) return { error: 'At most 20 allowances' };
  const out = [];
  for (const c of comps) {
    const name = String(c.name ?? '').trim().slice(0, 40), amount = Number(c.amount); if (!name && !c.amount) continue;
    if (!name) return { error: 'Every allowance needs a name' }; if (!(amount >= 0 && amount < 1e9)) return { error: `Allowance "${name}" must be a number, 0 or more` };
    out.push({ name, amount: round2(amount), taxable: c.taxable === false || c.taxable === 0 ? false : true });
  }
  if (!/^\d{4}-\d\d(-\d\d)?$/.test(b.effective_from ?? '')) return { error: 'Choose the month the new salary starts' };
  return { o: { effective_from: firstOf(b.effective_from), basic, components: out, note: String(b.note ?? '').slice(0, 200) || null } };
}
const empRow = (id) => db.prepare('SELECT e.id, e.code, e.name, e.salary, e.active, e.tax_exempt, e.eobi, e.social_scheme, e.bank_name, e.bank_account, e.bank_title, e.cnic, e.eobi_no, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=?').get(id);
payrollxRouter.get('/payroll/salary', (_q, res) => {
  const sc = scopeClause('e'), cur = salaryMap(thisMonth());
  const rows = db.prepare(`SELECT e.id, e.code, e.name, e.salary, e.active, e.tax_exempt, e.eobi, e.social_scheme, e.bank_account, d.name AS dept, (SELECT COUNT(*) FROM emp_salary s WHERE s.employee_id=e.id) AS revisions FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql} ORDER BY e.code`).all(...sc.args);
  res.json(rows.map(r => { const st = cur.get(r.id); return { ...r, basic: st ? st.basic : r.salary, gross: st ? st.gross : r.salary, effective_from: st?.effective_from ?? null, structured: !!st }; }));
});
payrollxRouter.get('/payroll/salary/:id', (req, res) => {
  const e = empRow(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  if (scopeClause('e').sql && !db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${scopeClause('e').sql}`).get(e.id, ...scopeClause('e').args)) return fail(res, 'No such employee', 404);
  const hist = db.prepare('SELECT * FROM emp_salary WHERE employee_id=? ORDER BY effective_from DESC, id DESC').all(e.id).map(r => ({ ...r, components: JSON.parse(r.components) }));
  res.json({ employee: e, current: salaryMap(thisMonth()).get(e.id) ?? null, history: hist.map((r, i) => ({ ...r, change_pct: hist[i + 1] && hist[i + 1].gross > 0 ? round2((r.gross - hist[i + 1].gross) / hist[i + 1].gross * 100) : null })) });
});
payrollxRouter.post('/payroll/salary/:id', (req, res) => {
  const e = empRow(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  const { o, error } = cleanStructure(req.body ?? {}); if (error) return fail(res, error);
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(o.effective_from.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized. Reopen it first, or choose a later month.');
  res.json(addRevision(e.id, o, req.user));
});
payrollxRouter.delete('/payroll/salary/revision/:rid', (req, res) => {
  const r = db.prepare('SELECT * FROM emp_salary WHERE id=?').get(req.params.rid); if (!r) return fail(res, 'No such revision', 404);
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(r.effective_from.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized');
  db.prepare('DELETE FROM emp_salary WHERE id=?').run(r.id); syncSalary(r.employee_id); res.json({ ok: true });
});
// Annual increment: raise everyone (or chosen people) by a percentage or a fixed amount on the basic, from a month.
payrollxRouter.post('/payroll/salary-bulk', (req, res) => {
  const b = req.body ?? {}, pct = b.percent !== undefined && b.percent !== '' ? Number(b.percent) : null, amt = b.amount !== undefined && b.amount !== '' ? Number(b.amount) : null;
  if ((pct === null) === (amt === null)) return fail(res, 'Give either a percentage or an amount'); if (pct !== null && !(pct > -50 && pct < 500)) return fail(res, 'The percentage looks wrong'); if (amt !== null && !(amt > -1e8 && amt < 1e8)) return fail(res, 'The amount looks wrong');
  if (!/^\d{4}-\d\d(-\d\d)?$/.test(b.effective_from ?? '')) return fail(res, 'Choose the month the new salary starts');
  const from = firstOf(b.effective_from); if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(from.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized');
  const sc = scopeClause('e'), ids = Array.isArray(b.employee_ids) && b.employee_ids.length ? b.employee_ids.map(Number) : db.prepare(`SELECT e.id FROM employees e WHERE e.active=1 AND e.salary>0${sc.sql}`).all(...sc.args).map(r => r.id);
  const cur = salaryMap(from.slice(0, 7)); let changed = 0; const preview = [];
  for (const id of ids) {
    const e = empRow(id); if (!e || !(e.salary > 0)) continue; const st = cur.get(id), basic0 = st ? st.basic : e.salary, comps = st ? st.components : [];
    const newBasic = pct !== null ? basic0 * (1 + pct / 100) : basic0 + amt, newComps = pct !== null ? comps.map(c => ({ ...c, amount: round2(c.amount * (1 + pct / 100)) })) : comps;
    if (!(newBasic > 0)) continue; const gross = round2(newBasic + newComps.reduce((a, c) => a + c.amount, 0));
    preview.push({ code: e.code, name: e.name, from: round2(st ? st.gross : e.salary), to: gross });
    if (!b.dry_run) { addRevision(id, { effective_from: from, basic: newBasic, components: newComps, note: b.note ? String(b.note).slice(0, 200) : `Increment ${pct !== null ? pct + '%' : 'Rs ' + amt}` }, req.user); changed++; }
  }
  res.json({ changed, dry_run: !!b.dry_run, preview: preview.slice(0, 300), total: preview.length });
});
// Tax / EOBI / social security flags and bank details of one employee.
payrollxRouter.put('/payroll/employee/:id', (req, res) => {
  const e = empRow(req.params.id); if (!e) return fail(res, 'No such employee', 404); const b = req.body ?? {}, set = [], vals = [];
  const text = (k, max) => { if (k in b) { set.push(k); vals.push(b[k] === '' || b[k] === null ? null : String(b[k]).trim().slice(0, max)); } };
  text('bank_name', 60); text('bank_account', 40); text('bank_title', 80); text('cnic', 20); text('eobi_no', 30);
  if ('tax_exempt' in b) { set.push('tax_exempt'); vals.push(b.tax_exempt ? 1 : 0); } if ('eobi' in b) { set.push('eobi'); vals.push(b.eobi ? 1 : 0); }
  if ('social_scheme' in b) { if (b.social_scheme && !['SESSI', 'PESSI'].includes(b.social_scheme)) return fail(res, 'Social security is SESSI, PESSI or none'); set.push('social_scheme'); vals.push(b.social_scheme || null); }
  if (b.cnic && !/^\d{5}-?\d{7}-?\d$/.test(String(b.cnic).trim())) return fail(res, 'CNIC looks wrong (example 35202-1234567-1)');
  if (b.bank_account && !/^[A-Za-z0-9 -]{6,40}$/.test(String(b.bank_account).trim())) return fail(res, 'Account number / IBAN looks wrong');
  if (set.length) db.prepare(`UPDATE employees SET ${set.map(k => k + '=?')} WHERE id=?`).run(...vals, e.id); res.json({ ok: true });
});

// ---------- tax slabs and contribution rates ----------
const RATE_KEYS = ['tax_enabled', 'tax_surcharge_over', 'tax_surcharge_pct', 'eobi_wage', 'eobi_rate_employee', 'eobi_rate_employer', 'sessi_rate', 'sessi_ceiling', 'pessi_rate', 'pessi_ceiling', 'payroll_approval'];
payrollxRouter.get('/payroll/rates', (_q, res) => { const S = getSettings(); res.json({ settings: Object.fromEntries(RATE_KEYS.map(k => [k, S[k]])), slabs: slabs(), tax_year: db.prepare("SELECT value FROM payroll_meta WHERE key='tax_year'").get()?.value ?? '' }); });
payrollxRouter.put('/payroll/rates', (req, res) => {
  if (scoped(res)) return; const b = req.body ?? {};
  if (b.slabs !== undefined) {
    const sl = b.slabs; if (!Array.isArray(sl) || !sl.length || sl.length > 20) return fail(res, 'Give 1 to 20 tax slabs');
    let prev = 0; const rows = [];
    for (const [i, x] of sl.entries()) {
      const lower = Number(x.lower), upper = x.upper === null || x.upper === '' || x.upper === undefined ? null : Number(x.upper), fixed = Number(x.fixed || 0), rate = Number(x.rate || 0);
      if (!(lower >= 0) || !(fixed >= 0) || !(rate >= 0 && rate <= 100)) return fail(res, `Slab ${i + 1}: the numbers look wrong`);
      if (i === 0 && lower !== 0) return fail(res, 'The first slab must start at 0'); if (i > 0 && lower !== prev) return fail(res, `Slab ${i + 1} must start where slab ${i} ends (${prev})`);
      if (upper === null && i !== sl.length - 1) return fail(res, 'Only the last slab can have no upper limit'); if (upper !== null && !(upper > lower)) return fail(res, `Slab ${i + 1}: the upper limit must be above the lower limit`);
      if (upper === null && i === sl.length - 1) { /* open-ended last slab */ } else if (i === sl.length - 1) return fail(res, 'The last slab must have no upper limit');
      rows.push([lower, upper, fixed, rate]); prev = upper;
    }
    db.exec('BEGIN'); try { db.prepare('DELETE FROM tax_slabs').run(); for (const r of rows) db.prepare('INSERT INTO tax_slabs(lower, upper, fixed, rate) VALUES(?,?,?,?)').run(...r); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (b.tax_year !== undefined) db.prepare("INSERT INTO payroll_meta(key, value) VALUES('tax_year', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(b.tax_year).slice(0, 60));
  for (const k of RATE_KEYS) if (k in (b.settings ?? {}) && !(Number(b.settings[k]) >= 0)) return fail(res, `${k.replace(/_/g, ' ')} must be a number, 0 or more`);
  setSettings(Object.fromEntries(Object.entries(b.settings ?? {}).filter(([k]) => RATE_KEYS.includes(k)))); res.json({ ok: true });
});
// Try the slabs: what tax does a given monthly or annual income attract?
payrollxRouter.get('/payroll/tax-calc', (req, res) => { const S = getSettings(), annual = req.query.annual ? Number(req.query.annual) : Number(req.query.monthly) * 12; if (!(annual >= 0)) return fail(res, 'Give monthly= or annual='); res.json({ annual_income: annual, annual_tax: round2(annualTax(annual, S)), monthly_tax: round2(annualTax(annual, S) / 12) }); });

// ---------- approval ----------
const hashOf = (rows) => createHash('sha256').update(JSON.stringify(rows.map(r => [r.code, r.net, r.tax, r.eobi_employee, r.gross]))).digest('hex');
export const approvalOf = (m) => db.prepare('SELECT * FROM payroll_approvals WHERE month=?').get(m) ?? null;
export function approvalState(m) { // for the screen: is the approval still valid for the current numbers?
  const a = approvalOf(m); if (!a) return { status: 'none' };
  const stale = a.status === 'approved' && a.hash !== hashOf(payroll(m)); return { ...a, hash: undefined, status: stale ? 'stale' : a.status };
}
export const approvalOk = (m) => !getSettings().payroll_approval || (approvalOf(m)?.status === 'approved' && approvalOf(m).hash === hashOf(payroll(m)));
payrollxRouter.post('/payroll/submit', (req, res) => {
  if (scoped(res)) return; const m = req.body?.month; if (!MONTH.test(m ?? '')) return fail(res, 'month=YYYY-MM required');
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month=?').get(m)) return fail(res, 'This month is already finalized'); if (!payroll(m).length) return fail(res, 'No payroll data for this month');
  db.prepare("INSERT INTO payroll_approvals(month, status, submitted_by, submitted_at, decided_by, decided_at, note, hash) VALUES(?, 'submitted', ?, ?, NULL, NULL, ?, NULL) ON CONFLICT(month) DO UPDATE SET status='submitted', submitted_by=excluded.submitted_by, submitted_at=excluded.submitted_at, decided_by=NULL, decided_at=NULL, note=excluded.note, hash=NULL").run(m, req.user, nowStr(), String(req.body?.note ?? '').slice(0, 200) || null);
  res.json({ ok: true });
});
payrollxRouter.post('/payroll/approve', (req, res) => {
  if (scoped(res)) return; if (req.role !== 'admin') return fail(res, 'Only an admin can approve payroll', 403);
  const m = req.body?.month; const a = approvalOf(m); if (!a || a.status !== 'submitted') return fail(res, 'Nothing is waiting for approval for this month');
  db.prepare("UPDATE payroll_approvals SET status='approved', decided_by=?, decided_at=?, hash=?, note=COALESCE(?, note) WHERE month=?").run(req.user, nowStr(), hashOf(payroll(m)), req.body?.note ? String(req.body.note).slice(0, 200) : null, m); res.json({ ok: true });
});
payrollxRouter.post('/payroll/reject', (req, res) => {
  if (scoped(res)) return; if (req.role !== 'admin') return fail(res, 'Only an admin can reject payroll', 403);
  const m = req.body?.month; const a = approvalOf(m); if (!a || !['submitted', 'approved'].includes(a.status)) return fail(res, 'Nothing to reject for this month');
  db.prepare("UPDATE payroll_approvals SET status='rejected', decided_by=?, decided_at=?, note=?, hash=NULL WHERE month=?").run(req.user, nowStr(), String(req.body?.note ?? '').slice(0, 200) || null, m); res.json({ ok: true });
});

// ---------- history ----------
payrollxRouter.get('/payroll/history', (_q, res) => {
  const ok = (() => { const sc = scopeClause('e'); return sc.sql ? new Set(db.prepare(`SELECT e.code FROM employees e WHERE 1=1${sc.sql}`).all(...sc.args).map(r => r.code)) : null; })();
  res.json(db.prepare('SELECT month, status, finalized_at, paid_at, data FROM payroll_runs ORDER BY month DESC').all().map(r => {
    const rows = JSON.parse(r.data).filter(x => !ok || ok.has(x.code)), sum = (k) => round2(rows.reduce((a, x) => a + (x[k] ?? 0), 0));
    return { month: r.month, status: r.status, finalized_at: r.finalized_at, paid_at: r.paid_at, employees: rows.length, gross: sum('gross'), base: sum('base'), deductions: sum('deduction'), overtime_pay: sum('overtime_pay'), tax: sum('tax'), eobi_employee: sum('eobi_employee'), eobi_employer: sum('eobi_employer'), social_employer: sum('social_employer'), net: sum('net'), approval: approvalOf(r.month)?.decided_by ?? null };
  }));
});
payrollxRouter.get('/payroll/employee-history/:id', (req, res) => {
  const e = empRow(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  res.json({ employee: e, months: db.prepare('SELECT month, status, paid_at, data FROM payroll_runs ORDER BY month DESC LIMIT 60').all().map(r => { const row = JSON.parse(r.data).find(x => x.code === e.code); return row ? { month: r.month, status: r.status, paid_at: r.paid_at, ...row } : null; }).filter(Boolean) });
});

// ---------- bank transfer file ----------
// One line per person to pay: account title, bank, account/IBAN, amount. People without bank details are listed so they can be paid another way.
payrollxRouter.get('/payroll/bank-file', (req, res) => {
  const m = req.query.month; if (!MONTH.test(m ?? '')) return fail(res, 'month=YYYY-MM required');
  const run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(m); if (!run && !req.query.draft) return fail(res, 'Finalize the month first, so the amounts are fixed (or add draft=1 to see a draft file)');
  const sc = scopeClause('e'), ok = sc.sql ? new Set(db.prepare(`SELECT e.code FROM employees e WHERE 1=1${sc.sql}`).all(...sc.args).map(r => r.code)) : null;
  const rows = (run ? JSON.parse(run.data) : payroll(m)).filter(r => !ok || ok.has(r.code)), emp = new Map(db.prepare('SELECT code, name, bank_name, bank_account, bank_title FROM employees').all().map(e => [e.code, e]));
  const lines = [], skipped = []; let total = 0;
  for (const r of rows) {
    const e = emp.get(r.code), amount = round2(r.net); if (!(amount > 0)) { skipped.push({ code: r.code, name: r.name, reason: 'Nothing to pay' }); continue; }
    if (!e?.bank_account) { skipped.push({ code: r.code, name: r.name, reason: 'No bank account on file', amount }); continue; }
    total += amount; lines.push({ code: r.code, title: e.bank_title || e.name, bank: e.bank_name ?? '', account: e.bank_account, amount: amount.toFixed(2), narration: `Salary ${m}` });
  }
  const keys = req.query.format === 'ibft' ? ['title', 'bank', 'account', 'amount', 'narration'] : ['code', 'title', 'bank', 'account', 'amount', 'narration'];
  res.json({ month: m, count: lines.length, total: round2(total), skipped, csv: toCsv(keys, lines), status: run?.status ?? 'draft' });
});

export function startPayroll() { syncSalaries(); setInterval(() => { if (bgEnabled('payroll')) syncSalaries(); }, 3600000).unref(); } // Background Task Setting can switch the hourly salary sync off
