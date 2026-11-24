import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, hash, verify, getSettings, setSettings, DB_FILE, validateBackup } from './db.js';
import { payroll } from './payroll.js';
import { attendanceReport, summarize, dateStr, addDays, PRESENT } from './report.js';
import { syncDevice, saveLogs } from './zk.js';
import { admsRouter } from './adms.js';
import { hrRouter, auditMiddleware } from './hr.js';
import { leaveRouter } from './leave.js';
import { notifyRouter } from './notify.js';
import { alertsRouter } from './alerts.js';
import { mobileRouter, mobileAdminRouter } from './mobile.js';
import { automationRouter, startAutomations } from './automation.js';
import { overtimeRouter, syncOvertimeRequests, needsOtApproval } from './overtime.js';
import { requestsRouter } from './requests.js';
import { reportsRouter } from './reports.js';
import { zkReportsRouter } from './zk-reports.js';
import { shiftsRouter } from './shifts.js';
import { portalRouter, portalAdminRouter } from './portal.js';
import { devicesRouter, startMonitor } from './devices.js';
import { v1, integrationsRouter } from './api.js';
import { monitorRouter } from './monitor.js';
import { visitorsRouter } from './visitors.js';
import { rulesRouter, startRules } from './rules.js';
import { policyRouter } from './policy.js';
import { workflowRouter } from './workflow.js';
import { orgRouter } from './org.js';
import { acRouter } from './ac.js';
import { zkAccessRouter } from './zk-access.js';
import { zkSystemRouter, sysHooks, startSystemJobs } from './zk-system.js';
import { adminLog, lockedFor, loginFailed, loginOk, loginDone, accountDisabled, sessionIdle, passwordProblem, security, passwordChanged } from './zk-log.js';
import { payCodesRouter } from './paycodes.js';
import { hrxRouter, startHr } from './hrx.js';
import { payrollxRouter, approvalState, approvalOk, startPayroll } from './payrollx.js';
import { payformulaRouter } from './payformula.js';
import { meetingsRouter } from './meetings.js';
import { zkpRouter } from './zk-personnel.js';
import { zkdRouter, mobileLog } from './zk-device.js';
import { webauthnRouter } from './webauthn.js';
import { payExtraRouter } from './payextra.js';
import { attSetupRouter } from './zk-attsetup.js';
import { startWebhookWorker, emit } from './events.js';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { effectiveConfig, httpsCredentials, httpHandler, serverConfigRouter } from './server-config.js';
import { authorize, rolesRouter, permsOf, userScope, isScoped, scopeClause, allowedCodes } from './rbac.js';

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : process.env.TRUST_PROXY); // behind a reverse proxy: use the real client address for limits and device allow-lists
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()' });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});
app.use('/api/restore', express.json({ limit: '500mb' })); // a whole database backup arrives as base64
app.use(express.json({ limit: '15mb' })); // photos and documents arrive as base64
app.use('/iclock/fdata', express.raw({ type: '*/*', limit: '8mb' })); // a punch photo is binary JPEG data
app.use(express.text({ type: '*/*', limit: '20mb' })); // ADMS bodies are tab-separated text, not JSON
app.get('/favicon.ico', (_q, res) => res.status(204).end());
app.use('/iclock', admsRouter); // device push endpoints: devices cannot send a login token
app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

