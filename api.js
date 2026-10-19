import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { db } from './db.js';
import { attendanceReport } from './report.js';
import { dateStr, addDays } from './dates.js';
import { payroll } from './payroll.js';
import { validate, nextCode } from './hr.js';
import { queueUser } from './devsync.js';
import { emit, EVENTS, checkUrl, sign, deliverDue } from './events.js';
import { apiLog } from './zk-log.js';

const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
export const SCOPES = { 'employees:read': 'List employees, departments, branches, shifts', 'employees:write': 'Create and update employees, change their status', 'attendance:read': 'Daily attendance, raw punches, leave',
  'payroll:read': 'Finalized payroll and salaries' };

// ================= public API for other software: /api/v1 (API key, no staff login) =================
export const v1 = express.Router();
v1.use(apiLog); // every request, answered or refused, goes to the API Request log
const calls = new Map(); // key id -> recent request times
const hashKey = (k) => createHash('sha256').update(k).digest('hex');

export const ENDPOINTS = [
    ['GET', '/api/v1/ping', 'any key', 'Check that the key works'], ['GET', '/api/v1/employees?q=&department=&branch=&status=&limit=&offset=', 'employees:read', 'List employees (salary only with payroll:read)'],
    ['GET', '/api/v1/employees/:code', 'employees:read', 'One employee'], ['POST', '/api/v1/employees', 'employees:write', 'Create or update by code; department/branch/designation/group are names (created if new), shift must exist'],
    ['PUT', '/api/v1/employees/:code/status', 'employees:write', 'status = resigned | terminated | active, date, reason'], ['GET', '/api/v1/departments | /branches | /shifts', 'employees:read', 'Reference lists'],
    ['GET', '/api/v1/attendance/daily?from=&to=&employee_code=&department=&limit=&offset=', 'attendance:read', 'One row per employee per day (max 93 days)'],
    ['GET', '/api/v1/attendance/punches?since_id=&limit=', 'attendance:read', 'Raw punches in order; pass next_since_id back to get only new ones'], ['GET', '/api/v1/leaves?status=&from=&to=', 'attendance:read', 'Leave requests'],
    ['GET', '/api/v1/payroll/:month', 'payroll:read', 'Finalized payroll for YYYY-MM (add ?draft=1 for the live calculation)']];
v1.get('/docs', (_q, res) => res.json({ auth: 'Send your key as "Authorization: Bearer ak_..." or "X-API-Key: ak_...". Create keys in Integrations.', scopes: SCOPES, rate_limit: `${process.env.API_RATE_PER_MIN || 120} requests per minute per key`, events: EVENTS,
  endpoints: ENDPOINTS }));

