import express from 'express';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { db, getSettings } from './db.js';
import { queueUser } from './devsync.js';
import { salaryEdited } from './paycalc.js';
import { parseCsv, toCsv } from './csv.js';
import { dateStr } from './dates.js';
import { emit } from './events.js';
import { scopeClause } from './rbac.js';
import './zk-log.js'; // adds ip / status columns to audit_log (the User Log page)

export const hrRouter = express.Router();
export const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
const DATE = /^\d{4}-\d\d-\d\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- helpers ----------
const FIELDS = ['name', 'department_id', 'shift_id', 'company_id', 'branch_id', 'designation_id', 'group_id', 'salary', 'join_date',
  'email', 'phone', 'gender', 'dob', 'address', 'emergency_contact', 'leave_policy_id', 'ot_policy_id', 'rotation_id', 'rotation_anchor', 'manager_id', 'card_no',
  'cnic', 'eobi_no', 'bank_name', 'bank_account', 'bank_title'];
// Identity and bank details: only people with payroll access can see or change them (a salary could be redirected otherwise).
const PAY = ['cnic', 'eobi_no', 'bank_name', 'bank_account', 'bank_title'];
const payEdit = (req) => req.role === 'admin' || req.perms?.payroll === 'edit', payView = (req) => req.role === 'admin' || ['view', 'edit'].includes(req.perms?.payroll);
const maskPay = (req, rows) => { if (!payView(req)) for (const r of Array.isArray(rows) ? rows : [rows]) for (const f of PAY) delete r[f]; return rows; };
export const nextCode = () => String((db.prepare("SELECT MAX(CAST(code AS INTEGER)) m FROM employees WHERE code GLOB '[0-9]*'").get().m ?? 0) + 1);

export function validate(b, partial) {
  if (!partial && !String(b.name ?? '').trim()) return 'Name required';
  if ('name' in b && !String(b.name).trim()) return 'Name required';
  for (const f of ['join_date', 'dob', 'rotation_anchor']) if (b[f] && !DATE.test(b[f])) return `${f} must be YYYY-MM-DD`;
  if (b.card_no && !/^\d{1,20}$/.test(String(b.card_no))) return 'Card number: digits only';
  if (b.cnic && !/^\d{5}-?\d{7}-?\d$/.test(String(b.cnic).trim())) return 'CNIC looks wrong (example 35202-1234567-1)';
  if (b.bank_account && !/^[A-Za-z0-9 -]{6,40}$/.test(String(b.bank_account).trim())) return 'Bank account number / IBAN looks wrong';
  if (b.rotation_id && !b.rotation_anchor) return 'Choose the date the rotation starts (day 1 of its cycle)';
  if (b.salary !== undefined && b.salary !== null && b.salary !== '' && !(Number(b.salary) >= 0)) return 'Salary must be a number';
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) return 'Invalid email';
  if (b.gender && !['male', 'female', 'other'].includes(String(b.gender).toLowerCase())) return 'Gender must be male, female or other';
  return null;
}
const REF = { department_id: 'departments', shift_id: 'shifts', company_id: 'companies', branch_id: 'branches', designation_id: 'designations', group_id: 'emp_groups', leave_policy_id: 'leave_policies', ot_policy_id: 'ot_policies', rotation_id: 'rotations', manager_id: 'employees' };
function checkRefs(b) {
  for (const [f, t] of Object.entries(REF))
    if (b[f] !== undefined && b[f] !== null && b[f] !== '' && !db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(b[f])) return `Unknown ${f.replace('_id', '').replace('group', 'group')}`;
  return null;
}
function customJson(input, existing, selfId = null) {
  if (input === undefined) return { value: existing ?? null };
  const defs = new Map(db.prepare('SELECT * FROM custom_fields').all().map(d => [String(d.id), d]));
  const out = { ...(existing ? JSON.parse(existing) : {}) };
  for (const [k, v] of Object.entries(input ?? {})) {
    const d = defs.get(k); if (!d || d.enabled === 0) continue;
    if (v === '' || v === null) { delete out[k]; continue; }
    if (d.type === 'number' && !Number.isFinite(Number(v))) return { error: `${d.label} must be a number` };
    if (d.type === 'date' && !DATE.test(v)) return { error: `${d.label} must be a date` };
    if (d.type === 'select' && !String(d.options ?? '').split(',').map(x => x.trim()).includes(v)) return { error: `${d.label}: pick one of its options` };
    if (d.uniq && db.prepare("SELECT id, custom FROM employees WHERE custom IS NOT NULL AND id IS NOT ?").all(selfId).some(r => { try { return JSON.parse(r.custom)[k] === String(v); } catch { return false; } })) return { error: `${d.label} "${v}" is already used by someone else` };
    out[k] = String(v).slice(0, 500);
  }
  return { value: JSON.stringify(out) };
}
const history = (employeeId, kind, date, detail, user) =>
  db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(employeeId, kind, date, typeof detail === 'string' ? detail : JSON.stringify(detail), user);