const tokens = new Map(); // token -> { user, role, exp }
sysHooks.tokens = tokens;
const TOKEN_MS = 12 * 3600 * 1000;
const fails = new Map(); // ip -> { n, until }
app.get('/api/setup/status', (_req, res) => res.json({ required: process.env.FIRST_RUN_SETUP === '1' && !db.prepare('SELECT 1 FROM users').get() }));
app.post('/api/setup', (req, res) => {
  if (process.env.FIRST_RUN_SETUP !== '1' || db.prepare('SELECT 1 FROM users').get()) return res.status(409).json({ error: 'Setup is already complete' });
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip)) return res.status(403).json({ error: 'Create the first administrator on this computer' });
  const { username, email, password, confirm } = req.body || {};
  const name = String(username || '').trim(), mail = String(email || '').trim(), pw = String(password || '');
  if (!/^[A-Za-z0-9_.-]{3,40}$/.test(name)) return res.status(400).json({ error: 'Username must be 3–40 letters, numbers, dots, dashes or underscores' });
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (pw.length < 10 || pw !== confirm) return res.status(400).json({ error: 'Use a matching password of at least 10 characters' });
  db.prepare('INSERT INTO users(username,pass,role,email) VALUES(?,?,?,?)').run(name, hash(pw), 'admin', mail || null);
  res.json({ ok: true });
});
app.post('/api/login', (req, res) => {
  const f = fails.get(req.ip) ?? { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(body.username ?? ''));
  const locked = u && lockedFor(u.username); // Security Settings: lock an account after repeated wrong passwords
  if (locked) { adminLog(u.username, req.ip, 'Login', 'accounts | User', u.username, 'Failed', 'Account locked'); return res.status(429).json({ error: `This account is locked. Try again in ${locked} minute(s)` }); }
  if (!u || !verify(String(body.password ?? ''), u.pass)) {
    f.n++; if (f.n >= 5) { f.n = 0; f.until = Date.now() + 60000; }
    fails.set(req.ip, f);
    if (u) loginFailed(u.username); adminLog(String(body.username ?? '').slice(0, 60), req.ip, 'Login', 'accounts | User', String(body.username ?? '').slice(0, 60), 'Failed', 'Wrong username or password');
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  if (accountDisabled(u)) { adminLog(u.username, req.ip, 'Login', 'accounts | User', u.username, 'Failed', 'Account disabled'); return res.status(403).json({ error: 'This account is disabled' }); }
  fails.delete(req.ip); loginOk(u.username); loginDone(u, req.ip);
  if (security().single_login) for (const [k, s] of tokens) if (s.user === u.username) tokens.delete(k); // Security Settings: one login per account
  const t = randomBytes(24).toString('hex'); tokens.set(t, { user: u.username, role: u.role, exp: Date.now() + TOKEN_MS, last: Date.now() });
  res.json({ token: t, role: u.role });
});
app.use('/api/v1', v1); // other software: API key, no staff login
app.use('/api/portal', portalRouter);
app.use('/api/m', mobileLog, mobileRouter); // a paired phone: its own token, never a staff token // employee portal: its own login and tokens, never a staff token
app.get('/m', (_q, res) => res.sendFile(fileURLToPath(new URL('./public/m.html', import.meta.url))));
app.get('/portal', (_q, res) => res.sendFile(fileURLToPath(new URL('./public/portal.html', import.meta.url))));
app.use('/api', (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = tokens.get(t);
  if (!sess || sess.exp < Date.now() || sessionIdle(sess)) { tokens.delete(t); return res.status(401).json({ error: 'Login required' }); }
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(sess.user); // role and scope are re-read on every request, so changes apply at once
  if (!row || accountDisabled(row)) { tokens.delete(t); return res.status(401).json({ error: 'Login required' }); }
  req.user = row.username; req.role = row.role; req.userRow = row;
  next();
});
app.use('/api', authorize);
app.use('/api', auditMiddleware);
app.use('/api', rolesRouter);
app.get('/api/me', (req, res) => res.json({ user: req.user, role: req.role, perms: permsOf(req.role), scope: userScope(req.userRow), scoped: isScoped(userScope(req.userRow)) }));
const adminOnly = (req, res, next) => req.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const scopeCols = { departments: 'scope_departments', branches: 'scope_branches', companies: 'scope_companies' };
const scopeJson = (v) => (Array.isArray(v) && v.length ? JSON.stringify(v.map(Number).filter(Number.isFinite)) : null);
const roleExists = (r) => !!db.prepare('SELECT 1 FROM roles WHERE name=?').get(r);
app.get('/api/users', adminOnly, (_q, res) => res.json(db.prepare('SELECT * FROM users ORDER BY id').all().map(u => ({ id: u.id, username: u.username, role: u.role, ...userScope(u) }))));
app.post('/api/users', adminOnly, (req, res) => {
  const { username, password, role } = req.body ?? {};
  if (!username || String(password ?? '').length < 6 || !roleExists(role)) return res.status(400).json({ error: 'Username, password (min 6) and an existing role required' });
  const pp = passwordProblem(password); if (pp) return res.status(400).json({ error: pp });
  try {
    db.prepare('INSERT INTO users(username, pass, role, scope_departments, scope_branches, scope_companies) VALUES(?,?,?,?,?,?)')
      .run(String(username).trim(), hash(String(password)), role, scopeJson(req.body.departments), scopeJson(req.body.branches), scopeJson(req.body.companies));
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Username already exists' }); }
});
app.put('/api/users/:id', adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user' });
  const { username, password, role } = req.body ?? {};
  if (role !== undefined && !roleExists(role)) return res.status(400).json({ error: 'Unknown role' });
  if (role && role !== 'admin' && u.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n < 2) return res.status(400).json({ error: 'Keep at least one admin' });
  if (password !== undefined && String(password).length < 6) return res.status(400).json({ error: 'Password min 6 characters' });
  if (password) { const pp = passwordProblem(password); if (pp) return res.status(400).json({ error: pp }); }
  try {
    if (username) db.prepare('UPDATE users SET username=? WHERE id=?').run(String(username).trim(), u.id);
    if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id);
    if (password) { db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(String(password)), u.id); passwordChanged(u.id); }
    for (const [k, col] of Object.entries(scopeCols)) if (k in req.body) db.prepare(`UPDATE users SET ${col}=? WHERE id=?`).run(scopeJson(req.body[k]), u.id);
  } catch { return res.status(400).json({ error: 'Username already exists' }); }
  if (username || password || role) for (const [t, s] of tokens) if (s.user === u.username) tokens.delete(t); // force re-login with the new details
  res.json({ ok: true });
});
app.delete('/api/users/:id', adminOnly, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'No such user' });
  if (u.username === req.user) return res.status(400).json({ error: 'You cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(u.id);
  for (const [t, s] of tokens) if (s.user === u.username) tokens.delete(t);
  res.json({ ok: true });
});
app.use('/api', hrRouter);
app.use('/api', leaveRouter);
app.use('/api', notifyRouter);
app.use('/api', alertsRouter);
app.use('/api', mobileAdminRouter);
app.use('/api', automationRouter);
app.use('/api', overtimeRouter);
app.use('/api', requestsRouter);
app.use('/api', reportsRouter);
app.use('/api', zkReportsRouter);
app.use('/api', shiftsRouter);
app.use('/api', portalAdminRouter);
app.use('/api', devicesRouter);
app.use('/api', integrationsRouter);
app.use('/api', monitorRouter);
app.use('/api', visitorsRouter);
app.use('/api', rulesRouter);
app.use('/api', policyRouter);
app.use('/api', workflowRouter);
app.use('/api', orgRouter);
app.use('/api', acRouter);
app.use('/api', zkAccessRouter);
app.use('/api', zkSystemRouter);
app.use('/api', attSetupRouter);
app.use('/api', payCodesRouter);
app.use('/api', hrxRouter);
app.use('/api', payrollxRouter);
app.use('/api', payformulaRouter);
app.use('/api', meetingsRouter);
app.use('/api', zkpRouter);
app.use('/api', zkdRouter);
app.use('/api', webauthnRouter);
app.use('/api', payExtraRouter);
app.use('/api', serverConfigRouter);
app.post('/api/password', (req, res) => {
  if (!req.body?.password || req.body.password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  const pp = passwordProblem(req.body.password); if (pp) return res.status(400).json({ error: pp });
  db.prepare('UPDATE users SET pass=? WHERE username=?').run(hash(req.body.password), req.user); passwordChanged(db.prepare('SELECT id FROM users WHERE username=?').get(req.user).id);
  res.json({ ok: true });
});

// Generic CRUD for simple tables
const crud = (path, table, cols, listSql) => {
  app.get(`/api/${path}`, (_q, res) => res.json(db.prepare(listSql || `SELECT * FROM ${table} ORDER BY id`).all()));
  app.post(`/api/${path}`, (req, res) => {
    try {
      const v = cols.map(c => req.body[c] ?? null);
      const r = db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${cols.map(() => '?')})`).run(...v);
      res.json({ id: Number(r.lastInsertRowid) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put(`/api/${path}/:id`, (req, res) => {
    try {
      const present = cols.filter(c => c in req.body);
      db.prepare(`UPDATE ${table} SET ${present.map(c => c + '=?')} WHERE id=?`).run(...present.map(c => req.body[c]), req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${path}/:id`, (req, res) => {
    try { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: 'In use, cannot delete' }); }
  });
};
crud('departments', 'departments', ['name']);
app.delete('/api/leave_types/:id', (req, res, next) => {
  const t = db.prepare('SELECT name FROM leave_types WHERE id=?').get(req.params.id);
  if (t && db.prepare('SELECT COUNT(*) n FROM leaves WHERE type=?').get(t.name).n) return res.status(400).json({ error: 'Leave records use this type' });
  next();
});
crud('leave_types', 'leave_types', ['name', 'paid', 'quota', 'accrual', 'carry_max', 'gender', 'approval']);
crud('leave_policies', 'leave_policies', ['name']);
const OTP = ['name', 'post', 'pre', 'weekend', 'holiday', 'min_minutes', 'round_minutes', 'mult_work', 'mult_weekend', 'mult_holiday', 'daily_max', 'monthly_max', 'approval'];
app.delete('/api/ot_policies/:id', (req, res, next) => (db.prepare('SELECT COUNT(*) n FROM employees WHERE ot_policy_id=?').get(req.params.id).n ? res.status(400).json({ error: 'Assigned to employees. Reassign them first.' }) : next()));
crud('ot_policies', 'ot_policies', OTP);
// Organization rows that employees (or branches) still point to cannot be deleted; those columns have no database-level foreign key.
for (const [path, uses] of [['companies', [['employees', 'company_id'], ['branches', 'company_id']]], ['branches', [['employees', 'branch_id']]],
  ['designations', [['employees', 'designation_id']]], ['emp_groups', [['employees', 'group_id']]]])
  app.delete(`/api/${path}/:id`, (req, res, next) => {
    for (const [t, c] of uses) if (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(req.params.id).n) return res.status(400).json({ error: `In use by ${t}. Reassign them first.` });
    next();
  });
