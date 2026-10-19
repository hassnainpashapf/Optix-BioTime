import express from 'express';
import { mkdirSync, existsSync, readdirSync, statSync, rmSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { db, hash, DB_FILE, validateBackup } from './db.js';
import { MODULES, userScope } from './rbac.js';
import { SCOPES, ENDPOINTS } from './api.js';
import { sendMessage } from './gateway.js';
import { attendanceReport } from './report.js';
import { kvGet, kvSet, sysLog, calcLog, zkUser, passwordProblem, security, SECURITY_DEFAULTS, unlockUser, bgRetentionDays, passwordChanged } from './zk-log.js';
import { integrationRouter, startIntegration } from './zk-integration.js';

// System module in the ZKT layout: users, user groups, API permissions, notifications, backups, migration, logs, settings pages, FTP, bookmarks.
// Everything here is under /api/zk/... (admin only by the default rule in rbac.js) except /api/bookmarks, which every signed-in user may use.
export const zkSystemRouter = express.Router();
export const sysHooks = { tokens: null }; // server.js hands over its session map so changing a password or disabling an account signs the person out
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const txt = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))].slice(0, 2000);
const stamp = () => new Date().toLocaleString('sv');
const dropSessions = (username) => { if (sysHooks.tokens) for (const [t, s] of sysHooks.tokens) if (s.user === username) sysHooks.tokens.delete(t); };
const lim = (q, d = 1000) => Math.min(Math.max(Number(q.limit) || d, 1), 5000);

// ======================= UserGroup (= roles) =======================
zkSystemRouter.get('/zk/modules', (_q, res) => res.json(MODULES));

// ======================= User =======================
const userRows = () => {
  for (const u of db.prepare('SELECT id FROM users').all()) zkUser(u);
  return db.prepare(`SELECT u.id, u.username, u.role, u.scope_departments, u.scope_branches, z.first_name, z.last_name, z.email, z.enabled, z.twofa, z.date_joined, z.last_login, z.login_count FROM users u JOIN zk_users z ON z.user_id=u.id ORDER BY u.id`).all()
    .map(r => ({ ...r, superuser: r.role === 'admin' ? 1 : 0, usergroup: r.role, ...userScope(r) }));
};
zkSystemRouter.get('/zk/users', (_q, res) => res.json(userRows()));
const roleOk = (r) => !!db.prepare('SELECT 1 FROM roles WHERE name=?').get(r);
const scopeJson = (v) => (Array.isArray(v) && v.length ? JSON.stringify(v.map(Number).filter(Number.isFinite)) : null);
const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function userBody(b, existing) {
  const o = {}; let role = existing?.role;
  if (b.superuser !== undefined || b.usergroup !== undefined || b.role !== undefined) {
    const sup = b.superuser !== undefined ? !!b.superuser : existing?.role === 'admin';
    role = sup ? 'admin' : (b.usergroup ?? b.role ?? (existing?.role !== 'admin' ? existing?.role : null));
    if (!role || (!sup && role === 'admin' && b.superuser === false)) return { error: 'Choose a UserGroup (or tick Superuser)' }; if (!roleOk(role)) return { error: 'Unknown UserGroup' };
  }
  if (!existing && !role) return { error: 'Choose a UserGroup (or tick Superuser)' };
  if (b.email !== undefined && !emailOk(String(b.email).trim())) return { error: 'Enter a valid email address' };
  return { role, first: txt(b.first_name, 60), last: txt(b.last_name, 60), email: txt(b.email, 120), has: ['first_name', 'last_name', 'email'].filter(k => k in b) };
}
zkSystemRouter.post('/zk/users', (req, res) => {
  const b = req.body ?? {}, username = String(b.username ?? '').trim();
  if (!/^[\w.@+-]{1,60}$/.test(username)) return fail(res, 'Username: up to 60 letters, digits or . @ + - _');
  if (b.password !== (b.password2 ?? b.password)) return fail(res, 'The two passwords do not match');
  const pp = passwordProblem(b.password); if (pp) return fail(res, pp);
  const u = userBody(b, null); if (u.error) return fail(res, u.error);
  try { db.prepare('INSERT INTO users(username, pass, role, scope_departments, scope_branches, scope_companies) VALUES(?,?,?,?,?,NULL)').run(username, hash(String(b.password)), u.role, scopeJson(b.departments), scopeJson(b.branches)); }
  catch { return fail(res, 'Username already exists'); }
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username); zkUser(row);
  db.prepare('UPDATE zk_users SET first_name=?, last_name=?, email=?, enabled=?, twofa=? WHERE user_id=?').run(u.first, u.last, u.email, b.enabled === false ? 0 : 1, b.twofa ? 1 : 0, row.id);
  if (b.twofa) db.prepare('UPDATE zk_users SET twofa_secret=? WHERE user_id=?').run(randomBytes(10).toString('hex'), row.id);
  sysLog('Create user', 'Success', username); res.json({ id: row.id });
});
zkSystemRouter.put('/zk/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!row) return fail(res, 'No such user', 404);
  const b = req.body ?? {}, u = userBody(b, row); if (u.error) return fail(res, u.error);
  const newRole = u.role ?? row.role;
  if (row.role === 'admin' && newRole !== 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n < 2) return fail(res, 'Keep at least one superuser');
  if (b.enabled === false && row.username === req.user) return fail(res, 'You cannot disable yourself');
  if (b.enabled === false && row.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users u JOIN zk_users z ON z.user_id=u.id WHERE u.role='admin' AND z.enabled=1").get().n < 2) return fail(res, 'Keep at least one enabled superuser');
  if (b.username && String(b.username).trim() !== row.username) { try { db.prepare('UPDATE users SET username=? WHERE id=?').run(String(b.username).trim(), row.id); } catch { return fail(res, 'Username already exists'); } dropSessions(row.username); }
  if (newRole !== row.role) { db.prepare('UPDATE users SET role=? WHERE id=?').run(newRole, row.id); dropSessions(row.username); }
  for (const [k, col] of [['departments', 'scope_departments'], ['branches', 'scope_branches']]) if (k in b) db.prepare(`UPDATE users SET ${col}=? WHERE id=?`).run(scopeJson(b[k]), row.id);
  zkUser(row); const z = db.prepare('SELECT * FROM zk_users WHERE user_id=?').get(row.id);
  db.prepare('UPDATE zk_users SET first_name=?, last_name=?, email=?, enabled=?, twofa=? WHERE user_id=?').run(u.has.includes('first_name') ? u.first : z.first_name, u.has.includes('last_name') ? u.last : z.last_name, u.has.includes('email') ? u.email : z.email,
    b.enabled === undefined ? z.enabled : b.enabled ? 1 : 0, b.twofa === undefined ? z.twofa : b.twofa ? 1 : 0, row.id);
  if (b.twofa && !z.twofa_secret) db.prepare('UPDATE zk_users SET twofa_secret=? WHERE user_id=?').run(randomBytes(10).toString('hex'), row.id);
  if (b.enabled === false) dropSessions(row.username);
  res.json({ ok: true });
});
zkSystemRouter.delete('/zk/users/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!row) return fail(res, 'No such user', 404);
  if (row.username === req.user) return fail(res, 'You cannot delete yourself');
  if (row.role === 'admin' && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n < 2) return fail(res, 'Keep at least one superuser');
  db.prepare('DELETE FROM users WHERE id=?').run(row.id); dropSessions(row.username); sysLog('Delete user', 'Success', row.username); res.json({ ok: true });
});
zkSystemRouter.post('/zk/users/:id/password', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!row) return fail(res, 'No such user', 404);
  const b = req.body ?? {}; if (b.password !== (b.password2 ?? b.password)) return fail(res, 'The two passwords do not match');
  const pp = passwordProblem(b.password); if (pp) return fail(res, pp);
  db.prepare('UPDATE users SET pass=? WHERE id=?').run(hash(String(b.password)), row.id); passwordChanged(row.id); unlockUser(row.username); dropSessions(row.username); sysLog('Change password', 'Success', row.username); res.json({ ok: true });
});
// 2FA: the flag and a secret are stored per user. The login screen has no code prompt yet, so the flag is not enforced at login (see the Security Settings page note).
zkSystemRouter.post('/zk/users/2fa', (req, res) => {
  const l = ids(req.body?.ids); if (!l.length) return fail(res, 'Choose at least one user'); const on = req.body?.enable ? 1 : 0; let n = 0;
  for (const id of l) { const u = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!u) continue; zkUser(u); db.prepare('UPDATE zk_users SET twofa=?, twofa_secret=CASE WHEN ?=1 AND twofa_secret IS NULL THEN ? ELSE twofa_secret END WHERE user_id=?').run(on, on, randomBytes(10).toString('hex'), id); n++; }
  res.json({ updated: n });
});