const SELECT = `SELECT e.*, d.name AS dept, b.name AS branch, g.name AS grp, ds.name AS designation, s.name AS shift, c.name AS company
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN emp_groups g ON g.id=e.group_id
  LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN shifts s ON s.id=e.shift_id LEFT JOIN companies c ON c.id=e.company_id`;
function listEmployees(q) {
  const w = [], a = [];
  if (q.q) { w.push('(e.code LIKE ? OR e.name LIKE ? OR e.phone LIKE ? OR e.email LIKE ?)'); const l = `%${q.q}%`; a.push(l, l, l, l); }
  for (const [p, col] of [['department_id', 'e.department_id'], ['branch_id', 'e.branch_id'], ['designation_id', 'e.designation_id'], ['group_id', 'e.group_id'], ['shift_id', 'e.shift_id'], ['company_id', 'e.company_id']])
    if (q[p]) { w.push(`${col}=?`); a.push(q[p]); }
  if (q.status === 'inactive') w.push("e.active=0"); else if (q.status) { w.push('e.status=?'); a.push(q.status); }
  const sc = scopeClause('e');
  const rows = db.prepare(`${SELECT} WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY CAST(e.code AS INTEGER), e.code LIMIT 2000`).all(...sc.args, ...a);
  for (const r of rows) r.custom = r.custom ? JSON.parse(r.custom) : {};
  return rows;
}

// ---------- list / detail / create / update / delete ----------
hrRouter.get('/employees', (req, res) => res.json(maskPay(req, listEmployees(req.query))));
hrRouter.get('/employees/next-code', (_q, res) => res.json({ code: nextCode() }));

hrRouter.get('/employees/export.csv', (req, res) => {
  const cols = ['code', 'name', 'department', 'branch', 'designation', 'group', 'shift', 'status', 'salary', 'join_date', 'email', 'phone', 'gender', 'dob'];
  const rows = listEmployees(req.query).map(e => ({ ...e, department: e.dept, group: e.grp }));
  res.type('text/csv').attachment('employees.csv').send(toCsv(cols, rows));
});
hrRouter.get('/employees/template.csv', (_q, res) =>
  res.type('text/csv').attachment('employees-template.csv').send('code,name,department,branch,designation,group,shift,salary,join_date,email,phone,gender,dob\n,Example Person,Operations,Main Office,Clerk,Staff,Office,45000,2026-01-15,a@b.com,03001234567,male,1990-05-20\n'));

hrRouter.get('/employees/:id', (req, res) => {
  const e = db.prepare(`${SELECT} WHERE e.id=?`).get(req.params.id);
  if (!e) return fail(res, 'No such employee', 404);
  e.custom = e.custom ? JSON.parse(e.custom) : {};
  res.json(maskPay(req, e));
});

hrRouter.post('/employees', (req, res) => {
  const b = { ...req.body }; if (!payEdit(req)) for (const f of PAY) delete b[f];
  const bad = validate(b, false) || checkRefs(b); if (bad) return fail(res, bad);
  const code = String(b.code ?? '').trim() || nextCode();
  if (!/^[\w-]{1,24}$/.test(code)) return fail(res, 'Code: letters, digits, - and _ only (max 24)');
  { const S = getSettings(); if (S.emp_id_numeric && !/^\d{1,12}$/.test(code)) return fail(res, 'Employee IDs must be numbers (see Personnel > Configurations)'); if (S.emp_id_ordered && String(b.code ?? '').trim() && Number(code) !== Number(nextCode())) return fail(res, `The next employee ID must be ${nextCode()} (IDs are numbered in order)`); }
  const cf = customJson(b.custom); if (cf.error) return fail(res, cf.error);
  try {
    const cols = ['code', 'status', 'active', 'custom', ...FIELDS];
    const vals = [code, 'active', 1, cf.value, ...FIELDS.map(f => (b[f] === '' || b[f] === undefined ? null : b[f]))];
    const r = db.prepare(`INSERT INTO employees(${cols}) VALUES(${cols.map(() => '?')})`).run(...vals);
    const id = Number(r.lastInsertRowid);
    history(id, 'registered', b.join_date ?? dateStr(new Date()), 'Employee registered', req.user);
    queueUser(code, String(b.name).trim(), 'update');
    emit('employee.created', { code, name: String(b.name).trim() });
    res.json({ id, code });
  } catch (e) { fail(res, /card_no/.test(e.message) ? 'This card number is already assigned to another employee' : /UNIQUE/.test(e.message) ? 'Employee code already exists' : /FOREIGN/.test(e.message) ? 'Unknown department, branch, designation, group or shift' : e.message); }
});

