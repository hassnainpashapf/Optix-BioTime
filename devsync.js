import { db } from './db.js';

// Changes made in the app reach approved push devices as commands the device fetches on its next poll.
export const clean = (v) => String(v ?? '').replace(/[\t\r\n]/g, ' ').trim();
export const userCmd = (code, name, card = '') => `DATA UPDATE USERINFO PIN=${clean(code)}\tName=${clean(name)}\tPri=0\tPasswd=\tCard=${clean(card)}\tGrp=1\tTZ=0000000100000000`;
export const queueCommand = (deviceId, cmd) => Number(db.prepare('INSERT INTO device_commands(device_id, cmd) VALUES(?,?)').run(deviceId, cmd).lastInsertRowid);
export function queueUser(code, name, op) {
  const card = db.prepare('SELECT card_no FROM employees WHERE code=?').get(code)?.card_no ?? '';
  const cmd = op === 'delete' ? `DATA DELETE USERINFO PIN=${clean(code)}` : userCmd(code, name, card);
  const emp = db.prepare('SELECT id FROM employees WHERE code=?').get(code);
  for (const d of db.prepare('SELECT id, access_mode FROM devices WHERE sn IS NOT NULL AND approved=1').all()) {
    if (op !== 'delete' && d.access_mode === 'selected' && !(emp && db.prepare('SELECT 1 FROM device_access WHERE device_id=? AND employee_id=?').get(d.id, emp.id))) continue; // this device only takes chosen people
    queueCommand(d.id, cmd);
  }
}
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
