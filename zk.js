import ZKLib from 'node-zklib';
import { db } from './db.js';
import { emit } from './events.js';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export function saveLogs(rows, deviceId = null) {
  const ins = db.prepare('INSERT OR IGNORE INTO logs(emp_code, ts, device_id, temp_c, mask) VALUES(?,?,?,?,?)');
  const emp = db.prepare('INSERT OR IGNORE INTO employees(code, name) VALUES(?,?)');
  let added = 0; const fresh = [];
  db.exec('BEGIN');
  try {
    for (const c of new Set(rows.map(r => String(r.code)))) emp.run(c, `User ${c}`); // punch from an unknown person must not vanish
    for (const r of rows) if (Number(ins.run(String(r.code), r.ts, deviceId, r.temp_c ?? null, r.mask ?? null).changes)) { added++; fresh.push({ code: String(r.code), time: r.ts, device_id: deviceId }); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (fresh.length) emit('punch.created', { punches: fresh.slice(0, 500), count: fresh.length });
  return added;
}

// Pull users + attendance logs from a ZKTeco device over TCP (default port 4370).
export async function syncDevice(device) {
  const zk = new ZKLib(device.ip, device.port || 4370, 10000, 4000);
  const status = (s) => db.prepare('UPDATE devices SET last_sync=?, last_status=? WHERE id=?').run(fmt(new Date()), s, device.id);
  try {
    await zk.createSocket();
    const users = (await zk.getUsers()).data ?? [];
    const logs = (await zk.getAttendances()).data ?? [];

    const insEmp = db.prepare('INSERT OR IGNORE INTO employees(code, name) VALUES(?,?)');
    for (const u of users) { insEmp.run(String(u.userId), u.name || `User ${u.userId}`); db.prepare("INSERT INTO device_users(device_id, code, name) VALUES(?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name, seen=datetime('now','localtime')").run(device.id, String(u.userId), u.name || null); }

    const added = saveLogs(logs.map(l => ({ code: l.deviceUserId, ts: fmt(new Date(l.recordTime)) })), device.id);
    status(`OK: ${logs.length} logs read, ${added} new, ${users.length} users`);
    return { read: logs.length, added, users: users.length };
  } catch (e) {
    const msg = e?.message || e?.err?.message || String(e);
    status('ERROR: ' + msg);
    throw new Error(msg);
  } finally {
    try { await zk.disconnect(); } catch {}
  }
}