v1.use((req, res, next) => {
  const raw = String(req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')).trim();
  const k = /^ak_[A-Za-z0-9_-]{20,}$/.test(raw) ? db.prepare('SELECT * FROM api_keys WHERE key_hash=? AND active=1').get(hashKey(raw)) : null;
  if (!k) return fail(res, 'Missing or invalid API key', 401);
  const limit = Number(process.env.API_RATE_PER_MIN) || 120, t = Date.now(), recent = (calls.get(k.id) ?? []).filter(x => t - x < 60000);
  if (recent.length >= limit) { res.set('Retry-After', '30'); return fail(res, `Rate limit: ${limit} requests per minute`, 429); }
  recent.push(t); calls.set(k.id, recent); res.set('X-RateLimit-Remaining', String(limit - recent.length));
  db.prepare('UPDATE api_keys SET last_used=?, requests=requests+1 WHERE id=?').run(new Date().toLocaleString('sv'), k.id);
  req.apiKey = k; req.scopes = new Set(k.scopes.split(','));
  next();
});
const need = (scope) => (req, res, next) => (req.scopes.has(scope) ? next() : fail(res, `This key does not have the "${scope}" permission`, 403));
const page = (q, dflt = 100, max = 500) => ({ limit: Math.min(max, Math.max(1, Number(q.limit) || dflt)), offset: Math.max(0, Number(q.offset) || 0) });
v1.get('/ping', (req, res) => res.json({ ok: true, key: req.apiKey.name, scopes: [...req.scopes] }));

const EMP = `SELECT e.code, e.name, d.name AS department, b.name AS branch, ds.name AS designation, g.name AS "group", s.name AS shift, e.status, e.active, e.join_date, e.exit_date, e.email, e.phone, e.gender, e.dob, m.code AS manager_code, e.salary
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN emp_groups g ON g.id=e.group_id
  LEFT JOIN shifts s ON s.id=e.shift_id LEFT JOIN employees m ON m.id=e.manager_id`;
const shape = (r, req) => { const o = { ...r, active: !!r.active }; if (!req.scopes.has('payroll:read')) delete o.salary; return o; };
v1.get('/employees', need('employees:read'), (req, res) => {
  const w = [], a = [], q = req.query;
  if (q.q) { w.push('(e.code LIKE ? OR e.name LIKE ?)'); a.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.department) { w.push('d.name=? COLLATE NOCASE'); a.push(q.department); } if (q.branch) { w.push('b.name=? COLLATE NOCASE'); a.push(q.branch); }
  if (q.status === 'inactive') w.push('e.active=0'); else if (q.status) { w.push('e.status=?'); a.push(q.status); }
  const { limit, offset } = page(q), where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  res.json({ total: db.prepare(`SELECT COUNT(*) n FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id ${where}`).get(...a).n, limit, offset,
    data: db.prepare(`${EMP} ${where} ORDER BY CAST(e.code AS INTEGER), e.code LIMIT ? OFFSET ?`).all(...a, limit, offset).map(r => shape(r, req)) });
});
v1.get('/employees/:code', need('employees:read'), (req, res) => { const r = db.prepare(`${EMP} WHERE e.code=?`).get(req.params.code); r ? res.json({ data: shape(r, req) }) : fail(res, 'No such employee', 404); });

const lookup = (table, name) => { if (!name) return null; return db.prepare(`SELECT id FROM ${table} WHERE name=? COLLATE NOCASE`).get(String(name).trim())?.id ?? Number(db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(String(name).trim().slice(0, 80)).lastInsertRowid); };
v1.post('/employees', need('employees:write'), (req, res) => {
  const b = req.body ?? {}, code = String(b.code ?? '').trim();
  const old = code ? db.prepare('SELECT * FROM employees WHERE code=?').get(code) : null;
  const bad = validate(b, !!old) || (b.card_no && !/^\d{1,20}$/.test(String(b.card_no)) ? 'Card number: digits only' : null); if (bad) return fail(res, bad);
  if (code && !/^[\w-]{1,24}$/.test(code)) return fail(res, 'Code: letters, digits, - and _ only (max 24)');
  let shiftId; if (b.shift) { shiftId = db.prepare('SELECT id FROM shifts WHERE name=? COLLATE NOCASE').get(String(b.shift))?.id; if (!shiftId) return fail(res, `Unknown shift "${b.shift}"`); }
  const set = {}; // only fields that were sent are touched
  for (const f of ['name', 'email', 'phone', 'gender', 'dob', 'join_date', 'card_no', 'address', 'emergency_contact']) if (f in b) set[f] = b[f] === '' ? null : b[f];
  for (const [f, t] of [['department', 'departments'], ['branch', 'branches'], ['designation', 'designations'], ['group', 'emp_groups']]) if (f in b) set[(f === 'group' ? 'group' : f) + '_id'] = lookup(t, b[f]);
  if (shiftId) set.shift_id = shiftId;
  try {
    db.exec('BEGIN');
    let id, created = false;
    if (old) { id = old.id; const c = Object.keys(set); if (c.length) db.prepare(`UPDATE employees SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => set[k]), id); }
    else {
      created = true; const c = ['code', 'status', 'active', ...Object.keys(set)];
      id = Number(db.prepare(`INSERT INTO employees(${c}) VALUES(${c.map(() => '?')})`).run(code || nextCode(), 'active', 1, ...Object.values(set)).lastInsertRowid);
      db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(id, 'registered', set.join_date ?? dateStr(new Date()), 'Created through the API', `api:${req.apiKey.name}`);
    }
    db.exec('COMMIT');
    const e = db.prepare('SELECT * FROM employees WHERE id=?').get(id); queueUser(e.code, e.name, e.active ? 'update' : 'delete');
    emit(created ? 'employee.created' : 'employee.updated', { code: e.code, name: e.name });
    res.status(created ? 201 : 200).json({ data: shape(db.prepare(`${EMP} WHERE e.id=?`).get(id), req), created });
  } catch (err) { try { db.exec('ROLLBACK'); } catch {} fail(res, /card_no/.test(err.message) ? 'This card number belongs to another employee' : /UNIQUE/.test(err.message) ? 'Employee code already exists' : err.message); }
});
v1.put('/employees/:code/status', need('employees:write'), (req, res) => {
  const e = db.prepare('SELECT * FROM employees WHERE code=?').get(req.params.code); if (!e) return fail(res, 'No such employee', 404);
  const { status, reason } = req.body ?? {}, date = req.body?.date || dateStr(new Date());
  if (!['resigned', 'terminated', 'active'].includes(status)) return fail(res, 'status must be resigned, terminated or active'); if (!/^\d{4}-\d\d-\d\d$/.test(date)) return fail(res, 'date must be YYYY-MM-DD');
  if (status === 'active' ? e.active : !e.active) return fail(res, status === 'active' ? 'Employee is already active' : 'Employee is already inactive');
  if (status === 'active') db.prepare("UPDATE employees SET active=1, status='active', exit_date=NULL WHERE id=?").run(e.id); else db.prepare('UPDATE employees SET active=0, status=?, exit_date=? WHERE id=?').run(status, date, e.id);
  db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(e.id, status === 'active' ? 'rejoin' : status === 'resigned' ? 'resignation' : 'termination', date, JSON.stringify({ reason: reason ?? '' }), `api:${req.apiKey.name}`);
  queueUser(e.code, e.name, status === 'active' ? 'update' : 'delete'); emit('employee.status_changed', { code: e.code, status, date });
  res.json({ ok: true, status });
});
for (const [path, sql] of [['departments', 'SELECT id, name FROM departments ORDER BY name'], ['branches', 'SELECT id, name FROM branches ORDER BY name'], ['shifts', 'SELECT id, name, code, type, start, end FROM shifts ORDER BY id']])
  v1.get('/' + path, need('employees:read'), (_q, res) => res.json({ data: db.prepare(sql).all() }));

v1.get('/attendance/daily', need('attendance:read'), (req, res) => {
  const q = req.query, to = /^\d{4}-\d\d-\d\d$/.test(q.to ?? '') ? q.to : dateStr(new Date()), from = /^\d{4}-\d\d-\d\d$/.test(q.from ?? '') ? q.from : to.slice(0, 8) + '01';
  if (from > to || addDays(from, 93) < to) return fail(res, 'Ask for at most 93 days at a time, with from before to');
  const f = {}; if (q.employee_code) { const e = db.prepare('SELECT id FROM employees WHERE code=?').get(String(q.employee_code)); if (!e) return fail(res, 'No such employee', 404); f.employeeId = e.id; }
  if (q.department) { const d = db.prepare('SELECT id FROM departments WHERE name=? COLLATE NOCASE').get(String(q.department)); if (!d) return fail(res, 'No such department', 404); f.departmentId = d.id; }
  const rows = attendanceReport(from, to, f).filter(r => r.status), { limit, offset } = page(q, 1000, 5000);
  res.json({ from, to, total: rows.length, limit, offset, data: rows.slice(offset, offset + limit).map(r => ({ date: r.date, code: r.code, name: r.name, department: r.dept, shift: r.shift, in: r.in, out: r.out, worked_min: r.worked_min, late_min: r.late_min, early_min: r.early_min, overtime_min: r.overtime_min, overtime_approved_min: r.ot_approved_min, status: r.status, note: r.note })) });
});
v1.get('/attendance/punches', need('attendance:read'), (req, res) => {
  const since = Math.max(0, Number(req.query.since_id) || 0), { limit } = page(req.query, 1000, 5000);
  const rows = db.prepare('SELECT l.id, l.emp_code AS code, l.ts, l.source, v.sn AS device FROM logs l LEFT JOIN devices v ON v.id=l.device_id WHERE l.id>? ORDER BY l.id LIMIT ?').all(since, limit);
  res.json({ data: rows, next_since_id: rows.length ? rows.at(-1).id : since });
});
v1.get('/leaves', need('attendance:read'), (req, res) => {
  const w = [], a = [], q = req.query; if (q.status) { w.push('l.status=?'); a.push(q.status); } if (q.from) { w.push('l.to_date>=?'); a.push(q.from); } if (q.to) { w.push('l.from_date<=?'); a.push(q.to); }
  res.json({ data: db.prepare(`SELECT l.id, e.code, e.name, l.type, l.from_date, l.to_date, l.days, l.half, l.status FROM leaves l JOIN employees e ON e.id=l.employee_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.from_date DESC LIMIT 2000`).all(...a) });
});
v1.get('/payroll/:month', need('payroll:read'), (req, res) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.params.month)) return fail(res, 'month must be YYYY-MM');
  const run = db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(req.params.month);
  if (run) return res.json({ month: req.params.month, status: run.status, finalized_at: run.finalized_at, paid_at: run.paid_at, data: JSON.parse(run.data) });
  if (req.query.draft === '1') return res.json({ month: req.params.month, status: 'draft', data: payroll(req.params.month) });
  fail(res, 'This month has not been finalized yet (add ?draft=1 for the live calculation)', 404);
});

// ================= staff side: manage keys and webhooks (admin only, see rbac) =================
export const integrationsRouter = express.Router();
integrationsRouter.get('/api-keys', (_q, res) => res.json({ scopes: SCOPES, keys: db.prepare('SELECT id, name, prefix, scopes, active, created, created_by, last_used, requests FROM api_keys ORDER BY id DESC').all() }));
integrationsRouter.post('/api-keys', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 80), scopes = [...new Set(req.body?.scopes ?? [])];
  if (!name) return fail(res, 'Give the key a name (for example "Payroll system")'); if (!scopes.length || scopes.some(s => !SCOPES[s])) return fail(res, 'Choose what this key may do');
  const key = 'ak_' + randomBytes(24).toString('base64url');
  const id = Number(db.prepare('INSERT INTO api_keys(name, prefix, key_hash, scopes, created_by) VALUES(?,?,?,?,?)').run(name, key.slice(0, 9), hashKey(key), scopes.join(','), req.user).lastInsertRowid);
  res.json({ id, key, note: 'Copy the key now. It cannot be shown again.' }); // the key is stored only as a hash
});
integrationsRouter.put('/api-keys/:id', (req, res) => { db.prepare('UPDATE api_keys SET active=? WHERE id=?').run(req.body?.active ? 1 : 0, req.params.id); res.json({ ok: true }); });
integrationsRouter.delete('/api-keys/:id', (req, res) => { db.prepare('DELETE FROM api_keys WHERE id=?').run(req.params.id); res.json({ ok: true }); });

const mask = (s) => 'whsec_…' + s.slice(-4);
const whBody = (b) => {
  const name = String(b.name ?? '').trim().slice(0, 80); if (!name) return { error: 'Name required' };
  const bad = checkUrl(String(b.url ?? '')); if (bad) return { error: bad };
  const arr = Array.isArray(b.events) ? b.events : b.events === '*' ? ['*'] : [], ev = !arr.length || arr.includes('*') ? '*' : [...new Set(arr)];
  if (ev !== '*' && ev.some(e => !EVENTS.includes(e))) return { error: 'Unknown event' };
  return { o: { name, url: String(b.url).trim(), events: ev === '*' ? '*' : ev.join(',') } };
};
integrationsRouter.get('/webhooks/events', (_q, res) => res.json(EVENTS));
integrationsRouter.get('/webhooks', (_q, res) => res.json(db.prepare(`SELECT w.*, (SELECT COUNT(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='pending') AS pending FROM webhooks w ORDER BY w.id`).all().map(w => ({ ...w, secret: mask(w.secret), events: w.events === '*' ? ['*'] : w.events.split(',') }))));
integrationsRouter.post('/webhooks', (req, res) => {
  const { o, error } = whBody(req.body ?? {}); if (error) return fail(res, error);
  const secret = 'whsec_' + randomBytes(24).toString('base64url');
  const id = Number(db.prepare('INSERT INTO webhooks(name, url, secret, events) VALUES(?,?,?,?)').run(o.name, o.url, secret, o.events).lastInsertRowid);
  res.json({ id, secret, note: 'Use this secret to verify the X-Signature header. It is shown only now.' });
});
integrationsRouter.put('/webhooks/:id', (req, res) => {
  const { o, error } = whBody(req.body ?? {}); if (error) return fail(res, error);
  db.prepare('UPDATE webhooks SET name=?, url=?, events=?, active=? WHERE id=?').run(o.name, o.url, o.events, req.body.active === false || req.body.active === 0 ? 0 : 1, req.params.id); res.json({ ok: true });
});
integrationsRouter.delete('/webhooks/:id', (req, res) => { db.prepare('DELETE FROM webhooks WHERE id=?').run(req.params.id); res.json({ ok: true }); });
integrationsRouter.post('/webhooks/:id/rotate', (req, res) => {
  if (!db.prepare('SELECT 1 FROM webhooks WHERE id=?').get(req.params.id)) return fail(res, 'No such webhook', 404);
  const secret = 'whsec_' + randomBytes(24).toString('base64url'); db.prepare('UPDATE webhooks SET secret=? WHERE id=?').run(secret, req.params.id); res.json({ secret });
});
integrationsRouter.post('/webhooks/:id/test', async (req, res) => {
  const w = db.prepare('SELECT * FROM webhooks WHERE id=?').get(req.params.id); if (!w) return fail(res, 'No such webhook', 404);
  const payload = JSON.stringify({ id: 'test', event: 'test.ping', created: new Date().toLocaleString('sv'), data: { message: 'This is a test from the attendance system' } });
  db.prepare('INSERT INTO webhook_deliveries(webhook_id, event, payload, next_try) VALUES(?,?,?,?)').run(w.id, 'test.ping', payload, new Date().toLocaleString('sv'));
  await deliverDue({ force: false });
  const d = db.prepare('SELECT status, code, error FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 1').get(w.id); res.json({ ok: d.status === 'done', ...d });
});
integrationsRouter.post('/webhooks/run', async (req, res) => res.json(await deliverDue({ force: !!req.body?.force })));
integrationsRouter.get('/webhooks/:id/deliveries', (req, res) => res.json(db.prepare('SELECT id, event, status, attempts, code, error, next_try, created FROM webhook_deliveries WHERE webhook_id=? ORDER BY id DESC LIMIT 100').all(req.params.id)));
integrationsRouter.post('/webhooks/deliveries/:id/retry', (req, res) => {
  const r = db.prepare("UPDATE webhook_deliveries SET status='pending', attempts=0, next_try=?, error=NULL WHERE id=? AND status IN ('failed','pending')").run(new Date().toLocaleString('sv'), req.params.id);
  r.changes ? res.json({ ok: true }) : fail(res, 'Nothing to retry');
});
export { sign };