// ======================= API Permissions (per API key) =======================
zkSystemRouter.get('/zk/api-permissions', (_q, res) => res.json({
  scopes: Object.entries(SCOPES).map(([scope, description]) => ({ scope, description, group: scope.split(':')[0] })), endpoints: ENDPOINTS.map(([method, path, scope, description]) => ({ method, path, scope, description })),
  keys: db.prepare('SELECT id, name, prefix, scopes, active, last_used, requests FROM api_keys ORDER BY id').all().map(k => ({ ...k, scopes: k.scopes ? k.scopes.split(',') : [] })) }));
zkSystemRouter.put('/zk/api-permissions/:id', (req, res) => {
  const k = db.prepare('SELECT * FROM api_keys WHERE id=?').get(req.params.id); if (!k) return fail(res, 'No such API user', 404);
  const sc = [...new Set((Array.isArray(req.body?.scopes) ? req.body.scopes : []).map(String))]; for (const s of sc) if (!(s in SCOPES)) return fail(res, `Unknown permission ${s}`);
  db.prepare('UPDATE api_keys SET scopes=? WHERE id=?').run(sc.join(','), k.id); res.json({ ok: true, scopes: sc });
});

// ======================= Notification (list = existing /notifications; add/delete here) =======================
zkSystemRouter.post('/zk/notifications', (req, res) => {
  const title = txt(req.body?.title, 120), body = txt(req.body?.body, 500); if (!title || !body) return fail(res, 'Event and content are required');
  res.json({ id: Number(db.prepare("INSERT INTO notifications(audience, title, body, kind) VALUES('admin',?,?,'manual')").run(title, body).lastInsertRowid) });
});
zkSystemRouter.delete('/zk/notifications/:id', (req, res) => { db.prepare('DELETE FROM notifications WHERE id=?').run(req.params.id); res.json({ ok: true }); });
zkSystemRouter.post('/zk/notifications/delete', (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM notifications WHERE id=?').run(id).changes); res.json({ deleted: n }); });

// ======================= Backup =======================
db.exec(`CREATE TABLE IF NOT EXISTS zk_backups(id INTEGER PRIMARY KEY, db_type TEXT DEFAULT 'SQLite', db_name TEXT, operator TEXT, ts TEXT, path TEXT, status TEXT, remark TEXT);`);
const BACKUP_DIR = () => process.env.BACKUP_DIR || 'backups';
const ZK_BACKUP_DIR = () => join(BACKUP_DIR(), 'zk');
function makeBackup(operator, remark) {
  const dir = ZK_BACKUP_DIR(); mkdirSync(dir, { recursive: true }); const name = `attendance-${stamp().replace(/[- :]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2')}-${randomBytes(2).toString('hex')}.db`, path = join(dir, name);
  try { db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`); const r = db.prepare('INSERT INTO zk_backups(db_name, operator, ts, path, status, remark) VALUES(?,?,?,?,?,?)').run(basename(DB_FILE), operator, stamp(), path, 'Success', remark);
    sysLog('Database backup', 'Success', `${operator}: ${name}`); return { id: Number(r.lastInsertRowid), path }; }
  catch (e) { db.prepare('INSERT INTO zk_backups(db_name, operator, ts, path, status, remark) VALUES(?,?,?,?,?,?)').run(basename(DB_FILE), operator, stamp(), path, 'Failed', String(e.message).slice(0, 200)); sysLog('Database backup', 'Failed', e.message); throw e; }
}
// the daily backups server.js writes (attendance-YYYY-MM-DD.db) show up in the list as well
function indexDaily() {
  try { const dir = BACKUP_DIR(); if (!existsSync(dir)) return; for (const f of readdirSync(dir).filter(n => /^attendance-\d{4}-\d\d-\d\d\.db$/.test(n))) { const p = join(dir, f);
    if (!db.prepare('SELECT 1 FROM zk_backups WHERE path=?').get(p)) db.prepare('INSERT INTO zk_backups(db_name, operator, ts, path, status, remark) VALUES(?,?,?,?,?,?)').run(basename(DB_FILE), 'system', statSync(p).mtime.toLocaleString('sv'), p, 'Success', 'Daily backup'); } } catch {}
}
zkSystemRouter.get('/zk/backups', (_q, res) => { indexDaily(); res.json(db.prepare('SELECT id, db_type, db_name, operator, ts, path, status, remark FROM zk_backups ORDER BY id DESC LIMIT 500').all().map(r => ({ ...r, exists: existsSync(r.path) }))); });
zkSystemRouter.post('/zk/backups', (req, res) => { try { res.json(makeBackup(req.user, txt(req.body?.remark, 200) ?? 'Manual backup')); } catch (e) { fail(res, 'Backup failed: ' + e.message, 500); } });
zkSystemRouter.delete('/zk/backups/:id', (req, res) => { const r = db.prepare('SELECT * FROM zk_backups WHERE id=?').get(req.params.id); if (r) { try { rmSync(r.path, { force: true }); } catch {} db.prepare('DELETE FROM zk_backups WHERE id=?').run(r.id); } res.json({ ok: true }); });
zkSystemRouter.get('/zk/backups/:id/download', (req, res) => { const r = db.prepare('SELECT * FROM zk_backups WHERE id=?').get(req.params.id); if (!r || !existsSync(r.path)) return fail(res, 'The backup file is gone', 404); res.download(r.path, basename(r.path)); });
zkSystemRouter.post('/zk/backups/restore', (req, res) => { // same mechanism as /api/restore: validate, queue, stop; the next start swaps the file in before the database opens
  const r = db.prepare('SELECT * FROM zk_backups WHERE id=?').get(req.body?.id); if (!r || r.status !== 'Success' || !existsSync(r.path)) return fail(res, 'Choose a backup whose file still exists');
  const tmp = DB_FILE + '.restore.tmp'; copyFileSync(r.path, tmp); const err = validateBackup(tmp); if (err) { rmSync(tmp, { force: true }); return fail(res, err); }
  renameSync(tmp, DB_FILE + '.restore'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sysLog('Database restore', 'Success', `${req.user}: ${basename(r.path)}`);
  res.json({ ok: true, restart: true, message: 'Backup accepted. The server is restarting to apply it.' }); res.on('finish', () => setTimeout(() => process.exit(0), 300));
});
const AUTO_DEFAULT = { enabled: false, frequency: 'daily', time: '02:00', keep: 7 };
zkSystemRouter.get('/zk/backups/auto', (_q, res) => res.json({ ...AUTO_DEFAULT, ...(kvGet('backup_auto', {}) ?? {}) }));
zkSystemRouter.put('/zk/backups/auto', (req, res) => {
  const b = req.body ?? {}, o = { enabled: !!b.enabled, frequency: b.frequency, time: String(b.time ?? ''), keep: Number(b.keep) };
  if (!['daily', 'weekly', 'monthly'].includes(o.frequency)) return fail(res, 'Frequency is daily, weekly or monthly'); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.time)) return fail(res, 'Time is HH:MM');
  if (!(Number.isInteger(o.keep) && o.keep >= 1 && o.keep <= 365)) return fail(res, 'Keep 1 to 365 backups'); kvSet('backup_auto', o); res.json(o);
});
// automatic backup tick (every minute): run once per due period, keep only the newest N of the automatic ones
function autoBackupTick(at = new Date()) {
  const a = { ...AUTO_DEFAULT, ...(kvGet('backup_auto', {}) ?? {}) }; if (!a.enabled) return false;
  const hm = at.toLocaleTimeString('sv').slice(0, 5), day = at.toLocaleDateString('sv'); if (hm < a.time) return false;
  const last = db.prepare("SELECT ts FROM zk_backups WHERE remark LIKE 'Automatic%' AND status='Success' ORDER BY id DESC LIMIT 1").get()?.ts;
  const due = !last || (a.frequency === 'daily' ? last.slice(0, 10) < day : a.frequency === 'weekly' ? Date.parse(day) - Date.parse(last.slice(0, 10)) >= 7 * 86400000 : last.slice(0, 7) < day.slice(0, 7));
  if (!due) return false;
  try { makeBackup('system', 'Automatic backup'); } catch { return false; }
  for (const old of db.prepare("SELECT * FROM zk_backups WHERE remark LIKE 'Automatic%' ORDER BY id DESC").all().slice(a.keep)) { try { rmSync(old.path, { force: true }); } catch {} db.prepare('DELETE FROM zk_backups WHERE id=?').run(old.id); }
  return true;
}
zkSystemRouter.post('/zk/backups/auto/run', (_q, res) => res.json({ ran: autoBackupTick() })); // run the automatic backup now if it is due

// ======================= Database Migrate (from a SQLite database of the other software) =======================
const MIGRATE_ITEMS = ['area', 'department', 'position', 'employee', 'transaction'];
const tableOf = (src, ...names) => names.find(n => src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n));
const colsOf = (src, t) => new Set(src.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
const pick = (row, ...ks) => { for (const k of ks) if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k]; return null; };
function migrateFrom(src, items, period) {
  const out = {}, ci = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
  const upsert = (table, name, code) => { // by code when our table has one, otherwise by name
    if (!name) return null; const useCode = code && ci(table, 'code'); const ex = useCode ? db.prepare(`SELECT id FROM ${table} WHERE code=?`).get(code) ?? db.prepare(`SELECT id FROM ${table} WHERE name=?`).get(name) : db.prepare(`SELECT id FROM ${table} WHERE name=?`).get(name);
    if (ex) return { id: ex.id, created: false }; return { id: Number(useCode ? db.prepare(`INSERT INTO ${table}(name, code) VALUES(?,?)`).run(name, code).lastInsertRowid : db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name).lastInsertRowid), created: true };
  };
  const simple = (label, ours, ...tables) => { const t = tableOf(src, ...tables); if (!t) { out[label] = { skipped: `no ${tables[0]} table in the file` }; return new Map(); } const map = new Map(); let added = 0, existing = 0;
    for (const r of src.prepare(`SELECT * FROM ${t}`).all()) { const name = pick(r, `${label === 'department' ? 'dept' : label}_name`, 'name'), code = pick(r, `${label === 'department' ? 'dept' : label}_code`, 'code'); const u = upsert(ours, txt(name, 100), txt(code, 40)); if (!u) continue; u.created ? added++ : existing++; map.set(String(r.id ?? code), u.id); if (code) map.set('c:' + code, u.id); }
    out[label] = { added, existing }; return map; };
  const want = new Set(items); let areas = new Map(), depts = new Map(), poss = new Map();
  if (want.has('area') || want.has('employee')) areas = simple('area', 'branches', 'personnel_area', 'area'); if (want.has('department') || want.has('employee')) depts = simple('department', 'departments', 'personnel_department', 'department'); if (want.has('position') || want.has('employee')) poss = simple('position', 'designations', 'personnel_position', 'position');
  if (want.has('employee')) {
    const t = tableOf(src, 'personnel_employee', 'employee'); if (!t) out.employee = { skipped: 'no personnel_employee table in the file' }; else {
      let added = 0, existing = 0, failed = 0; const ins = db.prepare('INSERT INTO employees(code, name, department_id, designation_id, branch_id, card_no, join_date, gender, dob, email, active) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const r of src.prepare(`SELECT * FROM ${t}`).all()) { const code = txt(pick(r, 'emp_code', 'code'), 40); if (!code) { failed++; continue; } if (db.prepare('SELECT 1 FROM employees WHERE code=?').get(code)) { existing++; continue; }
        const name = [pick(r, 'first_name'), pick(r, 'last_name')].filter(Boolean).join(' ') || pick(r, 'name') || code, g = String(pick(r, 'gender') ?? '').toUpperCase();
        try { ins.run(code, String(name).trim().slice(0, 100), depts.get(String(pick(r, 'department_id', 'department'))) ?? null, poss.get(String(pick(r, 'position_id', 'position'))) ?? null, areas.get(String(pick(r, 'area_id', 'area'))) ?? null, txt(pick(r, 'card_no'), 40), txt(String(pick(r, 'hire_date', 'join_date') ?? '').slice(0, 10)),
          g === 'M' ? 'Male' : g === 'F' ? 'Female' : txt(pick(r, 'gender'), 10), txt(String(pick(r, 'birthday', 'dob') ?? '').slice(0, 10)), txt(pick(r, 'email'), 120), pick(r, 'is_active') === 0 ? 0 : 1); added++; } catch { failed++; } }
      out.employee = { added, existing, failed }; }
  }
  if (want.has('transaction')) {
    const t = tableOf(src, 'iclock_transaction', 'transaction'); if (!t) out.transaction = { skipped: 'no iclock_transaction table in the file' }; else {
      const from = period?.from ? period.from + ' 00:00:00' : '0000', to = period?.to ? period.to + ' 23:59:59' : '9999'; let added = 0, skipped = 0;
      const ins = db.prepare("INSERT OR IGNORE INTO logs(emp_code, ts, source) VALUES(?,?,'migrated')");
      for (const r of src.prepare(`SELECT * FROM ${t}`).all()) { const ts = String(pick(r, 'punch_time', 'ts') ?? '').replace('T', ' ').slice(0, 19), code = txt(pick(r, 'emp_code'), 40); if (!code || ts.length < 19 || ts < from || ts > to) { skipped++; continue; } added += Number(ins.run(code, ts).changes); }
      out.transaction = { added, skipped }; }
  }
  return out;
}
zkSystemRouter.post('/zk/migrate', (req, res) => {
  const b = req.body ?? {}, dbType = String(b.database_type ?? 'sqlite'); if (dbType !== 'sqlite') return fail(res, `Only SQLite databases can be migrated here (${dbType} needs its driver). Export the data to a SQLite file first.`);
  const items = (Array.isArray(b.items) ? b.items : []).map(String).filter(x => MIGRATE_ITEMS.includes(x)); if (!items.length) return fail(res, 'Choose what to migrate (area, department, position, employee, transaction)');
  const period = b.period ?? {}; for (const k of ['from', 'to']) if (period[k] && !/^\d{4}-\d\d-\d\d$/.test(period[k])) return fail(res, 'Transaction period dates are YYYY-MM-DD');
  let file = null, tmp = null;
  if (b.data) { const raw = String(b.data), buf = Buffer.from(raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64'); if (!buf.length) return fail(res, 'Choose the SQLite file'); tmp = join(tmpdir(), `migrate-${randomBytes(6).toString('hex')}.db`); writeFileSync(tmp, buf); file = tmp; }
  else if (b.sqlite_file) { file = resolve(String(b.sqlite_file)); if (!existsSync(file)) return fail(res, 'That file does not exist on the server'); } else return fail(res, 'Choose the SQLite file');
  let src; try {
    try { src = new DatabaseSync(file, { readOnly: true }); src.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get(); } catch { return fail(res, 'This is not a SQLite database'); }
    const t0 = Date.now(); let r; try { db.exec('BEGIN'); r = migrateFrom(src, items, period); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); sysLog('Database migrate', 'Failed', e.message); return fail(res, 'Migration failed and was rolled back: ' + e.message); }
    sysLog('Database migrate', 'Success', JSON.stringify(r).slice(0, 400)); calcLog({ task: 'Database migrate', by: req.user, employees: r.employee?.added ?? 0, seconds: (Date.now() - t0) / 1000, details: JSON.stringify(r).slice(0, 300) }); res.json({ ok: true, result: r });
  } finally { try { src?.close(); } catch {} if (tmp) rmSync(tmp, { force: true }); }
});

// ======================= Logs =======================
const ACTION = { POST: 'Create', PUT: 'Update', PATCH: 'Update', DELETE: 'Delete', EVENT: '' };
const OBJECT_TYPE = (p) => { const seg = String(p).replace(/^\/api\//, '').split('/').filter(Boolean); return seg[0] ? seg[0].replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) : ''; };
zkSystemRouter.get('/zk/userlog', (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  res.json(db.prepare(`SELECT * FROM audit_log ${q ? 'WHERE user LIKE ? OR path LIKE ? OR summary LIKE ? OR object LIKE ?' : ''} ORDER BY id DESC LIMIT ${lim(req.query, 2000)}`).all(...(q ? [q, q, q, q] : [])).map(r => ({
    id: r.id, user: r.user, ip: r.ip ?? '', ts: r.ts, action: r.action || (ACTION[r.method] ?? r.method), ctype: r.ctype || OBJECT_TYPE(r.path), object: r.object || String(r.path).split('/').filter(Boolean).slice(2).join('/') || '', status: r.status || 'Success', description: r.summary ?? '', method: r.method, path: r.path })));
});
zkSystemRouter.post('/zk/userlog', (req, res) => { const b = req.body ?? {}; if (!txt(b.action, 60)) return fail(res, 'Action required'); db.prepare('INSERT INTO audit_log(user, method, path, summary, ip, status, action, ctype, object) VALUES(?,?,?,?,?,?,?,?,?)').run(req.user, 'EVENT', '', txt(b.description, 400), req.ip, 'Success', txt(b.action, 60), txt(b.ctype, 80), txt(b.object, 120)); res.json({ ok: true }); });
const logTable = (name, table, order = 'id') => {
  zkSystemRouter.delete(`/zk/${name}/:id`, (req, res) => { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
  zkSystemRouter.post(`/zk/${name}/delete`, (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id).changes); res.json({ deleted: n }); });
};
logTable('userlog', 'audit_log'); logTable('syslog', 'zk_syslog'); logTable('calclog', 'zk_calclog'); logTable('apireq', 'zk_apireq'); logTable('walog', 'zk_walog');
const logList = (path, table, order = 'id DESC') => zkSystemRouter.get(path, (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ${lim(req.query, 2000)}`).all()));
logList('/zk/syslog', 'zk_syslog'); logList('/zk/calclog', 'zk_calclog'); logList('/zk/apireq', 'zk_apireq'); logList('/zk/walog', 'zk_walog');
zkSystemRouter.post('/zk/syslog', (req, res) => { const op = txt(req.body?.operation, 120); if (!op) return fail(res, 'Operation required'); sysLog(op, txt(req.body?.result, 20) ?? 'Success', req.body?.description); res.json({ ok: true }); });
// Calculation Log "Add": run the attendance calculation for a period and record the batch
zkSystemRouter.post('/zk/calclog', (req, res) => {
  const b = req.body ?? {}, D = /^\d{4}-\d\d-\d\d$/; if (!D.test(b.from ?? '') || !D.test(b.to ?? '') || b.from > b.to) return fail(res, 'Attendance dates: from and to (YYYY-MM-DD), from not after to');
  if (Date.parse(b.to) - Date.parse(b.from) > 93 * 86400000) return fail(res, 'At most 93 days at a time');
  const t0 = Date.now(); let rows, result = 'Success', details = '';
  try { rows = attendanceReport(b.from, b.to, { departmentId: b.department_id || null }); details = `${rows.length} day record(s) calculated`; } catch (e) { result = 'Failed'; details = e.message; rows = []; }
  const group = b.department_id ? db.prepare('SELECT name FROM departments WHERE id=?').get(b.department_id)?.name ?? '' : 'All employees';
  calcLog({ task: 'Attendance calculation', by: req.user, result, employees: new Set(rows.map(r => r.code)).size, seconds: (Date.now() - t0) / 1000, dates: `${b.from} to ${b.to}`, group, details, processedBy: req.user });
  result === 'Success' ? res.json({ ok: true, records: rows.length }) : fail(res, 'Calculation failed: ' + details, 500);
});
zkSystemRouter.post('/zk/walog', async (req, res) => { // Add: send a WhatsApp message to an employee (by ID) or a number, through the gateway; the attempt is logged either way
  const b = req.body ?? {}, text = txt(b.content, 600); if (!text) return fail(res, 'Content required');
  const e = b.emp_code ? db.prepare('SELECT code, phone FROM employees WHERE code=?').get(String(b.emp_code)) : null; if (b.emp_code && !e) return fail(res, 'No such employee ID', 404);
  const phone = e?.phone ?? b.phone; if (!phone) return fail(res, e ? 'This employee has no phone number' : 'Enter an employee ID or a phone number');
  try { await sendMessage('whatsapp', phone, text); res.json({ ok: true }); } catch (err) { fail(res, err.message, 502); }
});
zkSystemRouter.post('/zk/walog/resend', async (req, res) => {
  const l = ids(req.body?.ids); if (!l.length) return fail(res, 'Choose at least one message'); let sent = 0, failed = 0;
  for (const id of l) { const r = db.prepare('SELECT * FROM zk_walog WHERE id=?').get(id); if (!r?.phone) { failed++; continue; } try { await sendMessage('whatsapp', r.phone, r.content); sent++; } catch { failed++; } }
  res.json({ sent, failed });
});

// ======================= FTP Settings =======================
db.exec(`CREATE TABLE IF NOT EXISTS zk_ftp(id INTEGER PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 21, is_sftp INTEGER NOT NULL DEFAULT 0, username TEXT NOT NULL, password TEXT, ssh_key TEXT);`);
const ftpRow = (r) => ({ id: r.id, host: r.host, port: r.port, is_sftp: r.is_sftp, username: r.username, has_password: !!r.password, ssh_key: r.ssh_key ?? '' });
function cleanFtp(b, old) {
  const host = txt(b.host, 200), user = txt(b.username ?? b.user_name, 100), port = Number(b.port ?? 21); if (!host) return { error: 'Host address required' }; if (!user) return { error: 'Username required' };
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) return { error: 'Port number is 1 to 65535' };
  const given = b.password ?? b.user_password; const pw = given === undefined || given === null || given === '' ? old?.password ?? null : String(given); return { o: { host, port, is_sftp: b.is_sftp && b.is_sftp !== '0' ? 1 : 0, username: user, password: pw ?? null, ssh_key: txt(b.ssh_key ?? b.user_key, 4000) } };
}
zkSystemRouter.get('/zk/ftp', (_q, res) => res.json(db.prepare('SELECT * FROM zk_ftp ORDER BY id').all().map(ftpRow)));
zkSystemRouter.post('/zk/ftp', (req, res) => { const { o, error } = cleanFtp(req.body ?? {}); if (error) return fail(res, error); res.json({ id: Number(db.prepare('INSERT INTO zk_ftp(host, port, is_sftp, username, password, ssh_key) VALUES(?,?,?,?,?,?)').run(o.host, o.port, o.is_sftp, o.username, o.password, o.ssh_key).lastInsertRowid) }); });
zkSystemRouter.put('/zk/ftp/:id', (req, res) => { const old = db.prepare('SELECT * FROM zk_ftp WHERE id=?').get(req.params.id); if (!old) return fail(res, 'No such FTP server', 404); const { o, error } = cleanFtp(req.body ?? {}, old); if (error) return fail(res, error);
  db.prepare('UPDATE zk_ftp SET host=?, port=?, is_sftp=?, username=?, password=?, ssh_key=? WHERE id=?').run(o.host, o.port, o.is_sftp, o.username, o.password, o.ssh_key, old.id); res.json({ ok: true }); });
