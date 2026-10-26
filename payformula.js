// Payroll > Formula (Overtime, Exception, Leave, Increment, Deduction) and Payroll > Extra Funds (Extra Increase, Extra Deduction).
// A formula is text such as "Basic Salary / Schedule Days / 8 * Normal OT * 1.5" built with the calculator; it is worked out per employee each month.
import express from 'express';
import { db } from './db.js';
import { scopeClause } from './rbac.js';
import { addRevision, firstOf } from './paycalc.js';

export const payformulaRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
db.exec(`CREATE TABLE IF NOT EXISTS pay_formulas(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, pay_code TEXT NOT NULL, formula TEXT NOT NULL, remarks TEXT, UNIQUE(kind, name))`);
addCol('payroll_items', 'issue_date', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS pay_special(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, remarks TEXT);
CREATE TABLE IF NOT EXISTS pay_exemptions(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, kind TEXT NOT NULL, amount REAL NOT NULL, year INTEGER NOT NULL, issued TEXT, remarks TEXT, created TEXT DEFAULT (datetime('now','localtime')));`);
export const KINDS = ['overtime', 'exception', 'leave', 'increment', 'deduction'];

// The names the calculator offers; each becomes a number for the employee and month.
export const VARS = ['Basic Salary', 'Schedule Days', 'Schedule Period', 'Duty Duration', 'Worked Hrs', 'Full Attendance', 'Full Attendance Days', 'Full Attendance Hours', 'Late In', 'Early Out', 'Absence',
  'Annual Leave', 'Sick Leave', 'Casual Leave', 'Maternity Leave', 'Compassionate Leave', 'Business Trip', 'Compensatory', 'Compensatory Leave', 'Normal OT', 'Weekend OT', 'Holiday OT', 'OT1', 'OT2', 'OT3'];
const BY_LEN = [...VARS].sort((a, b) => b.length - a.length);

function tokenize(src) {
  const out = []; let i = 0; const s = String(src ?? '').replace(/²/g, '^2');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = s.slice(i).match(/^(\d+(\.\d*)?|\.\d+)/);
    if (num) { out.push({ t: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=') { out.push({ t: 'o', v: two }); i += 2; continue; }
    if ('+-*/^()<>'.includes(c)) { out.push({ t: 'o', v: c }); i++; continue; }
    const v = BY_LEN.find(n => s.slice(i, i + n.length).toLowerCase() === n.toLowerCase() && !/[A-Za-z0-9]/.test(s[i + n.length] ?? ''));
    if (v) { out.push({ t: 'v', v }); i += v.length; continue; }
    throw new Error(`Unknown name near "${s.slice(i, i + 12).trim()}"`);
  }
  return out;
}
// Returns { ok, error, run(vars) }. Division by zero gives 0; a comparison gives 1 or 0.
export function compile(text) {
  try {
    const tk = tokenize(text); let p = 0;
    if (!tk.length) throw new Error('Write a formula');
    const peek = () => tk[p], eat = (v) => { if (tk[p]?.t === 'o' && tk[p].v === v) { p++; return true; } return false; };
    const prim = () => {
      const x = tk[p++]; if (!x) throw new Error('The formula ends too early');
      if (x.t === 'n') return () => x.v;
      if (x.t === 'v') return (vars) => Number(vars[x.v]) || 0;
      if (x.v === '(') { const e = cmp(); if (!eat(')')) throw new Error('A bracket is not closed'); return e; }
      if (x.v === '-') { const e = unary(); return (v) => -e(v); }
      throw new Error(`Unexpected "${x.v}"`);
    };
    const unary = () => (eat('-') ? ((e) => (v) => -e(v))(unary()) : prim());
    const pow = () => { const a = unary(); return eat('^') ? ((b) => (v) => Math.pow(a(v), b(v)))(unary()) : a; };
    const mul = () => { let a = pow(); for (;;) { if (eat('*')) { const l = a, b = pow(); a = (v) => l(v) * b(v); } else if (eat('/')) { const l = a, b = pow(); a = (v) => { const d = b(v); return d ? l(v) / d : 0; }; } else return a; } };
    const add = () => { let a = mul(); for (;;) { if (eat('+')) { const l = a, b = mul(); a = (v) => l(v) + b(v); } else if (eat('-')) { const l = a, b = mul(); a = (v) => l(v) - b(v); } else return a; } };
    const cmp = () => { const a = add(), o = peek(); if (o?.t === 'o' && ['<', '>', '<=', '>='].includes(o.v)) { p++; const b = add(); return (v) => ({ '<': a(v) < b(v), '>': a(v) > b(v), '<=': a(v) <= b(v), '>=': a(v) >= b(v) }[o.v] ? 1 : 0); } return a; };
    const f = cmp(); if (p < tk.length) throw new Error(`Unexpected "${tk[p].v}"`);
    return { ok: true, run: (vars) => { const r = f(vars); return Number.isFinite(r) ? r : 0; } };
  } catch (e) { return { ok: false, error: e.message }; }
}
// For the payroll run: every formula, ready to evaluate, grouped by kind.
export function loadFormulas() {
  const g = Object.fromEntries(KINDS.map(k => [k, []]));
  for (const r of db.prepare('SELECT * FROM pay_formulas ORDER BY id').all()) { const c = compile(r.formula); if (c.ok && g[r.kind]) g[r.kind].push({ ...r, run: c.run }); }
  return g;
}

payformulaRouter.get('/payroll/formula-vars', (_q, res) => res.json(VARS));
payformulaRouter.post('/payroll/formulas/check', (req, res) => {
  const c = compile(req.body?.formula); if (!c.ok) return res.json({ ok: false, error: c.error });
  const sample = Object.fromEntries(VARS.map(v => [v, 1])); res.json({ ok: true, message: 'The formula is correct', sample: Math.round(c.run(sample) * 100) / 100 });
});
payformulaRouter.get('/payroll/formulas', (req, res) => res.json(db.prepare('SELECT * FROM pay_formulas WHERE kind=? ORDER BY id').all(KINDS.includes(req.query.kind) ? req.query.kind : 'overtime')));
function body(req, id) {
  const b = req.body ?? {}, kind = b.kind, name = String(b.name ?? '').trim().slice(0, 60), code = String(b.pay_code ?? '').trim(), formula = String(b.formula ?? '').trim().slice(0, 500);
  if (!KINDS.includes(kind)) return { error: 'Unknown formula type' }; if (!name) return { error: 'Name required' };
  const needsCode = ['overtime', 'exception', 'leave'].includes(kind); // Increment and Deduction formulas have no pay code
  if (needsCode && !db.prepare('SELECT 1 FROM pay_codes WHERE code=?').get(code)) return { error: 'Choose a pay code' };
  const c = compile(formula); if (!c.ok) return { error: 'Formula: ' + c.error };
  if (db.prepare('SELECT 1 FROM pay_formulas WHERE kind=? AND name=? AND id IS NOT ?').get(kind, name, id ?? null)) return { error: 'A formula with this name already exists' };
  return { kind, name, code: needsCode ? code : '', formula, remarks: String(b.remarks ?? '').trim().slice(0, 300) || null };
}
payformulaRouter.post('/payroll/formulas', (req, res) => { const o = body(req); if (o.error) return fail(res, o.error); res.json({ id: Number(db.prepare('INSERT INTO pay_formulas(kind,name,pay_code,formula,remarks) VALUES(?,?,?,?,?)').run(o.kind, o.name, o.code, o.formula, o.remarks).lastInsertRowid) }); });
payformulaRouter.put('/payroll/formulas/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM pay_formulas WHERE id=?').get(req.params.id); if (!old) return fail(res, 'Not found', 404);
  const o = body({ body: { ...old, pay_code: old.pay_code, ...req.body, kind: old.kind } }, old.id); if (o.error) return fail(res, o.error);
  db.prepare('UPDATE pay_formulas SET name=?, pay_code=?, formula=?, remarks=? WHERE id=?').run(o.name, o.code, o.formula, o.remarks, old.id); res.json({ ok: true });
});
payformulaRouter.post('/payroll/formulas/delete', (req, res) => { let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) { n += Number(db.prepare('DELETE FROM pay_formulas WHERE id=?').run(id).changes); for (const c of ['f_deduction', 'f_exception', 'f_increment', 'f_leave', 'f_overtime']) db.prepare(`UPDATE emp_salary SET ${c}=NULL WHERE ${c}=?`).run(id); } res.json({ deleted: n }); }); // a deleted formula leaves every salary structure that used it

// ---- Extra Funds: one amount for one or many employees, on an issue date; it is added to (or taken from) the salary of that month ----
const EXTRA_KIND = { increase: ['bonus', 'allowance'], deduction: ['deduction'] };
payformulaRouter.get('/payroll/extra', (req, res) => {
  const ks = EXTRA_KIND[req.query.kind]; if (!ks) return fail(res, 'Choose increase or deduction'); const sc = scopeClause('e');
  res.json(db.prepare(`SELECT i.id, e.code, e.name, e.last_name, d.name AS dept, i.amount, COALESCE(i.issue_date, i.month || '-01') AS issue_date, i.note AS remarks FROM payroll_items i JOIN employees e ON e.id=i.employee_id LEFT JOIN departments d ON d.id=e.department_id
    WHERE i.kind IN (${ks.map(() => '?')})${sc.sql} ORDER BY COALESCE(i.issue_date, i.month || '-01') DESC, i.id DESC LIMIT 5000`).all(...ks, ...sc.args));
});
payformulaRouter.post('/payroll/extra', (req, res) => {
  const b = req.body ?? {}, ks = EXTRA_KIND[b.kind]; if (!ks) return fail(res, 'Choose increase or deduction');
  const ids = [...new Set((b.employee_ids ?? []).map(Number).filter(Number.isInteger))]; if (!ids.length) return fail(res, 'Choose at least one employee');
  const amount = Number(b.amount); if (!(amount > 0 && amount < 1e9)) return fail(res, 'Enter an amount above zero');
  const d = String(b.issue_date ?? '').slice(0, 10); if (!/^\d{4}-\d\d-\d\d$/.test(d)) return fail(res, 'Choose the issue time');
  const ins = db.prepare('INSERT INTO payroll_items(employee_id, month, kind, amount, note, issue_date) VALUES(?,?,?,?,?,?)'), sc = scopeClause('e'); let n = 0;
  db.exec('BEGIN'); try { for (const id of ids) { if (!db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${sc.sql}`).get(id, ...sc.args)) continue; ins.run(id, d.slice(0, 7), ks[0], amount, String(b.remarks ?? '').trim().slice(0, 300) || null, d); n++; } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ added: n });
});
payformulaRouter.post('/payroll/extra/delete', (req, res) => { let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) n += Number(db.prepare("DELETE FROM payroll_items WHERE id=? AND kind IN ('bonus','allowance','deduction')").run(id).changes); res.json({ deleted: n }); });

