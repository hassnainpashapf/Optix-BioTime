// Payroll: Loan, Salary Advance, Reimbursement. Approving one writes the monthly adjustments the payroll run already reads (payroll_items):
//   loan -> a "deduction" each month for the installments, advance -> an "advance" in its month, reimbursement -> an "allowance" in its month.
// Rejecting or deleting removes what it wrote. Months that are already finalized are left alone and reported.
import express from 'express';
import { db } from './db.js';
import { scopeClause } from './rbac.js';
export const payExtraRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const KINDS = ['loan', 'advance', 'reimbursement'], MONTH = /^\d{4}-\d\d$/;
db.exec(`CREATE TABLE IF NOT EXISTS pay_extras(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, amount REAL NOT NULL, month TEXT NOT NULL,
  installments INTEGER DEFAULT 1, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')), decided TEXT);`);
const addMonth = (m, n) => { const [y, mo] = m.split('-').map(Number), d = new Date(y, mo - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const tag = (id) => `[extra:${id}]`;
const finalized = (m) => !!db.prepare('SELECT 1 FROM payroll_runs WHERE month=?').get(m);
function plan(x) {
  const n = x.kind === 'loan' ? Math.max(1, x.installments || 1) : 1, each = Math.round(x.amount / n * 100) / 100, out = [];
  for (let i = 0; i < n; i++) out.push({ month: addMonth(x.month, i), amount: i === n - 1 ? Math.round((x.amount - each * (n - 1)) * 100) / 100 : each, i: i + 1, n });
  return out;
}
function writeItems(x) {
  const kind = { loan: 'deduction', advance: 'advance', reimbursement: 'allowance' }[x.kind], skipped = [];
  for (const p of plan(x)) {
    if (finalized(p.month)) { skipped.push(p.month); continue; }
    const label = x.kind === 'loan' ? `Loan installment ${p.i}/${p.n}` : x.kind === 'advance' ? 'Salary advance' : 'Reimbursement';
    db.prepare('INSERT INTO payroll_items(employee_id, month, kind, amount, note) VALUES(?,?,?,?,?)').run(x.employee_id, p.month, kind, p.amount, `${label} ${tag(x.id)}`);
  }
  return skipped;
}
const clearItems = (id) => db.prepare("DELETE FROM payroll_items WHERE note LIKE ? AND month NOT IN (SELECT month FROM payroll_runs)").run(`%${tag(id)}`).changes;
const list = (kind) => { const sc = scopeClause('e'); return db.prepare(`SELECT x.*, e.code, e.name, d.name AS department FROM pay_extras x JOIN employees e ON e.id=x.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE x.kind=?${sc.sql} ORDER BY x.id DESC LIMIT 1000`).all(kind, ...sc.args); };
payExtraRouter.get('/payroll/extras', (req, res) => { if (!KINDS.includes(req.query.kind)) return fail(res, 'kind must be loan, advance or reimbursement'); res.json(list(req.query.kind).map(x => ({ ...x, monthly: x.kind === 'loan' ? Math.round(x.amount / Math.max(1, x.installments) * 100) / 100 : null }))); });
payExtraRouter.post('/payroll/extras', (req, res) => {
  const b = req.body ?? {}, sc = scopeClause('e');
  if (!KINDS.includes(b.kind)) return fail(res, 'Unknown kind'); if (!(Number(b.amount) > 0)) return fail(res, 'Amount must be more than 0'); if (!MONTH.test(b.month ?? '')) return fail(res, 'Month is required (YYYY-MM)');
  const inst = b.kind === 'loan' ? Number(b.installments) || 1 : 1; if (!(Number.isInteger(inst) && inst >= 1 && inst <= 60)) return fail(res, 'Installments must be 1 to 60');
  if (!db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${sc.sql}`).get(Number(b.employee_id), ...sc.args)) return fail(res, 'Choose the employee', 404);
  res.json({ id: Number(db.prepare('INSERT INTO pay_extras(kind, employee_id, amount, month, installments, reason, created_by) VALUES(?,?,?,?,?,?,?)').run(b.kind, Number(b.employee_id), Number(b.amount), b.month, inst, String(b.reason ?? '').slice(0, 200) || null, req.user).lastInsertRowid) });
});
payExtraRouter.post('/payroll/extras/:id/decide', (req, res) => {
  const x = db.prepare('SELECT * FROM pay_extras WHERE id=?').get(req.params.id); if (!x) return fail(res, 'Not found', 404);
  const want = req.body?.approve ? 'approved' : 'rejected'; if (x.status === want) return fail(res, `Already ${want}`);
  const removed = clearItems(x.id); let skipped = [];
  if (want === 'approved') skipped = writeItems(x);
  db.prepare('UPDATE pay_extras SET status=?, decided=? WHERE id=?').run(want, new Date().toLocaleString('sv'), x.id);
  res.json({ ok: true, status: want, removed, skipped_finalized_months: skipped });
});
payExtraRouter.delete('/payroll/extras/:id', (req, res) => {
  const x = db.prepare('SELECT * FROM pay_extras WHERE id=?').get(req.params.id); if (!x) return fail(res, 'Not found', 404);
  clearItems(x.id); db.prepare('DELETE FROM pay_extras WHERE id=?').run(x.id); res.json({ ok: true });
});