zkSystemRouter.delete('/zk/ftp/:id', (req, res) => { db.prepare('DELETE FROM zk_ftp WHERE id=?').run(req.params.id); db.prepare('UPDATE zk_exports SET ftp_id=NULL WHERE ftp_id=?').run(req.params.id); res.json({ ok: true }); });

// ======================= Settings pages (stored in the settings table) =======================
const tcp = (host, port, ms = 4000) => new Promise((ok) => { const s = createConnection({ host, port }); const done = (r) => { s.destroy(); ok(r); }; s.setTimeout(ms, () => done({ up: false, why: 'no answer in 4 seconds' })); s.once('connect', () => done({ up: true })); s.once('error', (e) => done({ up: false, why: e.code || e.message })); });
const SECRET = { ldap: ['password'], zoom: ['client_secret'], twilio: ['auth_token'], email: ['password'] };
const DEFAULT = {
  ldap: { host: '', port: 389, username: '', password: '', emp_location: '', emp_auth: false, emp_sync: false, sync_frequency: 1, sync_day: 1, sync_time: '00:00:00', user_location: '', user_auth: false, m_empid: '', m_fname: '', m_lname: '', m_dept: '', m_pos: '', m_email: '', u_username: '', u_fname: '', u_lname: '', u_email: '' },
  zoom: { account_id: '', client_id: '', client_secret: '', zoom_enable: false }, twilio: { mobile: '', account_sid: '', auth_token: '', twilio_enable: false },
  bgtask: { meeting: true, payroll: true, ep: true, access: true, retention: 30 },
  company: { company_name: '', website_title: 'BioTime 9.5', logo_display: 'none', name_display: 'none', ai_enable: true, logo: '' },
  email: { smtp_server: '', port: 25, tls: false, account: '', password: '', account_name: 'BioTime 9.5', enabled: false },
  pdf: { page_size: 'auto', orientation: 'portrait', footer_left: 'page_total', footer_right: 'time' },
  week: { week_start: 'monday' },
  punchstate: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['a' + i, ['Check In', 'Check Out', 'Break Out', 'Break In', 'Overtime In', 'Overtime Out'][i] ?? (i === 15 ? 'Unknown' : String(i))])),
};
const mask = (name, v) => { const o = { ...v }; for (const k of SECRET[name] ?? []) { o['has_' + k] = !!o[k]; o[k] = ''; } return o; };
const getConf = (name) => ({ ...DEFAULT[name], ...(kvGet(name, {}) ?? {}) });
export const twilioConf = () => getConf('twilio');
zkSystemRouter.get('/zk/settings/security', (_q, res) => res.json({ ...security(), defaults: SECURITY_DEFAULTS }));
zkSystemRouter.put('/zk/settings/security', (req, res) => {
  const b = req.body ?? {}, cur = security(), o = { ...cur };
  for (const k of Object.keys(SECURITY_DEFAULTS)) if (k in b) o[k] = typeof SECURITY_DEFAULTS[k] === 'boolean' ? !!b[k] : Number(b[k]);
  const chk = (k, lo, hi, what) => { if (!(Number.isInteger(o[k]) && o[k] >= lo && o[k] <= hi)) return `${what} must be ${lo} to ${hi}`; };
  const err = chk('lock_failed_count', 1, 100, 'Failed login') || chk('lock_duration', 1, 100000, 'Lock duration') || chk('password_level', 1, 3, 'Password strength') || chk('validity_period', 1, 3650, 'Validity duration') || chk('session_timeout', 0, 100000, 'Session timeout') || chk('code_length', 4, 8, 'Length of code') || chk('code_length_2fa', 4, 8, 'Length of code') || chk('valid_duration', 1, 60, 'Valid duration') || chk('failed_times', 0, 100, 'Login failures');
  if (err) return fail(res, err); kvSet('security', o); sysLog('Security settings', 'Success', req.user); res.json(o);
});
zkSystemRouter.get('/zk/settings/:name', (req, res) => { const n = req.params.name; if (!DEFAULT[n]) return fail(res, 'Unknown settings page', 404); res.json(mask(n, getConf(n))); });
zkSystemRouter.put('/zk/settings/:name', (req, res) => {
  const n = req.params.name; if (!DEFAULT[n]) return fail(res, 'Unknown settings page', 404); const b = req.body ?? {}, cur = getConf(n), o = { ...cur };
  for (const k of Object.keys(DEFAULT[n])) { if (!(k in b)) continue; const d = DEFAULT[n][k]; if ((SECRET[n] ?? []).includes(k) && b[k] === '') continue; o[k] = typeof d === 'boolean' ? !!b[k] : typeof d === 'number' ? Number(b[k]) : String(b[k] ?? '').slice(0, k === 'logo' ? 300000 : 300); }
  if (n === 'ldap') { if (o.host === '' && (o.emp_sync || o.emp_auth)) return fail(res, 'Host Address is required'); if (!(Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535)) return fail(res, 'Port Number is 1 to 65535'); if (!/^\d\d:\d\d:\d\d$/.test(o.sync_time)) return fail(res, 'Time is HH:MM:SS'); }
  if (n === 'zoom' && o.zoom_enable && !(o.account_id && o.client_id && o.client_secret)) return fail(res, 'Account ID, Client ID and Client Secret are required to enable Zoom');
  if (n === 'twilio') { if (o.twilio_enable && !(o.mobile && o.account_sid && o.auth_token)) return fail(res, 'Mobile, Account Sid and Auth Token are required to enable Twilio'); if (o.mobile && !/^\+\d{8,15}$/.test(o.mobile)) return fail(res, 'Mobile must be an international number like +15005550006'); }
  if (n === 'bgtask') { for (const k of ['meeting', 'payroll', 'ep', 'access']) o[k] = !!o[k]; if (!(Number.isInteger(o.retention) && o.retention >= 1 && o.retention <= 3650)) return fail(res, 'Task History Retention is 1 to 3650 days'); }
  if (n === 'email') { if (!(Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535)) return fail(res, 'Port is 1 to 65535'); if (o.enabled && !(o.smtp_server && o.account)) return fail(res, 'SMTP Server and Email Account are required to enable e-mail'); }
  if (n === 'company' && o.logo && !/^data:image\/(png|jpeg|gif|webp);base64,/.test(o.logo)) return fail(res, 'The logo must be a PNG, JPG, GIF or WEBP image');
  if (n === 'punchstate') for (const k of Object.keys(o)) if (!String(o[k]).trim()) return fail(res, 'Alias cannot be empty');
  kvSet(n, o); sysLog(`${n} settings`, 'Success', req.user); res.json(mask(n, o));
});
zkSystemRouter.post('/zk/settings/email/test', async (_q, res) => { const c = getConf('email'); if (!c.smtp_server) return fail(res, 'Enter the SMTP server first'); const r = await tcp(c.smtp_server, c.port); r.up ? res.json({ ok: true, message: 'The mail server answered on port ' + c.port }) : fail(res, 'Cannot reach ' + c.smtp_server + ':' + c.port + ' (' + r.why + ')', 502); });
// Alert Settings: which channel carries which event (stored; the alert sender reads the per-user switches in notify.js)
const ALERT_EVENTS = [['Manual Log', 'Attendance', 'Approvals', 1, 1, 0], ['Leave', 'Attendance', 'Approvals', 1, 1, 0], ['Overtime', 'Attendance', 'Approvals', 1, 1, 0], ['Training', 'Attendance', 'Approvals', 1, 1, 0], ['Schedule Adjustment', 'Attendance', 'Approvals', 1, 1, 0], ['Late In', 'Attendance', 'Rule', 1, 1, 0], ['Early Out', 'Attendance', 'Rule', 1, 1, 0], ['Absence', 'Attendance', 'Rule', 1, 1, 0], ['Meeting', 'Meeting', 'Meeting', 1, 0, 0], ['Manual Log', 'Meeting', 'Manual Log', 1, 0, 0], ['Public', 'Device', 'Announcement', 0, 1, 0], ['Private', 'Device', 'Announcement', 0, 1, 0], ['Device Offline & Online', 'Device', 'Device', 1, 0, 0]];
const alertRows = () => { const sv = kvGet('alertcfg', {}) ?? {}; return ALERT_EVENTS.map((e, i) => ({ id: i + 1, event: e[0], module: e[1], sub_module: e[2], email: !!(sv[i + 1]?.email ?? e[3]), app: !!(sv[i + 1]?.app ?? e[4]), sms: !!(sv[i + 1]?.sms ?? e[5]) })); };
zkSystemRouter.get('/zk/alert-settings', (_q, res) => res.json(alertRows()));
zkSystemRouter.put('/zk/alert-settings/:id', (req, res) => {
  const id = Number(req.params.id); if (!(id >= 1 && id <= ALERT_EVENTS.length)) return fail(res, 'Unknown event', 404);
  const sv = kvGet('alertcfg', {}) ?? {}, cur = alertRows()[id - 1], b = req.body ?? {};
  sv[id] = { email: 'email' in b ? !!b.email : cur.email, app: 'app' in b ? !!b.app : cur.app, sms: 'sms' in b ? !!b.sms : cur.sms };
  kvSet('alertcfg', sv); sysLog('Alert settings', 'Success', req.user); res.json(alertRows()[id - 1]);
});
zkSystemRouter.post('/zk/settings/ldap/test', async (_q, res) => { const c = getConf('ldap'); if (!c.host) return fail(res, 'Enter the host address first'); const r = await tcp(c.host, c.port); r.up ? res.json({ ok: true, message: `${c.host}:${c.port} accepts connections` }) : fail(res, `Cannot reach ${c.host}:${c.port} (${r.why})`); });
zkSystemRouter.post('/zk/settings/zoom/test', async (_q, res) => {
  const c = getConf('zoom'); if (!(c.account_id && c.client_id && c.client_secret)) return fail(res, 'Save the Account ID, Client ID and Client Secret first');
  try { const r = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.account_id)}`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64') }, signal: AbortSignal.timeout(10000) });
    r.ok ? res.json({ ok: true, message: 'Zoom accepted the credentials' }) : fail(res, `Zoom answered ${r.status}: check the credentials`); } catch (e) { fail(res, 'Could not reach Zoom: ' + e.message); }
});
zkSystemRouter.post('/zk/settings/twilio/test', async (req, res) => {
  const c = getConf('twilio'); if (!(c.account_sid && c.auth_token)) return fail(res, 'Save the Account Sid and Auth Token first');
  try { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}.json`, { headers: { Authorization: 'Basic ' + Buffer.from(`${c.account_sid}:${c.auth_token}`).toString('base64') }, signal: AbortSignal.timeout(10000) });
    r.ok ? res.json({ ok: true, message: 'Twilio accepted the credentials' }) : fail(res, `Twilio answered ${r.status}: check the Account Sid and Auth Token`); } catch (e) { fail(res, 'Could not reach Twilio: ' + e.message); }
});
// Email templates: one per event kind (subject, switch, text with {macros})
const EVENTS = ['late', 'absent_summary', 'missing_punch', 'leave_request', 'leave_decision', 'attendance_request', 'request_decision', 'overtime_decision', 'contract', 'visitor', 'access', 'device_status'];
const EMAIL_MACROS = ['{event}', '{receiver}', '{employee}', '{date}', '{time}', '{content}'];
const tplAll = () => kvGet('emailtpl', {}) ?? {};
zkSystemRouter.get('/zk/email-templates', (_q, res) => res.json({ macros: EMAIL_MACROS, events: EVENTS.map(e => ({ event: e, subject: '', enable: false, template: '', ...(tplAll()[e] ?? {}) })) }));
zkSystemRouter.put('/zk/email-templates/:event', (req, res) => {
  const ev = req.params.event; if (!EVENTS.includes(ev)) return fail(res, 'Unknown event', 404); const subject = txt(req.body?.subject, 150) ?? '', template = String(req.body?.template ?? '').slice(0, 5000), enable = !!req.body?.enable;
  if (enable && (!subject || !template.trim())) return fail(res, 'Subject and template are required to enable a template'); const all = tplAll(); all[ev] = { subject, enable, template }; kvSet('emailtpl', all); res.json(all[ev]);
});
export const emailTemplate = (event, vars = {}) => { const t = tplAll()[event]; if (!t?.enable) return null; const f = (s) => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m); return { subject: f(t.subject), text: f(t.template) }; };

