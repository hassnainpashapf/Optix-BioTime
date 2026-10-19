import express from 'express';
import net from 'node:net';
import { db, getSettings } from './db.js';
import { userCmd, queueCommand, logEvent, eligibleEmployees } from './devsync.js';
import { parseCsv, toCsv } from './csv.js';
import { notify } from './notify.js';
import { emit } from './events.js';
import { syncDevice } from './zk.js';
import os from 'node:os';

export const devicesRouter = express.Router();
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const isPush = (d) => !!d.sn; // push devices are identified by serial number; pull devices by IP address
const stamp = () => new Date().toLocaleString('sv');
const ts = (s) => Date.parse(String(s).replace(' ', 'T'));
const hideTmpl = (cmd) => String(cmd).replace(/TMP=(\{\{bio:\d+\}\}|[A-Za-z0-9+/=]{20,})/g, 'TMP=[template]');

// ---------- health ----------
export const probe = (host, port, ms = 2000) => new Promise((ok) => {
  const t0 = Date.now(), s = net.connect({ host, port, timeout: ms });
  s.once('connect', () => { s.destroy(); ok({ up: true, ms: Date.now() - t0 }); });
  s.once('timeout', () => { s.destroy(); ok({ up: false }); });
  s.once('error', () => ok({ up: false }));
});
export const pushOnline = (d, nowMs, S) => !!d.last_seen && nowMs - ts(d.last_seen) <= (d.alert_min || S.device_offline_min) * 60000;

// Looks at every approved device, records changes (and tells the admins), and gives up on commands that never got an answer.
export async function checkDevices(nowMs = Date.now()) {
  const S = getSettings(), out = [];
  for (const d of db.prepare('SELECT * FROM devices WHERE approved=1').all()) {
    let online = null, detail = '';
    if (isPush(d)) { if (d.last_seen) online = pushOnline(d, nowMs, S); detail = d.last_seen ? `last contact ${d.last_seen}` : ''; }
    else if (d.ip) { const r = await probe(d.ip, d.port || 4370); online = r.up; detail = r.up ? `answered in ${r.ms} ms` : `no answer from ${d.ip}:${d.port || 4370}`; }
    if (online === null) { out.push({ id: d.id, name: d.name, online: null }); continue; }
    const prev = d.online === null || d.online === undefined ? null : !!d.online;
    db.prepare('UPDATE devices SET online=?, last_check=? WHERE id=?').run(online ? 1 : 0, stamp(), d.id);
    if (prev !== online && !(prev === null && online)) {
      logEvent(d.id, online ? 'online' : 'offline', detail);
      emit(online ? 'device.online' : 'device.offline', { device: d.name, serial: d.sn ?? null, detail });
      if (!d.alert_off) notify({ title: online ? `Device back online: ${d.name}` : `Device offline: ${d.name}`, body: detail, link: 'Devices' , kind: 'device_status'});
    }
    out.push({ id: d.id, name: d.name, online });
  }
  const today = new Date(nowMs).toLocaleDateString('sv'), soon = new Date(nowMs + 7 * 86400000).toLocaleDateString('sv'), warn = new Date(nowMs + 30 * 86400000).toLocaleDateString('sv');
  for (const d of db.prepare('SELECT * FROM devices').all()) { // maintenance reminders, once a day per device
    const due = d.next_service && d.next_service <= soon ? `service ${d.next_service <= today ? 'was due' : 'due'} ${d.next_service}` : d.warranty_until && d.warranty_until >= today && d.warranty_until <= warn ? `warranty ends ${d.warranty_until}` : null;
    if (!due || db.prepare("SELECT 1 FROM device_events WHERE device_id=? AND kind='service_due' AND ts>=?").get(d.id, today + ' 00:00:00')) continue;
    logEvent(d.id, 'service_due', due); if (!d.alert_off) notify({ title: `Device maintenance: ${d.name}`, body: due, link: 'Devices' , kind: 'device_service'});
  }
  const stale = db.prepare("SELECT c.id, c.device_id, c.cmd FROM device_commands c WHERE c.status='sent' AND c.created < ?").all(new Date(nowMs - 15 * 60000).toLocaleString('sv'));
  for (const c of stale) { db.prepare("UPDATE device_commands SET status='failed', result='No reply from the device' WHERE id=?").run(c.id); logEvent(c.device_id, 'command_failed', `${hideTmpl(c.cmd).split('\t')[0].slice(0, 60)}: no reply from the device`); }
  return out;
}
export function startMonitor() { checkDevices().catch(() => {}); setInterval(() => checkDevices().catch(() => {}), 60000).unref(); }