crud('companies', 'companies', ['name']);
crud('branches', 'branches', ['name', 'company_id', 'address'],
  'SELECT b.*, c.name AS company FROM branches b LEFT JOIN companies c ON c.id=b.company_id ORDER BY b.name');
crud('designations', 'designations', ['name']);
crud('emp_groups', 'emp_groups', ['name']);
crud('custom_fields', 'custom_fields', ['label', 'type', 'options', 'uniq', 'enabled']);
app.get('/api/schedules', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT c.*, e.name AS employee, s.name AS shift FROM schedules c JOIN employees e ON e.id=c.employee_id JOIN shifts s ON s.id=c.shift_id WHERE 1=1${sc.sql} ORDER BY from_date DESC`).all(...sc.args));
});
crud('schedules', 'schedules', ['employee_id', 'shift_id', 'from_date', 'to_date']);
crud('holidays', 'holidays', ['date', 'name'], 'SELECT * FROM holidays ORDER BY date DESC');

// Manual import (CSV text "code,YYYY-MM-DD HH:MM[:SS]" per line) for devices that export USB files
app.post('/api/logs/import', (req, res) => {
  const rows = String(req.body?.csv ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [code, ts] = l.split(',').map(s => s.trim());
    return { code, ts: ts?.length === 16 ? ts + ':00' : ts };
  }).filter(r => r.code && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r.ts ?? ''));
  res.json({ parsed: rows.length, added: saveLogs(rows) });
});

// Manual punch for a forgotten / failed scan. Marked source=manual so it can be told apart and removed.
app.post('/api/logs/manual', (req, res) => {
  const { emp_code, ts } = req.body ?? {};
  const t = String(ts ?? '').replace('T', ' ');
  const full = t.length === 16 ? t + ':00' : t;
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(full)) return res.status(400).json({ error: 'Date and time required' });
  if (!db.prepare('SELECT 1 FROM employees WHERE code=?').get(String(emp_code))) return res.status(404).json({ error: 'No such employee' });
  const r = db.prepare("INSERT OR IGNORE INTO logs(emp_code, ts, source) VALUES(?,?,'manual')").run(String(emp_code), full);
  res.json({ added: Number(r.changes) });
});
app.delete('/api/logs/:id', (req, res) => {
  const r = db.prepare("DELETE FROM logs WHERE id=? AND source IN ('manual','mobile')").run(req.params.id);
  r.changes ? res.json({ ok: true }) : res.status(400).json({ error: 'Only manual or phone punches can be deleted' });
});

app.get('/api/logs', (req, res) => {
  const day = req.query.date || dateStr(new Date());
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT l.id, l.ts, l.emp_code, l.source, l.temp_c, l.mask, e.name FROM logs l ${sc.sql ? 'JOIN' : 'LEFT JOIN'} employees e ON e.code=l.emp_code
                       WHERE substr(l.ts,1,10)=?${sc.sql} ORDER BY l.ts DESC LIMIT 500`).all(day, ...sc.args));
});