// ======================= Bookmarks (every signed-in user: own + shared) =======================
db.exec(`CREATE TABLE IF NOT EXISTS zk_bookmarks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, user TEXT NOT NULL, content_type TEXT NOT NULL, filters TEXT, shared INTEGER NOT NULL DEFAULT 0, saved TEXT);`);
zkSystemRouter.get('/bookmarks', (req, res) => res.json(db.prepare('SELECT * FROM zk_bookmarks WHERE user=? OR shared=1 ORDER BY id DESC LIMIT 500').all(req.user).map(r => ({ ...r, mine: r.user === req.user }))));
zkSystemRouter.post('/bookmarks', (req, res) => {
  const b = req.body ?? {}, title = txt(b.title, 80), ct = txt(b.content_type, 80); if (!title) return fail(res, 'Title required'); if (!ct) return fail(res, 'Choose the page to bookmark');
  if (db.prepare('SELECT 1 FROM zk_bookmarks WHERE user=? AND title=?').get(req.user, title)) return fail(res, 'You already have a bookmark with this title');
  res.json({ id: Number(db.prepare('INSERT INTO zk_bookmarks(title, user, content_type, filters, shared, saved) VALUES(?,?,?,?,?,?)').run(title, req.user, ct, txt(b.filters, 1000), b.shared ? 1 : 0, stamp()).lastInsertRowid) });
});
zkSystemRouter.put('/bookmarks/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM zk_bookmarks WHERE id=?').get(req.params.id); if (!r) return fail(res, 'No such bookmark', 404); if (r.user !== req.user && req.role !== 'admin') return fail(res, 'This is not your bookmark', 403);
  const b = req.body ?? {}, title = txt(b.title ?? r.title, 80); if (!title) return fail(res, 'Title required');
  db.prepare('UPDATE zk_bookmarks SET title=?, content_type=?, filters=?, shared=? WHERE id=?').run(title, txt(b.content_type ?? r.content_type, 80), b.filters === undefined ? r.filters : txt(b.filters, 1000), b.shared === undefined ? r.shared : b.shared ? 1 : 0, r.id); res.json({ ok: true });
});
zkSystemRouter.delete('/bookmarks/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM zk_bookmarks WHERE id=?').get(req.params.id); if (!r) return res.json({ ok: true }); if (r.user !== req.user && req.role !== 'admin') return fail(res, 'This is not your bookmark', 403);
  db.prepare('DELETE FROM zk_bookmarks WHERE id=?').run(r.id); res.json({ ok: true });
});

zkSystemRouter.use(integrationRouter);

// ======================= background jobs =======================
function purgeOld() { // Task History Retention: old system/calculation/API/WhatsApp log rows go
  const d = `-${bgRetentionDays()} day`; let n = 0;
  for (const [t, col] of [['zk_syslog', 'ts'], ['zk_calclog', 'ts'], ['zk_apireq', 'ts'], ['zk_walog', 'ts']]) n += Number(db.prepare(`DELETE FROM ${t} WHERE ${col} < datetime('now','localtime', ?)`).run(d).changes);
  return n;
}
export const _purgeOld = purgeOld;
export function startSystemJobs() {
  const tick = () => { try { autoBackupTick(); } catch {} };
  setInterval(tick, 60000).unref(); setTimeout(tick, 5000).unref(); setInterval(() => { try { purgeOld(); } catch {} }, 6 * 3600000).unref();
  startIntegration();
}