// ---------- registry ----------
const IP = /^(\d{1,3}\.){3}\d{1,3}$/, HOST = /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/i;
function clean(b, partial) {
  const o = {};
  const text = (k, max) => { if (k in b) o[k] = b[k] === '' || b[k] === null ? null : String(b[k]).trim().slice(0, max); };
  text('name', 80); text('location', 120); text('ip', 100); text('sn', 40); text('allowed_ips', 400);
  text('model', 60); text('dtype', 30); text('mac', 20); text('timezone', 40); text('notes', 500); text('installed', 10); text('warranty_until', 10); text('next_service', 10);
  if (o.mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(o.mac)) return { error: 'MAC address looks wrong (example 00:17:61:AB:CD:EF)' };
  if (o.installed && !/^\d{4}-\d\d-\d\d$/.test(o.installed)) return { error: 'Installed date must be YYYY-MM-DD' };
  for (const [k, l] of [['warranty_until', 'Warranty end'], ['next_service', 'Next service']]) if (o[k] && !/^\d{4}-\d\d-\d\d$/.test(o[k])) return { error: `${l} date must be YYYY-MM-DD` };
  if (o.allowed_ips && !o.allowed_ips.split(',').every(x => { x = x.trim(); const m = x.match(/^((\d{1,3}\.){3}\d{1,3})(\/(\d|[12]\d|3[0-2]))?$/); return m ? m[1].split('.').every(n => +n <= 255) : x === '::1'; })) return { error: 'Allowed addresses: IPv4 addresses or ranges such as 203.0.113.7 or 192.168.1.0/24, separated by commas' };
  if (!partial && !o.name) return { error: 'Name required' };
  if ('name' in b && !o.name) return { error: 'Name required' };
  if (o.ip && !(IP.test(o.ip) ? o.ip.split('.').every(n => +n <= 255) : HOST.test(o.ip))) return { error: 'The IP address or host name looks wrong' };
  if (o.sn && !/^[\w.-]{3,40}$/.test(o.sn)) return { error: 'Serial number: 3-40 letters, digits, - . _' };
  if (!partial && !o.ip && !o.sn) return { error: 'Give the IP address (the server connects to the device) or the serial number (the device connects to the server)' };
  for (const [k, lo, hi, label] of [['port', 1, 65535, 'Port'], ['delay', 1, 3600, 'Check-in interval'], ['error_delay', 1, 3600, 'Retry interval after an error']])
    if (k in b && b[k] !== null && b[k] !== '') { const v = Number(b[k]); if (!(Number.isInteger(v) && v >= lo && v <= hi)) return { error: `${label} must be a whole number from ${lo} to ${hi}` }; o[k] = v; }
  for (const k of ['approved', 'realtime', 'alert_off', 'att_device']) if (k in b) o[k] = b[k] ? 1 : 0;
  if ('alert_min' in b) { if (b.alert_min === null || b.alert_min === '') o.alert_min = null; else { const v = Number(b.alert_min); if (!(Number.isInteger(v) && v >= 1 && v <= 1440)) return { error: 'Offline alert must be a whole number of minutes from 1 to 1440' }; o.alert_min = v; } }
  if ('group_id' in b) { if (b.group_id && !db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(b.group_id)) return { error: 'Unknown device group' }; o.group_id = b.group_id || null; }
  return { o };
}
devicesRouter.get('/devices', (_q, res) => {
  const S = getSettings(), nowMs = Date.now();
  res.json(db.prepare(`SELECT d.*, g.name AS group_name,
      (SELECT COUNT(*) FROM device_users du WHERE du.device_id=d.id) AS user_qty,
      (SELECT COUNT(*) FROM biodata b WHERE b.device_id=d.id AND b.kind='fp') AS fp_qty, (SELECT COUNT(*) FROM biodata b WHERE b.device_id=d.id AND b.kind='face') AS face_qty,
      (SELECT COUNT(*) FROM logs l WHERE l.device_id=d.id) AS punches,
      (SELECT COUNT(*) FROM logs l WHERE l.device_id=d.id AND l.ts>=date('now','localtime')) AS punches_today,
      (SELECT MAX(ts) FROM logs l WHERE l.device_id=d.id) AS last_punch,
      (SELECT COUNT(*) FROM device_commands c WHERE c.device_id=d.id AND c.status IN ('pending','sent')) AS pending_commands,
      (SELECT COUNT(*) FROM device_commands c WHERE c.device_id=d.id AND c.status='failed') AS failed_commands,
      (SELECT COUNT(*) FROM device_events e WHERE e.device_id=d.id AND e.ts>=datetime('now','localtime','-1 day') AND e.kind IN ('offline','command_failed','sync_error','rejected_data','card_conflict')) AS problems_24h
    FROM devices d LEFT JOIN device_groups g ON g.id=d.group_id ORDER BY d.id`).all()
    .map(d => ({ ...d, info: d.info ? JSON.parse(d.info) : {}, push: isPush(d), online: isPush(d) ? (d.last_seen ? pushOnline(d, nowMs, S) : null) : (d.online === null ? null : !!d.online) })));
});
devicesRouter.post('/devices', (req, res) => {
  const { o, error } = clean(req.body ?? {}, false); if (error) return fail(res, error);
  if (o.sn) o.approved = 1; // a serial number typed in by an admin is trusted from its first connection
  const c = Object.keys(o);
  try { res.json({ id: Number(db.prepare(`INSERT INTO devices(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); }
  catch (e) { fail(res, /UNIQUE/.test(e.message) ? 'A device with this serial number already exists' : e.message); }
});
devicesRouter.put('/devices/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(req.params.id)) return fail(res, 'No such device', 404);
  const { o, error } = clean(req.body ?? {}, true); if (error) return fail(res, error);
  const c = Object.keys(o); if (!c.length) return res.json({ ok: true });
  try { db.prepare(`UPDATE devices SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true }); }
  catch (e) { fail(res, /UNIQUE/.test(e.message) ? 'Another device already has this serial number' : e.message); }
});
devicesRouter.delete('/devices/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM devices WHERE id=?').get(req.params.id)) return fail(res, 'No such device', 404);
  db.prepare('UPDATE logs SET device_id=NULL WHERE device_id=?').run(req.params.id); // punches stay in the attendance record
  db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id); res.json({ ok: true });
});