app.get('/api/settings', (_q, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => res.json(setSettings(req.body)));
// Company stamp (an image printed on payslips): kept in the settings table as a data URL
app.get('/api/payroll/stamp', (_q, res) => res.json({ stamp: db.prepare("SELECT value FROM settings WHERE key='company_stamp'").get()?.value ?? '' }));
app.put('/api/payroll/stamp', (req, res) => {
  const v = String(req.body?.stamp ?? '');
  if (!v) { db.prepare("DELETE FROM settings WHERE key='company_stamp'").run(); return res.json({ stamp: '' }); }
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v)) return res.status(400).json({ error: 'The stamp must be a PNG or JPEG image' });
  if (v.length > 700000) return res.status(400).json({ error: 'The stamp image is too big (500 KB at most)' });
  db.prepare("INSERT INTO settings(key,value) VALUES('company_stamp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v); res.json({ stamp: v });
});

// Restore: validate the uploaded file, queue it, then stop. The next start swaps it in before the database opens.
// (Run the server as a service - launchd KeepAlive / systemd Restart - and it comes straight back.)
app.post('/api/restore', (req, res) => {
  const raw = String(req.body?.data ?? ''), b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'Choose a backup file' });
  const tmp = DB_FILE + '.restore.tmp';
  writeFileSync(tmp, buf);
  const err = validateBackup(tmp);
  if (err) { rmSync(tmp, { force: true }); return res.status(400).json({ error: err }); }
  renameSync(tmp, DB_FILE + '.restore');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  res.json({ ok: true, restart: true, message: 'Backup accepted. The server is restarting to apply it.' });
  res.on('finish', () => setTimeout(() => process.exit(0), 300));
});