// ---- Payroll Structure > Salary Structure: basic salary from a date, and which formulas apply to the person ----
const FK = { deduction: 'f_deduction', exception: 'f_exception', increment: 'f_increment', leave: 'f_leave', overtime: 'f_overtime' };
payformulaRouter.get('/payroll/structure', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT s.id, s.employee_id, e.code, e.name, e.last_name, d.name AS dept, s.basic, s.effective_from, s.created, s.note AS remarks, s.f_deduction, s.f_exception, s.f_increment, s.f_leave, s.f_overtime,
    (SELECT name FROM pay_formulas WHERE id=s.f_deduction) AS deduction_formula, (SELECT name FROM pay_formulas WHERE id=s.f_exception) AS exception_formula, (SELECT name FROM pay_formulas WHERE id=s.f_increment) AS increment_formula,
    (SELECT name FROM pay_formulas WHERE id=s.f_leave) AS leave_formula, (SELECT name FROM pay_formulas WHERE id=s.f_overtime) AS overtime_formula
    FROM emp_salary s JOIN employees e ON e.id=s.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE 1=1${sc.sql} ORDER BY s.effective_from DESC, s.id DESC LIMIT 5000`).all(...sc.args));
});
function structBody(b) {
  const basic = Number(b.basic); if (!(basic > 0 && basic < 1e9)) return { error: 'Basic Salary must be a number above 0' };
  const d = String(b.effective_date ?? '').slice(0, 10); if (!/^\d{4}-\d\d-\d\d$/.test(d)) return { error: 'Choose the Effective Date' };
  const f = {}; for (const [k, col] of Object.entries(FK)) { const id = b[col] ? Number(b[col]) : null; if (id && !db.prepare('SELECT 1 FROM pay_formulas WHERE id=? AND kind=?').get(id, k)) return { error: `Unknown ${k} formula` }; f[col] = id; }
  return { basic, d, f, note: String(b.remarks ?? '').trim().slice(0, 200) || null };
}
payformulaRouter.post('/payroll/structure', (req, res) => {
  const o = structBody(req.body ?? {}); if (o.error) return fail(res, o.error);
  const ids = [...new Set((req.body?.employee_ids ?? []).map(Number).filter(Number.isInteger))]; if (!ids.length) return fail(res, 'Choose at least one employee');
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(o.d.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized. Reopen it first, or choose a later date.');
  const sc = scopeClause('e'); let n = 0;
  for (const id of ids) { if (!db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${sc.sql}`).get(id, ...sc.args)) continue; addRevision(id, { effective_from: o.d, basic: o.basic, note: o.note, formulas: o.f }, req.user); n++; }
  res.json({ added: n });
});
payformulaRouter.put('/payroll/structure/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM emp_salary WHERE id=?').get(req.params.id); if (!r) return fail(res, 'Not found', 404);
  const o = structBody({ basic: r.basic, effective_date: r.effective_from, remarks: r.note, ...Object.fromEntries(Object.values(FK).map(c => [c, r[c]])), ...req.body }); if (o.error) return fail(res, o.error);
  if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(o.d.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized');
  addRevision(r.employee_id, { effective_from: o.d, basic: o.basic, components: JSON.parse(r.components || '[]'), note: o.note, formulas: o.f }, req.user); res.json({ ok: true });
});
payformulaRouter.post('/payroll/structure/delete', (req, res) => {
  let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) {
    const r = db.prepare('SELECT * FROM emp_salary WHERE id=?').get(id); if (!r || db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(r.effective_from.slice(0, 7))) continue;
    db.prepare('DELETE FROM emp_salary WHERE id=?').run(id); n++;
  } res.json({ deleted: n });
});