hrRouter.put('/employees/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!old) return fail(res, 'No such employee', 404);
  const b = { ...(req.body ?? {}) }; if (!payEdit(req)) for (const f of PAY) delete b[f];
  const bad = validate(b, true) || checkRefs(b); if (bad) return fail(res, bad);
  const cf = customJson(b.custom, old.custom, old.id); if (cf.error) return fail(res, cf.error);
  const set = FIELDS.filter(f => f in b), vals = set.map(f => (b[f] === '' ? null : b[f]));
  if ('active' in b) { set.push('active', 'status'); vals.push(b.active ? 1 : 0, b.active ? 'active' : 'inactive'); }
  if ('custom' in b) { set.push('custom'); vals.push(cf.value); }
  try {
    if (set.length) db.prepare(`UPDATE employees SET ${set.map(f => f + '=?')} WHERE id=?`).run(...vals, old.id);
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(old.id);
    if ('salary' in b) salaryEdited(old.salary, e, req.user);
    if (e.name !== old.name || e.active !== old.active) queueUser(e.code, e.name, e.active ? 'update' : 'delete');
    emit('employee.updated', { code: e.code, name: e.name });
    res.json({ ok: true });
  } catch (e) { fail(res, /card_no/.test(e.message) ? 'This card number is already assigned to another employee' : /FOREIGN/.test(e.message) ? 'Unknown department, branch, designation, group or shift' : e.message); }
});

hrRouter.delete('/employees/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return fail(res, 'No such employee', 404);
  try {
    db.prepare('DELETE FROM employees WHERE id=?').run(e.id);
    queueUser(e.code, e.name, 'delete');
    if (e.photo) rmSync(join(UPLOAD_DIR, 'photos', e.photo), { force: true });
    res.json({ ok: true });
  } catch { fail(res, 'Has leave or roster records. Deactivate the employee instead.'); }
});

// ---------- lifecycle: transfer, resignation, termination, rejoining ----------
hrRouter.post('/employees/:id/transfer', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return fail(res, 'No such employee', 404);
  const date = req.body?.date || dateStr(new Date());
  if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  const name = (t, id) => (id ? db.prepare(`SELECT name FROM ${t} WHERE id=?`).get(id)?.name ?? null : null);
  const to = {}, change = {};
  for (const [f, t] of [['department_id', 'departments'], ['branch_id', 'branches'], ['designation_id', 'designations'], ['company_id', 'companies'], ['group_id', 'emp_groups']])
    if (req.body?.[f] && Number(req.body[f]) !== e[f]) {
      if (!name(t, req.body[f])) return fail(res, `Unknown ${f.replace('_id', '')}`);
      to[f] = Number(req.body[f]); change[f.replace('_id', '')] = { from: name(t, e[f]), to: name(t, req.body[f]) };
    }
  if (!Object.keys(to).length) return fail(res, 'Nothing to change');
  db.prepare(`UPDATE employees SET ${Object.keys(to).map(f => f + '=?')} WHERE id=?`).run(...Object.values(to), e.id);
  history(e.id, 'transfer', date, { ...change, note: req.body?.note ?? '' }, req.user);
  res.json({ ok: true });
});

