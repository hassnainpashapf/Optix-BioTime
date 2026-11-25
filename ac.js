import express from 'express';
import { db } from './db.js';
import { onEvent } from './events.js';
import { notify } from './notify.js';
import { queueCommand } from './devsync.js';
import { scopeClause } from './rbac.js';
import { bgEnabled } from './zk-log.js';

// Access control: doors (a door of a device), time zones, access levels (doors + time zone) and the people who hold them.
// The device decides at the door; this module keeps the rules, sends them to the devices, logs door events and flags entries outside the rules.
db.exec(`CREATE TABLE IF NOT EXISTS ac_timezones(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, rules TEXT NOT NULL, builtin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ac_doors(id INTEGER PRIMARY KEY, name TEXT NOT NULL, device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL, door_no INTEGER NOT NULL DEFAULT 1, location TEXT, open_sec INTEGER NOT NULL DEFAULT 5, note TEXT);
CREATE TABLE IF NOT EXISTS ac_levels(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, timezone_id INTEGER NOT NULL REFERENCES ac_timezones(id), note TEXT);
CREATE TABLE IF NOT EXISTS ac_level_doors(level_id INTEGER NOT NULL REFERENCES ac_levels(id) ON DELETE CASCADE, door_id INTEGER NOT NULL REFERENCES ac_doors(id) ON DELETE CASCADE, PRIMARY KEY(level_id, door_id));
CREATE TABLE IF NOT EXISTS ac_level_people(level_id INTEGER NOT NULL REFERENCES ac_levels(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, PRIMARY KEY(level_id, employee_id));
CREATE TABLE IF NOT EXISTS ac_events(id INTEGER PRIMARY KEY, ts TEXT NOT NULL, door_id INTEGER REFERENCES ac_doors(id) ON DELETE SET NULL, employee_id INTEGER, code TEXT, kind TEXT NOT NULL, detail TEXT, violation INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ac_ev_ts ON ac_events(ts);
CREATE TABLE IF NOT EXISTS ac_synced(device_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, PRIMARY KEY(device_id, employee_id));`);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ALL = Object.fromEntries(DAYS.map(d => [d, [['00:00', '23:59']]]));
if (!db.prepare('SELECT 1 FROM ac_timezones').get()) db.prepare('INSERT INTO ac_timezones(name, rules, builtin) VALUES(?,?,1)').run('24 hours, every day', JSON.stringify(ALL));

// Extra access-control data (ZKT-style pages): door parameters, time period numbers, group options, per-person privileges, holidays, combinations.
const addCol = (t, c, def) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
for (const [t, c, d] of [['ac_doors', 'sensor_delay', 'INTEGER DEFAULT 15'], ['ac_doors', 'sensor_type', 'INTEGER DEFAULT 0'], ['ac_doors', 'alarm_delay', 'INTEGER DEFAULT 0'], ['ac_doors', 'retry_alarm', 'INTEGER DEFAULT 3'],
  ['ac_doors', 'valid_holidays', 'INTEGER DEFAULT 1'], ['ac_doors', 'alarm', 'INTEGER DEFAULT 0'],
  ['ac_timezones', 'timezone_no', 'INTEGER'], ['ac_timezones', 'remark', 'TEXT'],
  ['ac_levels', 'group_no', 'INTEGER'], ['ac_levels', 'verify_mode', 'INTEGER DEFAULT 0'], ['ac_levels', 'timezone2_id', 'INTEGER'], ['ac_levels', 'timezone3_id', 'INTEGER'], ['ac_levels', 'include_holiday', 'INTEGER DEFAULT 0'],
  ['ac_level_people', 'tz_mode', 'INTEGER DEFAULT 0'], ['ac_level_people', 'tz1', 'INTEGER'], ['ac_level_people', 'tz2', 'INTEGER'], ['ac_level_people', 'tz3', 'INTEGER'], ['ac_level_people', 'verify_mode', 'INTEGER DEFAULT -1']]) addCol(t, c, d);
