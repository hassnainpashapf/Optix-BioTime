// Shared logging + small key/value settings for the System module (ZKT-style User Log, System Log, Calculation Log, API Request, WhatsApp Log).
// Kept free of heavy imports so api.js, gateway.js, hr.js and server.js can all use it without import cycles.
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS zk_syslog(id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now','localtime')), operation TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'Success', description TEXT);
CREATE TABLE IF NOT EXISTS zk_calclog(id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now','localtime')), task TEXT NOT NULL, started_by TEXT, result TEXT NOT NULL DEFAULT 'Success', employees INTEGER DEFAULT 0, seconds REAL DEFAULT 0, dates TEXT, run_group TEXT, details TEXT, processed_by TEXT);
CREATE TABLE IF NOT EXISTS zk_apireq(id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now','localtime')), user TEXT, path TEXT, method TEXT, ip TEXT, status INTEGER, ms INTEGER);
CREATE INDEX IF NOT EXISTS zk_apireq_ts ON zk_apireq(ts);
CREATE TABLE IF NOT EXISTS zk_walog(id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now','localtime')), emp_code TEXT, phone TEXT, content TEXT, status TEXT NOT NULL, reason TEXT);`);
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
for (const [c, d] of [['ip', 'TEXT'], ['status', 'TEXT'], ['action', 'TEXT'], ['ctype', 'TEXT'], ['object', 'TEXT']]) addCol('audit_log', c, d);

// Extra account data for the User page (first/last name, e-mail, enable switch, 2FA flag, login statistics). The login in server.js stays on the users table.
db.exec(`CREATE TABLE IF NOT EXISTS zk_users(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, first_name TEXT, last_name TEXT, email TEXT, enabled INTEGER NOT NULL DEFAULT 1, twofa INTEGER NOT NULL DEFAULT 0, twofa_secret TEXT,
  date_joined TEXT, last_login TEXT, login_count INTEGER NOT NULL DEFAULT 0, pwd_changed TEXT);`);
db.exec(`CREATE TRIGGER IF NOT EXISTS zk_users_cleanup AFTER DELETE ON users BEGIN DELETE FROM zk_users WHERE user_id=OLD.id; END;`);
addCol('zk_apireq', 'host', 'TEXT'); addCol('zk_apireq', 'error', 'TEXT');
addCol('notifications', 'read_time', 'TEXT'); // the Notification page shows when each one was read
db.exec(`CREATE TRIGGER IF NOT EXISTS zk_notif_read AFTER UPDATE OF is_read ON notifications WHEN NEW.is_read=1 AND OLD.is_read=0 BEGIN UPDATE notifications SET read_time=datetime('now','localtime') WHERE id=NEW.id; END;`);
const now = () => new Date().toLocaleString('sv');
export const sysLog = (operation, result = 'Success', description = '') => { try { db.prepare('INSERT INTO zk_syslog(operation, result, description) VALUES(?,?,?)').run(String(operation).slice(0, 120), result, String(description ?? '').slice(0, 500)); } catch {} };
export const calcLog = ({ task, by = 'system', result = 'Success', employees = 0, seconds = 0, dates = '', group = '', details = '', processedBy = 'system' }) => { try { db.prepare('INSERT INTO zk_calclog(task, started_by, result, employees, seconds, dates, run_group, details, processed_by) VALUES(?,?,?,?,?,?,?,?,?)').run(task, by, result, employees, Math.round(seconds * 1000) / 1000, dates, group, String(details).slice(0, 500), processedBy); } catch {} };
export const waLog = ({ phone, text, status, reason = '', emp_code = null }) => { try { if (!emp_code && phone) { const d = String(phone).replace(/\D/g, '').slice(-9); if (d.length >= 7) emp_code = db.prepare("SELECT code FROM employees WHERE replace(replace(replace(replace(phone,' ',''),'-',''),'+',''),'(','') LIKE ? LIMIT 1").get('%' + d)?.code ?? null; } db.prepare('INSERT INTO zk_walog(emp_code, phone, content, status, reason) VALUES(?,?,?,?,?)').run(emp_code, phone, String(text ?? '').slice(0, 600), status, String(reason).slice(0, 300)); } catch {} };
// A line in the User Log (audit_log) that is not an HTTP write: logins, logouts, failed logins.
export const adminLog = (user, ip, action, ctype, object, status = 'Success', desc = '') => { try { db.prepare('INSERT INTO audit_log(user, method, path, summary, ip, status, action, ctype, object) VALUES(?,?,?,?,?,?,?,?,?)').run(user, 'EVENT', '', desc, ip, status, action, ctype, object); } catch {} };
// Express middleware for the external API (/api/v1): one row per request.
export const apiLog = (req, res, next) => {
  const t0 = Date.now(); let err = null; const j = res.json.bind(res); res.json = (b) => { if (b && typeof b === 'object' && typeof b.error === 'string') err = b.error; return j(b); }; // what went wrong, for the Errors column
  res.on('finish', () => { try { db.prepare('INSERT INTO zk_apireq(user, path, method, ip, status, ms, host, error) VALUES(?,?,?,?,?,?,?,?)').run(req.apiKey?.name ?? null, req.originalUrl.split('?')[0].slice(0, 300), req.method, req.ip, res.statusCode, Date.now() - t0, String(req.headers.host ?? '').slice(0, 120), err ? String(err).slice(0, 300) : null); } catch {} });
  next();
};

// key/value settings (the existing settings table; getSettings() only reads its own known keys so these are separate)
export const kvGet = (k, dflt = null) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get('zk.' + k); if (!r) return dflt; try { return JSON.parse(r.value); } catch { return dflt; } };
export const kvSet = (k, v) => { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('zk.' + k, JSON.stringify(v)); return v; };

// Background Task Setting: is a module's background work switched on? (default on)
export const bgEnabled = (name) => kvGet('bgtask', {})?.[name] !== false;
export const bgRetentionDays = () => Number(kvGet('bgtask', {})?.retention ?? 30) || 30;

// Security Settings (defaults: nothing stricter than before this page existed)
export const SECURITY_DEFAULTS = { single_login: false, failed_locked: false, lock_failed_count: 5, lock_duration: 60, password_level: 1, enforce_pwd_expiration: false, validity_period: 90, session_timeout: 0,
  security_code: false, code_length: 5, valid_duration: 1, failed_times: 0, app_single_user_login: false, app_single_device_login: false, web_2fa_user: false, code_length_2fa: 5, enforce_pwd_change: false, export_encryption: false, backup_encryption: false };
export const security = () => ({ ...SECURITY_DEFAULTS, ...(kvGet('security', {}) ?? {}) });
// Password policy: 1 weak (6+ characters, the old rule), 2 normal (8+, letters and digits), 3 strong (8+, upper, lower, digit, symbol). Returns a message or null.
export function passwordProblem(pw, level = security().password_level) {
  pw = String(pw ?? '');
  if (pw.length < 6) return 'Password needs at least 6 characters';
  if (level >= 2 && !(pw.length >= 8 && /[a-z]/i.test(pw) && /\d/.test(pw))) return 'Password strength is Normal: at least 8 characters with letters and digits';
  if (level >= 3 && !(/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw))) return 'Password strength is Strong: upper and lower case letters, a digit and a symbol';
  return null;
}
// Login lockout per user (Security Settings: lock after N failures for M minutes)
const lockFails = new Map();
export function lockedFor(username) { const s = security(), f = lockFails.get(username); if (!s.failed_locked || !f || f.until <= Date.now()) return 0; return Math.ceil((f.until - Date.now()) / 60000); }
export function loginFailed(username) { const s = security(); if (!s.failed_locked) return; const f = lockFails.get(username) ?? { n: 0, until: 0 }; if (f.until && f.until <= Date.now()) { f.n = 0; f.until = 0; } f.n++; if (f.n >= s.lock_failed_count) { f.n = 0; f.until = Date.now() + s.lock_duration * 60000; sysLog('Account locked', 'Failed', `${username}: ${s.lock_failed_count} wrong passwords, locked for ${s.lock_duration} min`); } lockFails.set(username, f); }
export const loginOk = (username) => lockFails.delete(username);
export const unlockUser = (username) => lockFails.delete(username);
export { now as zkNow };

// ---------- account helpers used by the login in server.js ----------
export const zkUser = (u) => { db.prepare("INSERT OR IGNORE INTO zk_users(user_id, date_joined, pwd_changed) VALUES(?, datetime('now','localtime'), datetime('now','localtime'))").run(u.id); return db.prepare('SELECT * FROM zk_users WHERE user_id=?').get(u.id); };
export const accountDisabled = (u) => !zkUser(u).enabled;
export function loginDone(u, ip) { zkUser(u); db.prepare("UPDATE zk_users SET last_login=datetime('now','localtime'), login_count=login_count+1 WHERE user_id=?").run(u.id); adminLog(u.username, ip, 'Login', 'accounts | User', u.username); }
export const passwordChanged = (userId) => { zkUser({ id: userId }); db.prepare("UPDATE zk_users SET pwd_changed=datetime('now','localtime') WHERE user_id=?").run(userId); };
// Idle session timeout (minutes, 0 = never): true when the session has been unused too long; otherwise stamps it as used.
export function sessionIdle(sess) { const m = security().session_timeout, t = Date.now(); if (m > 0 && sess.last && t - sess.last > m * 60000) return true; sess.last = t; return false; }