app.get('/api/backup', (_q, res) => {
  const f = join(tmpdir(), `biotime-${randomBytes(6).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${f}'`);
  res.download(f, `attendance-backup-${dateStr(new Date())}.db`, () => rmSync(f, { force: true }));
});

const range = (q) => {
  const to = q.to || dateStr(new Date());
  const from = q.from || to.slice(0, 8) + '01';
  return [from, to, { departmentId: q.department_id || null, employeeId: q.employee_id || null, branchId: q.branch_id || null, groupId: q.group_id || null, designationId: q.designation_id || null }];
};
app.get('/api/report/daily', (req, res) => res.json(attendanceReport(...range(req.query))));
app.get('/api/report/summary', (req, res) => res.json(summarize(attendanceReport(...range(req.query)))));

// ---- payroll management: adjustments, finalize (locks a snapshot), mark paid, reopen
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const nowStr = () => new Date().toLocaleString('sv');
const runOf = (m) => db.prepare('SELECT * FROM payroll_runs WHERE month=?').get(m);
function payrollView(m, filter, period) {
  const run = period ? null : runOf(m);
  const needs = !!getSettings().payroll_approval;
  if (run) { const ok = allowedCodes(); return { status: run.status, finalized_at: run.finalized_at, paid_at: run.paid_at, approval_required: needs, approval: approvalState(m), rows: JSON.parse(run.data).filter(r => !ok || ok.has(r.code)) }; }
  return { status: 'draft', approval_required: needs, approval: needs ? approvalState(m) : { status: 'none' }, rows: payroll(m, filter, period) };
}
app.get('/api/payroll/items', (req, res) => {
  if (!MONTH.test(req.query.month ?? '')) return res.status(400).json({ error: 'month=YYYY-MM required' });
  res.json(db.prepare(`SELECT i.id, i.month, i.kind, i.amount, i.note, e.code, e.name AS employee FROM payroll_items i
                       JOIN employees e ON e.id=i.employee_id WHERE i.month=?${scopeClause('e').sql} ORDER BY e.code, i.id`).all(req.query.month, ...scopeClause('e').args));
});
app.post('/api/payroll/items', (req, res) => {
  const { employee_id, month: m, kind, amount, note } = req.body ?? {};
  if (!MONTH.test(m ?? '') || !['allowance', 'bonus', 'deduction', 'advance'].includes(kind) || !(Number(amount) > 0)) return res.status(400).json({ error: 'Month, kind and a positive amount required' });
  if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(employee_id)) return res.status(404).json({ error: 'No such employee' });
  if (runOf(m)) return res.status(400).json({ error: 'Month is finalized. Reopen it first.' });
  res.json({ id: Number(db.prepare('INSERT INTO payroll_items(employee_id, month, kind, amount, note) VALUES(?,?,?,?,?)').run(employee_id, m, kind, Number(amount), note ?? null).lastInsertRowid) });
});
app.delete('/api/payroll/items/:id', (req, res) => {
  const i = db.prepare('SELECT * FROM payroll_items WHERE id=?').get(req.params.id);
  if (i && runOf(i.month)) return res.status(400).json({ error: 'Month is finalized. Reopen it first.' });
  db.prepare('DELETE FROM payroll_items WHERE id=?').run(req.params.id); res.json({ ok: true });
});
app.post('/api/payroll/finalize', (req, res) => {
  if (isScoped()) return res.status(403).json({ error: 'Closing or reopening payroll needs an account without a data scope' });
  const m = req.body?.month;
  if (!MONTH.test(m ?? '')) return res.status(400).json({ error: 'month=YYYY-MM required' });
  if (runOf(m)) return res.status(400).json({ error: 'Already finalized' });
  const rows = payroll(m);
  if (!rows.length) return res.status(400).json({ error: 'No payroll data for this month' });
  if (!rows[0].final && !req.body.force) return res.status(400).json({ error: 'Month is not over yet. Finalize after it ends.' });
  if (!approvalOk(m)) return res.status(400).json({ error: approvalState(m).status === 'stale' ? 'The numbers changed after approval. Submit the month again for approval.' : 'This month must be submitted and approved by an admin before it can be finalized.' });
  db.prepare("INSERT INTO payroll_runs(month, status, finalized_at, data) VALUES(?, 'finalized', ?, ?)").run(m, nowStr(), JSON.stringify(rows));
  emit('payroll.finalized', { month: m, employees: rows.length });
  res.json({ ok: true, employees: rows.length });
});
app.post('/api/payroll/paid', (req, res) => {
  if (isScoped()) return res.status(403).json({ error: 'Closing or reopening payroll needs an account without a data scope' });
  const r = db.prepare("UPDATE payroll_runs SET status='paid', paid_at=? WHERE month=? AND status='finalized'").run(nowStr(), req.body?.month ?? '');
  r.changes ? res.json({ ok: true }) : res.status(400).json({ error: 'Month must be finalized first' });
});
app.post('/api/payroll/reopen', (req, res) => {
  if (isScoped()) return res.status(403).json({ error: 'Closing or reopening payroll needs an account without a data scope' });
  db.prepare('DELETE FROM payroll_runs WHERE month=?').run(req.body?.month ?? ''); res.json({ ok: true });
});