devicesRouter.post('/devices/check', async (_q, res) => res.json(await checkDevices()));
const load = (req, res) => { const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id); if (!d) fail(res, 'No such device', 404); return d; };
devicesRouter.post('/devices/:id/test', async (req, res) => {
  const d = load(req, res); if (!d) return;
  if (isPush(d)) return res.json({ ok: !!d.last_seen && pushOnline(d, Date.now(), getSettings()), mode: 'push', last_seen: d.last_seen, message: d.last_seen ? `Last contact ${d.last_seen}` : 'This device has never connected yet' });
  const r = await probe(d.ip, d.port || 4370, 3000);
  res.json({ ok: r.up, mode: 'pull', ms: r.ms ?? null, message: r.up ? `Reached ${d.ip}:${d.port || 4370} in ${r.ms} ms` : `No answer from ${d.ip}:${d.port || 4370}. Check the cable/WiFi, the IP address and that the device allows connections.` });
});
devicesRouter.post('/devices/:id/sync', async (req, res) => { // pull devices: read users and all punches now
  const d = load(req, res); if (!d) return;
  if (isPush(d)) return fail(res, 'This is a push device: it uploads by itself. Use "Request logs" to ask it to send punches again.');
  try { const r = await syncDevice(d); res.json(r); } catch (e) { logEvent(d.id, 'sync_error', e.message); res.status(502).json({ error: 'Device sync failed: ' + e.message }); }
});

