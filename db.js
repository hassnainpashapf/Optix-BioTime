import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { existsSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';

export const DB_FILE = process.env.DB_FILE || 'biotime.db';
// Is this file a usable backup of this application? Returns an error message, or null when it is fine.
export function validateBackup(path) {
  try {
    const fd = openSync(path, 'r'), head = Buffer.alloc(16); readSync(fd, head, 0, 16, 0); closeSync(fd);
    if (head.toString('latin1') !== 'SQLite format 3\0') return 'This is not a backup file (not an SQLite database)';
    const t = new DatabaseSync(path, { readOnly: true });
    try {
      const have = new Set(t.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      const missing = ['employees', 'logs', 'users', 'shifts', 'settings'].filter(n => !have.has(n));
      if (missing.length) return `This does not look like a backup of this system (missing: ${missing.join(', ')})`;
      if (t.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') return 'The backup file is damaged';
      if (!t.prepare('SELECT 1 FROM users').get()) return 'The backup has no user accounts';
    } finally { t.close(); }
    return null;
  } catch (e) { return 'Cannot read the file: ' + e.message; }
}
// A restore uploaded earlier is applied here, before the database is opened, so nothing is replaced while in use.
if (DB_FILE !== ':memory:' && existsSync(DB_FILE + '.restore')) {
  const pending = DB_FILE + '.restore';
  try {
    const err = validateBackup(pending); if (err) throw new Error(err);
    if (existsSync(DB_FILE)) renameSync(DB_FILE, `${DB_FILE}.before-restore-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
    rmSync(DB_FILE + '-wal', { force: true }); rmSync(DB_FILE + '-shm', { force: true }); // a stale journal must never be applied to the restored file
    renameSync(pending, DB_FILE);
    console.log('Database restored from the uploaded backup (the previous database was kept as .before-restore-*)');
  } catch (e) { console.error('Restore failed, keeping the current database:', e.message); rmSync(pending, { force: true }); }
}
export const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, pass TEXT, role TEXT DEFAULT 'admin');
CREATE TABLE IF NOT EXISTS departments(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS shifts(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  grace_min INTEGER DEFAULT 10, workdays TEXT DEFAULT '1,2,3,4,5,6');
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  department_id INTEGER REFERENCES departments(id), shift_id INTEGER REFERENCES shifts(id), active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY, name TEXT, ip TEXT, port INTEGER DEFAULT 4370,
  last_sync TEXT, last_status TEXT, sn TEXT UNIQUE, approved INTEGER DEFAULT 1, last_seen TEXT);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, emp_code TEXT NOT NULL, ts TEXT NOT NULL, device_id INTEGER,
  UNIQUE(emp_code, ts));
CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
CREATE TABLE IF NOT EXISTS holidays(id INTEGER PRIMARY KEY, date TEXT UNIQUE NOT NULL, name TEXT);
CREATE TABLE IF NOT EXISTS leave_types(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, paid INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS leaves(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id),
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, type TEXT DEFAULT 'Casual', note TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

// Additive migrations so an existing database keeps working after an upgrade.
const addCol = (t, c, def) => {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
};
addCol('employees', 'salary', 'REAL DEFAULT 0');
addCol('users', 'email', 'TEXT');
addCol('employees', 'join_date', 'TEXT'); // days before this are never counted absent
db.exec(`CREATE TABLE IF NOT EXISTS device_commands(id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  cmd TEXT NOT NULL, status TEXT DEFAULT 'pending', result TEXT, created TEXT DEFAULT (datetime('now','localtime')))`);
db.exec(`
CREATE TABLE IF NOT EXISTS payroll_items(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS payroll_runs(month TEXT PRIMARY KEY, status TEXT NOT NULL, finalized_at TEXT, paid_at TEXT, data TEXT NOT NULL);`);
// ---- HR core: org structure, richer employee profile, lifecycle history, documents, custom fields, audit trail
db.exec(`
CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, company_id INTEGER REFERENCES companies(id), address TEXT);
CREATE TABLE IF NOT EXISTS designations(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS emp_groups(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS emp_history(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, date TEXT, detail TEXT, by_user TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS emp_documents(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  name TEXT NOT NULL, filename TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS custom_fields(id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL, type TEXT NOT NULL DEFAULT 'text', options TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now','localtime')), user TEXT, method TEXT, path TEXT, summary TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);`);
for (const [c, t] of [['company_id', 'INTEGER'], ['branch_id', 'INTEGER'], ['designation_id', 'INTEGER'], ['group_id', 'INTEGER'],
  ['email', 'TEXT'], ['phone', 'TEXT'], ['gender', 'TEXT'], ['dob', 'TEXT'], ['address', 'TEXT'], ['emergency_contact', 'TEXT'],
  ['status', "TEXT DEFAULT 'active'"], ['exit_date', 'TEXT'], ['photo', 'TEXT'], ['custom', 'TEXT']]) addCol('employees', c, t);
addCol('logs', 'source', "TEXT DEFAULT 'device'");
db.exec(`CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id), from_date TEXT NOT NULL, to_date TEXT NOT NULL)`);

// Leave types: quota 0 = not balance-tracked (e.g. Unpaid). accrual: yearly (all at once) or monthly (quota/12 per month).
for (const [c, t] of [['quota', 'REAL DEFAULT 0'], ['accrual', "TEXT DEFAULT 'yearly'"], ['carry_max', 'REAL DEFAULT 0'], ['gender', "TEXT DEFAULT 'any'"], ['approval', 'INTEGER DEFAULT 1']]) addCol('leave_types', c, t);
if (!db.prepare('SELECT 1 FROM leave_types').get()) {
  const ins = db.prepare('INSERT INTO leave_types(name, paid, quota, accrual, carry_max, gender) VALUES(?,?,?,?,?,?)');
  for (const t of [['Casual', 1, 10, 'yearly', 0, 'any'], ['Sick', 1, 8, 'yearly', 0, 'any'], ['Annual', 1, 14, 'monthly', 7, 'any'], ['Unpaid', 0, 0, 'yearly', 0, 'any'],
    ['Maternity', 1, 90, 'yearly', 0, 'female'], ['Paternity', 1, 7, 'yearly', 0, 'male']]) ins.run(...t);
}
db.exec(`
CREATE TABLE IF NOT EXISTS leave_policies(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS leave_policy_items(id INTEGER PRIMARY KEY, policy_id INTEGER NOT NULL REFERENCES leave_policies(id) ON DELETE CASCADE,
  type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE, quota REAL NOT NULL, accrual TEXT DEFAULT 'yearly', carry_max REAL DEFAULT 0, UNIQUE(policy_id, type_id));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, created TEXT DEFAULT (datetime('now','localtime')), audience TEXT NOT NULL,
  employee_id INTEGER, title TEXT NOT NULL, body TEXT, link TEXT, is_read INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS notif_aud ON notifications(audience, is_read);`);
for (const [c, t] of [['status', "TEXT DEFAULT 'approved'"], ['days', 'REAL'], ['half', 'INTEGER DEFAULT 0'], ['applied_by', 'TEXT'], ['applied_at', 'TEXT'],
  ['decided_by', 'TEXT'], ['decided_at', 'TEXT'], ['decision_note', 'TEXT']]) addCol('leaves', c, t);
addCol('employees', 'leave_policy_id', 'INTEGER');

// ---- overtime policies/requests and attendance correction requests
addCol('employees', 'ot_policy_id', 'INTEGER');

// ---- roles and per-user data scope (department / branch / company), saved report definitions
db.exec(`CREATE TABLE IF NOT EXISTS roles(name TEXT PRIMARY KEY, perms TEXT NOT NULL, builtin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS saved_reports(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL, params TEXT NOT NULL, created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')));`);
for (const c of ['scope_departments', 'scope_branches', 'scope_companies']) addCol('users', c, 'TEXT');

// ---- shifts: types, breaks, shift-level rules, rotations, department default, alternates, change/swap requests
for (const [c, t] of [['type', "TEXT DEFAULT 'fixed'"], ['code', 'TEXT'], ['required_min', 'INTEGER'], ['break_start', 'TEXT'], ['break_end', 'TEXT'],
  ['seg2_start', 'TEXT'], ['seg2_end', 'TEXT'], ['alt_off', 'TEXT'], ['late_to_absent_min', 'REAL'], ['half_day_min', 'REAL'], ['ot_policy_id', 'INTEGER']]) addCol('shifts', c, t);
addCol('departments', 'shift_id', 'INTEGER');
addCol('employees', 'rotation_id', 'INTEGER');
addCol('employees', 'rotation_anchor', 'TEXT');
addCol('employees', 'manager_id', 'INTEGER'); // reporting manager: sees and decides requests of their team in the portal

// ---- devices: health, location, groups, communication settings, cards, biometric enrollment
for (const [c, t] of [['location', 'TEXT'], ['group_id', 'INTEGER'], ['delay', 'INTEGER DEFAULT 10'], ['error_delay', 'INTEGER DEFAULT 30'], ['realtime', 'INTEGER DEFAULT 1'],
  ['info', 'TEXT'], ['online', 'INTEGER'], ['last_check', 'TEXT'], ['firmware', 'TEXT']]) addCol('devices', c, t);
addCol('employees', 'card_no', 'TEXT');

// ---- dashboards, visitors, meetings, scheduled notifications, health readings, device IP allow-list
addCol('users', 'dash_prefs', 'TEXT');
addCol('devices', 'allowed_ips', 'TEXT');
for (const [c, t] of [['model', 'TEXT'], ['dtype', 'TEXT'], ['mac', 'TEXT'], ['timezone', 'TEXT'], ['notes', 'TEXT'], ['installed', 'TEXT']]) addCol('devices', c, t);
addCol('logs', 'temp_c', 'REAL');
// ---- device pages: users known to be on each device, per-device offline alert settings
db.exec(`CREATE TABLE IF NOT EXISTS device_users(device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT, card TEXT, seen TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY(device_id, code));`);
for (const [c, t] of [['warranty_until', 'TEXT'], ['next_service', 'TEXT'], ['access_mode', "TEXT DEFAULT 'all'"]]) addCol('devices', c, t); // access_mode: all | selected
db.exec(`CREATE TABLE IF NOT EXISTS device_maint(id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, day TEXT NOT NULL, kind TEXT NOT NULL, note TEXT, cost REAL, by TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS device_access(device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, PRIMARY KEY(device_id, employee_id));`);
addCol('devices', 'alert_min', 'INTEGER');
addCol('device_commands', 'sent', 'TEXT');
addCol('custom_fields', 'uniq', 'INTEGER DEFAULT 0');
addCol('custom_fields', 'enabled', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS cert_types(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL)`);
// ---- short messages shown on the device screen (public: everybody, private: one person)
db.exec(`CREATE TABLE IF NOT EXISTS device_messages(id INTEGER PRIMARY KEY, scope TEXT NOT NULL, employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, content TEXT NOT NULL, start_ts TEXT NOT NULL, duration_min INTEGER NOT NULL DEFAULT 1440, created TEXT DEFAULT (datetime('now','localtime')), last_sent TEXT);`);
// ---- approval workflows: leave / attendance / shift / overtime requests can need several approvers in turn
// Workflow roles (named groups of approvers) and builder rules (a workflow for a department, position or one person, for a period)
db.exec(`CREATE TABLE IF NOT EXISTS wf_roles(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT);
CREATE TABLE IF NOT EXISTS wf_role_members(role_id INTEGER NOT NULL REFERENCES wf_roles(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, PRIMARY KEY(role_id, employee_id));
CREATE TABLE IF NOT EXISTS wf_rules(id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, target_id INTEGER NOT NULL, start_date TEXT, end_date TEXT, kind TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1);`);
db.exec(`CREATE TABLE IF NOT EXISTS workflows(kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, steps TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS wf_progress(kind TEXT NOT NULL, ref_id INTEGER NOT NULL, idx INTEGER, steps TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', started TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY(kind, ref_id));`);
// ---- break times (a saved break can be used by many shifts) and pay codes (short code and pay share of each attendance status)
db.exec(`CREATE TABLE IF NOT EXISTS breaks(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pay_codes(status TEXT PRIMARY KEY, code TEXT NOT NULL, pay_factor REAL NOT NULL DEFAULT 1, label TEXT);`);
addCol('shifts', 'break_id', 'INTEGER');
addCol('shifts', 'pattern', 'TEXT');
addCol('shifts', 'child_of', 'INTEGER');
for (const r of [['Present', 'P', 1], ['Late', 'LT', 1], ['Half Day', 'HD', 0.5], ['Absent', 'A', 0], ['Leave', 'LV', 1], ['Unpaid Leave', 'UL', 0], ['Weekly Off', 'W', 1], ['Holiday', 'H', 1], ['On Duty', 'OD', 1], ['Work From Home', 'WFH', 1],
  ['Training', 'TR', 1], ['Missing Out', 'MO', 1], ['Short Hours', 'SH', 1], ['In progress', 'IP', 1], ['Pending', '-', 1]])
  db.prepare('INSERT OR IGNORE INTO pay_codes(status, code, pay_factor) VALUES(?,?,?)').run(...r);
// ---- phones paired with a login (staff user or employee) to receive alerts
db.exec(`CREATE TABLE IF NOT EXISTS mobile_pair(code TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_devices(id INTEGER PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, label TEXT, created TEXT DEFAULT (datetime('now','localtime')), last_seen TEXT, revoked INTEGER DEFAULT 0);`);
// ---- contracts (type, dates, probation, expiry reminders)
db.exec(`CREATE TABLE IF NOT EXISTS emp_contracts(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, type TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
  probation_end TEXT, notice_days INTEGER, status TEXT NOT NULL DEFAULT 'active', note TEXT, reminded INTEGER, reminded_probation INTEGER, by_user TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS contract_emp ON emp_contracts(employee_id, status);`);
// ---- payroll: salary structure with revisions, statutory (tax / EOBI / social security) flags, bank details, tax slabs, approval
for (const [c, t] of [['tax_exempt', 'INTEGER DEFAULT 0'], ['eobi', 'INTEGER DEFAULT 0'], ['social_scheme', 'TEXT'], ['bank_name', 'TEXT'], ['bank_account', 'TEXT'], ['bank_title', 'TEXT'], ['cnic', 'TEXT'], ['eobi_no', 'TEXT']]) addCol('employees', c, t);
db.exec(`CREATE TABLE IF NOT EXISTS emp_salary(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, effective_from TEXT NOT NULL, basic REAL NOT NULL, components TEXT NOT NULL DEFAULT '[]',
  gross REAL NOT NULL, note TEXT, created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS emp_salary_e ON emp_salary(employee_id, effective_from);
CREATE TABLE IF NOT EXISTS tax_slabs(id INTEGER PRIMARY KEY, lower REAL NOT NULL, upper REAL, fixed REAL NOT NULL DEFAULT 0, rate REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payroll_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS payroll_approvals(month TEXT PRIMARY KEY, status TEXT NOT NULL, submitted_by TEXT, submitted_at TEXT, decided_by TEXT, decided_at TEXT, note TEXT, hash TEXT);`);
// Default salaried-individual slabs (annual income, Rs): the FY 2026-27 schedule as published by tax advisers. They are starting values: check them against the current FBR schedule in Payroll > Tax and contributions.
const SLABS_2627 = [[0, 600000, 0, 0], [600000, 1200000, 0, 1], [1200000, 2200000, 6000, 11], [2200000, 3200000, 116000, 20], [3200000, 4100000, 316000, 25], [4100000, 5600000, 541000, 29], [5600000, 7000000, 976000, 32], [7000000, null, 1424000, 35]];
const SLABS_2526 = [[0, 600000, 0, 0], [600000, 1200000, 0, 1], [1200000, 2200000, 6000, 11], [2200000, 3200000, 116000, 23], [3200000, 4100000, 346000, 30], [4100000, null, 616000, 35]];
const putSlabs = (rows, label) => { db.exec('DELETE FROM tax_slabs'); for (const r of rows) db.prepare('INSERT INTO tax_slabs(lower, upper, fixed, rate) VALUES(?,?,?,?)').run(...r); db.prepare("INSERT INTO payroll_meta(key, value) VALUES('tax_year', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(label); };
if (!db.prepare('SELECT 1 FROM tax_slabs').get()) putSlabs(SLABS_2627, '2026-27 (starting values, please verify)');
else { // a database still holding the untouched 2025-26 starting values moves to the current schedule; anything the admin edited stays
  const cur = JSON.stringify(db.prepare('SELECT lower, upper, fixed, rate FROM tax_slabs ORDER BY lower').all().map(r => [r.lower, r.upper, r.fixed, r.rate]));
  if (cur === JSON.stringify(SLABS_2526)) putSlabs(SLABS_2627, '2026-27 (starting values, please verify)');
}
// ---- automation rules: when <trigger> and <conditions> then <actions>
db.exec(`CREATE TABLE IF NOT EXISTS automations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 1, trigger TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', actions TEXT NOT NULL DEFAULT '[]',
  last_run TEXT, runs INTEGER DEFAULT 0, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS automation_log(id INTEGER PRIMARY KEY, automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE, ts TEXT DEFAULT (datetime('now','localtime')), subject TEXT, outcome TEXT, ok INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS autolog_a ON automation_log(automation_id, id);
CREATE TABLE IF NOT EXISTS automation_seen(automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE, key TEXT NOT NULL, ts TEXT DEFAULT (datetime('now','localtime')), PRIMARY KEY(automation_id, key));`);
// ---- alerts: what each person wants to hear about (owner = 'u:<username>' for staff, 'e:<employee id>' for employees)
addCol('notifications', 'kind', 'TEXT');
for (const [like, kind] of [['Device offline%', 'device_status'], ['Device back online%', 'device_status'], ['Device maintenance%', 'device_service'], ['High temperature%', 'high_temp'], ['Visitor:%', 'visitor'], ['Your visitor%', 'visitor'], ['Leave request:%', 'leave_request'], ['Attendance request:%', 'attendance_request'], ['Shift % request:%', 'shift_request'], ['Your % leave was%', 'leave_decision'], ['Your attendance request%', 'request_decision'], ['Overtime %', 'overtime_decision']])
  db.prepare('UPDATE notifications SET kind=? WHERE kind IS NULL AND title LIKE ?').run(kind, like); // notices made before alert types existed
db.exec(`CREATE TABLE IF NOT EXISTS alert_prefs(owner TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(owner, kind));
CREATE TABLE IF NOT EXISTS alert_opts(owner TEXT PRIMARY KEY, quiet_start TEXT, quiet_end TEXT, watch_mode TEXT DEFAULT 'all');
CREATE TABLE IF NOT EXISTS alert_watch(owner TEXT NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, PRIMARY KEY(owner, employee_id));
CREATE INDEX IF NOT EXISTS notif_kind ON notifications(audience, kind, id);`);
// ---- attendance policies: rules by department / group / branch / employee (NULL field = use the global Settings value)
db.exec(`CREATE TABLE IF NOT EXISTS att_policies(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, min_gap_min REAL, late_to_absent_min REAL, half_day_min REAL, lates_per_deduction REAL,
  grace_extra_min REAL, missing_out_as TEXT);`);
for (const t of ['employees', 'departments', 'emp_groups', 'branches']) addCol(t, 'att_policy_id', 'INTEGER'); // offline after this many minutes (push devices); empty = the global setting
addCol('devices', 'alert_off', 'INTEGER DEFAULT 0'); // 1 = no notifications for this device
addCol('logs', 'mask', 'INTEGER');
db.exec("DELETE FROM logs WHERE emp_code='' OR ts<'2001-01-02'"); try { db.exec("DELETE FROM employees WHERE code=''"); } catch {} // junk records an earlier read took from a device's empty slots
addCol('logs', 'state', 'INTEGER');
for (const c of ['f_deduction', 'f_exception', 'f_increment', 'f_leave', 'f_overtime']) addCol('emp_salary', c, 'INTEGER'); // the formulas a salary structure uses (Payroll > Formula)
addCol('employees', 'updated', 'TEXT'); // when the record last changed (Employee > Update Time)
db.exec("CREATE TRIGGER IF NOT EXISTS emp_touch_ins AFTER INSERT ON employees BEGIN UPDATE employees SET updated=datetime('now','localtime') WHERE id=NEW.id; END; CREATE TRIGGER IF NOT EXISTS emp_touch_upd AFTER UPDATE ON employees WHEN NEW.updated IS OLD.updated BEGIN UPDATE employees SET updated=datetime('now','localtime') WHERE id=NEW.id; END;");
db.exec("UPDATE employees SET updated=COALESCE(join_date || ' 00:00:00', datetime('now','localtime')) WHERE updated IS NULL"); // people saved before this existed
for (const [c, d] of [['verify', 'INTEGER'], ['workcode', 'TEXT'], ['lat', 'REAL'], ['lng', 'REAL']]) addCol('logs', c, d); // how the person was verified (device code), the work code they chose, and where a phone punch was made
for (const [c, d] of [['enable_att', 1], ['enable_schedule', 1], ['enable_holiday', 1], ['enable_ot', 1], ['enable_comp', 0]]) addCol('employees', c, `INTEGER DEFAULT ${d}`); // Employee > Attendance Settings switches // the device's punch code: 0 Check In, 1 Check Out, 2 Break Out, 3 Break In, 4 Overtime In, 5 Overtime Out (empty = not reported)
addCol('devices', 'log_count', 'INTEGER'); // punches the device held at the last full read: unchanged = nothing new to read
addCol('devices', 'log_capacity', 'INTEGER');
addCol('devices', 'dev_serial', 'TEXT'); // serial number the device reports itself (pull devices)
addCol('devices', 'dev_fp', 'INTEGER'); addCol('devices', 'dev_face', 'INTEGER'); // fingerprints and faces the device itself reports (pull devices) // how many punches the device can hold
addCol('devices', 'clock_diff_s', 'INTEGER'); // device clock minus server clock, seconds, at the last read
addCol('devices', 'users_sync', 'TEXT'); // last scheduled directory-only scan of this pull device
addCol('devices', 'brand', 'TEXT'); addCol('devices', 'dev_user', 'TEXT'); addCol('devices', 'dev_pass', 'BLOB'); // other brands: Hikvision / Dahua / Suprema (BioStar 2), reached by their network API
addCol('devices', 'comm_key', 'TEXT'); // the device's Comm Key (password) for pull mode; empty = none
addCol('devices', 'att_device', 'INTEGER DEFAULT 1'); // 0 = access-control only: its punches are not used for attendance
db.exec(`
CREATE TABLE IF NOT EXISTS visitors(id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT, phone TEXT, id_no TEXT, purpose TEXT, host_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  expected_date TEXT, expected_time TEXT, badge_no TEXT, vehicle TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'expected', checked_in TEXT, checked_out TEXT, created_by TEXT,
  created TEXT DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS vis_status ON visitors(status, expected_date);
CREATE TABLE IF NOT EXISTS visitor_blocklist(id INTEGER PRIMARY KEY, name TEXT, id_no TEXT, phone TEXT, reason TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, capacity INTEGER, location TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS meetings(id INTEGER PRIMARY KEY, title TEXT NOT NULL, organizer_id INTEGER REFERENCES employees(id) ON DELETE SET NULL, room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL, place TEXT,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, agenda TEXT, minutes TEXT, status TEXT NOT NULL DEFAULT 'scheduled', created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS meet_time ON meetings(start_ts);
CREATE TABLE IF NOT EXISTS meeting_attendees(meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rsvp TEXT DEFAULT 'pending', attended INTEGER, PRIMARY KEY(meeting_id, employee_id));
CREATE TABLE IF NOT EXISTS notification_rules(id INTEGER PRIMARY KEY, kind TEXT UNIQUE NOT NULL, title TEXT NOT NULL, enabled INTEGER DEFAULT 0, at TEXT NOT NULL, email INTEGER DEFAULT 0, last_run TEXT);`);
addCol('rooms', 'device_id', 'INTEGER');
addCol('rooms', 'remark', 'TEXT');
// the rest of BioTime's Meeting form: topic, time zone, purpose, approval, Zoom switches and the check-in / check-out windows
for (const [c, t] of [['topic', 'TEXT'], ['timezone', "TEXT DEFAULT 'Asia/Karachi'"], ['online', 'INTEGER DEFAULT 0'], ['purpose', 'TEXT'], ['auto_approved', 'INTEGER DEFAULT 1'], ['approval_status', "TEXT DEFAULT 'Approved'"], ['approval_comment', 'TEXT'], ['approver', 'TEXT'], ['approved_at', 'TEXT'],
  ['waiting_room', 'INTEGER DEFAULT 0'], ['join_before_host', 'INTEGER DEFAULT 0'], ['auto_recording', "TEXT DEFAULT 'none'"], ['mute_entry', 'INTEGER DEFAULT 0'], ['host_video', 'INTEGER DEFAULT 0'], ['participant_video', 'INTEGER DEFAULT 0'],
  ['zoom_id', 'TEXT'], ['join_url', 'TEXT'], ['start_url', 'TEXT'], ['zoom_user', 'TEXT'],
  ['checkin_required', 'INTEGER DEFAULT 0'], ['checkin_start', 'TEXT'], ['checkin_end', 'TEXT'], ['checkout_required', 'INTEGER DEFAULT 0'], ['checkout_start', 'TEXT'], ['checkout_end', 'TEXT']]) addCol('meetings', c, t);
db.exec(`CREATE TABLE IF NOT EXISTS meeting_manual_logs(id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, punch_ts TEXT NOT NULL, state TEXT DEFAULT 'Check In', reason TEXT,
  status TEXT DEFAULT 'Pending', comment TEXT, decided_by TEXT, decided_at TEXT, created TEXT DEFAULT (datetime('now','localtime')), created_by TEXT);`);
for (const r of [['absent_summary', 'Daily summary of who is not in yet (to admins)', '11:00'], ['late_alert', 'Late arrivals today (to each person\'s manager)', '10:30'],
  ['missing_punch', 'Reminder to employees who forgot to punch out yesterday', '09:00'], ['leave_pending', 'Leave requests waiting more than 2 days (to managers and admins)', '09:30']])
  db.prepare('INSERT OR IGNORE INTO notification_rules(kind, title, at) VALUES(?,?,?)').run(...r);

// ---- integrations: API keys for other software, webhooks that tell other software what happened
db.exec(`
CREATE TABLE IF NOT EXISTS api_keys(id INTEGER PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, active INTEGER DEFAULT 1,
  created TEXT DEFAULT (datetime('now','localtime')), created_by TEXT, last_used TEXT, requests INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS webhooks(id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '*', active INTEGER DEFAULT 1,
  created TEXT DEFAULT (datetime('now','localtime')), last_status TEXT, failures INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS webhook_deliveries(id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_try TEXT, code INTEGER, error TEXT, created TEXT DEFAULT (datetime('now','localtime')));
CREATE INDEX IF NOT EXISTS wh_due ON webhook_deliveries(status, next_try);`);
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS emp_card ON employees(card_no) WHERE card_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS device_groups(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, branch_id INTEGER);
CREATE TABLE IF NOT EXISTS punch_photos(id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE, emp_code TEXT NOT NULL, ts TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(device_id, emp_code, ts)); -- the picture a device takes at each punch (push devices upload it)
CREATE INDEX IF NOT EXISTS ix_punch_photos ON punch_photos(emp_code, ts);
CREATE TABLE IF NOT EXISTS device_events(id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, ts TEXT DEFAULT (datetime('now','localtime')), kind TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS dev_ev ON device_events(device_id, id);
CREATE TABLE IF NOT EXISTS biodata(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, kind TEXT NOT NULL, fid INTEGER NOT NULL DEFAULT 0,
  size INTEGER, device_id INTEGER, received TEXT DEFAULT (datetime('now','localtime')), data BLOB, UNIQUE(employee_id, kind, fid));`);

// ---- employee self-service portal: accounts, geofence sites, mobile punches, announcements
db.exec(`
CREATE TABLE IF NOT EXISTS employee_accounts(employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE, pass TEXT NOT NULL,
  must_change INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, mobile_enabled INTEGER DEFAULT 1, last_login TEXT, fails INTEGER DEFAULT 0, locked_until TEXT,
  created TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS geo_sites(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, radius_m REAL DEFAULT 150,
  max_accuracy_m REAL DEFAULT 100, branch_id INTEGER, all_employees INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS employee_sites(employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, site_id INTEGER NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE, PRIMARY KEY(employee_id, site_id));
CREATE TABLE IF NOT EXISTS mobile_punches(id INTEGER PRIMARY KEY, log_id INTEGER, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, ts TEXT NOT NULL,
  lat REAL, lng REAL, accuracy REAL, site_id INTEGER, distance_m REAL, inside INTEGER DEFAULT 0, flagged INTEGER DEFAULT 0, note TEXT, device_id TEXT);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, audience TEXT DEFAULT 'all', department_id INTEGER, branch_id INTEGER,
  starts TEXT, ends TEXT, pinned INTEGER DEFAULT 0, created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')));`);
db.exec(`
CREATE TABLE IF NOT EXISTS rotations(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS rotation_steps(id INTEGER PRIMARY KEY, rotation_id INTEGER NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, shift_id INTEGER REFERENCES shifts(id), days INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS employee_shifts(employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, shift_id INTEGER NOT NULL REFERENCES shifts(id), PRIMARY KEY(employee_id, shift_id));
CREATE TABLE IF NOT EXISTS shift_requests(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  other_employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, shift_id INTEGER REFERENCES shifts(id), from_date TEXT NOT NULL, to_date TEXT NOT NULL, reason TEXT,
  status TEXT DEFAULT 'pending', created_by TEXT, created TEXT DEFAULT (datetime('now','localtime')), decided_by TEXT, decided_at TEXT, decision_note TEXT);`);
db.exec(`
CREATE TABLE IF NOT EXISTS ot_policies(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, post INTEGER DEFAULT 1, pre INTEGER DEFAULT 0,
  weekend INTEGER DEFAULT 1, holiday INTEGER DEFAULT 1, min_minutes REAL DEFAULT 30, round_minutes REAL DEFAULT 15,
  mult_work REAL DEFAULT 1.5, mult_weekend REAL DEFAULT 2, mult_holiday REAL DEFAULT 2, daily_max REAL DEFAULT 0, monthly_max REAL DEFAULT 0, approval INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS overtime_requests(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'auto', day_type TEXT, calc_minutes REAL DEFAULT 0, minutes REAL DEFAULT 0, status TEXT DEFAULT 'pending',
  note TEXT, decided_by TEXT, decided_at TEXT, created TEXT DEFAULT (datetime('now','localtime')), UNIQUE(employee_id, date, kind));
CREATE TABLE IF NOT EXISTS attendance_requests(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL, kind TEXT NOT NULL, time TEXT, status_text TEXT, reason TEXT, status TEXT DEFAULT 'pending', created_by TEXT,
  created TEXT DEFAULT (datetime('now','localtime')), decided_by TEXT, decided_at TEXT, decision_note TEXT);
CREATE TABLE IF NOT EXISTS day_overrides(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date TEXT NOT NULL, status TEXT NOT NULL, note TEXT, UNIQUE(employee_id, date));`);

// Attendance + payroll policy (global).
export const DEFAULTS = {
  min_gap_min: 5,          // punches closer than this count as one punch (double tap)
  late_to_absent_min: 0,   // arriving later than this many minutes = Absent (0 = off)
  half_day_min: 0,         // worked less than this many minutes = Half Day (0 = off)
  lates_per_deduction: 0,  // every N lates cost 1 day of pay (0 = off)
  ot_min_minutes: 30,      // overtime below this is ignored
  ot_round_minutes: 15,    // overtime is rounded down to this step
  ot_mult_work: 1.5,       // pay multiplier: after-shift overtime
  ot_mult_weekend: 2,      // pay multiplier: work on weekly off
  ot_mult_holiday: 2,      // pay multiplier: work on public holiday
  ot_pre_shift: 0,         // 1 = early arrival before shift start also counts as overtime
  ot_approval: 0,          // 1 = overtime is paid only after it is approved
  ot_daily_max_min: 0,     // overtime cap per day in minutes (0 = no cap)
  ot_monthly_max_min: 0,   // overtime cap per month in minutes (0 = no cap)
  mtd_unit: 0,             // temperature shown in: 0 = °C, 1 = °F
  mtd_temp_alarm: 1,       // 1 = a high temperature raises an alert
  mtd_mask_alarm: 1,       // 1 = a punch without a mask counts as abnormal
  temp_alert_c: 37.3,      // a body temperature reported by a device at or above this raises an alert (0 = off)
  visitor_max_hours: 8,    // a visitor still signed in after this many hours is shown as overstaying
  monitor_refresh_sec: 10, // the dashboard's Real-Time Monitor reloads this often (kept here so every screen follows the server)
  photo_keep_days: 90,     // punch photos older than this are deleted (0 = keep forever)
  comp_hours_per_day: 8,   // compensatory time off: this many overtime hours earn one day off (employees with Enable Compensatory = Yes)
  comp_expiry_days: 90,    // overtime older than this no longer earns time off (0 = never expires)
  pull_sync_min: 2,        // devices added by IP and port (pull) are read by the server every this many minutes (0 = only when you press Sync)
  device_user_sync_min: 5, // refresh device user names even when its punch count has not changed (0 = only manual sync)
  device_offline_min: 5,   // a device that has not contacted the server for this many minutes is shown as offline
  store_templates: 0,      // 1 = keep fingerprint/face templates reported by devices (encrypted) so they can be copied to other devices
  portal_gps: 2,           // phone punch location: 0 = record only, 1 = accept anywhere but flag outside the site, 2 = must be inside an allowed site
  portal_min_gap_min: 2,   // an employee cannot punch from the phone again within this many minutes
  payroll_approval: 0,     // 1 = a payroll month must be submitted and approved by an admin before it can be finalized
  tax_enabled: 0,          // 1 = income tax is deducted from salary using the slabs (employees marked tax exempt are skipped)
  tax_surcharge_over: 10000000, // annual taxable income above this adds a surcharge on the tax
  tax_surcharge_pct: 9,    // surcharge, percent of the tax
  eobi_wage: 40700,        // wage EOBI contributions are calculated on (the minimum wage; set the figure for your province)
  eobi_rate_employee: 1,   // EOBI, percent of that wage paid by the employee (deducted)
  eobi_rate_employer: 5,   // EOBI, percent paid by the employer (company cost, not deducted)
  sessi_rate: 6, sessi_ceiling: 40000,   // Sindh social security (employer share): percent of wages up to this ceiling
  emp_id_numeric: 0,       // 1 = employee IDs must be numbers
  emp_id_ordered: 0,       // 1 = new employee IDs continue the number sequence (cannot skip or be below the highest)
  pessi_rate: 6, pessi_ceiling: 40000,   // Punjab social security (employer share)
  slip_day: 0,             // payslips reach the employee portal on this day of the month after the pay month (0 = as soon as the month is finalized)
};
export function getSettings() {
  const o = { ...DEFAULTS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) if (r.key in o) o[r.key] = Number(r.value);
  return o;
}
export function setSettings(body) {
  const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of Object.keys(DEFAULTS)) {
    const v = Number(body?.[k]);
    if (body && k in body && Number.isFinite(v) && v >= 0) up.run(k, String(v));
  }
  return getSettings();
}

export const hash = (p) => { const s = randomBytes(16).toString('hex'); return s + ':' + scryptSync(p, s, 32).toString('hex'); };
export const verify = (p, h) => { const [s, k] = h.split(':'); return timingSafeEqual(scryptSync(p, s, 32), Buffer.from(k, 'hex')); };

if (process.env.FIRST_RUN_SETUP !== '1' && !db.prepare('SELECT 1 FROM users').get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users(username,pass) VALUES(?,?)').run('admin', hash(pw));
  console.log(`Default login: admin / ${pw}  (change it)`);
}