// ---- Employee Profile: how and where each person is paid ----
payformulaRouter.get('/payroll/profiles', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT e.id, e.code, e.name, e.last_name, d.name AS dept, COALESCE(e.pay_period,'Monthly') AS pay_period, COALESCE(e.pay_type,'Cash') AS pay_type, e.bank_name, e.bank_account, e.bank_title, e.agent_id, e.agent_account
    FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql} ORDER BY CAST(e.code AS INTEGER), e.code LIMIT 5000`).all(...sc.args));
});

// ---- Special Payment (named kinds of payment) and Employee Expense Exemption (an amount of the year's income that is not taxed) ----
payformulaRouter.get('/payroll/special', (_q, res) => res.json(db.prepare('SELECT * FROM pay_special ORDER BY name').all()));
payformulaRouter.post('/payroll/special', (req, res) => { const n = String(req.body?.name ?? '').trim().slice(0, 60); if (!n) return fail(res, 'Special Payment is required'); try { res.json({ id: Number(db.prepare('INSERT INTO pay_special(name, remarks) VALUES(?,?)').run(n, String(req.body?.remarks ?? '').trim().slice(0, 200) || null).lastInsertRowid) }); } catch { fail(res, 'This special payment already exists'); } });
payformulaRouter.put('/payroll/special/:id', (req, res) => { const n = String(req.body?.name ?? '').trim().slice(0, 60); if (!n) return fail(res, 'Special Payment is required'); try { db.prepare('UPDATE pay_special SET name=?, remarks=? WHERE id=?').run(n, String(req.body?.remarks ?? '').trim().slice(0, 200) || null, req.params.id); res.json({ ok: true }); } catch { fail(res, 'This special payment already exists'); } });
payformulaRouter.post('/payroll/special/delete', (req, res) => { let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) n += Number(db.prepare('DELETE FROM pay_special WHERE id=?').run(id).changes); res.json({ deleted: n }); });
payformulaRouter.get('/payroll/exemptions', (_q, res) => { const sc = scopeClause('e'); res.json(db.prepare(`SELECT x.id, e.code, e.name, e.last_name, d.name AS dept, x.kind, x.amount, x.year, COALESCE(x.issued, x.created) AS issued, x.remarks FROM pay_exemptions x JOIN employees e ON e.id=x.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE 1=1${sc.sql} ORDER BY x.id DESC LIMIT 5000`).all(...sc.args)); });
payformulaRouter.post('/payroll/exemptions', (req, res) => {
  const b = req.body ?? {}, ids = [...new Set((b.employee_ids ?? []).map(Number).filter(Number.isInteger))]; if (!ids.length) return fail(res, 'Choose at least one employee');
  const kind = String(b.kind ?? '').trim().slice(0, 60); if (!kind) return fail(res, 'Expense exemption is required'); const amount = Number(b.amount); if (!(amount > 0 && amount < 1e9)) return fail(res, 'Enter an amount above zero');
  const year = Number(b.year); if (!(Number.isInteger(year) && year >= 2000 && year <= 2100)) return fail(res, 'Enter the year, for example 2026'); const issued = String(b.issued ?? '').slice(0, 10) || null; if (issued && !/^\d{4}-\d\d-\d\d$/.test(issued)) return fail(res, 'Issued Time looks like 2026-10-20');
  const sc = scopeClause('e'); let n = 0;
  for (const id of ids) { if (!db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${sc.sql}`).get(id, ...sc.args)) continue; db.prepare('INSERT INTO pay_exemptions(employee_id, kind, amount, year, issued, remarks) VALUES(?,?,?,?,?,?)').run(id, kind, amount, year, issued, String(b.remarks ?? '').trim().slice(0, 300) || null); n++; }
  res.json({ added: n });
});
payformulaRouter.post('/payroll/exemptions/delete', (req, res) => { let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) n += Number(db.prepare('DELETE FROM pay_exemptions WHERE id=?').run(id).changes); res.json({ deleted: n }); });