function exitEmployee(kind, status) {
  return (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
    if (!e) return fail(res, 'No such employee', 404);
    if (!e.active) return fail(res, 'Employee is already inactive');
    const date = req.body?.date || dateStr(new Date());
    if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
    db.prepare('UPDATE employees SET active=0, status=?, exit_date=? WHERE id=?').run(status, date, e.id);
    history(e.id, kind, date, { reason: req.body?.reason ?? '' }, req.user);
    queueUser(e.code, e.name, 'delete');
    emit('employee.status_changed', { code: e.code, status, date });
    res.json({ ok: true });
  };
}
hrRouter.post('/employees/:id/resign', exitEmployee('resignation', 'resigned'));
hrRouter.post('/employees/:id/terminate', exitEmployee('termination', 'terminated'));
hrRouter.post('/employees/:id/rejoin', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return fail(res, 'No such employee', 404);
  if (e.active) return fail(res, 'Employee is already active');
  const date = req.body?.date || dateStr(new Date());
  if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  db.prepare("UPDATE employees SET active=1, status='active', exit_date=NULL WHERE id=?").run(e.id);
  history(e.id, 'rejoin', date, { note: req.body?.note ?? '' }, req.user);
  queueUser(e.code, e.name, 'update');
  emit('employee.status_changed', { code: e.code, status: 'active', date });
  res.json({ ok: true });
});
hrRouter.get('/employees/:id/history', (req, res) =>
  res.json(db.prepare('SELECT id, kind, date, detail, by_user, created FROM emp_history WHERE employee_id=? ORDER BY date DESC, id DESC').all(req.params.id)));

// ---------- photo ----------
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
hrRouter.post('/employees/:id/photo', (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id);
  if (!e) return fail(res, 'No such employee', 404);
  const m = String(req.body?.data ?? '').match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return fail(res, 'Photo must be a JPEG or PNG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return fail(res, 'Photo must be under 2 MB');
  mkdirSync(join(UPLOAD_DIR, 'photos'), { recursive: true });
  const file = `${e.id}-${randomBytes(4).toString('hex')}.${EXT[m[1]]}`;
  writeFileSync(join(UPLOAD_DIR, 'photos', file), buf);
  if (e.photo) rmSync(join(UPLOAD_DIR, 'photos', e.photo), { force: true });
  db.prepare('UPDATE employees SET photo=? WHERE id=?').run(file, e.id);
  res.json({ ok: true });
});
hrRouter.get('/employees/:id/photo', (req, res) => {
  const e = db.prepare('SELECT photo FROM employees WHERE id=?').get(req.params.id);
  if (!e?.photo) return fail(res, 'No photo', 404);
  res.sendFile(resolve(UPLOAD_DIR, 'photos', basename(e.photo)));
});
hrRouter.delete('/employees/:id/photo', (req, res) => {
  const e = db.prepare('SELECT photo FROM employees WHERE id=?').get(req.params.id);
  if (e?.photo) { rmSync(join(UPLOAD_DIR, 'photos', basename(e.photo)), { force: true }); db.prepare('UPDATE employees SET photo=NULL WHERE id=?').run(req.params.id); }
  res.json({ ok: true });
});

// ---------- documents ----------
const DOC_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.doc', '.docx', '.xls', '.xlsx', '.txt']);
hrRouter.get('/employees/:id/documents', (req, res) =>
  res.json(db.prepare('SELECT id, name, filename, size, created FROM emp_documents WHERE employee_id=? ORDER BY id DESC').all(req.params.id)));
hrRouter.post('/employees/:id/documents', (req, res) => {
  if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(req.params.id)) return fail(res, 'No such employee', 404);
  const filename = basename(String(req.body?.filename ?? '')).replace(/[\x00-\x1f]/g, '').slice(0, 120);
  const ext = extname(filename).toLowerCase();
  if (!DOC_EXT.has(ext)) return fail(res, 'Allowed: pdf, png, jpg, doc, docx, xls, xlsx, txt');
  const m = String(req.body?.data ?? '').match(/^(?:data:[^;]*;base64,)?([A-Za-z0-9+/=]+)$/);
  if (!m) return fail(res, 'File data missing');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length || buf.length > 8 * 1024 * 1024) return fail(res, 'File must be 1 byte to 8 MB');
  mkdirSync(join(UPLOAD_DIR, 'docs'), { recursive: true });
  const stored = randomBytes(12).toString('hex') + ext;
  writeFileSync(join(UPLOAD_DIR, 'docs', stored), buf);
  const r = db.prepare('INSERT INTO emp_documents(employee_id, name, filename, stored, size) VALUES(?,?,?,?,?)')
    .run(req.params.id, String(req.body?.name || filename).slice(0, 100), filename, stored, buf.length);
  res.json({ id: Number(r.lastInsertRowid) });
});
hrRouter.get('/documents/:id/download', (req, res) => {
  const d = db.prepare('SELECT * FROM emp_documents WHERE id=?').get(req.params.id);
  if (!d) return fail(res, 'No such document', 404);
  res.download(resolve(UPLOAD_DIR, 'docs', basename(d.stored)), d.filename);
});
hrRouter.delete('/documents/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM emp_documents WHERE id=?').get(req.params.id);
  if (d) { rmSync(join(UPLOAD_DIR, 'docs', basename(d.stored)), { force: true }); db.prepare('DELETE FROM emp_documents WHERE id=?').run(d.id); }
  res.json({ ok: true });
});

