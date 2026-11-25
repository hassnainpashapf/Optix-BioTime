import express from 'express';
import { db, getSettings, setSettings } from './db.js';
import { clean, userCmd, queueCommand, eligibleEmployees } from './devsync.js';
import { notify } from './notify.js';
import { makePairCode } from './mobile.js';
import { dateStr, addDays } from './dates.js';
import { scopeClause } from './rbac.js';
import { setDeviceClock, clearDeviceLogs, syncDevice, sendUsersToDevice, sendFingerprintsToDevice, removeUsersFromDevice, startEnroll, enrolling } from './zk.js';

// ZKT-style Device module: parameters, work codes, bio photos, logs, device commands, message targeting, mobile app and geo-fence pages.
export const zkdRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const stamp = () => new Date().toLocaleString('sv');
const DATE = /^\d{4}-\d\d-\d\d$/;
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))].slice(0, 2000);

addCol('device_commands', 'returned', 'TEXT');
addCol('device_users', 'priv', 'INTEGER DEFAULT 0');
addCol('device_users', 'verify_mode', 'INTEGER DEFAULT 0');
addCol('logs', 'uploaded', 'TEXT');
addCol('geo_sites', 'address', 'TEXT');
addCol('announcements', 'category', 'TEXT');
addCol('announcements', 'employee_id', 'INTEGER');
addCol('announcements', 'system_sender', 'INTEGER DEFAULT 0');
addCol('mobile_devices', 'disabled', 'INTEGER DEFAULT 0');
db.exec(`CREATE TRIGGER IF NOT EXISTS zk_log_up AFTER INSERT ON logs BEGIN UPDATE logs SET uploaded=datetime('now','localtime') WHERE id=NEW.id; END;
CREATE TABLE IF NOT EXISTS zk_devparam(id INTEGER PRIMARY KEY, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, name TEXT NOT NULL, value TEXT, UNIQUE(device_id, name));
CREATE TABLE IF NOT EXISTS zk_workcode(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, last_activity TEXT);
CREATE TABLE IF NOT EXISTS zk_biophoto(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, email TEXT, serial TEXT, user_photo TEXT, bio_photo TEXT, register_time TEXT, remark TEXT, approval_state TEXT DEFAULT 'Pending', approval_time TEXT);
CREATE TABLE IF NOT EXISTS zk_oplog(id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE, tz TEXT, admin TEXT, action TEXT, object TEXT, params TEXT, action_time TEXT, upload_time TEXT);
CREATE TABLE IF NOT EXISTS zk_errlog(id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE, code TEXT, message TEXT, command TEXT, command_id INTEGER, extra TEXT, upload_time TEXT);
CREATE TABLE IF NOT EXISTS zk_uplog(id INTEGER PRIMARY KEY, device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE, event TEXT, content TEXT, count INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, upload_time TEXT);
CREATE TABLE IF NOT EXISTS zk_msg_dev(message_id INTEGER NOT NULL REFERENCES device_messages(id) ON DELETE CASCADE, device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE, PRIMARY KEY(message_id, device_id));
CREATE TABLE IF NOT EXISTS zk_applog(id INTEGER PRIMARY KEY, user TEXT, ts TEXT, path TEXT, method TEXT, ip TEXT, status INTEGER, ms INTEGER, query TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS zk_gps_emp(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, site_id INTEGER NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE, distance REAL, start_date TEXT, end_date TEXT);
CREATE TABLE IF NOT EXISTS zk_gps_dept(id INTEGER PRIMARY KEY, department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE, site_id INTEGER NOT NULL REFERENCES geo_sites(id) ON DELETE CASCADE, distance REAL, start_date TEXT, end_date TEXT);`);

// ---- small recorders other modules (adms.js) call
const upTime = () => stamp();
export function recordUpload(deviceId, event, content, count = 0, errorCount = 0) {
  try { db.prepare('INSERT INTO zk_uplog(device_id, event, content, count, error_count, upload_time) VALUES(?,?,?,?,?,?)').run(deviceId, event, String(content ?? '').slice(0, 300), count, errorCount, upTime()); } catch {}
}
export function recordOp(deviceId, admin, action, object = '', params = '', actionTime = null) {
  try { const tz = db.prepare('SELECT timezone FROM devices WHERE id=?').get(deviceId)?.timezone ?? ''; db.prepare('INSERT INTO zk_oplog(device_id, tz, admin, action, object, params, action_time, upload_time) VALUES(?,?,?,?,?,?,?,?)').run(deviceId, tz, admin, action, String(object).slice(0, 100), String(params).slice(0, 300), actionTime ?? stamp(), upTime()); } catch {}
}
const ERR_TEXT = { '-1': 'The device could not run the command', '-2': 'Parameter error', '-3': 'Command not supported by this device', '-10': 'Data does not exist on the device', '-11': 'Data already exists on the device', '-12': 'The device storage is full' };
export function recordCommandResult(deviceId, cmdId, cmd, ret) {
  try {
    db.prepare("UPDATE device_commands SET returned=datetime('now','localtime') WHERE id=? AND device_id=?").run(cmdId, deviceId);
    if (ret !== '0') db.prepare('INSERT INTO zk_errlog(device_id, code, message, command, command_id, extra, upload_time) VALUES(?,?,?,?,?,?,?)').run(deviceId, ret, ERR_TEXT[ret] ?? `The device returned error ${ret}`, String(cmd ?? '').replace(/(TMP|Content)=\S{20,}/gi, '$1=[hidden]').replace(/\t/g, '  ').slice(0, 300), cmdId, '', upTime());
  } catch {}
}
// commands that failed before this module existed still show in the Error Log
db.exec(`INSERT INTO zk_errlog(device_id, code, message, command, command_id, extra, upload_time)
  SELECT c.device_id, REPLACE(IFNULL(c.result,''),'Return=',''), 'The device returned error ' || REPLACE(IFNULL(c.result,''),'Return=',''), CASE WHEN c.cmd LIKE '%TMP=%' OR c.cmd LIKE '%Content=%' THEN SUBSTR(c.cmd,1,INSTR(c.cmd,char(9))-1) ELSE SUBSTR(REPLACE(c.cmd, char(9), '  '),1,300) END, c.id, '', IFNULL(c.sent, c.created)
  FROM device_commands c WHERE c.status='failed' AND NOT EXISTS (SELECT 1 FROM zk_errlog z WHERE z.command_id=c.id)`);
addCol('zk_applog', 'query', 'TEXT'); addCol('zk_applog', 'error', 'TEXT'); // databases made before these columns existed
// mobile app request log (mounted in front of /api/m)
export function mobileLog(req, res, next) {
  const t0 = Date.now(); let err = null; const j = res.json.bind(res); res.json = (b) => { if (b && typeof b === 'object' && typeof b.error === 'string') err = b.error; return j(b); };
  res.on('finish', () => { try { const q = String(req.originalUrl).split('?')[1] ?? ''; db.prepare('INSERT INTO zk_applog(user, ts, path, method, ip, status, ms, query, error) VALUES(?,?,?,?,?,?,?,?,?)').run(req.user ?? req.me?.name ?? '', stamp(), String(req.originalUrl).split('?')[0].slice(0, 200), req.method, String(req.ip ?? '').replace('::ffff:', ''), res.statusCode, Date.now() - t0, q.replace(/(token|password|pass|code)=[^&]*/gi, '$1=[hidden]').slice(0, 300) || null, err ? String(err).slice(0, 300) : null); db.prepare('DELETE FROM zk_applog WHERE id<(SELECT MAX(id)-5000 FROM zk_applog)').run(); } catch {} });
  next();
}

