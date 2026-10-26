import { db } from './db.js';

// Changes made in the app reach approved push devices as commands the device fetches on its next poll.
export const clean = (v) => String(v ?? '').replace(/[\t\r\n]/g, ' ').trim();
export const userCmd = (code, name, card = '', pri = 0, pass = '') => `DATA UPDATE USERINFO PIN=${clean(code)}\tName=${clean(name)}\tPri=${Number(pri) || 0}\tPasswd=${clean(pass)}\tCard=${clean(card)}\tGrp=1\tTZ=0000000100000000`;
export const queueCommand = (deviceId, cmd) => Number(db.prepare('INSERT INTO device_commands(device_id, cmd) VALUES(?,?)').run(deviceId, cmd).lastInsertRowid);
export function queueUser(code, name, op) {
  const me = db.prepare('SELECT card_no, device_priv, pin FROM employees WHERE code=?').get(code), card = me?.card_no ?? '';
  const cmd = op === 'delete' ? `DATA DELETE USERINFO PIN=${clean(code)}` : userCmd(code, name, card, me?.device_priv ?? 0, me?.pin ?? '');
  const emp = db.prepare('SELECT id FROM employees WHERE code=?').get(code);
  for (const d of db.prepare('SELECT id, access_mode FROM devices WHERE sn IS NOT NULL AND approved=1').all()) {
    if (op !== 'delete' && d.access_mode === 'selected' && !(emp && db.prepare('SELECT 1 FROM device_access WHERE device_id=? AND employee_id=?').get(d.id, emp.id))) continue; // this device only takes chosen people
    queueCommand(d.id, cmd);
  }
  pullUser(code, name, card, op);
}

// Devices added by IP and port (pull) are written directly, like BioTime's area sync: an employee goes to the devices of their Area, and leaves them when deleted, resigned or moved to another Area.
// Changes are collected for a moment and sent in one connection per device (one at a time, so they never clash with the scheduled read).
const pend = new Map(), chain = new Map();
function pullUser(code, name, card, op) {
  const emp = db.prepare('SELECT * FROM employees WHERE code=?').get(code);
  for (const d of db.prepare('SELECT * FROM devices WHERE sn IS NULL AND ip IS NOT NULL AND approved=1').all()) {
    const allowed = op !== 'delete' && emp && emp.active && eligibleEmployees(d).some(e => e.code === code);
    if (!pend.has(d.id)) pend.set(d.id, new Map());
    pend.get(d.id).set(code, allowed ? { send: { code, name, card, role: emp.device_priv ?? 0, password: emp.pin ?? undefined } } : { remove: code });
  }
  clearTimeout(pullUser.t); pullUser.t = setTimeout(flushPull, 1500);
}
function flushPull() {
  for (const [id, ops] of [...pend]) {
    pend.delete(id);
    chain.set(id, (chain.get(id) ?? Promise.resolve()).then(async () => {
      const d = db.prepare('SELECT * FROM devices WHERE id=?').get(id); if (!d) return;
      const { sendUsersToDevice, removeUsersFromDevice, sendFingerprintsToDevice } = await import('./zk.js');
      const send = [...ops.values()].filter(o => o.send).map(o => o.send), remove = [...ops.values()].filter(o => o.remove).map(o => o.remove);
      try {
        if (send.length) { await sendUsersToDevice(d, send); await sendFingerprintsToDevice(d, send).catch(() => null); // fingerprints already kept for them (enrolled on another device)
 for (const p of send) db.prepare('INSERT INTO device_users(device_id, code, name) VALUES(?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name').run(d.id, p.code, p.name); }
        if (remove.length) { await removeUsersFromDevice(d, remove); for (const c of remove) db.prepare('DELETE FROM device_users WHERE device_id=? AND code=?').run(d.id, c); }
        logEvent(d.id, 'users_synced', `${send.length} person(s) written, ${remove.length} removed`);
      } catch (e) { logEvent(d.id, 'sync_error', 'Could not update the people on the device: ' + e.message); }
    }));
  }
}
export const pullIdle = () => Promise.all([...chain.values()]); // for tests
// Is this client address on the device's allow-list? Entries are single IPv4 addresses or a.b.c.d/nn ranges; an empty list means "anyone".
export function ipAllowed(ip, list) {
  const entries = String(list ?? '').split(',').map(s => s.trim()).filter(Boolean); if (!entries.length) return true;
  const a = String(ip ?? '').replace(/^::ffff:/, ''), n = (s) => s.split('.').reduce((x, p) => x * 256 + Number(p), 0), v4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  return entries.some(e => { if (!e.includes('/')) return e === a; const [base, bits] = e.split('/'); if (!v4.test(base) || !v4.test(a)) return false; const m = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0; return (n(a) & m) >>> 0 === (n(base) & m) >>> 0; });
}
export function logEvent(deviceId, kind, detail = '') {
  db.prepare('INSERT INTO device_events(device_id, kind, detail) VALUES(?,?,?)').run(deviceId, kind, String(detail).slice(0, 300));
}

// Active employees this device may hold: its group's branch (if any) and its access list (if the device takes only chosen people).
export function eligibleEmployees(d) {
  const g = d.group_id ? db.prepare('SELECT branch_id FROM device_groups WHERE id=?').get(d.group_id) : null, a = [];
  let w = 'e.active=1'; if (g?.branch_id) { w += ' AND e.branch_id=?'; a.push(g.branch_id); }
  if (d.access_mode === 'selected') { w += ' AND e.id IN (SELECT employee_id FROM device_access WHERE device_id=?)'; a.push(d.id); }
  return db.prepare(`SELECT e.id, e.code, e.name, e.card_no FROM employees e WHERE ${w} ORDER BY e.code`).all(...a);
}
