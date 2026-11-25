import express from 'express';
import { db } from './db.js';
import { dateStr, addDays } from './dates.js';
import { scopeClause, inScope } from './rbac.js';
import { notify } from './notify.js';
import { salaryMap, addRevision, round2 } from './paycalc.js';

export const hrxRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const DATE = /^\d{4}-\d\d-\d\d$/;
export const CONTRACT_TYPES = ['Permanent', 'Probation', 'Fixed-term', 'Contract', 'Internship', 'Part-time', 'Daily wage'];
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// ---------- contracts ----------
function cleanContract(b, partial) {
  const o = {};
  if (!partial || 'type' in b) { if (!CONTRACT_TYPES.includes(b.type)) return { error: `Type must be one of: ${CONTRACT_TYPES.join(', ')}` }; o.type = b.type; }
  for (const k of ['start_date', 'end_date', 'probation_end']) if (k in b || (!partial && k === 'start_date')) { const v = b[k] || null; if (k === 'start_date' && !v) return { error: 'Start date required' }; if (v && !DATE.test(v)) return { error: `${k.replace(/_/g, ' ')} must be YYYY-MM-DD` }; o[k] = v; }
  if ('notice_days' in b) { const n = b.notice_days === '' || b.notice_days === null ? null : Number(b.notice_days); if (n !== null && !(Number.isInteger(n) && n >= 0 && n <= 365)) return { error: 'Notice period is a number of days from 0 to 365' }; o.notice_days = n; }
  if ('note' in b) o.note = String(b.note ?? '').slice(0, 300) || null;
  return { o };
}
const withState = (r, today = dateStr(new Date())) => {
  const left = r.end_date ? daysBetween(today, r.end_date) : null;
  const state = r.status === 'renewed' ? 'renewed' : r.status === 'ended' ? 'ended' : left !== null && left < 0 ? 'expired' : left !== null && left <= 30 ? 'expiring' : 'active';
  const probation_left = r.probation_end && r.status === 'active' ? daysBetween(today, r.probation_end) : null;
  return { ...r, state, days_left: left, probation_left };
};
const SEL = `SELECT c.*, e.code, e.name AS employee, e.active, d.name AS dept FROM emp_contracts c JOIN employees e ON e.id=c.employee_id LEFT JOIN departments d ON d.id=e.department_id`;
hrxRouter.get('/contracts', (req, res) => {
  const sc = scopeClause('e'), want = req.query.state || 'all';
  let rows = db.prepare(`${SEL} WHERE 1=1${sc.sql} ORDER BY COALESCE(c.end_date,'9999-12-31'), c.id DESC`).all(...sc.args).map(r => withState(r));
  if (want === 'attention') rows = rows.filter(r => ['expiring', 'expired'].includes(r.state) && r.active || (r.probation_left !== null && r.probation_left <= 30 && r.probation_left >= -30 && r.active));
  else if (want !== 'all') rows = rows.filter(r => r.state === want);
  res.json(rows.slice(0, 1000));
});
hrxRouter.get('/employees/:id/contracts', (req, res) => {
  const r = db.prepare('SELECT 1 FROM employees WHERE id=?').get(req.params.id); if (!r) return fail(res, 'No such employee', 404);
  res.json(db.prepare(`${SEL} WHERE c.employee_id=? ORDER BY c.start_date DESC, c.id DESC`).all(req.params.id).map(r => withState(r)));
});
hrxRouter.post('/employees/:id/contracts', (req, res) => {
  const e = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  const { o, error } = cleanContract(req.body ?? {}, false); if (error) return fail(res, error);
  if (o.end_date && o.end_date < o.start_date) return fail(res, 'The end date is before the start date'); if (o.probation_end && o.probation_end < o.start_date) return fail(res, 'Probation cannot end before the contract starts');
  if (o.type === 'Permanent' && o.end_date) return fail(res, 'A permanent contract has no end date');
  if (o.type !== 'Permanent' && o.type !== 'Probation' && !o.end_date && ['Fixed-term', 'Contract', 'Internship'].includes(o.type)) return fail(res, `A ${o.type.toLowerCase()} needs an end date`);
  db.exec('BEGIN'); try { // a new contract replaces the one in force: the old one is marked renewed
    db.prepare("UPDATE emp_contracts SET status='renewed', end_date=COALESCE(end_date, ?) WHERE employee_id=? AND status='active'").run(addDays(o.start_date, -1) < o.start_date ? addDays(o.start_date, -1) : o.start_date, e.id);
    const c = Object.keys(o); const id = Number(db.prepare(`INSERT INTO emp_contracts(employee_id, by_user, ${c}) VALUES(?,?,${c.map(() => '?')})`).run(e.id, req.user, ...c.map(k => o[k])).lastInsertRowid);
    db.exec('COMMIT'); res.json({ id });
  } catch (x) { db.exec('ROLLBACK'); fail(res, x.message); }
});
hrxRouter.put('/contracts/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM emp_contracts WHERE id=?').get(req.params.id); if (!c) return fail(res, 'No such contract', 404);
  const { o, error } = cleanContract(req.body ?? {}, true); if (error) return fail(res, error);
  const m = { ...c, ...o }; if (m.end_date && m.end_date < m.start_date) return fail(res, 'The end date is before the start date'); if (m.type === 'Permanent' && m.end_date) return fail(res, 'A permanent contract has no end date');
  const keys = Object.keys(o); if (!keys.length) return res.json({ ok: true });
  const reset = ('end_date' in o ? ', reminded=NULL' : '') + ('probation_end' in o ? ', reminded_probation=NULL' : ''); // a changed date is reminded afresh
  db.prepare(`UPDATE emp_contracts SET ${keys.map(k => k + '=?')}${reset} WHERE id=?`).run(...keys.map(k => o[k]), c.id); res.json({ ok: true });
});
hrxRouter.post('/contracts/:id/end', (req, res) => { // the contract is over (left, or not renewed)
  const c = db.prepare('SELECT * FROM emp_contracts WHERE id=?').get(req.params.id); if (!c) return fail(res, 'No such contract', 404); if (c.status !== 'active') return fail(res, 'Only a contract in force can be ended');
  const day = req.body?.date || dateStr(new Date()); if (!DATE.test(day)) return fail(res, 'Date must be YYYY-MM-DD');
  db.prepare("UPDATE emp_contracts SET status='ended', end_date=?, note=COALESCE(?, note) WHERE id=?").run(day, req.body?.reason ? String(req.body.reason).slice(0, 300) : null, c.id); res.json({ ok: true });
});
hrxRouter.post('/contracts/check', (_q, res) => res.json({ sent: checkContracts() })); // the same check the server runs every hour
hrxRouter.delete('/contracts/:id', (req, res) => { db.prepare('DELETE FROM emp_contracts WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// Reminders: contract end and probation end, at 30, 14, 7 and 1 day(s) before (once each), to the admins and to the manager.
const STEPS = [30, 14, 7, 1, 0];
export function checkContracts(today = dateStr(new Date())) {
  let sent = 0;
  const tell = (c, title, body) => { notify({ title, body, link: 'Contracts', kind: 'contract', employee_id: c.employee_id }); const m = db.prepare('SELECT manager_id FROM employees WHERE id=?').get(c.employee_id)?.manager_id; if (m) notify({ audience: 'employee', employee_id: m, title, body, kind: 'contract' }); sent++; };
  for (const c of db.prepare("SELECT c.*, e.name FROM emp_contracts c JOIN employees e ON e.id=c.employee_id WHERE c.status='active' AND e.active=1").all()) {
    for (const [field, mark, label] of [['end_date', 'reminded', 'contract'], ['probation_end', 'reminded_probation', 'probation']]) {
      if (!c[field]) continue; const left = daysBetween(today, c[field]); if (left < 0) continue;
      const step = STEPS.filter(s => left <= s).at(-1); if (step === undefined || (c[mark] !== null && c[mark] !== undefined && c[mark] <= step)) continue;
      db.prepare(`UPDATE emp_contracts SET ${mark}=? WHERE id=?`).run(step, c.id);
      tell(c, left === 0 ? `${c.name}'s ${label} ends today` : `${c.name}'s ${label} ends in ${left} day${left === 1 ? '' : 's'}`, `${c.type}, ${label === 'contract' ? 'ends' : 'probation ends'} ${c[field]}. Renew or end it under Contracts.`);
    }
  }
  return sent;
}

// ---------- promotions ----------
hrxRouter.post('/employees/:id/promote', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  if (!e.active) return fail(res, 'Only an active employee can be promoted');
  const b = req.body ?? {}, date = b.date || dateStr(new Date()); if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  const nm = (t, id) => (id ? db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(id)?.name ?? null : null);
  const set = {}, change = {};
  for (const [f, t, label] of [['designation_id', 'designations', 'designation'], ['department_id', 'departments', 'department']]) if (b[f] && Number(b[f]) !== e[f]) { if (!nm(t, b[f])) return fail(res, `Unknown ${label}`); set[f] = Number(b[f]); change[label] = { from: nm(t, e[f]), to: nm(t, b[f]) }; }
  const wantsPay = b.salary !== undefined && b.salary !== null && b.salary !== '';
  if (wantsPay) {
    const sal = Number(b.salary); if (!(sal > 0 && sal < 1e9)) return fail(res, 'New salary must be a number above 0');
    if (!(req.role === 'admin' || req.perms?.payroll === 'edit')) return fail(res, 'Changing salary needs payroll edit access', 403);
    if (db.prepare('SELECT 1 FROM payroll_runs WHERE month>=?').get(date.slice(0, 7))) return fail(res, 'A payroll month from that date on is already finalized. Reopen it or use a later date.');
  }
  if (!Object.keys(set).length && !wantsPay) return fail(res, 'Choose a new designation, department or salary');
  db.exec('BEGIN');
  try {
    if (Object.keys(set).length) db.prepare(`UPDATE employees SET ${Object.keys(set).map(f => f + '=?')} WHERE id=?`).run(...Object.values(set), e.id);
    if (wantsPay) {
      const sal = Number(b.salary), st = salaryMap(date.slice(0, 7)).get(e.id), from = st ? st.gross : Number(e.salary) || 0, k = st && st.gross > 0 ? sal / st.gross : 1;
      addRevision(e.id, st ? { effective_from: date, basic: st.basic * k, components: st.components.map(c => ({ ...c, amount: round2(c.amount * k) })), note: 'Promotion' } : { effective_from: date, basic: sal, components: [], note: 'Promotion' }, req.user);
      change.salary = { from: round2(from), to: round2(sal) };
    }
    db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(e.id, 'promotion', date, JSON.stringify({ ...change, note: String(b.note ?? '').slice(0, 200) }), req.user);
    db.exec('COMMIT');
  } catch (x) { db.exec('ROLLBACK'); return fail(res, x.message); }
  notify({ audience: 'employee', employee_id: e.id, title: 'Congratulations on your promotion', body: Object.entries(change).filter(([k]) => k !== 'salary').map(([k, v]) => `${k}: ${v.to}`).join(', ') || 'Your salary was revised.', kind: 'automation' });
  res.json({ ok: true, change });
});
hrxRouter.get('/promotions', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT h.id, h.date, h.detail, h.by_user, e.id AS employee_id, e.code, e.name AS employee FROM emp_history h JOIN employees e ON e.id=h.employee_id WHERE h.kind='promotion'${sc.sql} ORDER BY h.date DESC, h.id DESC LIMIT 500`).all(...sc.args)
    .map(r => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
});

// ---------- directory ----------
hrxRouter.get('/directory', (req, res) => {
  const sc = scopeClause('e'), w = ['e.active=1'], a = [];
  if (req.query.q) { w.push('(e.name LIKE ? OR e.code LIKE ? OR ds.name LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'); a.push(...Array(5).fill(`%${req.query.q}%`)); }
  for (const [p, c] of [['department_id', 'e.department_id'], ['branch_id', 'e.branch_id'], ['designation_id', 'e.designation_id']]) if (req.query[p]) { w.push(`${c}=?`); a.push(req.query[p]); }
  res.json(db.prepare(`SELECT e.id, e.code, e.name, e.email, e.phone, e.join_date, e.photo IS NOT NULL AS has_photo, d.name AS dept, b.name AS branch, ds.name AS designation, m.name AS manager FROM employees e
    LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN employees m ON m.id=e.manager_id
    WHERE ${w.join(' AND ')}${sc.sql} ORDER BY e.name LIMIT 500`).all(...a, ...sc.args).map(r => ({ ...r, has_photo: !!r.has_photo })));
});
// Birthdays and work anniversaries in the next N days (default 30).
export function upcoming(days = 30, scope = true, today = dateStr(new Date())) {
  const sc = scope ? scopeClause('e') : { sql: '', args: [] }, out = [];
  for (const e of db.prepare(`SELECT e.id, e.name, e.dob, e.join_date, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.active=1${sc.sql}`).all(...sc.args)) {
    for (const [kind, d] of [['birthday', e.dob], ['anniversary', e.join_date]]) {
      if (!d || !DATE.test(d)) continue;
      for (const y of [+today.slice(0, 4), +today.slice(0, 4) + 1]) {
        const day = `${y}-${d.slice(5)}`; if (d.slice(5) === '02-29' && new Date(y, 1, 29).getDate() !== 29) continue;
        const left = daysBetween(today, day); if (left < 0 || left > days) continue;
        const years = y - +d.slice(0, 4); if (kind === 'anniversary' && years < 1) continue;
        out.push({ id: e.id, name: e.name, dept: e.dept, kind, date: day, in_days: left, years }); break;
      }
    }
  }
  return out.sort((a, b) => a.in_days - b.in_days || a.name.localeCompare(b.name));
}
hrxRouter.get('/directory/upcoming', (req, res) => res.json(upcoming(Math.min(Number(req.query.days) || 30, 366))));

export function startHr() { checkContracts(); setInterval(() => checkContracts(), 3600000).unref(); }