// ---------- device actions (Data Clean / Data Transfer / Device Menu / Maintain) ----------
const dev = (id) => db.prepare('SELECT * FROM devices WHERE id=?').get(id);
const isPush = (d) => d && d.sn && d.approved;
const isPull = (d) => d && !d.sn && d.ip && d.approved; // reached directly over its IP and port
const ACTIONS = {
  'clear-attlog': { label: 'Clear Attendance Data', cmd: () => 'CLEAR LOG' },
  'set-time': { label: 'Set Time', cmd: () => `SET OPTION DateTime=${stamp()}` },
  'clear-photo': { label: 'Clear the captured image', cmd: () => 'CLEAR PHOTO' },
  'clear-admin': { label: 'Clear administrator privilege', each: (d) => db.prepare('SELECT code, name, card FROM device_users WHERE device_id=? AND priv>0').all(d.id).map(u => userCmd(u.code, u.name, u.card ?? '')) },
  'clear-all': { label: 'Clear All Data', cmd: () => 'CLEAR DATA' },
  'upload-users': { label: 'Upload User Data', cmd: () => 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*' },
  'upload-tx': { label: 'Upload Transaction', cmd: (_d, a) => { const to = DATE.test(a.to ?? '') ? a.to : dateStr(new Date()), from = DATE.test(a.from ?? '') ? a.from : addDays(to, -365); return `DATA QUERY ATTLOG StartTime=${from} 00:00:00\tEndTime=${to} 23:59:59`; } },
  'sync-to-device': { label: 'Sync Data to the Device', each: (d) => eligibleEmployees(d).map(e => userCmd(e.code, e.name, e.card_no)) },
  reboot: { label: 'Reboot', cmd: () => 'REBOOT' },
  info: { label: 'Read Information', cmd: () => 'INFO' },
  'enroll-remote': { label: 'Enroll Remotely', cmd: (_d, a) => { const pin = clean(a.pin); if (!pin) throw new Error('Enter the employee ID to enroll'); return `ENROLL_FP PIN=${pin}\tFID=${Number(a.fid) || 0}\tRETRY=3\tOVERWRITE=1`; } },
  'dup-punch': { label: 'Duplicate Punch Period', cmd: (_d, a) => { const n = Number(a.minutes); if (!(n >= 0 && n <= 999)) throw new Error('Enter 0 to 999 minutes'); return `SET OPTION DuplicatePunchPeriod=${Math.floor(n)}`; } },
  'capture-setting': { label: 'Capture Setting', cmd: (_d, a) => `SET OPTION CameraOpen=${a.on === false || a.on === 0 || a.on === '0' ? 0 : 1}` },
  upgrade: { label: 'Upgrade Firmware', cmd: (_d, a) => { const url = clean(a.url); if (!/^https?:\/\/\S+$/.test(url)) throw new Error('Enter the http(s) address of the firmware file'); return `UPGRADE checksum=${clean(a.checksum)},url=${url},size=${Number(a.size) || 0}`; } },
  dst: { label: 'Daylight Saving Time', cmd: (_d, a) => `SET OPTION DSTOn=${a.on === false || a.on === 0 || a.on === '0' ? 0 : 1}` },
  'punch-state': { label: 'Punch State Change Setting', cmd: (_d, a) => `SET OPTION PunchStateAuto=${a.on === false || a.on === 0 || a.on === '0' ? 0 : 1}` },
  'download-file': { label: 'Download File', cmd: (_d, a) => { const p = clean(a.path); if (!p) throw new Error('Enter the file name to fetch'); return `GET FILE ${p}`; } },
  'set-option': { label: 'Set Option', cmd: (_d, a) => { const n = clean(a.name), v = clean(a.value); if (!/^[A-Za-z0-9_.]{1,60}$/.test(n)) throw new Error('Option name: letters, digits, dot or underscore'); return `SET OPTION ${n}=${v}`; } },
};
zkdRouter.post('/zkd/devices/action', async (req, res) => {
  const b = req.body ?? {}, act = ACTIONS[b.action], list = ids(b.ids);
  if (!act) return fail(res, 'Unknown action'); if (!list.length) return fail(res, 'Select at least one device');
  let done = 0, skipped = 0, queued = 0, direct = 0;
  try {
    for (const id of list) {
      const d = dev(id);
      if (d && !d.sn && d.ip && d.approved && ['clear-attlog', 'set-time', 'upload-users', 'upload-tx', 'sync-to-device'].includes(b.action)) { // a pull device is reached directly, not through the command queue
        try { if (b.action === 'set-time') await setDeviceClock(d); else if (b.action === 'upload-users' || b.action === 'upload-tx') await syncDevice(d, true); else if (b.action === 'sync-to-device') { const ppl = eligibleEmployees(d).map(e => ({ code: e.code, name: e.name, card: e.card_no })); if (ppl.length) { await sendUsersToDevice(d, ppl); if (getSettings().store_templates) await sendFingerprintsToDevice(d, ppl); } } else await clearDeviceLogs(d); recordOp(d.id, req.user, act.label, d.name, ''); direct++; } catch (e) { return fail(res, `${d.name}: ${e.message}`); }
        continue;
      }
      if (!isPush(d)) { skipped++; continue; }
      const cmds = act.each ? act.each(d) : [act.cmd(d, b.args ?? {})];
      for (const c of cmds) { queueCommand(d.id, c); queued++; }
      recordOp(d.id, req.user, act.label, d.name, JSON.stringify(b.args ?? {}).slice(0, 200)); done++;
    }
  } catch (e) { return fail(res, e.message); }
  res.json({ done, skipped, queued, direct });
});

// ---------- device commands ----------
zkdRouter.post('/zkd/commands', (req, res) => {
  const b = req.body ?? {}, list = ids(b.device_ids), cmd = String(b.cmd ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 2000);
  if (!list.length) return fail(res, 'Choose at least one device'); if (!cmd) return fail(res, 'Write the command');
  const out = []; for (const id of list) { const d = dev(id); if (!d) continue; if (!d.sn) return fail(res, `${d.name} is a pull device: commands only work for push devices`); out.push(queueCommand(d.id, cmd.replace(/\\t/g, '\t'))); }
  if (!out.length) return fail(res, 'No such device'); res.json({ ids: out });
});
const SCOPE_W = { queue: "status IN ('pending','sent','cancelled')", log: "status IN ('done','failed')" };
zkdRouter.post('/zkd/commands/clear-all', (req, res) => res.json({ cleared: Number(db.prepare(`DELETE FROM device_commands${SCOPE_W[req.body?.scope] ? ' WHERE ' + SCOPE_W[req.body.scope] : ''}`).run().changes) }));
zkdRouter.post('/zkd/commands/bulk-delete', (req, res) => {
  const before = req.body?.before; if (!DATE.test(before ?? '')) return fail(res, 'Choose a date: commands committed before it are removed');
  res.json({ cleared: Number(db.prepare(`DELETE FROM device_commands WHERE substr(created,1,10)<?${SCOPE_W[req.body?.scope] ? ' AND ' + SCOPE_W[req.body.scope] : ''}`).run(before).changes) });
});
zkdRouter.post('/zkd/commands/delete', (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM device_commands WHERE id=?').run(id).changes); res.json({ cleared: n }); });
zkdRouter.get('/zkd/commands', (req, res) => { // scope=queue (waiting or fetched) | log (answered) | all
  const sc = req.query.scope, w = sc === 'queue' ? "WHERE c.status IN ('pending','sent','cancelled')" : sc === 'log' ? "WHERE c.status IN ('done','failed')" : '';
  res.json(db.prepare(`SELECT c.id, c.device_id, d.name AS device, d.sn, c.cmd, c.status, c.result, c.created, c.sent, c.returned FROM device_commands c JOIN devices d ON d.id=c.device_id ${w} ORDER BY c.id DESC LIMIT 1000`).all()
    .map(c => ({ ...c, cmd: String(c.cmd).replace(/TMP=(\{\{bio:\d+\}\}|[A-Za-z0-9+/=]{20,})/g, 'TMP=[template]').replace(/Passwd=[^\t\r\n]+/g, 'Passwd=[hidden]').replace(/Content=[A-Za-z0-9+/=]{40,}/g, 'Content=[photo]').replace(/\t/g, '  '), value: String(c.result ?? '').replace('Return=', '') })));
});

// ---------- device parameters ----------
const PARAM_SQL = 'SELECT p.id, p.device_id, p.name, p.value, d.name AS device, d.sn FROM zk_devparam p JOIN devices d ON d.id=p.device_id ORDER BY d.name, p.name';
zkdRouter.get('/zkd/params', (_q, res) => res.json(db.prepare(PARAM_SQL).all()));
zkdRouter.post('/zkd/params', (req, res) => {
  const b = req.body ?? {}, d = dev(Number(b.device_id)), name = txt(b.name, 60), value = String(b.value ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200);
  if (!d) return fail(res, 'Choose a device'); if (!name || !/^[A-Za-z0-9_.]+$/.test(name)) return fail(res, 'Name: letters, digits, dot or underscore');
  db.prepare('INSERT INTO zk_devparam(device_id, name, value) VALUES(?,?,?) ON CONFLICT(device_id, name) DO UPDATE SET value=excluded.value').run(d.id, name, value);
  let command = null; if (b.push && isPush(d)) command = queueCommand(d.id, `SET OPTION ${name}=${value}`);
  res.json({ ok: true, command });
});
zkdRouter.put('/zkd/params/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM zk_devparam WHERE id=?').get(req.params.id); if (!p) return fail(res, 'Not found', 404);
  const value = String(req.body?.value ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200); db.prepare('UPDATE zk_devparam SET value=? WHERE id=?').run(value, p.id);
  const d = dev(p.device_id); let command = null; if (req.body?.push && isPush(d)) command = queueCommand(d.id, `SET OPTION ${p.name}=${value}`); res.json({ ok: true, command });
});
zkdRouter.delete('/zkd/params/:id', (req, res) => { db.prepare('DELETE FROM zk_devparam WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------- work codes ----------
zkdRouter.get('/zkd/workcodes', (_q, res) => res.json(db.prepare('SELECT * FROM zk_workcode ORDER BY CAST(code AS INTEGER), code').all()));
zkdRouter.post('/zkd/workcodes', (req, res) => {
  const code = txt(req.body?.code, 10), name = txt(req.body?.name, 60); if (!code || !/^\d{1,8}$/.test(code)) return fail(res, 'Code must be a number (up to 8 digits)'); if (!name) return fail(res, 'Name required');
  try { res.json({ id: Number(db.prepare('INSERT INTO zk_workcode(code, name) VALUES(?,?)').run(code, name).lastInsertRowid) }); } catch { fail(res, 'This code already exists'); }
});
zkdRouter.put('/zkd/workcodes/:id', (req, res) => {
  const code = txt(req.body?.code, 10), name = txt(req.body?.name, 60); if (!code || !/^\d{1,8}$/.test(code)) return fail(res, 'Code must be a number (up to 8 digits)'); if (!name) return fail(res, 'Name required');
  try { const r = db.prepare('UPDATE zk_workcode SET code=?, name=? WHERE id=?').run(code, name, req.params.id); r.changes ? res.json({ ok: true }) : fail(res, 'Not found', 404); } catch { fail(res, 'This code already exists'); }
});
zkdRouter.delete('/zkd/workcodes/:id', (req, res) => { db.prepare('DELETE FROM zk_workcode WHERE id=?').run(req.params.id); res.json({ ok: true }); });
zkdRouter.post('/zkd/workcodes/send', (req, res) => { // action: send | remove, to every approved push device (or the chosen ones)
  const list = ids(req.body?.ids), op = req.body?.action === 'remove' ? 'remove' : 'send', want = ids(req.body?.device_ids);
  if (!list.length) return fail(res, 'Tick at least one work code');
  const devs = db.prepare('SELECT id, name FROM devices WHERE sn IS NOT NULL AND approved=1').all().filter(d => !want.length || want.includes(d.id)); if (!devs.length) return fail(res, 'No approved push device to send to');
  let n = 0;
  for (const id of list) {
    const w = db.prepare('SELECT * FROM zk_workcode WHERE id=?').get(id); if (!w) continue;
    for (const d of devs) { queueCommand(d.id, op === 'send' ? `DATA UPDATE WORKCODE PIN=${clean(w.code)}\tCODE=${clean(w.code)}\tNAME=${clean(w.name)}` : `DATA DELETE WORKCODE CODE=${clean(w.code)}`); n++; }
    if (op === 'send') db.prepare('UPDATE zk_workcode SET last_activity=? WHERE id=?').run(stamp(), id);
  }
  res.json({ queued: n, devices: devs.length });
});

// ---------- bio templates (read-only) ----------
zkdRouter.get('/zkd/biotemplates', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT b.id, e.code, e.name, b.kind, b.fid, d.sn, d.name AS device, b.received FROM biodata b JOIN employees e ON e.id=b.employee_id LEFT JOIN devices d ON d.id=b.device_id WHERE 1=1${sc.sql} ORDER BY b.received DESC, b.id DESC LIMIT 2000`).all(...sc.args)
    .map(r => ({ ...r, type: r.kind === 'fp' ? 'Fingerprint' : r.kind === 'face' ? 'Face' : r.kind === 'palm' ? 'Palm' : r.kind, major: r.kind === 'fp' ? '10' : r.kind === 'face' ? '7' : '', minor: r.kind === 'fp' ? '0' : r.kind === 'face' ? '0' : '' })));
});

// ---------- bio photos ----------
const IMG = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
zkdRouter.get('/zkd/biophotos', (_q, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`SELECT z.id, z.employee_id, e.code, e.name, z.email, z.serial, CASE WHEN LENGTH(z.user_photo)<400000 THEN z.user_photo END AS user_photo, CASE WHEN LENGTH(z.bio_photo)<400000 THEN z.bio_photo END AS bio_photo, z.register_time, z.remark, z.approval_state, z.approval_time
    FROM zk_biophoto z JOIN employees e ON e.id=z.employee_id WHERE 1=1${sc.sql} ORDER BY z.id DESC LIMIT 1000`).all(...sc.args));
});
zkdRouter.post('/zkd/biophotos', (req, res) => {
  const b = req.body ?? {}, e = b.employee_id ? db.prepare('SELECT * FROM employees WHERE id=?').get(Number(b.employee_id)) : db.prepare('SELECT * FROM employees WHERE code=?').get(String(b.code ?? ''));
  if (!e) return fail(res, 'No such employee');
  for (const k of ['user_photo', 'bio_photo']) if (b[k] && (!IMG.test(b[k]) || b[k].length > 3e6)) return fail(res, 'Photos must be JPEG or PNG under 2 MB');
  if (!b.bio_photo) return fail(res, 'Choose the bio photo');
  const id = Number(db.prepare('INSERT INTO zk_biophoto(employee_id, email, serial, user_photo, bio_photo, register_time, remark) VALUES(?,?,?,?,?,?,?)').run(e.id, txt(b.email ?? e.email, 100), txt(b.serial, 40), b.user_photo ?? null, b.bio_photo, stamp(), txt(b.remark, 200)).lastInsertRowid);
  res.json({ id });
});
zkdRouter.delete('/zkd/biophotos/:id', (req, res) => { db.prepare('DELETE FROM zk_biophoto WHERE id=?').run(req.params.id); res.json({ ok: true }); });
zkdRouter.post('/zkd/biophotos/approve', (req, res) => {
  const list = ids(req.body?.ids), state = req.body?.state === 'Rejected' ? 'Rejected' : 'Approved'; if (!list.length) return fail(res, 'Tick at least one row');
  let done = 0, queued = 0;
  for (const id of list) {
    const z = db.prepare('SELECT z.*, e.code FROM zk_biophoto z JOIN employees e ON e.id=z.employee_id WHERE z.id=?').get(id); if (!z) continue;
    db.prepare('UPDATE zk_biophoto SET approval_state=?, approval_time=? WHERE id=?').run(state, stamp(), id); done++;
    if (state === 'Approved') {
      const b64 = z.bio_photo.split(',')[1];
      for (const d of db.prepare('SELECT id FROM devices WHERE sn IS NOT NULL AND approved=1').all()) { queueCommand(d.id, `DATA UPDATE BIOPHOTO PIN=${z.code}\tType=9\tSize=${b64.length}\tContent=${b64}`); queued++; }
    }
  }
  res.json({ done, queued });
});
zkdRouter.get('/zkd/biophotos/qr-info', (req, res) => res.json({ url: `${req.protocol}://${req.headers.host}/portal` }));

// ---------- transactions ----------
const TX_FROM = `FROM (SELECT l.id, l.emp_code, l.ts, l.device_id, l.source, l.uploaded, l.state, l.verify, l.workcode, l.lat, l.lng, l.temp_c, l.mask, (SELECT p.id FROM punch_photos p WHERE p.emp_code=l.emp_code AND p.ts BETWEEN datetime(l.ts,'-6 seconds') AND datetime(l.ts,'+6 seconds') LIMIT 1) AS photo_id, ROW_NUMBER() OVER (PARTITION BY l.emp_code, substr(l.ts,1,10) ORDER BY l.ts) AS n FROM logs l WHERE substr(l.ts,1,10)>=? AND substr(l.ts,1,10)<=?) x
  LEFT JOIN employees e ON e.code=x.emp_code LEFT JOIN designations dsg ON dsg.id=e.designation_id LEFT JOIN departments dp ON dp.id=e.department_id LEFT JOIN devices d ON d.id=x.device_id LEFT JOIN device_groups g ON g.id=d.group_id LEFT JOIN branches ba ON ba.id=COALESCE(g.branch_id, e.branch_id)`;
zkdRouter.get('/zkd/transactions', (req, res) => {
  const to = DATE.test(req.query.to ?? '') ? req.query.to : dateStr(new Date()), from = DATE.test(req.query.from ?? '') ? req.query.from : addDays(to, -6), sc = scopeClause('e'), q = req.query.q ? `%${req.query.q}%` : null;
  res.json(db.prepare(`SELECT x.id, x.emp_code AS code, e.name, e.last_name, dsg.name AS position, dp.name AS dept, x.ts, CASE x.state WHEN 0 THEN 'Check In' WHEN 1 THEN 'Check Out' WHEN 2 THEN 'Break Out' WHEN 3 THEN 'Break In' WHEN 4 THEN 'Overtime In' WHEN 5 THEN 'Overtime Out' ELSE CASE WHEN x.n%2=1 THEN 'Check In' ELSE 'Check Out' END END AS state, CASE x.verify WHEN 0 THEN 'Password' WHEN 1 THEN 'Fingerprint' WHEN 3 THEN 'Password' WHEN 4 THEN 'Card' WHEN 15 THEN 'Face' WHEN 25 THEN 'Palm' ELSE CASE WHEN x.source='mobile' THEN 'Mobile' WHEN x.source='manual' THEN 'Manual' WHEN x.source='fingerprint' THEN 'Fingerprint' ELSE x.verify END END AS verify_type, x.workcode, x.lat AS latitude, x.lng AS longitude, x.photo_id, CASE x.mask WHEN 1 THEN 'Yes' WHEN 0 THEN 'No' ELSE '' END AS with_mask, x.temp_c, ba.name AS area, d.sn, d.name AS device, COALESCE(x.uploaded, x.ts) AS uploaded, x.source
    ${TX_FROM} WHERE 1=1${sc.sql}${q ? ' AND (x.emp_code LIKE ? OR e.name LIKE ?)' : ''} ORDER BY x.ts DESC LIMIT 5000`).all(from, to, ...sc.args, ...(q ? [q, q] : [])));
});
zkdRouter.post('/zkd/transactions/delete', (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM logs WHERE id=?').run(id).changes); res.json({ deleted: n }); });
zkdRouter.post('/zkd/transactions/photos', (req, res) => {
  const b = req.body ?? {}, to = DATE.test(b.to ?? '') ? b.to : dateStr(new Date()), from = DATE.test(b.from ?? '') ? b.from : addDays(to, -6); let n = 0;
  for (const d of db.prepare('SELECT id FROM devices WHERE sn IS NOT NULL AND approved=1').all()) { queueCommand(d.id, `DATA QUERY ATTPHOTO StartTime=${from} 00:00:00\tEndTime=${to} 23:59:59`); n++; }
  if (!n) return fail(res, 'No approved push device to ask'); res.json({ devices: n });
});

// ---------- logs: operation / error / upload ----------
const logTable = (path, table, cols, order = 'id DESC') => {
  zkdRouter.get(`/zkd/${path}`, (_q, res) => res.json(db.prepare(`SELECT z.*, d.name AS device, d.sn FROM ${table} z LEFT JOIN devices d ON d.id=z.device_id ORDER BY z.${order} LIMIT 2000`).all()));
  zkdRouter.post(`/zkd/${path}`, (req, res) => {
    const b = req.body ?? {}, d = b.device_id ? dev(Number(b.device_id)) : null; if (!d) return fail(res, 'Choose a device');
    const o = { device_id: d.id }; for (const c of cols) o[c] = b[c] === undefined || b[c] === '' ? null : (c === 'count' || c === 'error_count' ? Number(b[c]) || 0 : String(b[c]).slice(0, 300));
    const k = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO ${table}(${k}) VALUES(${k.map(() => '?')})`).run(...k.map(x => o[x])).lastInsertRowid) });
  });
  zkdRouter.post(`/zkd/${path}/delete`, (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id).changes); res.json({ deleted: n }); });
  zkdRouter.post(`/zkd/${path}/clear`, (req, res) => { const b = req.body?.before; if (b && !DATE.test(b)) return fail(res, 'Date must be YYYY-MM-DD'); res.json({ deleted: Number(b ? db.prepare(`DELETE FROM ${table} WHERE substr(COALESCE(upload_time, ''),1,10)<?`).run(b).changes : db.prepare(`DELETE FROM ${table}`).run().changes) }); });
};
logTable('oplog', 'zk_oplog', ['tz', 'admin', 'action', 'object', 'params', 'action_time', 'upload_time']);
logTable('errlog', 'zk_errlog', ['code', 'message', 'command', 'command_id', 'extra', 'upload_time']);
logTable('uplog', 'zk_uplog', ['event', 'content', 'count', 'error_count', 'upload_time']);

// ---------- device data: people on each device ----------
const DEVEMP_SQL = `SELECT du.rowid AS id, du.device_id, du.code, COALESCE(e.name, du.name) AS name, e.id AS employee_id, dp.name AS dept, COALESCE(du.card, e.card_no) AS card, d.name AS device, d.sn, du.priv, du.verify_mode, du.seen, ba.name AS area,
  (SELECT COUNT(*) FROM biodata b WHERE b.employee_id=e.id AND b.kind='fp' AND b.device_id=du.device_id) AS fp, (SELECT COUNT(*) FROM biodata b WHERE b.employee_id=e.id AND b.kind='face' AND b.device_id=du.device_id) AS face,
  (SELECT COUNT(*) FROM biodata b WHERE b.employee_id=e.id AND b.kind='palm' AND b.device_id=du.device_id) AS palm
  FROM device_users du JOIN devices d ON d.id=du.device_id LEFT JOIN employees e ON e.code=du.code LEFT JOIN departments dp ON dp.id=e.department_id LEFT JOIN branches ba ON ba.id=e.branch_id`;
const privCmd = (code, name, card, pri) => `DATA UPDATE USERINFO PIN=${clean(code)}\tName=${clean(name)}\tPri=${Number(pri) || 0}\tPasswd=\tCard=${clean(card)}\tGrp=1\tTZ=0000000100000000`;
zkdRouter.get('/zkd/devemp', (req, res) => {
  const sc = scopeClause('e'), w = req.query.device_id ? ' AND du.device_id=?' : '';
  res.json(db.prepare(`${DEVEMP_SQL} WHERE 1=1${sc.sql}${w} ORDER BY d.name, CAST(du.code AS INTEGER), du.code LIMIT 5000`).all(...sc.args, ...(w ? [Number(req.query.device_id)] : [])));
});
zkdRouter.post('/zkd/devemp', async (req, res) => { // put chosen employees on a device
  const b = req.body ?? {}, d = dev(Number(b.device_id)), list = ids(b.employee_ids); if (!d) return fail(res, 'Choose a device'); if (!list.length) return fail(res, 'Choose at least one employee');
  let n = 0; const direct = [];
  for (const id of list) {
    const e = db.prepare('SELECT * FROM employees WHERE id=? AND active=1').get(id); if (!e) continue;
    if (isPull(d)) direct.push({ code: e.code, name: e.name, card: e.card_no });
    db.prepare("INSERT INTO device_users(device_id, code, name, card) VALUES(?,?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name, card=excluded.card, seen=datetime('now','localtime')").run(d.id, e.code, e.name, e.card_no ?? null);
    if (isPush(d)) queueCommand(d.id, userCmd(e.code, e.name, e.card_no ?? '')); n++;
  }
  if (direct.length) { try { await sendUsersToDevice(d, direct); } catch (e) { return fail(res, 'Could not write to the device: ' + e.message); } }
  res.json({ added: n, queued: isPush(d) });
});
zkdRouter.post('/zkd/devemp/delete', async (req, res) => {
  let n = 0; const direct = new Map();
  for (const id of ids(req.body?.ids)) {
    const u = db.prepare('SELECT rowid AS id, device_id, code FROM device_users WHERE rowid=?').get(id); if (!u) continue;
    const d = dev(u.device_id); if (isPush(d)) queueCommand(d.id, `DATA DELETE USERINFO PIN=${clean(u.code)}`);
    if (isPull(d)) { if (!direct.has(d.id)) direct.set(d.id, []); direct.get(d.id).push(u.code); }
  }
  for (const [did, codes] of direct) { try { await removeUsersFromDevice(dev(did), codes); } catch (e) { return fail(res, 'Could not delete on the device: ' + e.message); } } // nothing is forgotten here unless the device did it
  for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM device_users WHERE rowid=?').run(id).changes);
  res.json({ deleted: n });
});
zkdRouter.put('/zkd/devemp/:id', async (req, res) => {
  const u = db.prepare('SELECT rowid AS id, * FROM device_users WHERE rowid=?').get(req.params.id); if (!u) return fail(res, 'Not found', 404);
  const priv = [0, 2, 6, 14].includes(Number(req.body?.priv ?? u.priv)) ? Number(req.body?.priv ?? u.priv) : null, vm = Number(req.body?.verify_mode ?? u.verify_mode);
  if (priv === null) return fail(res, 'Privilege: user, enroller, administrator or super administrator'); if (!(Number.isInteger(vm) && vm >= 0 && vm <= 15)) return fail(res, 'Unknown verify mode');
  const d = dev(u.device_id);
  if (isPull(d)) { try { await sendUsersToDevice(d, [{ code: u.code, name: u.name || u.code, card: u.card, role: priv }]); } catch (e) { return fail(res, 'Could not update the device: ' + e.message); } }
  db.prepare('UPDATE device_users SET priv=?, verify_mode=? WHERE rowid=?').run(priv, vm, u.id);
  if (isPush(d)) queueCommand(d.id, privCmd(u.code, u.name, u.card ?? '', priv));
  res.json({ ok: true });
});
zkdRouter.post('/zkd/devemp/transfer', (req, res) => { // Data Transfer: resync | reupload | delete-bio
  const list = ids(req.body?.ids), op = req.body?.action; if (!list.length) return fail(res, 'Tick at least one row');
  let n = 0; const seen = new Set();
  for (const id of list) {
    const u = db.prepare('SELECT rowid AS id, * FROM device_users WHERE rowid=?').get(id); if (!u) continue; const d = dev(u.device_id), e = db.prepare('SELECT id, name, card_no FROM employees WHERE code=?').get(u.code);
    if (op === 'resync') { if (isPush(d) && e) { queueCommand(d.id, privCmd(u.code, e.name, e.card_no ?? '', u.priv)); n++; } }
    else if (op === 'reupload') { if (isPush(d) && !seen.has(d.id)) { seen.add(d.id); queueCommand(d.id, 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*'); n++; } }
    else if (op === 'delete-bio') { if (e) db.prepare('DELETE FROM biodata WHERE employee_id=? AND device_id=?').run(e.id, d.id); if (isPush(d)) { queueCommand(d.id, `DATA DELETE FINGERTMP PIN=${clean(u.code)}`); queueCommand(d.id, `DATA DELETE FACE PIN=${clean(u.code)}`); } n++; }
    else return fail(res, 'Unknown action');
  }
  res.json({ done: n });
});
zkdRouter.post('/zkd/devemp/enroll', async (req, res) => {
  const list = ids(req.body?.ids), type = req.body?.type; if (!list.length) return fail(res, 'Tick at least one row');
  if (!['fp', 'palm', 'face'].includes(type)) return fail(res, 'Choose fingerprint, palm or face photo'); let n = 0;
  for (const id of list) {
    const u = db.prepare('SELECT * FROM device_users WHERE rowid=?').get(id); if (!u) continue; const d = dev(u.device_id);
    if (isPull(d) && type === 'fp') { // a pull device: open its enrolment screen directly
      const e = db.prepare('SELECT * FROM employees WHERE code=?').get(u.code); if (!e || enrolling.has(d.id)) continue;
      try { await startEnroll(d, e, 0); n++; } catch (err) { return fail(res, `${d.name}: ${err.message}`); }
      continue;
    }
    if (!isPush(d)) continue;
    queueCommand(d.id, type === 'fp' ? `ENROLL_FP PIN=${clean(u.code)}\tFID=0\tRETRY=3\tOVERWRITE=1` : type === 'palm' ? `ENROLL_PALM PIN=${clean(u.code)}\tFID=0\tRETRY=3\tOVERWRITE=1` : `ENROLL_MF PIN=${clean(u.code)}\tRETRY=3\tOVERWRITE=1`); n++;
  }
  if (!n) return fail(res, 'Only approved devices can enroll (palm and face need a push device)'); res.json({ queued: n });
});

// ---------- messages with device targeting ----------
const msgClean = (t) => String(t ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200);
const MSG_SQL = (w) => `SELECT m.id, m.scope, m.employee_id, e.code, e.name AS employee, m.content, m.start_ts, m.duration_min, m.last_sent,
  (SELECT GROUP_CONCAT(d.name, ', ') FROM zk_msg_dev z JOIN devices d ON d.id=z.device_id WHERE z.message_id=m.id) AS device, (SELECT GROUP_CONCAT(d.sn, ', ') FROM zk_msg_dev z JOIN devices d ON d.id=z.device_id WHERE z.message_id=m.id) AS sn,
  (SELECT GROUP_CONCAT(z.device_id) FROM zk_msg_dev z WHERE z.message_id=m.id) AS device_ids
  FROM device_messages m LEFT JOIN employees e ON e.id=m.employee_id ${w} ORDER BY m.id DESC LIMIT 500`;
zkdRouter.get('/zkd/messages', (req, res) => res.json(db.prepare(MSG_SQL(req.query.scope ? 'WHERE m.scope=?' : '')).all(...(req.query.scope ? [req.query.scope] : [])).map(r => ({ ...r, device: r.device ?? 'All devices', sn: r.sn ?? '', device_ids: r.device_ids ? r.device_ids.split(',').map(Number) : [] }))));
function msgBody(b) {
  const scope = b.scope === 'private' ? 'private' : 'public', content = msgClean(b.content); if (!content) return { error: 'Write the message' };
  const start = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(b.start_ts ?? '') ? String(b.start_ts).replace('T', ' ').slice(0, 16) + ':00' : stamp(), dur = b.duration_min === undefined || b.duration_min === '' || b.duration_min === null ? 1440 : Number(b.duration_min);
  if (!(Number.isInteger(dur) && dur >= 1 && dur <= 65535)) return { error: 'Duration is 1 to 65535 minutes' };
  const emps = scope === 'private' ? ids(b.employee_ids).filter(i => db.prepare('SELECT 1 FROM employees WHERE id=?').get(i)) : [null]; if (scope === 'private' && !emps.length) return { error: 'Choose who the message is for' };
  const devs = ids(b.device_ids).filter(i => dev(i)); return { scope, content, start, dur, emps, devs };
}
zkdRouter.post('/zkd/messages', (req, res) => {
  const m = msgBody(req.body ?? {}); if (m.error) return fail(res, m.error); const out = [];
  for (const emp of m.emps) {
    const id = Number(db.prepare('INSERT INTO device_messages(scope, employee_id, content, start_ts, duration_min) VALUES(?,?,?,?,?)').run(m.scope, emp, m.content, m.start, m.dur).lastInsertRowid);
    for (const d of m.devs) db.prepare('INSERT OR IGNORE INTO zk_msg_dev(message_id, device_id) VALUES(?,?)').run(id, d); out.push(id);
  }
  res.json({ ids: out });
});
zkdRouter.put('/zkd/messages/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM device_messages WHERE id=?').get(req.params.id); if (!cur) return fail(res, 'Not found', 404);
  const m = msgBody({ ...req.body, scope: cur.scope, employee_ids: cur.scope === 'private' ? [cur.employee_id] : [] }); if (m.error) return fail(res, m.error);
  db.prepare('UPDATE device_messages SET content=?, start_ts=?, duration_min=? WHERE id=?').run(m.content, m.start, m.dur, cur.id);
  db.prepare('DELETE FROM zk_msg_dev WHERE message_id=?').run(cur.id); for (const d of m.devs) db.prepare('INSERT OR IGNORE INTO zk_msg_dev(message_id, device_id) VALUES(?,?)').run(cur.id, d);
  res.json({ ok: true });
});
zkdRouter.post('/zkd/messages/:id/send', (req, res) => { // a message goes to its own devices, or to every approved push device when none were chosen
  const m = db.prepare('SELECT m.*, e.code FROM device_messages m LEFT JOIN employees e ON e.id=m.employee_id WHERE m.id=?').get(req.params.id); if (!m) return fail(res, 'No such message', 404);
  const own = db.prepare('SELECT device_id FROM zk_msg_dev WHERE message_id=?').all(m.id).map(r => r.device_id);
  const devs = db.prepare('SELECT id FROM devices WHERE sn IS NOT NULL AND approved=1').all().filter(d => !own.length || own.includes(d.id)); if (!devs.length) return fail(res, 'No approved push device to send to');
  for (const d of devs) { queueCommand(d.id, `DATA UPDATE SMS UID=${m.id}\tMsg=${msgClean(m.content)}\tTag=${m.scope === 'private' ? 254 : 253}\tMin=${m.duration_min}\tStartTime=${m.start_ts}`); if (m.scope === 'private') queueCommand(d.id, `DATA UPDATE USER_SMS Pin=${m.code}\tUID=${m.id}`); }
  db.prepare('UPDATE device_messages SET last_sent=? WHERE id=?').run(stamp(), m.id); res.json({ devices: devs.length });
});

// ---------- mobile app accounts ----------
const APP_SQL = `SELECT m.id, m.kind, m.ref, m.label, m.created, m.last_seen, m.revoked, m.disabled, m.token_hash, CASE WHEN m.kind='staff' THEN m.ref ELSE e.name END AS user FROM mobile_devices m LEFT JOIN employees e ON m.kind!='staff' AND e.id=CAST(m.ref AS INTEGER) ORDER BY m.id DESC LIMIT 1000`;
zkdRouter.get('/zkd/app/accounts', (_q, res) => {
  const cut = new Date(Date.now() - 10 * 60000).toLocaleString('sv');
  res.json(db.prepare(APP_SQL).all().map(r => ({ id: r.id, user: r.user ?? r.ref, login_time: r.created, last_active: r.last_seen, client_id: `${r.kind === 'staff' ? 'S' : 'E'}${String(r.id).padStart(5, '0')}`, token: r.token_hash.slice(0, 16) + '...', category: r.label || 'Phone', running: !r.revoked && r.last_seen && r.last_seen >= cut ? 'Online' : 'Offline', status: r.revoked || r.disabled ? 'Disable' : 'Enable', kind: r.kind, ref: r.ref })));
});
zkdRouter.post('/zkd/app/accounts/pair', (req, res) => { // Add: a pairing code the phone enters (for a staff login, or for one employee)
  const eid = Number(req.body?.employee_id); if (eid) { if (!db.prepare('SELECT 1 FROM employee_accounts a JOIN employees e ON e.id=a.employee_id WHERE e.id=? AND e.active=1 AND a.enabled=1').get(eid)) return fail(res, 'This employee needs an enabled portal account first (Portal accounts)'); return res.json(makePairCode('emp', eid)); }
  res.json(makePairCode('staff', req.user));
});
zkdRouter.post('/zkd/app/accounts/action', (req, res) => {
  const list = ids(req.body?.ids), a = req.body?.action; if (!list.length) return fail(res, 'Tick at least one account'); let n = 0;
  for (const id of list) {
    const r = a === 'offline' ? db.prepare('UPDATE mobile_devices SET revoked=1 WHERE id=?').run(id) : a === 'disable' ? db.prepare('UPDATE mobile_devices SET revoked=1, disabled=1 WHERE id=?').run(id) : a === 'enable' ? db.prepare('UPDATE mobile_devices SET revoked=0, disabled=0 WHERE id=?').run(id) : a === 'delete' ? db.prepare('DELETE FROM mobile_devices WHERE id=?').run(id) : null;
    if (!r) return fail(res, 'Unknown action'); n += Number(r.changes);
  }
  res.json({ done: n });
});
zkdRouter.post('/zkd/app/accounts/push', (req, res) => {
  const list = ids(req.body?.ids), title = txt(req.body?.title, 150), body = txt(req.body?.body, 1000); if (!list.length) return fail(res, 'Tick at least one account'); if (!title) return fail(res, 'Write the notification');
  let n = 0; for (const id of list) { const m = db.prepare('SELECT kind, ref FROM mobile_devices WHERE id=?').get(id); if (!m) continue; m.kind === 'staff' ? notify({ audience: 'admin', title, body, kind: 'automation' }) : notify({ audience: 'employee', employee_id: Number(m.ref), title, body, kind: 'automation' }); n++; }
  res.json({ sent: n });
});

// ---------- announcements ----------
zkdRouter.get('/zkd/ann/list', (_q, res) => res.json(db.prepare('SELECT a.id, a.title, a.category, a.employee_id, e.code, e.name AS employee, a.body, a.created_by, a.system_sender, a.created, a.audience FROM announcements a LEFT JOIN employees e ON e.id=a.employee_id ORDER BY a.id DESC LIMIT 500').all()));
zkdRouter.post('/zkd/ann', (req, res) => {
  const b = req.body ?? {}, title = txt(b.title, 150); if (!title) return fail(res, 'Write the subject');
  const emp = b.employee_id ? db.prepare('SELECT id FROM employees WHERE id=?').get(Number(b.employee_id)) : null; if (b.employee_id && !emp) return fail(res, 'Unknown employee');
  const id = Number(db.prepare('INSERT INTO announcements(title, body, audience, category, employee_id, system_sender, created_by) VALUES(?,?,?,?,?,?,?)').run(title, String(b.body ?? '').slice(0, 4000), emp ? 'employee' : 'all', txt(b.category, 40) ?? (emp ? 'Private' : 'Public'), emp?.id ?? null, b.system_sender ? 1 : 0, req.user).lastInsertRowid);
  res.json({ id });
});
zkdRouter.delete('/zkd/ann/:id', (req, res) => { db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id); res.json({ ok: true }); });
zkdRouter.post('/zkd/ann/push', (req, res) => { // Push Public Notice (to everyone with a portal account) or Push Private Notice (to the named employee)
  const list = ids(req.body?.ids), mode = req.body?.mode === 'private' ? 'private' : 'public'; if (!list.length) return fail(res, 'Tick at least one announcement'); let n = 0;
  for (const id of list) {
    const a = db.prepare('SELECT * FROM announcements WHERE id=?').get(id); if (!a) continue;
    if (mode === 'private') { if (!a.employee_id) return fail(res, `"${a.title}" has no employee: it is a public notice`); notify({ audience: 'employee', employee_id: a.employee_id, title: a.title, body: a.body ?? '', kind: 'automation' }); n++; }
    else { if (a.employee_id) return fail(res, `"${a.title}" is for one employee: use Push Private Notice`); for (const e of db.prepare('SELECT e.id FROM employees e JOIN employee_accounts c ON c.employee_id=e.id WHERE e.active=1 AND c.enabled=1').all()) { notify({ audience: 'employee', employee_id: e.id, title: a.title, body: a.body ?? '', kind: 'automation' }); n++; } }
  }
  res.json({ sent: n });
});

// ---------- notices (what the app was told) ----------
zkdRouter.get('/zkd/app/notices', (_q, res) => res.json(db.prepare(`SELECT n.id, n.audience, n.employee_id, e.code, e.name AS employee, n.kind, n.title, n.body, n.created, n.is_read FROM notifications n LEFT JOIN employees e ON e.id=n.employee_id WHERE n.audience IN ('admin','employee') ORDER BY n.id DESC LIMIT 1000`).all()));
zkdRouter.post('/zkd/app/notices', (req, res) => {
  const b = req.body ?? {}, title = txt(b.title, 150); if (!title) return fail(res, 'Write the notice'); const emp = b.employee_id ? Number(b.employee_id) : null;
  if (emp && !db.prepare('SELECT 1 FROM employees WHERE id=?').get(emp)) return fail(res, 'Unknown employee');
  notify({ audience: emp ? 'employee' : 'admin', employee_id: emp, title, body: txt(b.body, 1000) ?? '', kind: txt(b.category, 40) ?? 'automation' }); res.json({ ok: true });
});
zkdRouter.post('/zkd/app/notices/delete', (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM notifications WHERE id=?').run(id).changes); res.json({ deleted: n }); });

// ---------- mobile operation log ----------
zkdRouter.get('/zkd/app/log', (_q, res) => res.json(db.prepare('SELECT * FROM zk_applog ORDER BY id DESC LIMIT 1000').all()));
zkdRouter.post('/zkd/app/log', (req, res) => {
  const b = req.body ?? {}; const id = Number(db.prepare('INSERT INTO zk_applog(user, ts, path, method, ip, status, ms) VALUES(?,?,?,?,?,?,?)').run(txt(b.user, 60), stamp(), txt(b.path, 200) ?? '/', txt(b.method, 8) ?? 'GET', txt(b.ip, 60), Number(b.status) || 200, Number(b.ms) || 0).lastInsertRowid); res.json({ id });
});
zkdRouter.post('/zkd/app/log/delete', (req, res) => { let n = 0; for (const id of ids(req.body?.ids)) n += Number(db.prepare('DELETE FROM zk_applog WHERE id=?').run(id).changes); res.json({ deleted: n }); });

// ---------- geo-fence ----------
const siteOf = (b, partial, id) => {
  const o = {}, num = (k, lo, hi, l) => { if (k in b) { const v = Number(b[k]); if (b[k] === '' || b[k] === null || !(v >= lo && v <= hi)) return `${l} must be between ${lo} and ${hi}`; o[k] = v; } return null; };
  if (!partial || 'alias' in b) { const n = txt(b.alias, 80); if (!n) return { error: 'Alias required' }; o.name = n; }
  if ('location' in b) o.address = txt(b.location, 200);
  const err = num('lat', -90, 90, 'Latitude') || num('lng', -180, 180, 'Longitude') || num('radius_m', 10, 5000, 'Radius (m)'); if (err) return { error: err };
  if (!partial && (!('lat' in b) || !('lng' in b))) return { error: 'Latitude and longitude required' }; return { o };
};
zkdRouter.get('/zkd/geo/locations', (_q, res) => res.json(db.prepare('SELECT id, name AS alias, address AS location, lng, lat, radius_m FROM geo_sites ORDER BY name').all()));
zkdRouter.post('/zkd/geo/locations', (req, res) => {
  const { o, error } = siteOf({ ...req.body, lat: req.body?.lat ?? '', lng: req.body?.lng ?? '' }, false); if (error) return fail(res, error); const k = Object.keys(o);
  try { res.json({ id: Number(db.prepare(`INSERT INTO geo_sites(${k}) VALUES(${k.map(() => '?')})`).run(...k.map(x => o[x])).lastInsertRowid) }); } catch { fail(res, 'A location with this alias exists'); }
});
zkdRouter.put('/zkd/geo/locations/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM geo_sites WHERE id=?').get(req.params.id)) return fail(res, 'Not found', 404);
  const { o, error } = siteOf(req.body ?? {}, true); if (error) return fail(res, error); const k = Object.keys(o); if (!k.length) return res.json({ ok: true });
  try { db.prepare(`UPDATE geo_sites SET ${k.map(x => x + '=?')} WHERE id=?`).run(...k.map(x => o[x]), req.params.id); res.json({ ok: true }); } catch { fail(res, 'A location with this alias exists'); }
});
zkdRouter.delete('/zkd/geo/locations/:id', (req, res) => { db.prepare('DELETE FROM geo_sites WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const gpsChecks = (b) => {
  if (!db.prepare('SELECT 1 FROM geo_sites WHERE id=?').get(Number(b.site_id))) return 'Choose a location';
  if (b.distance !== undefined && b.distance !== null && b.distance !== '' && !(Number(b.distance) >= 0)) return 'Distance must be a number of metres';
  for (const k of ['start_date', 'end_date']) if (b[k] && !DATE.test(b[k])) return `${k === 'start_date' ? 'Start' : 'End'} date must be YYYY-MM-DD`;
  if (b.start_date && b.end_date && b.end_date < b.start_date) return 'The end date is before the start date'; return null;
};
const gps = (path, table, col, targetTable, apply) => {
  zkdRouter.get(`/zkd/geo/${path}`, (_q, res) => res.json(db.prepare(`SELECT z.id, z.${col}, z.site_id, ${path === 'emp' ? "e.code || ' ' || e.name" : 't.name'} AS target, s.name AS location, z.distance, z.start_date, z.end_date FROM ${table} z JOIN ${targetTable} t ON t.id=z.${col} JOIN geo_sites s ON s.id=z.site_id ${path === 'emp' ? 'JOIN employees e ON e.id=z.employee_id' : ''} ORDER BY z.id DESC LIMIT 2000`).all()));
  const save = (id) => (req, res) => {
    const b = req.body ?? {}, err = gpsChecks(b) || (!db.prepare(`SELECT 1 FROM ${targetTable} WHERE id=?`).get(Number(b[col])) ? (path === 'emp' ? 'Choose an employee' : 'Choose a department') : null); if (err) return fail(res, err);
    const v = [Number(b[col]), Number(b.site_id), b.distance === '' || b.distance == null ? null : Number(b.distance), b.start_date || null, b.end_date || null];
    if (id(req)) { if (!db.prepare(`UPDATE ${table} SET ${col}=?, site_id=?, distance=?, start_date=?, end_date=? WHERE id=?`).run(...v, id(req)).changes) return fail(res, 'Not found', 404); res.json({ ok: true }); }
    else res.json({ id: Number(db.prepare(`INSERT INTO ${table}(${col}, site_id, distance, start_date, end_date) VALUES(?,?,?,?,?)`).run(...v).lastInsertRowid) });
    apply(v[0], v[1]);
  };
  zkdRouter.post(`/zkd/geo/${path}`, save(() => 0)); zkdRouter.put(`/zkd/geo/${path}/:id`, save((r) => Number(r.params.id)));
  zkdRouter.delete(`/zkd/geo/${path}/:id`, (req, res) => { db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id); res.json({ ok: true }); });
};
gps('emp', 'zk_gps_emp', 'employee_id', 'employees', (eid, site) => db.prepare('INSERT OR IGNORE INTO employee_sites(employee_id, site_id) VALUES(?,?)').run(eid, site)); // the real punch check reads employee_sites
gps('dept', 'zk_gps_dept', 'department_id', 'departments', (did, site) => { for (const e of db.prepare('SELECT id FROM employees WHERE department_id=? AND active=1').all(did)) db.prepare('INSERT OR IGNORE INTO employee_sites(employee_id, site_id) VALUES(?,?)').run(e.id, site); });

// ---------- device configuration (defaults) ----------
const CFG = { zkd_delay: 10, zkd_error_delay: 30, zkd_realtime: 1, zkd_auto_approve: 0, zkd_timezone: '' };
const cfgGet = () => { const o = { ...CFG }; for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'zkd\\_%' ESCAPE '\\'").all()) if (r.key in o) o[r.key] = typeof CFG[r.key] === 'number' ? Number(r.value) : r.value; const S = getSettings(); return { ...o, device_offline_min: S.device_offline_min, monitor_refresh_sec: S.monitor_refresh_sec, store_templates: S.store_templates, device_user_sync_min: S.device_user_sync_min }; };
export const autoApprove = () => cfgGet().zkd_auto_approve === 1;
zkdRouter.get('/zkd/config', (_q, res) => res.json(cfgGet()));
zkdRouter.put('/zkd/config', (req, res) => {
  const b = req.body ?? {}, up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const rng = (k, lo, hi, l) => { if (k in b) { const v = Number(b[k]); if (!(Number.isInteger(v) && v >= lo && v <= hi)) return `${l} must be a whole number from ${lo} to ${hi}`; } return null; };
  const err = rng('zkd_delay', 1, 3600, 'Upload interval') || rng('zkd_error_delay', 1, 3600, 'Retry delay') || rng('zkd_realtime', 0, 1, 'Realtime') || rng('zkd_auto_approve', 0, 1, 'Auto approve') || rng('device_offline_min', 1, 1440, 'Offline after') || rng('monitor_refresh_sec', 3, 3600, 'Monitor refresh') || rng('device_user_sync_min', 0, 1440, 'Device user scan interval'); if (err) return fail(res, err);
  for (const k of Object.keys(CFG)) if (k in b) up.run(k, String(k === 'zkd_timezone' ? String(b[k] ?? '').slice(0, 40) : Number(b[k])));
  setSettings({ device_offline_min: b.device_offline_min, monitor_refresh_sec: b.monitor_refresh_sec, store_templates: b.store_templates, device_user_sync_min: b.device_user_sync_min }); res.json(cfgGet());
});
zkdRouter.post('/zkd/config/apply', (_q, res) => { const c = cfgGet(); const r = db.prepare('UPDATE devices SET delay=?, error_delay=?, realtime=?' + (c.zkd_timezone ? ', timezone=?' : '')).run(c.zkd_delay, c.zkd_error_delay, c.zkd_realtime, ...(c.zkd_timezone ? [c.zkd_timezone] : [])); res.json({ devices: Number(r.changes) }); });