const month = (q) => /^\d{4}-\d\d$/.test(q.month ?? '') ? q.month : dateStr(new Date()).slice(0, 7);
app.get('/api/report/payroll', (req, res) => {
  const q = req.query, DATE = /^\d{4}-\d\d-\d\d$/; let period = null;
  if (q.from || q.to) {
    if (!DATE.test(q.from ?? '') || !DATE.test(q.to ?? '') || q.to < q.from) return res.status(400).json({ error: 'Give a valid Start Date and End Date' });
    if ((Date.parse(q.to) - Date.parse(q.from)) / 864e5 > 61) return res.status(400).json({ error: 'A payroll period can be at most 62 days' });
    period = { from: q.from, to: q.to };
  }
  res.json(payrollView(period ? period.from.slice(0, 7) : month(q), { departmentId: q.department_id || null }, period));
});

app.get('/api/report/:kind.csv', (req, res) => {
  const k = req.params.kind;
  const rows = k === 'payroll' ? payrollView(month(req.query)).rows : k === 'summary' ? summarize(attendanceReport(...range(req.query))) : attendanceReport(...range(req.query));
  if (!rows.length) return res.status(404).send('No data');
  const keys = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').attachment(`${req.params.kind}-report.csv`)
     .send([keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\n'));
});

const req_perms = (r) => r.perms ?? {};
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const UPDATE_REPO = 'hassnainpashapf/Optix-BioTime';
let updateCache = { at: 0, value: null };
const versionParts = (v) => String(v ?? '').replace(/^v/i, '').split('.').map(x => Number.parseInt(x, 10) || 0);
const newerVersion = (a, b) => { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); return false; };
app.get('/api/system/update', async (_q, res) => {
  if (Date.now() - updateCache.at < 10 * 60 * 1000 && updateCache.value) return res.json(updateCache.value);
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { 'User-Agent': 'ZKT-Attendance' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.json({ current: APP_VERSION, available: false, message: 'No published update is available yet.' });
    const rel = await r.json(), asset = (rel.assets ?? []).find(a => /(?:ZKT|OKT)-Setup-.*\.exe$/i.test(a.name));
    const value = { current: APP_VERSION, latest: String(rel.tag_name ?? '').replace(/^v/i, ''), available: newerVersion(rel.tag_name, APP_VERSION), name: rel.name || rel.tag_name, notes: rel.body || '', url: asset?.browser_download_url || rel.html_url, installer: !!asset, published: rel.published_at };
    updateCache = { at: Date.now(), value }; res.json(value);
  } catch (e) { res.json({ current: APP_VERSION, available: false, message: 'Update check unavailable.' }); }
});
app.get('/api/dashboard', (_q, res) => {
  const t = dateStr(new Date());
  const rows = attendanceReport(t, t);
  const c = (s) => rows.filter(r => r.status === s).length;
  if (needsOtApproval()) syncOvertimeRequests(addDays(t, -31), t); // so pending overtime shows up without opening the Overtime page
  const sc = scopeClause('e'), n = (sql, ...x) => db.prepare(sql).get(...x).n, p = req_perms(_q);
  if (p.attendance === 'none') return res.json({ employees: 0, present: 0, late: 0, absent: 0, leave: 0, devices: 0, pending_leaves: 0, pending_overtime: 0, pending_requests: 0, pending_devices: 0 });
  const cnt = (table, where) => n(`SELECT COUNT(*) n FROM ${table} t JOIN employees e ON e.id=t.employee_id WHERE ${where}${sc.sql}`, ...sc.args);
  res.json({ employees: rows.length, present: rows.filter(r => PRESENT.includes(r.status)).length, late: c('Late'),
             absent: c('Absent') + c('Pending'), leave: c('Leave'), devices: p.devices !== 'none' ? n('SELECT COUNT(*) n FROM devices') : 0,
             pending_leaves: p.leave !== 'none' ? cnt('leaves', "t.status='pending'") : 0,
             pending_overtime: p.overtime !== 'none' ? cnt('overtime_requests', "t.status='pending' AND t.kind='auto'") : 0,
             pending_requests: p.attendance !== 'none' ? cnt('attendance_requests', "t.status='pending'") : 0,
             pending_devices: p.devices !== 'none' ? n('SELECT COUNT(*) n FROM devices WHERE approved=0') : 0 });
});

// Daily automatic backup, keep the newest 14.
const BACKUP_DIR = process.env.BACKUP_DIR || 'backups';
function dailyBackup() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const f = join(BACKUP_DIR, `attendance-${dateStr(new Date())}.db`);
    if (!existsSync(f)) db.exec(`VACUUM INTO '${f}'`);
    for (const old of readdirSync(BACKUP_DIR).filter(n => n.endsWith('.db')).sort().slice(0, -14)) rmSync(join(BACKUP_DIR, old));
  } catch (e) { console.error('backup failed:', e.message); }
}