db.exec(`UPDATE ac_timezones SET timezone_no=id WHERE timezone_no IS NULL; UPDATE ac_levels SET group_no=id WHERE group_no IS NULL;
CREATE TABLE IF NOT EXISTS ac_holidays(id INTEGER PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 1, timezone_id INTEGER REFERENCES ac_timezones(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS ac_combos(id INTEGER PRIMARY KEY, combo_no INTEGER NOT NULL, name TEXT NOT NULL, g1 INTEGER, g2 INTEGER, g3 INTEGER, g4 INTEGER, g5 INTEGER, remark TEXT);`);

export const acRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/, stamp = () => new Date().toLocaleString('sv');
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };

// ---------- time zones ----------
function cleanRules(r) {
  if (!r || typeof r !== 'object') return { error: 'Give the times for each day' }; const out = {};
  for (const d of DAYS) {
    const list = Array.isArray(r[d]) ? r[d] : []; if (list.length > 3) return { error: 'At most 3 time ranges a day' }; out[d] = [];
    for (const [a, b] of list) { if (!HHMM.test(a ?? '') || !HHMM.test(b ?? '')) return { error: 'Times must be HH:MM' }; if (a >= b) return { error: `${d.toUpperCase()}: a range must end after it starts (${a} to ${b})` }; out[d].push([a, b]); }
    out[d].sort(); for (let i = 1; i < out[d].length; i++) if (out[d][i][0] < out[d][i - 1][1]) return { error: `${d.toUpperCase()}: time ranges overlap` };
  }
  return { rules: out };
}
function tzMeta(id, b) { // time period number (unique, 1 to 255 like the device tables) and remark
  const o = { remark: txt(b?.remark, 200) }; if (b?.timezone_no !== undefined && b.timezone_no !== '' && b.timezone_no !== null) { o.no = Number(b.timezone_no); if (!(Number.isInteger(o.no) && o.no >= 1 && o.no <= 255)) return { error: 'Time period number is 1 to 255' }; if (db.prepare('SELECT 1 FROM ac_timezones WHERE timezone_no=? AND id IS NOT ?').get(o.no, id)) return { error: 'This time period number is already used' }; }
  return o;
}
const tzRows = () => db.prepare('SELECT t.*, (SELECT COUNT(*) FROM ac_levels l WHERE l.timezone_id=t.id) AS levels FROM ac_timezones t ORDER BY t.id').all().map(t => ({ ...t, rules: JSON.parse(t.rules) }));
acRouter.get('/ac/timezones', (_q, res) => res.json(tzRows()));
acRouter.post('/ac/timezones', (req, res) => { const name = txt(req.body?.name, 60); if (!name) return fail(res, 'Name required'); const { rules, error } = cleanRules(req.body?.rules); if (error) return fail(res, error); const m = tzMeta(null, req.body); if (m.error) return fail(res, m.error); try { const id = Number(db.prepare('INSERT INTO ac_timezones(name, rules) VALUES(?,?)').run(name, JSON.stringify(rules)).lastInsertRowid); db.prepare('UPDATE ac_timezones SET timezone_no=?, remark=? WHERE id=?').run(m.no ?? id, m.remark, id); res.json({ id }); } catch { fail(res, 'A time zone with this name exists'); } });
acRouter.put('/ac/timezones/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM ac_timezones WHERE id=?').get(req.params.id); if (!t) return fail(res, 'No such time zone', 404); if (t.builtin) return fail(res, 'The built-in 24 hour zone cannot be changed');
  const name = txt(req.body?.name, 60); if (!name) return fail(res, 'Name required'); const { rules, error } = cleanRules(req.body?.rules); if (error) return fail(res, error);
  const m = tzMeta(t.id, req.body); if (m.error) return fail(res, m.error); try { db.prepare('UPDATE ac_timezones SET name=?, rules=?, timezone_no=?, remark=? WHERE id=?').run(name, JSON.stringify(rules), m.no ?? t.timezone_no ?? t.id, 'remark' in req.body ? m.remark : t.remark, t.id); res.json({ ok: true }); } catch { fail(res, 'A time zone with this name exists'); }
});
acRouter.delete('/ac/timezones/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM ac_timezones WHERE id=?').get(req.params.id); if (!t) return fail(res, 'No such time zone', 404); if (t.builtin) return fail(res, 'The built-in 24 hour zone cannot be deleted');
  if (db.prepare('SELECT 1 FROM ac_levels WHERE timezone_id=?').get(t.id)) return fail(res, 'Access levels still use this time zone'); db.prepare('DELETE FROM ac_timezones WHERE id=?').run(t.id); res.json({ ok: true });
});
const inZone = (rules, at) => { const d = new Date(String(at).replace(' ', 'T')), day = DAYS[d.getDay()], hm = String(at).slice(11, 16); return (rules[day] ?? []).some(([a, b]) => hm >= a && hm <= b); };

