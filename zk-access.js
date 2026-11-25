import express from 'express';
import { db } from './db.js';
import './ac.js';
import { zoneCmd, doorOptCmd, queueExtras } from './ac.js';
import { queueCommand } from './devsync.js';
import { scopeClause } from './rbac.js';
import { sysLog } from './zk-log.js';

// ZKT-style access control pages: device commands of access devices, door actions, holidays, combinations, privileges, clone to areas, personnel transfer.
// Doors, time periods and groups themselves are served by ac.js (/ac/doors, /ac/timezones, /ac/levels); their extra columns live there too.
export const zkAccessRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const DATE = /^\d{4}-\d\d-\d\d$/;
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))].slice(0, 2000);
const tzOk = (id) => !!db.prepare('SELECT 1 FROM ac_timezones WHERE id=?').get(id);

// ---------- Device Command (only devices that have doors) ----------
const accessDevices = () => db.prepare('SELECT DISTINCT device_id FROM ac_doors WHERE device_id IS NOT NULL').all().map(r => r.device_id);
zkAccessRouter.get('/ac/cmds', (_q, res) => {
  res.json(db.prepare(`SELECT c.id, v.sn, v.name AS device, c.cmd AS content, c.created AS commit_time, c.sent AS transfer_time, c.status, c.result
    FROM device_commands c JOIN devices v ON v.id=c.device_id WHERE c.device_id IN (SELECT device_id FROM ac_doors WHERE device_id IS NOT NULL) ORDER BY c.id DESC LIMIT 1000`).all());
});
zkAccessRouter.post('/ac/cmds', (req, res) => {
  const dev = Number(req.body?.device_id), cmd = String(req.body?.cmd ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!accessDevices().includes(dev)) return fail(res, 'Choose a device that has a door');
  if (!cmd || cmd.length > 2000) return fail(res, 'Enter the command (up to 2000 characters)');
  res.json({ id: queueCommand(dev, cmd) });
});
zkAccessRouter.delete('/ac/cmds/:id', (req, res) => { db.prepare('DELETE FROM device_commands WHERE id=? AND device_id IN (SELECT device_id FROM ac_doors)').run(req.params.id); res.json({ ok: true }); });
zkAccessRouter.post('/ac/cmds/delete', (req, res) => {
  const l = ids(req.body?.ids); let n = 0; for (const id of l) n += Number(db.prepare('DELETE FROM device_commands WHERE id=? AND device_id IN (SELECT device_id FROM ac_doors)').run(id).changes); res.json({ deleted: n });
});
zkAccessRouter.post('/ac/cmds/clear', (req, res) => { // Bulk Delete by status (pending, sent, done, failed) or Clear all (status all)
  const st = String(req.body?.status ?? 'all'); if (!['all', 'pending', 'sent', 'done', 'failed'].includes(st)) return fail(res, 'Unknown status');
  const r = db.prepare(`DELETE FROM device_commands WHERE device_id IN (SELECT device_id FROM ac_doors)${st === 'all' ? '' : ' AND status=?'}`).run(...(st === 'all' ? [] : [st])); res.json({ deleted: Number(r.changes) });
});