// ---------- commands for push devices (formats follow the ZKTeco push protocol; verify on your own device model) ----------
const needPush = (d, res) => (isPush(d) && d.approved ? true : (fail(res, 'This works for approved push devices only'), false));
devicesRouter.post('/devices/:id/reboot', (req, res) => { const d = load(req, res); if (!d || !needPush(d, res)) return; res.json({ command: queueCommand(d.id, 'REBOOT') }); });
devicesRouter.post('/devices/:id/time-sync', (req, res) => {
  const d = load(req, res); if (!d) return;
  if (!isPush(d)) return fail(res, 'Setting the clock is not supported for pull-mode devices. Set it on the device, or switch the device to push mode.');
  if (!d.approved) return fail(res, 'Approve the device first');
  res.json({ command: queueCommand(d.id, `SET OPTION DateTime=${stamp()}`) });
});
devicesRouter.post('/devices/:id/request-logs', (req, res) => {
  const d = load(req, res); if (!d || !needPush(d, res)) return;
  const D = /^\d{4}-\d\d-\d\d$/, from = req.body?.from, to = req.body?.to;
  if (!D.test(from ?? '') || !D.test(to ?? '') || to < from) return fail(res, 'Choose a from and to date');
  res.json({ command: queueCommand(d.id, `DATA QUERY ATTLOG StartTime=${from} 00:00:00\tEndTime=${to} 23:59:59`) });
});
devicesRouter.post('/devices/:id/fetch-users', (req, res) => { const d = load(req, res); if (!d || !needPush(d, res)) return; res.json({ command: queueCommand(d.id, 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*') }); });
// Send people to a device. A device in a group tied to a branch receives only that branch's employees.
devicesRouter.post('/devices/:id/push-users', (req, res) => {
  const d = load(req, res); if (!d || !needPush(d, res)) return;
  const g = d.group_id ? db.prepare('SELECT * FROM device_groups WHERE id=?').get(d.group_id) : null, emps = eligibleEmployees(d);
  for (const e of emps) queueCommand(d.id, userCmd(e.code, e.name, e.card_no));
  res.json({ queued: emps.length, only_branch: !!g?.branch_id, only_chosen: d.access_mode === 'selected' });
});
// Copy stored fingerprints/faces to this device (only possible when template storage is on).
devicesRouter.post('/devices/:id/sync-bio', (req, res) => {
  const d = load(req, res); if (!d || !needPush(d, res)) return;
  if (!getSettings().store_templates) return fail(res, 'Template storage is switched off in Settings, so there is nothing to copy.');
  const from = req.body?.from_device_id ?? null, okIds = new Set(eligibleEmployees(d).map(e => e.id));
  const rows = db.prepare(`SELECT b.id, b.kind, b.fid, b.size, e.id AS eid, e.code, e.name, e.card_no FROM biodata b JOIN employees e ON e.id=b.employee_id
    WHERE e.active=1 AND b.data IS NOT NULL AND IFNULL(b.device_id,0)!=? ${from ? 'AND b.device_id=?' : ''} LIMIT 5000`).all(d.id, ...(from ? [from] : [])).filter(r => okIds.has(r.eid));
  const seen = new Set(); let queued = 0;
  for (const r of rows) {
    if (!seen.has(r.code)) { seen.add(r.code); queueCommand(d.id, userCmd(r.code, r.name, r.card_no)); }
    // the queued command holds only a reference; the template is decrypted at the moment it is handed to the device
    queueCommand(d.id, `DATA UPDATE ${r.kind === 'fp' ? 'FINGERTMP' : 'FACE'} PIN=${r.code}\tFID=${r.fid}\tSize=${r.size ?? 0}\tValid=1\tTMP={{bio:${r.id}}}`); queued++;
  }
  res.json({ queued, employees: seen.size });
});


// ---------- connect guide, bulk actions, users on a device, punch log, health history ----------
devicesRouter.get('/devices/connect-info', (req, res) => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  res.json({ addresses: ips, port: Number(process.env.PORT || 8080), request_host: req.headers.host ?? null });
});
devicesRouter.post('/devices/bulk', (req, res) => {
  const ids = [...new Set((req.body?.ids ?? []).map(Number).filter(Number.isInteger))].slice(0, 500), action = req.body?.action;
  if (!ids.length) return fail(res, 'Select at least one device');
  const devs = ids.map(id => db.prepare('SELECT * FROM devices WHERE id=?').get(id)).filter(Boolean);
  let done = 0, skipped = 0;
  if (action === 'group') {
    const g = req.body.group_id || null; if (g && !db.prepare('SELECT 1 FROM device_groups WHERE id=?').get(g)) return fail(res, 'Unknown device group');
    for (const d of devs) { db.prepare('UPDATE devices SET group_id=? WHERE id=?').run(g, d.id); done++; }
  } else if (action === 'approve') { for (const d of devs) { db.prepare('UPDATE devices SET approved=1 WHERE id=?').run(d.id); done++; } }
  else if (action === 'delete') { for (const d of devs) { db.prepare('UPDATE logs SET device_id=NULL WHERE device_id=?').run(d.id); db.prepare('DELETE FROM devices WHERE id=?').run(d.id); done++; } }
  else if (action === 'clear-commands') { for (const d of devs) { done += Number(db.prepare('DELETE FROM device_commands WHERE device_id=?').run(d.id).changes) > 0 ? 1 : 0; } }
  else if (action === 'clear-log' || action === 'clear-data' || action === 'send-users' || action === 'fetch-users') { // data commands for approved push devices
    for (const d of devs) {
      if (!isPush(d) || !d.approved) { skipped++; continue; }
      if (action === 'clear-log') queueCommand(d.id, 'CLEAR LOG'); else if (action === 'clear-data') queueCommand(d.id, 'CLEAR DATA');
      else if (action === 'fetch-users') queueCommand(d.id, 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*');
      else for (const e of eligibleEmployees(d)) queueCommand(d.id, userCmd(e.code, e.name, e.card_no));
      done++;
    }
  } else if (action === 'reboot' || action === 'time-sync') {
    for (const d of devs) {
      if (!isPush(d) || !d.approved) { skipped++; continue; }
      queueCommand(d.id, action === 'reboot' ? 'REBOOT' : `SET OPTION DateTime=${stamp()}`); done++;
    }
  } else return fail(res, 'Unknown action');
  res.json({ done, skipped });
});

// Everyone known to be on this device: reported by the device itself, enrolled there, or punched there.
devicesRouter.get('/devices/:id/users', (req, res) => {
  const d = load(req, res); if (!d) return;
  const rows = db.prepare(`
    WITH codes AS (SELECT code FROM device_users WHERE device_id=:d UNION SELECT emp_code FROM logs WHERE device_id=:d UNION SELECT e.code FROM biodata b JOIN employees e ON e.id=b.employee_id WHERE b.device_id=:d)
    SELECT c.code, e.id AS employee_id, e.name AS emp_name, du.name AS device_name, COALESCE(e.card_no, du.card) AS card, e.active,
      (SELECT COUNT(*) FROM biodata b WHERE b.employee_id=e.id AND b.kind='fp' AND b.device_id=:d) AS fingerprints,
      (SELECT COUNT(*) FROM biodata b WHERE b.employee_id=e.id AND b.kind='face' AND b.device_id=:d) AS faces,
      (SELECT COUNT(*) FROM logs l WHERE l.emp_code=c.code AND l.device_id=:d) AS punches,
      (SELECT MAX(ts) FROM logs l WHERE l.emp_code=c.code AND l.device_id=:d) AS last_punch,
      du.code IS NOT NULL AS listed
    FROM codes c LEFT JOIN employees e ON e.code=c.code LEFT JOIN device_users du ON du.device_id=:d AND du.code=c.code ORDER BY c.code LIMIT 5000`).all({ d: d.id });
  res.json({ push: isPush(d), approved: !!d.approved, users: rows.map(r => ({ ...r, name: r.emp_name || r.device_name || '', in_system: !!r.employee_id })) });
});
const codesOf = (req) => [...new Set((req.body?.codes ?? []).map(String).filter(c => /^[\w.-]{1,30}$/.test(c)))].slice(0, 2000);
devicesRouter.post('/devices/:id/users/send', (req, res) => { // send chosen employees to the device (or every active one when "all")
  const d = load(req, res); if (!d || !needPush(d, res)) return;
  const ok = new Map(eligibleEmployees(d).map(e => [e.code, e]));
  const codes = req.body?.all ? [...ok.keys()] : codesOf(req);
  let n = 0; for (const c of codes) { const e = ok.get(c); if (!e) continue; queueCommand(d.id, userCmd(e.code, e.name, e.card_no)); db.prepare("INSERT INTO device_users(device_id, code, name) VALUES(?,?,?) ON CONFLICT(device_id, code) DO NOTHING").run(d.id, e.code, e.name); n++; }
  res.json({ queued: n });
});
devicesRouter.post('/devices/:id/users/remove', (req, res) => { // delete chosen people from the device only; the employee record stays
  const d = load(req, res); if (!d || !needPush(d, res)) return;
  const codes = codesOf(req); if (!codes.length) return fail(res, 'Select at least one person');
  for (const c of codes) { queueCommand(d.id, `DATA DELETE USERINFO PIN=${c}`); db.prepare('DELETE FROM device_users WHERE device_id=? AND code=?').run(d.id, c); }
  res.json({ queued: codes.length });
});

devicesRouter.get('/devices/:id/punches', (req, res) => {
  const d = load(req, res); if (!d) return;
  const D = /^\d{4}-\d\d-\d\d$/, w = ['l.device_id=?'], a = [d.id], q = req.query;
  if (D.test(q.from ?? '')) { w.push('l.ts>=?'); a.push(q.from + ' 00:00:00'); }
  if (D.test(q.to ?? '')) { w.push('l.ts<=?'); a.push(q.to + ' 23:59:59'); }
  if (q.q) { w.push('(l.emp_code LIKE ? OR e.name LIKE ?)'); a.push(`%${q.q}%`, `%${q.q}%`); }
  const where = w.join(' AND '), lim = Math.min(Number(q.limit) || 200, 20000);
  const total = db.prepare(`SELECT COUNT(*) n FROM logs l LEFT JOIN employees e ON e.code=l.emp_code WHERE ${where}`).get(...a).n;
  const rows = db.prepare(`SELECT l.id, l.ts, l.emp_code AS code, e.name, l.temp_c FROM logs l LEFT JOIN employees e ON e.code=l.emp_code WHERE ${where} ORDER BY l.ts DESC LIMIT ?`).all(...a, lim);
  res.json({ total, rows });
});

// Online/offline history: uptime per day from the recorded online/offline events.
devicesRouter.get('/devices/:id/health', (req, res) => {
  const d = load(req, res); if (!d) return;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90), now = Date.now(), from = now - days * 86400000;
  const evs = db.prepare("SELECT ts, kind FROM device_events WHERE device_id=? AND kind IN ('online','offline') ORDER BY id").all(d.id).map(e => ({ t: ts(e.ts), kind: e.kind })).filter(e => !isNaN(e.t)).sort((a, b) => a.t - b.t);
  const before = evs.filter(e => e.t < from).at(-1), inWin = evs.filter(e => e.t >= from);
  let state = before ? before.kind : null, cur = from, onMs = 0, offMs = 0; const outages = [], buckets = {};
  const add = (a, b, st) => { // split [a,b) over days
    if (b <= a || st === null) return;
    for (let t = a; t < b;) { const day = new Date(t); day.setHours(24, 0, 0, 0); const e = Math.min(b, day.getTime()), k = new Date(t).toLocaleDateString('sv'); (buckets[k] ??= { on: 0, off: 0 })[st === 'online' ? 'on' : 'off'] += e - t; t = e; }
    if (st === 'online') onMs += b - a; else offMs += b - a;
  };
  let offSince = state === 'offline' ? from : null;
  for (const e of inWin) { add(cur, e.t, state); if (e.kind === 'offline') offSince = e.t; else if (offSince !== null) { outages.push({ from: new Date(offSince).toLocaleString('sv'), to: new Date(e.t).toLocaleString('sv'), minutes: Math.round((e.t - offSince) / 60000) }); offSince = null; } state = e.kind; cur = e.t; }
  add(cur, now, state);
  if (offSince !== null) outages.push({ from: new Date(offSince).toLocaleString('sv'), to: null, minutes: Math.round((now - offSince) / 60000) });
  const known = onMs + offMs;
  res.json({ days, uptime_pct: known ? Math.round(onMs / known * 1000) / 10 : null, outages: outages.reverse().slice(0, 50), total_offline_min: Math.round(offMs / 60000),
    daily: Array.from({ length: days }, (_x, i) => { const k = new Date(now - (days - 1 - i) * 86400000).toLocaleDateString('sv'), b = buckets[k]; return { date: k, pct: b && b.on + b.off ? Math.round(b.on / (b.on + b.off) * 1000) / 10 : null }; }) });
});


// ---------- maintenance log ----------
const DAY = /^\d{4}-\d\d-\d\d$/;
devicesRouter.get('/devices/:id/maintenance', (req, res) => { const d = load(req, res); if (!d) return; res.json({ warranty_until: d.warranty_until, next_service: d.next_service, entries: db.prepare('SELECT id, day, kind, note, cost, by FROM device_maint WHERE device_id=? ORDER BY day DESC, id DESC').all(d.id) }); });
devicesRouter.post('/devices/:id/maintenance', (req, res) => {
  const d = load(req, res); if (!d) return; const b = req.body ?? {};
  const kind = ['Service', 'Repair', 'Replacement', 'Cleaning', 'Firmware', 'Other'].includes(b.kind) ? b.kind : null;
  if (!kind) return fail(res, 'Choose what was done'); if (!DAY.test(b.day ?? '')) return fail(res, 'Date must be YYYY-MM-DD');
  const cost = b.cost === '' || b.cost == null ? null : Number(b.cost); if (cost !== null && !(cost >= 0 && cost < 1e9)) return fail(res, 'Cost must be a number');
  if (b.next_service && !DAY.test(b.next_service)) return fail(res, 'Next service must be YYYY-MM-DD');
  db.prepare('INSERT INTO device_maint(device_id, day, kind, note, cost, by) VALUES(?,?,?,?,?,?)').run(d.id, b.day, kind, String(b.note ?? '').slice(0, 500) || null, cost, String(b.by ?? '').slice(0, 60) || null);
  if (b.next_service) db.prepare('UPDATE devices SET next_service=? WHERE id=?').run(b.next_service, d.id);
  else if (kind === 'Service' && d.next_service && d.next_service <= b.day) db.prepare('UPDATE devices SET next_service=NULL WHERE id=?').run(d.id); // the planned service has been done
  res.json({ ok: true });
});
devicesRouter.delete('/devices/maintenance/:mid', (req, res) => { db.prepare('DELETE FROM device_maint WHERE id=?').run(req.params.mid); res.json({ ok: true }); });

// ---------- who may use a device ----------
devicesRouter.get('/devices/:id/access', (req, res) => {
  const d = load(req, res); if (!d) return;
  res.json({ mode: d.access_mode || 'all', employees: db.prepare(`SELECT e.code, e.name, b.name AS branch, EXISTS(SELECT 1 FROM device_access a WHERE a.device_id=? AND a.employee_id=e.id) AS allowed FROM employees e LEFT JOIN branches b ON b.id=e.branch_id WHERE e.active=1 ORDER BY e.code`).all(d.id).map(r => ({ ...r, allowed: !!r.allowed })) });
});
devicesRouter.put('/devices/:id/access', (req, res) => { const d = load(req, res); if (!d) return; const m = req.body?.mode; if (!['all', 'selected'].includes(m)) return fail(res, 'Mode must be all or selected'); db.prepare('UPDATE devices SET access_mode=? WHERE id=?').run(m, d.id); res.json({ ok: true }); });
devicesRouter.post('/devices/:id/access/set', (req, res) => { // allow or revoke chosen people; revoking can also remove them from the device
  const d = load(req, res); if (!d) return; const codes = codesOf(req); if (!codes.length) return fail(res, 'Select at least one person');
  const allow = !!req.body?.allow, alsoRemove = !allow && !!req.body?.remove && isPush(d) && d.approved; let n = 0, removed = 0;
  for (const c of codes) {
    const e = db.prepare('SELECT id, code, name, card_no FROM employees WHERE code=?').get(c); if (!e) continue; n++;
    if (allow) { db.prepare('INSERT OR IGNORE INTO device_access(device_id, employee_id) VALUES(?,?)').run(d.id, e.id); if (req.body?.send && isPush(d) && d.approved && d.access_mode === 'selected') queueCommand(d.id, userCmd(e.code, e.name, e.card_no)); }
    else { db.prepare('DELETE FROM device_access WHERE device_id=? AND employee_id=?').run(d.id, e.id); if (alsoRemove) { queueCommand(d.id, `DATA DELETE USERINFO PIN=${e.code}`); db.prepare('DELETE FROM device_users WHERE device_id=? AND code=?').run(d.id, e.code); removed++; } }
  }
  res.json({ changed: n, removed });
});

// ---------- CSV export / import of the device list ----------
const CSV_COLS = ['name', 'serial', 'ip', 'port', 'model', 'type', 'mac', 'location', 'group', 'timezone', 'installed', 'warranty_until', 'notes'];
devicesRouter.get('/devices/export', (_q, res) => {
  const rows = db.prepare('SELECT d.*, g.name AS gname FROM devices d LEFT JOIN device_groups g ON g.id=d.group_id ORDER BY d.id').all().map(d => ({ name: d.name, serial: d.sn, ip: d.sn ? null : d.ip, port: d.sn ? null : d.port, model: d.model, type: d.dtype, mac: d.mac, location: d.location, group: d.gname, timezone: d.timezone, installed: d.installed, warranty_until: d.warranty_until, notes: d.notes }));
  res.json({ csv: toCsv(CSV_COLS, rows), count: rows.length });
});
devicesRouter.post('/devices/import', (req, res) => {
  const table = parseCsv(String(req.body?.csv ?? '')); if (table.length < 2) return fail(res, 'Paste a CSV with a header row and at least one device');
  const head = table[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_')); if (!head.includes('name')) return fail(res, 'The first row must have column names, including "name"');
  if (table.length > 1001) return fail(res, 'At most 1000 devices at a time');
  let added = 0, skipped = 0; const errors = [];
  table.slice(1).forEach((r, i) => {
    const g = (k) => (r[head.indexOf(k)] ?? '').trim(), line = i + 2;
    let group_id = null; if (g('group')) { group_id = db.prepare('SELECT id FROM device_groups WHERE name=?').get(g('group'))?.id ?? Number(db.prepare('INSERT INTO device_groups(name) VALUES(?)').run(g('group').slice(0, 60)).lastInsertRowid); }
    const b = { name: g('name'), sn: g('serial') || null, ip: g('ip') || null, port: g('port') || null, model: g('model') || null, dtype: g('type') || null, mac: g('mac') || null, location: g('location') || null, timezone: g('timezone') || null, installed: g('installed') || null, warranty_until: g('warranty_until') || null, notes: g('notes') || null, group_id };
    const { o, error } = clean(b, false); if (error) { errors.push({ line, error }); return; }
    if (o.sn) o.approved = 1;
    if ((o.sn && db.prepare('SELECT 1 FROM devices WHERE sn=?').get(o.sn)) || (!o.sn && o.ip && db.prepare('SELECT 1 FROM devices WHERE ip=? AND sn IS NULL AND IFNULL(port,4370)=?').get(o.ip, o.port || 4370))) { skipped++; return; }
    const c = Object.keys(o); db.prepare(`INSERT INTO devices(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])); added++;
  });
  res.json({ added, skipped, errors: errors.slice(0, 50) });
});

// ---------- messages shown on the device screen ----------
const msgClean = (t) => String(t ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 200);
devicesRouter.get('/device-messages', (req, res) => res.json(db.prepare(`SELECT m.*, e.code, e.name AS employee FROM device_messages m LEFT JOIN employees e ON e.id=m.employee_id ${req.query.scope ? 'WHERE m.scope=?' : ''} ORDER BY m.id DESC LIMIT 500`).all(...(req.query.scope ? [req.query.scope] : []))));
devicesRouter.post('/device-messages', (req, res) => {
  const b = req.body ?? {}, scope = b.scope === 'private' ? 'private' : 'public', content = msgClean(b.content); if (!content) return fail(res, 'Write the message');
  const start = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(b.start_ts ?? '') ? String(b.start_ts).replace('T', ' ').slice(0, 16) + ':00' : stamp(), dur = b.duration_min === undefined || b.duration_min === '' ? 1440 : Number(b.duration_min);
  if (!(Number.isInteger(dur) && dur >= 1 && dur <= 65535)) return fail(res, 'Duration is 1 to 65535 minutes');
  const ids = scope === 'private' ? [...new Set((b.employee_ids ?? []).map(Number))].filter(i => db.prepare('SELECT 1 FROM employees WHERE id=?').get(i)) : [null]; if (scope === 'private' && !ids.length) return fail(res, 'Choose who the message is for');
  const out = ids.map(emp => Number(db.prepare('INSERT INTO device_messages(scope, employee_id, content, start_ts, duration_min) VALUES(?,?,?,?,?)').run(scope, emp, content, start, dur).lastInsertRowid)); res.json({ ids: out });
});
devicesRouter.delete('/device-messages/:id', (req, res) => { db.prepare('DELETE FROM device_messages WHERE id=?').run(req.params.id); res.json({ ok: true }); });
// Send to the screens: a public message to the chosen (or every approved push) devices, a private one to every approved push device (the device shows it to that person only).
devicesRouter.post('/device-messages/:id/send', (req, res) => {
  const m = db.prepare('SELECT m.*, e.code FROM device_messages m LEFT JOIN employees e ON e.id=m.employee_id WHERE m.id=?').get(req.params.id); if (!m) return fail(res, 'No such message', 404);
  const want = Array.isArray(req.body?.device_ids) && req.body.device_ids.length ? req.body.device_ids.map(Number) : null;
  const devs = db.prepare('SELECT id FROM devices WHERE sn IS NOT NULL AND approved=1').all().filter(d => !want || want.includes(d.id)); if (!devs.length) return fail(res, 'No approved push device to send to');
  for (const d of devs) { queueCommand(d.id, `DATA UPDATE SMS UID=${m.id}\tMsg=${msgClean(m.content)}\tTag=${m.scope === 'private' ? 254 : 253}\tMin=${m.duration_min}\tStartTime=${m.start_ts}`); if (m.scope === 'private') queueCommand(d.id, `DATA UPDATE USER_SMS Pin=${m.code}\tUID=${m.id}`); }
  db.prepare('UPDATE device_messages SET last_sent=? WHERE id=?').run(stamp(), m.id); res.json({ devices: devs.length });
});
// Every command queued for any device (the "Device command" page).
devicesRouter.get('/device-commands', (req, res) => {
  const w = [], a = []; if (req.query.status) { w.push('c.status=?'); a.push(req.query.status); } if (req.query.device_id) { w.push('c.device_id=?'); a.push(Number(req.query.device_id)); }
  res.json(db.prepare(`SELECT c.id, c.device_id, d.name AS device, d.sn, c.cmd, c.status, c.result, c.created, c.sent FROM device_commands c JOIN devices d ON d.id=c.device_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY c.id DESC LIMIT ?`).all(...a, Math.min(Number(req.query.limit) || 300, 1000)).map(c => ({ ...c, cmd: hideTmpl(c.cmd).replace(/\t/g, '  ') })));
});
devicesRouter.delete('/device-commands/:id', (req, res) => { db.prepare('DELETE FROM device_commands WHERE id=?').run(req.params.id); res.json({ ok: true }); });
devicesRouter.post('/device-commands/clear', (req, res) => { const r = db.prepare("DELETE FROM device_commands WHERE status IN ('done','cancelled','failed')").run(); res.json({ cleared: Number(r.changes) }); });
devicesRouter.get('/devices/:id/commands', (req, res) =>
  res.json(db.prepare('SELECT id, cmd, status, result, created FROM device_commands WHERE device_id=? ORDER BY id DESC LIMIT 60').all(req.params.id).map(c => ({ ...c, cmd: hideTmpl(c.cmd).replace(/\t/g, '  ') }))));
devicesRouter.post('/devices/commands/:cid/cancel', (req, res) => {
  const r = db.prepare("UPDATE device_commands SET status='cancelled' WHERE id=? AND status='pending'").run(req.params.cid);
  r.changes ? res.json({ ok: true }) : fail(res, 'Only a command that has not been fetched yet can be cancelled');
});
devicesRouter.post('/devices/commands/:cid/retry', (req, res) => {
  const r = db.prepare("UPDATE device_commands SET status='pending', result=NULL WHERE id=? AND status IN ('failed','cancelled')").run(req.params.cid);
  r.changes ? res.json({ ok: true }) : fail(res, 'Only a failed or cancelled command can be retried');
});
devicesRouter.post('/devices/:id/commands/clear', (req, res) => {
  const r = db.prepare("DELETE FROM device_commands WHERE device_id=? AND status IN ('done','cancelled','failed')").run(req.params.id);
  res.json({ cleared: Number(r.changes) });
});
devicesRouter.get('/devices/:id/events', (req, res) => res.json(db.prepare('SELECT id, ts, kind, detail FROM device_events WHERE device_id=? ORDER BY id DESC LIMIT 100').all(req.params.id)));
devicesRouter.get('/device-events', (req, res) => {
  const w = [], a = []; if (req.query.kind) { w.push('AND e.kind=?'); a.push(req.query.kind); } if (req.query.device_id) { w.push('AND e.device_id=?'); a.push(Number(req.query.device_id)); }
  res.json(db.prepare(`SELECT e.id, e.ts, e.kind, e.detail, d.name AS device, d.id AS device_id FROM device_events e JOIN devices d ON d.id=e.device_id WHERE 1=1 ${w.join(' ')} ORDER BY e.id DESC LIMIT 200`).all(...a));
});

// ---------- device groups ----------
devicesRouter.get('/device_groups', (_q, res) => res.json(db.prepare('SELECT g.*, b.name AS branch, (SELECT COUNT(*) FROM devices WHERE group_id=g.id) AS devices FROM device_groups g LEFT JOIN branches b ON b.id=g.branch_id ORDER BY g.name').all()));
devicesRouter.post('/device_groups', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60), b = req.body?.branch_id || null;
  if (!name) return fail(res, 'Name required'); if (b && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(b)) return fail(res, 'Unknown branch');
  try { res.json({ id: Number(db.prepare('INSERT INTO device_groups(name, branch_id) VALUES(?,?)').run(name, b).lastInsertRowid) }); } catch { fail(res, 'A group with this name exists'); }
});
devicesRouter.put('/device_groups/:id', (req, res) => {
  const b = req.body?.branch_id || null; if (b && !db.prepare('SELECT 1 FROM branches WHERE id=?').get(b)) return fail(res, 'Unknown branch');
  db.prepare('UPDATE device_groups SET name=COALESCE(?, name), branch_id=? WHERE id=?').run(req.body?.name ? String(req.body.name).trim().slice(0, 60) : null, b, req.params.id); res.json({ ok: true });
});
devicesRouter.delete('/device_groups/:id', (req, res) => {
  if (db.prepare('SELECT COUNT(*) n FROM devices WHERE group_id=?').get(req.params.id).n) return fail(res, 'Devices are still in this group');
  db.prepare('DELETE FROM device_groups WHERE id=?').run(req.params.id); res.json({ ok: true });
});

// ---------- cards and enrolled biometrics per employee (templates themselves are never returned) ----------
devicesRouter.get('/employees/:id/biometrics', (req, res) => {
  const e = db.prepare('SELECT id, card_no FROM employees WHERE id=?').get(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  const items = db.prepare('SELECT b.kind, b.fid, b.size, b.received, b.data IS NOT NULL AS stored, d.name AS device FROM biodata b LEFT JOIN devices d ON d.id=b.device_id WHERE b.employee_id=? ORDER BY b.kind, b.fid').all(e.id);
  res.json({ card_no: e.card_no, fingerprints: items.filter(i => i.kind === 'fp').length, faces: items.filter(i => i.kind === 'face').length, stored: items.filter(i => i.stored).length, storage_on: !!getSettings().store_templates, items });
});
devicesRouter.delete('/employees/:id/biometrics', (req, res) => { db.prepare('DELETE FROM biodata WHERE employee_id=?').run(req.params.id); res.json({ ok: true }); });
devicesRouter.delete('/biodata', (_q, res) => { const r = db.prepare('UPDATE biodata SET data=NULL WHERE data IS NOT NULL').run(); res.json({ erased: Number(r.changes) }); }); // admin only: wipe every stored template