// ---------- doors ----------
const doorRows = () => db.prepare(`SELECT d.*, v.name AS device, v.sn, v.online AS dev_online, v.last_seen, (SELECT COUNT(DISTINCT p.employee_id) FROM ac_level_doors ld JOIN ac_level_people p ON p.level_id=ld.level_id WHERE ld.door_id=d.id) AS people,
  (SELECT MAX(ts) FROM ac_events e WHERE e.door_id=d.id) AS last_event FROM ac_doors d LEFT JOIN devices v ON v.id=d.device_id ORDER BY d.name`).all();
acRouter.get('/ac/doors', (_q, res) => res.json(doorRows()));
function cleanDoor(b, partial) {
  const o = {}; if (!partial || 'name' in b) { o.name = txt(b.name, 60); if (!o.name) return { error: 'Name required' }; }
  if ('device_id' in b) { o.device_id = b.device_id ? Number(b.device_id) : null; if (o.device_id && !db.prepare('SELECT 1 FROM devices WHERE id=?').get(o.device_id)) return { error: 'Unknown device' }; }
  if ('door_no' in b) { o.door_no = Number(b.door_no); if (!(Number.isInteger(o.door_no) && o.door_no >= 1 && o.door_no <= 4)) return { error: 'Door number is 1 to 4' }; }
  if ('open_sec' in b) { o.open_sec = Number(b.open_sec); if (!(Number.isInteger(o.open_sec) && o.open_sec >= 1 && o.open_sec <= 254)) return { error: 'Open time is 1 to 254 seconds' }; }
  for (const [k, lo, hi, what] of [['sensor_delay', 0, 254, 'Door sensor delay'], ['alarm_delay', 0, 254, 'Door alarm delay'], ['retry_alarm', 0, 20, 'Retry times to alarm']]) if (k in b && b[k] !== '' && b[k] != null) { o[k] = Number(b[k]); if (!(Number.isInteger(o[k]) && o[k] >= lo && o[k] <= hi)) return { error: `${what} is ${lo} to ${hi}` }; }
  if ('sensor_type' in b) { o.sensor_type = Number(b.sensor_type); if (![0, 1, 2].includes(o.sensor_type)) return { error: 'Door sensor type: 0 none, 1 normally open, 2 normally closed' }; }
  if ('valid_holidays' in b) o.valid_holidays = b.valid_holidays && b.valid_holidays !== '0' ? 1 : 0;
  if ('location' in b) o.location = txt(b.location, 80); if ('note' in b) o.note = txt(b.note, 200);
  if (o.device_id && o.door_no && db.prepare('SELECT 1 FROM ac_doors WHERE device_id=? AND door_no=? AND id IS NOT ?').get(o.device_id, o.door_no, b.__id ?? null)) return { error: 'That door of that device is already defined' };
  return { o };
}
acRouter.post('/ac/doors', (req, res) => { const { o, error } = cleanDoor({ door_no: 1, ...req.body }, false); if (error) return fail(res, error); const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO ac_doors(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); });
acRouter.put('/ac/doors/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM ac_doors WHERE id=?').get(req.params.id); if (!d) return fail(res, 'No such door', 404);
  const { o, error } = cleanDoor({ device_id: d.device_id, door_no: d.door_no, ...req.body, __id: d.id }, true); if (error) return fail(res, error); delete o.__id; const c = Object.keys(o).filter(k => k in req.body || k === 'device_id' || k === 'door_no'); if (c.length) db.prepare(`UPDATE ac_doors SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), d.id); res.json({ ok: true });
});
acRouter.delete('/ac/doors/:id', (req, res) => { db.prepare('DELETE FROM ac_doors WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const logEvent = (door, emp, kind, detail, violation = 0, ts = stamp()) => db.prepare('INSERT INTO ac_events(ts, door_id, employee_id, code, kind, detail, violation) VALUES(?,?,?,?,?,?,?)').run(ts, door?.id ?? null, emp?.id ?? null, emp?.code ?? null, kind, detail ?? null, violation);
// Open a door for a few seconds from here (a command the device fetches at its next check-in).
acRouter.post('/ac/doors/:id/open', (req, res) => {
  const d = db.prepare('SELECT d.*, v.sn, v.approved FROM ac_doors d LEFT JOIN devices v ON v.id=d.device_id WHERE d.id=?').get(req.params.id); if (!d) return fail(res, 'No such door', 404);
  if (!d.device_id || !d.sn || !d.approved) return fail(res, 'This door needs an approved push device');
  const sec = req.body?.seconds ? Number(req.body.seconds) : d.open_sec; if (!(Number.isInteger(sec) && sec >= 1 && sec <= 254)) return fail(res, 'Open time is 1 to 254 seconds');
  queueCommand(d.device_id, `CONTROL DEVICE 1 ${d.door_no} 1 ${sec}`); logEvent(d, null, 'remote_open', `Opened from the system by ${req.user} for ${sec} s`); res.json({ queued: true, seconds: sec });
});

// ---------- access levels ----------
const levelRows = () => db.prepare(`SELECT l.*, t.name AS timezone, t2.name AS timezone2, t3.name AS timezone3, (SELECT COUNT(*) FROM ac_level_people p WHERE p.level_id=l.id) AS people FROM ac_levels l JOIN ac_timezones t ON t.id=l.timezone_id LEFT JOIN ac_timezones t2 ON t2.id=l.timezone2_id LEFT JOIN ac_timezones t3 ON t3.id=l.timezone3_id ORDER BY l.name`).all()
  .map(l => ({ ...l, doors: db.prepare('SELECT d.id, d.name FROM ac_level_doors ld JOIN ac_doors d ON d.id=ld.door_id WHERE ld.level_id=? ORDER BY d.name').all(l.id) }));
acRouter.get('/ac/levels', (_q, res) => res.json(levelRows()));
function saveLevel(id, b) {
  const name = txt(b.name, 60); if (!name) return 'Name required'; const tz = Number(b.timezone_id); if (!db.prepare('SELECT 1 FROM ac_timezones WHERE id=?').get(tz)) return 'Choose a time zone';
  const x = {}; for (const k of ['timezone2_id', 'timezone3_id']) if (k in b) { x[k] = b[k] ? Number(b[k]) : null; if (x[k] && !db.prepare('SELECT 1 FROM ac_timezones WHERE id=?').get(x[k])) return 'Unknown time zone'; }
  if ('verify_mode' in b) { x.verify_mode = Number(b.verify_mode); if (!(Number.isInteger(x.verify_mode) && x.verify_mode >= 0 && x.verify_mode <= 11)) return 'Unknown verification mode'; }
  if ('include_holiday' in b) x.include_holiday = b.include_holiday && b.include_holiday !== '0' ? 1 : 0;
  if (b.group_no !== undefined && b.group_no !== '' && b.group_no !== null) { x.group_no = Number(b.group_no); if (!(Number.isInteger(x.group_no) && x.group_no >= 1 && x.group_no <= 99)) return 'Group number is 1 to 99'; if (db.prepare('SELECT 1 FROM ac_levels WHERE group_no=? AND id IS NOT ?').get(x.group_no, id ?? null)) return 'This group number is already used'; }
  const doors = [...new Set((b.door_ids ?? []).map(Number))]; for (const d of doors) if (!db.prepare('SELECT 1 FROM ac_doors WHERE id=?').get(d)) return 'Unknown door';
  try {
    db.exec('BEGIN'); if (id) db.prepare('UPDATE ac_levels SET name=?, timezone_id=?, note=? WHERE id=?').run(name, tz, txt(b.note, 200), id); else id = Number(db.prepare('INSERT INTO ac_levels(name, timezone_id, note) VALUES(?,?,?)').run(name, tz, txt(b.note, 200)).lastInsertRowid);
    for (const k of Object.keys(x)) db.prepare(`UPDATE ac_levels SET ${k}=? WHERE id=?`).run(x[k], id); if (!(db.prepare('SELECT group_no FROM ac_levels WHERE id=?').get(id).group_no)) db.prepare('UPDATE ac_levels SET group_no=id WHERE id=?').run(id);
    db.prepare('DELETE FROM ac_level_doors WHERE level_id=?').run(id); for (const d of doors) db.prepare('INSERT INTO ac_level_doors(level_id, door_id) VALUES(?,?)').run(id, d); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return /UNIQUE/.test(e.message) ? 'An access level with this name exists' : e.message; }
  return { id };
}
acRouter.post('/ac/levels', (req, res) => { const r = saveLevel(null, req.body ?? {}); typeof r === 'string' ? fail(res, r) : res.json(r); });
acRouter.put('/ac/levels/:id', (req, res) => { if (!db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(req.params.id)) return fail(res, 'No such access level', 404); const r = saveLevel(Number(req.params.id), req.body ?? {}); typeof r === 'string' ? fail(res, r) : res.json({ ok: true }); });
acRouter.delete('/ac/levels/:id', (req, res) => { db.prepare('DELETE FROM ac_levels WHERE id=?').run(req.params.id); res.json({ ok: true }); });
acRouter.get('/ac/levels/:id/people', (req, res) => { const sc = scopeClause('e'); res.json(db.prepare(`SELECT e.id, e.code, e.name, (e.photo IS NOT NULL AND e.photo<>'') AS has_photo, d.name AS dept FROM ac_level_people p JOIN employees e ON e.id=p.employee_id LEFT JOIN departments d ON d.id=e.department_id WHERE p.level_id=? AND e.active=1${sc.sql} ORDER BY e.code`).all(req.params.id, ...sc.args)); });
acRouter.post('/ac/levels/:id/people', (req, res) => { // by people, or everyone in a department / group / branch
  const lv = db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(req.params.id); if (!lv) return fail(res, 'No such access level', 404); const b = req.body ?? {}, sc = scopeClause('e'); let ids = [];
  if (Array.isArray(b.employee_ids)) ids = b.employee_ids.map(Number);
  else for (const [k, col] of [['department_id', 'department_id'], ['group_id', 'group_id'], ['branch_id', 'branch_id']]) if (b[k]) ids = db.prepare(`SELECT e.id FROM employees e WHERE e.${col}=? AND e.active=1${sc.sql}`).all(Number(b[k]), ...sc.args).map(r => r.id);
  if (!ids.length) return fail(res, 'Choose people, a department, a group or a branch with people in it'); let added = 0;
  for (const id of ids.slice(0, 5000)) if (db.prepare('SELECT 1 FROM employees WHERE id=?').get(id)) added += Number(db.prepare('INSERT OR IGNORE INTO ac_level_people(level_id, employee_id) VALUES(?,?)').run(req.params.id, id).changes);
  res.json({ added });
});
acRouter.delete('/ac/levels/:id/people/:emp', (req, res) => { db.prepare('DELETE FROM ac_level_people WHERE level_id=? AND employee_id=?').run(req.params.id, req.params.emp); res.json({ ok: true }); });

// ---------- is this person allowed through this door at this time? ----------
const holidayOn = (day) => db.prepare("SELECT h.*, t.rules, t.name AS tz FROM ac_holidays h LEFT JOIN ac_timezones t ON t.id=h.timezone_id WHERE ? BETWEEN h.start_date AND date(h.start_date, '+' || (h.duration - 1) || ' day') ORDER BY h.id LIMIT 1").get(day);
export function check(employeeId, doorId, at = stamp()) {
  const rows = db.prepare(`SELECT l.id, l.name, l.timezone_id, l.timezone2_id, l.timezone3_id, l.include_holiday, p.tz_mode, p.tz1, p.tz2, p.tz3 FROM ac_level_people p JOIN ac_levels l ON l.id=p.level_id JOIN ac_level_doors ld ON ld.level_id=l.id AND ld.door_id=? WHERE p.employee_id=?`).all(doorId, employeeId);
  if (!rows.length) return { allowed: false, reason: 'No access level gives this person this door' };
  const zone = (id) => db.prepare('SELECT name, rules FROM ac_timezones WHERE id=?').get(id), door = db.prepare('SELECT valid_holidays FROM ac_doors WHERE id=?').get(doorId);
  const hol = door?.valid_holidays ? holidayOn(String(at).slice(0, 10)) : null;
  const zonesOf = (r) => (r.tz_mode ? [r.tz1, r.tz2, r.tz3] : [r.timezone_id, r.timezone2_id, r.timezone3_id]).filter(Boolean).map(zone).filter(Boolean);
  for (const r of rows) {
    if (hol && !r.tz_mode) { // a holiday replaces the group's time periods, for groups that include holidays
      if (!r.include_holiday) continue; if (hol.rules && inZone(JSON.parse(hol.rules), at)) return { allowed: true, level: r.name, reason: `Allowed by "${r.name}" on holiday "${hol.name}" (${hol.tz})` }; continue;
    }
    for (const z of zonesOf(r)) if (inZone(JSON.parse(z.rules), at)) return { allowed: true, level: r.name, reason: `Allowed by "${r.name}" (${z.name})` };
  }
  if (hol && rows.every(r => r.tz_mode || !r.include_holiday || !hol.rules || !inZone(JSON.parse(hol.rules), at)) && rows.some(r => !r.tz_mode)) return { allowed: false, reason: `Holiday "${hol.name}": ${rows.some(r => r.include_holiday) ? 'outside the holiday time period' : 'the access groups do not include holidays'}` };
  return { allowed: false, reason: `Outside the time zone of ${rows.map(r => `"${r.name}"`).join(', ')}` };
}
acRouter.get('/ac/check', (req, res) => {
  const e = req.query.employee_id ? db.prepare('SELECT id, code, name FROM employees WHERE id=?').get(req.query.employee_id) : db.prepare('SELECT id, code, name FROM employees WHERE code=?').get(String(req.query.code ?? ''));
  const d = db.prepare('SELECT id, name FROM ac_doors WHERE id=?').get(req.query.door_id); if (!e || !d) return fail(res, 'Unknown person or door', 404);
  const at = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(req.query.at ?? '') ? String(req.query.at).replace('T', ' ') : stamp(); res.json({ employee: e, door: d, at, ...check(e.id, d.id, at) });
});

// ---------- events ----------
acRouter.get('/ac/events', (req, res) => {
  const w = [], a = [], q = req.query, sc = scopeClause('e'); const D = /^\d{4}-\d\d-\d\d$/;
  if (q.door_id) { w.push('ev.door_id=?'); a.push(Number(q.door_id)); } if (D.test(q.from ?? '')) { w.push('ev.ts>=?'); a.push(q.from + ' 00:00:00'); } if (D.test(q.to ?? '')) { w.push('ev.ts<=?'); a.push(q.to + ' 23:59:59'); }
  if (q.violation === '1') w.push('ev.violation=1'); if (q.q) { w.push('(ev.code LIKE ? OR e.name LIKE ?)'); a.push(`%${q.q}%`, `%${q.q}%`); }
  res.json(db.prepare(`SELECT ev.id, ev.ts, ev.kind, ev.detail, ev.violation, ev.code, ev.employee_id, (e.photo IS NOT NULL AND e.photo<>'') AS has_photo, e.name AS employee, d.name AS door FROM ac_events ev LEFT JOIN employees e ON e.id=ev.employee_id LEFT JOIN ac_doors d ON d.id=ev.door_id WHERE 1=1${sc.sql} ${w.length ? 'AND ' + w.join(' AND ') : ''} ORDER BY ev.id DESC LIMIT ?`).all(...sc.args, ...a, Math.min(Number(q.limit) || 300, 2000)));
});
// Every punch on a device that has doors is a door event; one the rules do not allow is flagged and the admins are told.
export function doorPunches(punches) {
  for (const p of (punches ?? []).slice(0, 300)) {
    if (!p.device_id) continue; const doors = db.prepare('SELECT * FROM ac_doors WHERE device_id=? ORDER BY door_no').all(p.device_id); if (!doors.length) continue;
    const e = db.prepare('SELECT id, code, name FROM employees WHERE code=?').get(String(p.code)); if (!e) continue; const door = doors[0], ts = String(p.time).replace('T', ' ').slice(0, 19);
    const r = check(e.id, door.id, ts), bad = !r.allowed;
    logEvent(door, e, 'entry', bad ? `Not in policy: ${r.reason}` : r.reason, bad ? 1 : 0, ts);
    if (bad && Date.now() - Date.parse(ts.replace(' ', 'T')) < 3 * 3600000) notify({ title: `Door entry outside policy: ${e.name}`, body: `${door.name} at ${ts.slice(11, 16)}. ${r.reason}`, link: 'Door events', kind: 'access', employee_id: e.id });
  }
}
onEvent((event, data) => { if (event === 'punch.created' && bgEnabled('access')) doorPunches(data.punches); });

// ---------- send the rules to the devices ----------
const pack = (a, b) => ((+a.slice(0, 2)) * 256 + (+a.slice(3, 5))) * 65536 + (+b.slice(0, 2)) * 256 + (+b.slice(3, 5));
export const zoneCmd = (t) => `DATA UPDATE timezone TimezoneId=${t.timezone_no ?? t.id}\t` + DAYS.map(d => [1, 2, 3].map(i => `${d[0].toUpperCase()}${d.slice(1)}Time${i}=${t.rules[d]?.[i - 1] ? pack(...t.rules[d][i - 1]) : 0}`).join('\t')).join('\t');
acRouter.post('/ac/sync', (req, res) => {
  const devs = db.prepare(`SELECT DISTINCT v.* FROM ac_doors d JOIN devices v ON v.id=d.device_id WHERE v.sn IS NOT NULL AND v.approved=1 ${req.body?.device_id ? 'AND v.id=?' : ''}`).all(...(req.body?.device_id ? [Number(req.body.device_id)] : []));
  if (!devs.length) return fail(res, 'No approved push device has a door yet');
  let commands = 0, users = 0, removed = 0; const zones = new Map(tzRows().map(t => [t.id, t]));
  for (const dv of devs) {
    const doors = db.prepare('SELECT * FROM ac_doors WHERE device_id=?').all(dv.id), want = new Map(); // employee -> {mask, tz}
    for (const door of doors) for (const r of db.prepare('SELECT p.employee_id, CASE WHEN p.tz_mode=1 AND p.tz1 IS NOT NULL THEN p.tz1 ELSE l.timezone_id END AS timezone_id FROM ac_level_doors ld JOIN ac_levels l ON l.id=ld.level_id JOIN ac_level_people p ON p.level_id=l.id WHERE ld.door_id=?').all(door.id)) {
      const w = want.get(r.employee_id) ?? { mask: 0, tz: r.timezone_id }; w.mask |= 1 << (door.door_no - 1); w.tz = Math.min(w.tz, r.timezone_id); want.set(r.employee_id, w);
    }
    for (const id of new Set([...want.values()].map(w => w.tz))) { queueCommand(dv.id, zoneCmd(zones.get(id))); commands++; }
    for (const [empId, w] of want) { const e = db.prepare('SELECT code FROM employees WHERE id=? AND active=1').get(empId); if (!e) continue; queueCommand(dv.id, `DATA UPDATE userauthorize Pin=${e.code}\tAuthorizeTimezoneId=${zones.get(w.tz)?.timezone_no ?? w.tz}\tAuthorizeDoorId=${w.mask}\tDevID=1`); db.prepare('INSERT OR IGNORE INTO ac_synced(device_id, employee_id) VALUES(?,?)').run(dv.id, empId); commands++; users++; }
    for (const r of db.prepare('SELECT s.employee_id, e.code FROM ac_synced s JOIN employees e ON e.id=s.employee_id WHERE s.device_id=?').all(dv.id)) if (!want.has(r.employee_id)) { queueCommand(dv.id, `DATA DELETE userauthorize Pin=${r.code}`); db.prepare('DELETE FROM ac_synced WHERE device_id=? AND employee_id=?').run(dv.id, r.employee_id); commands++; removed++; }
  }
  for (const dv of devs) commands += queueExtras(dv.id);
  res.json({ devices: devs.length, commands, users, removed });
});
// door parameters (lock delay, sensor, alarm) as a device option command; best effort on the ZK push option names
export const doorOptCmd = (d) => `SET OPTION Door${d.door_no}Drivertime=${d.open_sec},Door${d.door_no}Detectortime=${d.sensor_delay ?? 15},Door${d.door_no}SensorType=${d.sensor_type ?? 0},Door${d.door_no}AlarmTime=${d.alarm_delay ?? 0},Door${d.door_no}MaxTryTimes=${d.retry_alarm ?? 3},Door${d.door_no}ValidHoliday=${d.valid_holidays ?? 1}`;
const ymd = (d) => d.replace(/-/g, '');
// holidays (one entry per day) and multi-person combinations for one device
export function queueExtras(deviceId) {
  let n = 0;
  for (const h of db.prepare('SELECT h.*, t.timezone_no, t.id AS tid FROM ac_holidays h LEFT JOIN ac_timezones t ON t.id=h.timezone_id ORDER BY h.start_date').all()) for (let i = 0; i < h.duration; i++) {
    const d = new Date(h.start_date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); queueCommand(deviceId, `DATA UPDATE holiday Holiday=${ymd(d.toISOString().slice(0, 10))}\tHolidayType=1\tLoop=0\tTimezoneId=${h.timezone_no ?? h.tid ?? 0}`); n++;
  }
  for (const c of db.prepare('SELECT * FROM ac_combos ORDER BY combo_no').all()) { queueCommand(deviceId, `DATA UPDATE multimcard Index=${c.combo_no}\t` + [c.g1, c.g2, c.g3, c.g4, c.g5].map((g, i) => `Group${i + 1}=${g ? db.prepare('SELECT COALESCE(group_no,id) AS n FROM ac_levels WHERE id=?').get(g)?.n ?? 0 : 0}`).join('\t')); n++; }
  return n;
}