// ---------- door actions ----------
const doorsOf = (list) => list.map(id => db.prepare('SELECT d.*, v.sn, v.approved FROM ac_doors d LEFT JOIN devices v ON v.id=d.device_id WHERE d.id=?').get(id)).filter(Boolean);
zkAccessRouter.post('/ac/doors/params', (req, res) => { // Set Parameter: write the door parameters to the chosen doors and queue them for the devices
  const doors = doorsOf(ids(req.body?.ids)); if (!doors.length) return fail(res, 'Choose at least one door');
  const b = req.body ?? {}, sets = [], args = [];
  for (const [k, lo, hi, what] of [['open_sec', 1, 254, 'Door lock delay'], ['sensor_delay', 0, 254, 'Door sensor delay'], ['alarm_delay', 0, 254, 'Door alarm delay'], ['retry_alarm', 0, 20, 'Retry times to alarm']])
    if (b[k] !== undefined && b[k] !== '' && b[k] !== null) { const n = Number(b[k]); if (!(Number.isInteger(n) && n >= lo && n <= hi)) return fail(res, `${what} is ${lo} to ${hi}`); sets.push(k + '=?'); args.push(n); }
  if (b.sensor_type !== undefined && b.sensor_type !== '' && b.sensor_type !== null) { const n = Number(b.sensor_type); if (![0, 1, 2].includes(n)) return fail(res, 'Door sensor type is None, Normally Open or Normally Closed'); sets.push('sensor_type=?'); args.push(n); }
  if (b.valid_holidays !== undefined && b.valid_holidays !== '' && b.valid_holidays !== null) { sets.push('valid_holidays=?'); args.push(b.valid_holidays && b.valid_holidays !== '0' ? 1 : 0); }
  if (!sets.length) return fail(res, 'Nothing to change');
  let queued = 0;
  for (const d of doors) { db.prepare(`UPDATE ac_doors SET ${sets} WHERE id=?`).run(...args, d.id); const n = db.prepare('SELECT * FROM ac_doors WHERE id=?').get(d.id); if (n.device_id && d.sn && d.approved) { queueCommand(n.device_id, doorOptCmd(n)); queued++; } }
  res.json({ doors: doors.length, queued });
});
zkAccessRouter.post('/ac/doors/cancel-alarm', (req, res) => {
  const doors = doorsOf(ids(req.body?.ids)); if (!doors.length) return fail(res, 'Choose at least one door');
  let queued = 0; for (const d of doors) { db.prepare('UPDATE ac_doors SET alarm=0 WHERE id=?').run(d.id); if (d.device_id && d.sn && d.approved) { queueCommand(d.device_id, 'CONTROL DEVICE 02 00 00 00'); queued++; } }
  res.json({ doors: doors.length, queued });
});
zkAccessRouter.post('/ac/doors/raise-alarm', (req, res) => { db.prepare('UPDATE ac_doors SET alarm=1 WHERE id=?').run(Number(req.body?.id)); res.json({ ok: true }); });