const PORT = process.env.PORT || 8080;
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {   // run directly (not imported by a test); works on Windows and in folders with spaces
  // HTTP and/or HTTPS on the ports chosen under System > Server Setting (server.json); PORT / TLS_CERT / TLS_KEY in the environment still win.
  // Devices push over plain http, so keep HTTP on unless your devices speak https. Phones need https for GPS (employee portal) and the browser fingerprint needs it too.
  const cfg = effectiveConfig();
  if (cfg.http.enabled) http.createServer(httpHandler(app, cfg)).listen(cfg.http.port, () => console.log(`Attendance server on http://localhost:${cfg.http.port}`));
  if (cfg.https.enabled) {
    try { https.createServer(httpsCredentials(cfg), app).listen(cfg.https.port, () => console.log(`Attendance server (https) on https://localhost:${cfg.https.port}`)); }
    catch (e) { console.error('HTTPS could not start:', e.message); if (!cfg.http.enabled) { http.createServer(app).listen(cfg.http.port || 8080, () => console.log('Fell back to http on port ' + (cfg.http.port || 8080))); } }
  }
  dailyBackup(); setInterval(dailyBackup, 3600 * 1000).unref();
  startMonitor(); startWebhookWorker(); startRules(); startAutomations(); startPayroll(); startHr(); startSystemJobs();
}
export { app };