// ---------- bulk import ----------
hrRouter.post('/employees/import', (req, res) => {
  const rows = parseCsv(req.body?.csv);
  if (rows.length < 2) return fail(res, 'CSV needs a header row and at least one employee');
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (!head.includes('name')) return fail(res, 'CSV needs a "name" column');
  const get = (r, k) => (r[head.indexOf(k)] ?? '').trim();
  const lookup = (table, name, create = true) => {
    if (!name) return null;
    const f = db.prepare(`SELECT id FROM ${table} WHERE name=? COLLATE NOCASE`).get(name);
    if (f) return f.id;
    return create ? Number(db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name).lastInsertRowid) : null;
  };
  let created = 0, updated = 0; const errors = [];
  db.exec('BEGIN');
  try {
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const rec = { name: get(r, 'name'), salary: get(r, 'salary') || null, join_date: get(r, 'join_date') || null, email: get(r, 'email') || null,
        phone: get(r, 'phone') || null, gender: get(r, 'gender').toLowerCase() || null, dob: get(r, 'dob') || null };
      const bad = validate(rec, false); if (bad) return errors.push({ line, error: bad });
      const code = get(r, 'code') || nextCode();
      if (!/^[\w-]{1,24}$/.test(code)) return errors.push({ line, error: 'Bad code' });
      const ids = { department_id: lookup('departments', get(r, 'department')), branch_id: lookup('branches', get(r, 'branch')),
        designation_id: lookup('designations', get(r, 'designation')), group_id: lookup('emp_groups', get(r, 'group')),
        shift_id: lookup('shifts', get(r, 'shift'), false) };
      const data = { ...rec, ...ids };
      const exists = db.prepare('SELECT id FROM employees WHERE code=?').get(code);
      if (exists) {
        const cols = Object.keys(data).filter(k => data[k] !== null);
        db.prepare(`UPDATE employees SET ${cols.map(k => k + '=?')} WHERE id=?`).run(...cols.map(k => data[k]), exists.id); updated++;
      } else {
        const cols = ['code', 'status', 'active', ...Object.keys(data)];
        const id = Number(db.prepare(`INSERT INTO employees(${cols}) VALUES(${cols.map(() => '?')})`).run(code, 'active', 1, ...Object.values(data)).lastInsertRowid);
        history(id, 'registered', rec.join_date ?? dateStr(new Date()), 'Imported from CSV', req.user); created++;
      }
      queueUser(code, rec.name, 'update');
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return fail(res, 'Import failed: ' + e.message); }
  res.json({ created, updated, errors });
});

// ---------- audit trail ----------
export function auditMiddleware(req, res, next) {
  if (req.method === 'GET') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    try {
      const b = typeof req.body === 'object' && req.body ? { ...req.body } : {};
      for (const k of ['password', 'data', 'csv']) if (k in b) b[k] = '[hidden]';
      db.prepare('INSERT INTO audit_log(user, method, path, summary, ip, status) VALUES(?,?,?,?,?,?)').run(req.user, req.method, req.originalUrl.split('?')[0], JSON.stringify(b).slice(0, 400), req.ip, 'Success');
    } catch {}
  });
  next();
}
hrRouter.get('/audit', (req, res) => {
  if (req.role !== 'admin') return fail(res, 'Admin only', 403);
  const q = req.query.q ? `%${req.query.q}%` : '%';
  res.json(db.prepare('SELECT * FROM audit_log WHERE (user LIKE ? OR path LIKE ? OR summary LIKE ?) ORDER BY id DESC LIMIT 300').all(q, q, q));
});