// ---------- Holiday ----------
function cleanHoliday(b) {
  const name = txt(b?.name, 60); if (!name) return { error: 'Holiday name required' };
  if (!DATE.test(b?.start_date ?? '') || Number.isNaN(Date.parse(b.start_date))) return { error: 'Start date required (YYYY-MM-DD)' };
  const duration = Number(b.duration); if (!(Number.isInteger(duration) && duration >= 1 && duration <= 365)) return { error: 'Duration is 1 to 365 days' };
  const tz = Number(b.timezone_id); if (!tzOk(tz)) return { error: 'Choose a time period' };
  return { o: { name, start_date: b.start_date, duration, timezone_id: tz } };
}
const holidayRows = () => db.prepare(`SELECT h.*, t.name AS timezone, date(h.start_date, '+' || (h.duration - 1) || ' day') AS end_date FROM ac_holidays h LEFT JOIN ac_timezones t ON t.id=h.timezone_id ORDER BY h.start_date, h.id`).all();
zkAccessRouter.get('/ac/holidays', (_q, res) => res.json(holidayRows()));
zkAccessRouter.post('/ac/holidays', (req, res) => { const { o, error } = cleanHoliday(req.body); if (error) return fail(res, error); res.json({ id: Number(db.prepare('INSERT INTO ac_holidays(name, start_date, duration, timezone_id) VALUES(?,?,?,?)').run(o.name, o.start_date, o.duration, o.timezone_id).lastInsertRowid) }); });
zkAccessRouter.put('/ac/holidays/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM ac_holidays WHERE id=?').get(req.params.id)) return fail(res, 'No such holiday', 404);
  const { o, error } = cleanHoliday(req.body); if (error) return fail(res, error);
  db.prepare('UPDATE ac_holidays SET name=?, start_date=?, duration=?, timezone_id=? WHERE id=?').run(o.name, o.start_date, o.duration, o.timezone_id, req.params.id); res.json({ ok: true });
});
zkAccessRouter.delete('/ac/holidays/:id', (req, res) => { db.prepare('DELETE FROM ac_holidays WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---------- Combination (several people from several groups open a door together) ----------
const groupNo = (id) => db.prepare('SELECT group_no, name FROM ac_levels WHERE id=?').get(id);
function cleanCombo(b, id) {
  const name = txt(b?.name, 60); if (!name) return { error: 'Combination name required' };
  const no = Number(b?.combo_no); if (!(Number.isInteger(no) && no >= 1 && no <= 99)) return { error: 'Combination number is 1 to 99' };
  if (db.prepare('SELECT 1 FROM ac_combos WHERE combo_no=? AND id IS NOT ?').get(no, id ?? null)) return { error: 'This combination number is already used' };
  const g = [1, 2, 3, 4, 5].map(i => (b?.['g' + i] ? Number(b['g' + i]) : null));
  for (const x of g) if (x && !db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(x)) return { error: 'Unknown group' };
  if (g.filter(Boolean).length < 2) return { error: 'A combination needs people from at least two group slots' };
  if (g.findIndex(x => !x) !== -1 && g.slice(g.findIndex(x => !x)).some(Boolean)) return { error: 'Fill the group slots in order, without gaps' };
  return { o: { combo_no: no, name, g1: g[0], g2: g[1], g3: g[2], g4: g[3], g5: g[4], remark: txt(b?.remark, 200) } };
}
const comboRows = () => db.prepare('SELECT * FROM ac_combos ORDER BY combo_no').all().map(c => ({ ...c, groups: [c.g1, c.g2, c.g3, c.g4, c.g5].map(g => (g ? groupNo(g)?.name ?? '' : '')) }));
zkAccessRouter.get('/ac/combos', (_q, res) => res.json(comboRows()));
zkAccessRouter.post('/ac/combos', (req, res) => { const { o, error } = cleanCombo(req.body); if (error) return fail(res, error); const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO ac_combos(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); });
zkAccessRouter.put('/ac/combos/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM ac_combos WHERE id=?').get(req.params.id)) return fail(res, 'No such combination', 404);
  const { o, error } = cleanCombo(req.body, Number(req.params.id)); if (error) return fail(res, error); const c = Object.keys(o);
  db.prepare(`UPDATE ac_combos SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true });
});
zkAccessRouter.delete('/ac/combos/:id', (req, res) => { db.prepare('DELETE FROM ac_combos WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// Can these people open a door together under this combination? One person from each group slot, nobody counted twice.
export function comboSatisfied(combo, empIds) {
  const slots = [combo.g1, combo.g2, combo.g3, combo.g4, combo.g5].filter(Boolean), members = slots.map(g => new Set(db.prepare('SELECT employee_id FROM ac_level_people WHERE level_id=?').all(g).map(r => r.employee_id)));
  const people = [...new Set(empIds)], used = new Set(); if (people.length !== slots.length) return false;
  const fit = (i) => { if (i === slots.length) return true; for (const p of people) if (!used.has(p) && members[i].has(p)) { used.add(p); if (fit(i + 1)) return true; used.delete(p); } return false; };
  return fit(0);
}
zkAccessRouter.post('/ac/combos/check', (req, res) => {
  const c = db.prepare('SELECT * FROM ac_combos WHERE id=?').get(req.body?.combo_id); if (!c) return fail(res, 'No such combination', 404);
  let emp = Array.isArray(req.body?.employee_ids) ? ids(req.body.employee_ids) : [];
  if (Array.isArray(req.body?.codes)) emp = [...emp, ...req.body.codes.map(code => db.prepare('SELECT id FROM employees WHERE code=?').get(String(code))?.id).filter(Boolean)];
  const slots = [c.g1, c.g2, c.g3, c.g4, c.g5].filter(Boolean).length, ok = comboSatisfied(c, emp);
  res.json({ ok, needs: slots, given: new Set(emp).size, reason: ok ? `Allowed together under combination ${c.combo_no} "${c.name}"` : `Combination ${c.combo_no} "${c.name}" needs ${slots} different people, one from each listed group` });
});

// ---------- Privilege (who is in which group, with optional personal time periods / verification mode) ----------
const split = (n) => { const s = String(n ?? '').trim(), i = s.indexOf(' '); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]; };
const PRIV = `SELECT p.rowid AS id, e.id AS employee_id, e.code, e.name, l.id AS level_id, l.name AS level, l.group_no, l.verify_mode AS group_verify, p.tz_mode, p.tz1, p.tz2, p.tz3, p.verify_mode,
  l.timezone_id AS g1, l.timezone2_id AS g2, l.timezone3_id AS g3,
  (SELECT name FROM ac_timezones WHERE id=CASE WHEN p.tz_mode=1 THEN p.tz1 ELSE l.timezone_id END) AS time1, (SELECT name FROM ac_timezones WHERE id=CASE WHEN p.tz_mode=1 THEN p.tz2 ELSE l.timezone2_id END) AS time2,
  (SELECT name FROM ac_timezones WHERE id=CASE WHEN p.tz_mode=1 THEN p.tz3 ELSE l.timezone3_id END) AS time3
  FROM ac_level_people p JOIN employees e ON e.id=p.employee_id JOIN ac_levels l ON l.id=p.level_id`;
zkAccessRouter.get('/ac/privileges', (req, res) => {
  const sc = scopeClause('e'), q = req.query.q ? `%${req.query.q}%` : null;
  res.json(db.prepare(`${PRIV} WHERE 1=1${sc.sql}${q ? ' AND (e.code LIKE ? OR e.name LIKE ?)' : ''}${req.query.level_id ? ' AND l.id=?' : ''} ORDER BY e.code, l.name LIMIT 5000`)
    .all(...sc.args, ...(q ? [q, q] : []), ...(req.query.level_id ? [Number(req.query.level_id)] : [])).map(r => { const [first, last] = split(r.name); return { ...r, first_name: first, last_name: last }; }));
});
function privFields(b) {
  const o = {}; o.tz_mode = b.tz_mode == 1 || b.tz_mode === 'personnel' ? 1 : 0;
  if (o.tz_mode) { for (const k of ['tz1', 'tz2', 'tz3']) { o[k] = b[k] ? Number(b[k]) : null; if (o[k] && !tzOk(o[k])) return { error: 'Unknown time period' }; } if (!o.tz1) return { error: 'Time Period 1 is required for personnel time period mode' }; }
  else { o.tz1 = o.tz2 = o.tz3 = null; }
  o.verify_mode = b.verify_mode === undefined || b.verify_mode === '' || b.verify_mode === null ? -1 : Number(b.verify_mode);
  if (!(Number.isInteger(o.verify_mode) && o.verify_mode >= -1 && o.verify_mode <= 11)) return { error: 'Unknown verification mode' };
  return { o };
}
zkAccessRouter.post('/ac/privileges', (req, res) => {
  const b = req.body ?? {}, lv = db.prepare('SELECT id FROM ac_levels WHERE id=?').get(b.level_id); if (!lv) return fail(res, 'Choose a group');
  const emp = ids(b.employee_ids ?? (b.employee_id ? [b.employee_id] : [])); if (!emp.length) return fail(res, 'Choose at least one employee');
  const { o, error } = privFields(b); if (error) return fail(res, error); let added = 0;
  for (const id of emp) { if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(id)) continue;
    const r = db.prepare('INSERT OR IGNORE INTO ac_level_people(level_id, employee_id, tz_mode, tz1, tz2, tz3, verify_mode) VALUES(?,?,?,?,?,?,?)').run(lv.id, id, o.tz_mode, o.tz1, o.tz2, o.tz3, o.verify_mode); added += Number(r.changes); }
  if (!added) return fail(res, 'These people are already in that group'); res.json({ added });
});
// Adjust: change group and/or time periods and verification mode of the chosen privileges
function adjust(rowids, b) {
  const { o, error } = privFields(b); if (error) return { error }; let n = 0;
  for (const rid of rowids) {
    const r = db.prepare('SELECT rowid AS id, level_id, employee_id FROM ac_level_people WHERE rowid=?').get(rid); if (!r) continue;
    let level = r.level_id;
    if (b.level_id && Number(b.level_id) !== r.level_id) { if (!db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(b.level_id)) return { error: 'Unknown group' };
      if (db.prepare('SELECT 1 FROM ac_level_people WHERE level_id=? AND employee_id=?').get(b.level_id, r.employee_id)) { db.prepare('DELETE FROM ac_level_people WHERE rowid=?').run(rid); n++; continue; } level = Number(b.level_id); }
    db.prepare('UPDATE ac_level_people SET level_id=?, tz_mode=?, tz1=?, tz2=?, tz3=?, verify_mode=? WHERE rowid=?').run(level, o.tz_mode, o.tz1, o.tz2, o.tz3, o.verify_mode, rid); n++;
  }
  return { n };
}
zkAccessRouter.put('/ac/privileges/:id', (req, res) => { const r = adjust([Number(req.params.id)], req.body ?? {}); r.error ? fail(res, r.error) : res.json({ updated: r.n }); });
zkAccessRouter.post('/ac/privileges/adjust', (req, res) => { const l = ids(req.body?.ids); if (!l.length) return fail(res, 'Choose at least one privilege'); const r = adjust(l, req.body ?? {}); r.error ? fail(res, r.error) : res.json({ updated: r.n }); });
zkAccessRouter.delete('/ac/privileges/:id', (req, res) => { db.prepare('DELETE FROM ac_level_people WHERE rowid=?').run(req.params.id); res.json({ ok: true }); });

// ---------- Group Menu: personnel transfer between groups ----------
zkAccessRouter.post('/ac/levels/:id/transfer', (req, res) => {
  const from = Number(req.params.id), to = Number(req.body?.to_level_id);
  if (!db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(from)) return fail(res, 'No such group', 404); if (!db.prepare('SELECT 1 FROM ac_levels WHERE id=?').get(to)) return fail(res, 'Choose the group to transfer to');
  if (from === to) return fail(res, 'Choose a different group');
  const sc = scopeClause('e'), only = req.body?.employee_ids ? ids(req.body.employee_ids) : null;
  const rows = db.prepare(`SELECT p.employee_id FROM ac_level_people p JOIN employees e ON e.id=p.employee_id WHERE p.level_id=?${sc.sql}`).all(from, ...sc.args).map(r => r.employee_id).filter(id => !only || only.includes(id));
  if (!rows.length) return fail(res, 'Nobody to transfer'); let moved = 0;
  for (const id of rows) { const r = db.prepare('INSERT OR IGNORE INTO ac_level_people(level_id, employee_id) VALUES(?,?)').run(to, id); moved += Number(r.changes); if (!req.body?.copy) db.prepare('DELETE FROM ac_level_people WHERE level_id=? AND employee_id=?').run(from, id); }
  res.json({ transferred: rows.length, added: moved, moved: !req.body?.copy });
});

// ---------- Clone to Areas: send time periods / holidays / combinations / groups to the devices of other areas ----------
function devicesOfAreas(areaIds) {
  const cols = db.prepare('PRAGMA table_info(devices)').all().map(c => c.name), col = ['branch_id', 'area_id'].find(c => cols.includes(c));
  const base = 'SELECT DISTINCT v.* FROM devices v WHERE v.sn IS NOT NULL AND v.approved=1 AND v.id IN (SELECT device_id FROM ac_doors WHERE device_id IS NOT NULL)';
  if (!col) return { devs: db.prepare(base).all(), mapped: false };
  return { devs: areaIds.length ? db.prepare(`${base} AND v.${col} IN (${areaIds.map(() => '?')})`).all(...areaIds) : [], mapped: true };
}
zkAccessRouter.post('/ac/clone', (req, res) => {
  const kind = req.body?.kind, list = ids(req.body?.ids), areas = ids(req.body?.area_ids);
  if (!['timezones', 'holidays', 'levels', 'combos'].includes(kind)) return fail(res, 'Unknown kind'); if (!list.length) return fail(res, 'Choose at least one row');
  const { devs, mapped } = devicesOfAreas(areas); if (mapped && !areas.length) return fail(res, 'Choose at least one area');
  if (!devs.length) return fail(res, mapped ? 'No approved push device with a door in those areas' : 'No approved push device has a door yet');
  const zones = new Map(db.prepare('SELECT * FROM ac_timezones').all().map(t => [t.id, { ...t, rules: JSON.parse(t.rules) }])); let commands = 0;
  for (const d of devs) {
    const tzs = new Set();
    if (kind === 'timezones') list.forEach(i => tzs.add(i));
    if (kind === 'levels') for (const l of db.prepare(`SELECT * FROM ac_levels WHERE id IN (${list.map(() => '?')})`).all(...list)) [l.timezone_id, l.timezone2_id, l.timezone3_id].filter(Boolean).forEach(i => tzs.add(i));
    for (const i of tzs) if (zones.get(i)) { queueCommand(d.id, zoneCmd(zones.get(i))); commands++; }
  }
  if (kind === 'holidays' || kind === 'combos') { // extras are sent in full (holidays + combinations) so the device stays consistent
    commands = 0; for (const d of devs) { const t = new Set(); for (const h of db.prepare('SELECT timezone_id FROM ac_holidays').all()) if (h.timezone_id) t.add(h.timezone_id); for (const i of t) if (zones.get(i)) { queueCommand(d.id, zoneCmd(zones.get(i))); commands++; } commands += queueExtras(d.id); }
  }
  sysLog('Clone to areas', 'Success', `${kind} x${list.length} to ${devs.length} device(s)`);
  res.json({ devices: devs.length, commands, areas_mapped: mapped });
});
