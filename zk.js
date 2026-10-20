import net from 'node:net';
import ZKLib from 'node-zklib';
import { db, getSettings } from './db.js';
import { emit } from './events.js';
import { logEvent } from './devsync.js';
import { encrypt, decrypt } from './bio.js';
import { notify } from './notify.js';

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// People a device reports belong to that device's Area (Personnel > Area), unless HR already placed them somewhere
export function adoptArea(deviceId, codes = null) {
  try { const dd = db.prepare("SELECT id FROM departments WHERE code='1' ORDER BY id LIMIT 1").get(); if (dd) { const q = db.prepare('UPDATE employees SET department_id=? WHERE department_id IS NULL AND code=?'); if (codes) for (const c of codes) q.run(dd.id, String(c)); else db.prepare('UPDATE employees SET department_id=? WHERE department_id IS NULL AND code IN (SELECT code FROM device_users WHERE device_id=?)').run(dd.id, deviceId); } } catch {} // people the device reports start in the default department
  const br = db.prepare('SELECT g.branch_id AS b FROM devices d JOIN device_groups g ON g.id=d.group_id WHERE d.id=?').get(deviceId)?.b;
  if (!br) return 0;
  const up = db.prepare('UPDATE employees SET branch_id=? WHERE code=? AND branch_id IS NULL');
  if (codes) { let n = 0; for (const c of codes) n += Number(up.run(br, String(c)).changes); return n; }
  return Number(db.prepare('UPDATE employees SET branch_id=? WHERE branch_id IS NULL AND code IN (SELECT code FROM device_users WHERE device_id=?)').run(br, deviceId).changes);
}

export function saveLogs(rows, deviceId = null) {
  const ins = db.prepare('INSERT OR IGNORE INTO logs(emp_code, ts, device_id, temp_c, mask, state, verify, workcode) VALUES(?,?,?,?,?,?,?,?)');
  const emp = db.prepare('INSERT OR IGNORE INTO employees(code, name) VALUES(?,?)');
  let added = 0; const fresh = [];
  db.exec('BEGIN');
  try {
    for (const c of new Set(rows.map(r => String(r.code)))) emp.run(c, `User ${c}`); // punch from an unknown person must not vanish
    if (deviceId) adoptArea(deviceId, new Set(rows.map(r => String(r.code))));
    for (const r of rows) if (Number(ins.run(String(r.code), r.ts, deviceId, r.temp_c ?? null, r.mask ?? null, r.state ?? null, r.verify ?? null, r.workcode ?? null).changes)) { added++; fresh.push({ code: String(r.code), time: r.ts, device_id: deviceId }); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (fresh.length) emit('punch.created', { punches: fresh.slice(0, 500), count: fresh.length });
  return added;
}

// Comm Key handshake (CMD_AUTH): the device scrambles the key with the session id it handed out
export function commKey(key, sessionId, ticks = 50) {
  let k = 0;
  for (let i = 0; i < 32; i++) k = ((k << 1) | ((key >>> i) & 1)) >>> 0;
  k = (k + sessionId) >>> 0;
  const b = Buffer.alloc(4); b.writeUInt32LE(k);
  b[0] ^= 0x5a; b[1] ^= 0x4b; b[2] ^= 0x53; b[3] ^= 0x4f; // 'Z' 'K' 'S' 'O'
  const sw = Buffer.from([b[2], b[3], b[0], b[1]]); // swap the two 16-bit halves
  const t = ticks & 0xff;
  return Buffer.from([sw[0] ^ t, sw[1] ^ t, t, sw[3] ^ t]);
}
async function authenticate(zk, key) {
  const tcp = zk.zklibTcp;
  const r = await tcp.executeCmd(1102, commKey(Number(key), tcp.sessionId || 0)); // CMD_AUTH
  const code = r && r.length >= 2 ? r.readUInt16LE(0) : null;
  if (code !== 2000) throw new Error('Wrong Comm Key: the device refused the password (set the same Comm Key as on the device)');
}

// The library drops the punch code, so the attendance records are read here (40 bytes each: user id, time, ..., punch code at byte 31)
const GET_LOGS = Buffer.from([0x01, 0x0d, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const p2 = (n) => String(n).padStart(2, '0');
function zkTime(t) { const s = t % 60; t = (t - s) / 60; const mi = t % 60; t = (t - mi) / 60; const h = t % 24; t = (t - h) / 24; const d = t % 31 + 1; t = (t - (d - 1)) / 31; const mo = t % 12; t = (t - mo) / 12; return `${t + 2000}-${p2(mo + 1)}-${p2(d)} ${p2(h)}:${p2(mi)}:${p2(s)}`; }
async function readLogs(zk) {
  const tcp = zk.zklibTcp; await tcp.freeData();
  const raw = await tcp.readWithBuffer(GET_LOGS); await tcp.freeData();
  let buf = raw.data.subarray(4); const out = [];
  while (buf.length >= 40) {
    const code = buf.subarray(2, 11).toString('ascii').split('\0')[0], ts = zkTime(buf.readUInt32LE(27));
    if (code && ts >= '2001-01-02') out.push({ code, ts, state: buf[31] <= 15 ? buf[31] : null, verify: buf[26] }); // empty slots and reset-clock records (year 2000) are not punches
    buf = buf.subarray(40);
  }
  return out;
}
// Device clock (CMD_GET_TIME / CMD_SET_TIME)
async function readClock(zk) { const r = await zk.zklibTcp.executeCmd(201, ''); return r && r.length >= 12 ? zkTime(r.readUInt32LE(8)) : null; }
const toMs = (ts) => new Date(ts.replace(' ', 'T')).getTime();
function encodeTime(d) { return ((((d.getFullYear() % 100) * 12 * 31 + d.getMonth() * 31 + d.getDate() - 1) * 86400) + (d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) >>> 0; }

// Opens the port and sends a ZKTeco CMD_CONNECT; any ZKTeco-framed reply (accepted or asking for the Comm Key) proves a real device is there.
// A router that accepts the connection but forwards it nowhere is reported as such instead of looking online.
const ZK_HELLO = Buffer.from('5050827d08000000e80317fc00000000', 'hex');
const reach = (ip, port) => new Promise((ok, no) => {
  const s = net.connect({ host: ip, port, timeout: 5000 }); let done = false; const end = (f, v) => { if (done) return; done = true; s.destroy(); f(v); };
  s.on('connect', () => s.write(ZK_HELLO));
  s.on('data', (d) => d.length >= 4 && d.readUInt16LE(0) === 0x5050 ? end(ok) : end(no, new Error(`${ip}:${port} answered, but not like a ZKTeco device`)));
  s.on('timeout', () => end(no, new Error(`Port ${port} on ${ip} is open but the device did not answer. Check the router forwards it to the machine's own port (usually 4370).`)));
  s.on('close', () => end(no, new Error(`${ip}:${port} closed the connection without answering. Check the port forwarding on the router leads to the machine.`)));
  s.on('error', (e) => end(no, new Error(`Cannot reach ${ip}:${port} (${e.code || e.message})`)));
});
async function openDevice(device) {
  if (device.brand && device.brand !== 'zkteco') throw new Error('This action is only available for ZKTeco devices');
  await reach(device.ip, device.port || 4370); // fail in seconds when the device is off, the long timeouts below are for big reads
  const zk = new ZKLib(device.ip, device.port || 4370, 180000, 30000); // a full read of a large device takes over a minute
  await zk.createSocket();
  if (device.comm_key) await authenticate(zk, device.comm_key);
  return zk;
}
// Add or update people on a pull device (CMD_USER_WRQ, 72-byte record). Fingerprints and faces are enrolled on the device itself.
export async function sendUsersToDevice(device, people) {
  { const B = await import('./brands.js'); if (B.isBranded(device)) return B.sendUsersBranded(device, people); }
  const zk = await openDevice(device);
  try {
    const have = (await zk.getUsers()).data ?? [], byCode = new Map(have.map(u => [String(u.userId), u]));
    let next = Math.max(0, ...have.map(u => u.uid)) + 1, n = 0;
    await zk.zklibTcp.executeCmd(1003, ''); // CMD_DISABLEDEVICE while writing
    try {
      for (const p of people) {
        const old = byCode.get(String(p.code)), uid = old ? old.uid : next++;
        const b = Buffer.alloc(72); b.writeUInt16LE(uid, 0); b[2] = p.role ?? old?.role ?? 0; Buffer.from(String(p.password ?? old?.password ?? '').slice(0, 8), 'ascii').copy(b, 3);
        Buffer.from(String(p.name || p.code).replace(/[^\x20-\x7e]/g, '?').slice(0, 23), 'ascii').copy(b, 11); b.writeUInt32LE(Number(p.card) || old?.cardno || 0, 35);
        Buffer.from(String(p.code).slice(0, 23), 'ascii').copy(b, 48);
        const r = await zk.zklibTcp.executeCmd(8, b);
        if (!r || r.readUInt16LE(0) !== 2000) throw new Error(`The device refused ${p.code}`);
        n++;
      }
    } finally { await zk.zklibTcp.executeCmd(1002, '').catch(() => {}); await zk.zklibTcp.executeCmd(1013, '').catch(() => {}); } // enable + refresh
    return { sent: n };
  } finally { try { await zk.disconnect(); } catch {} }
}
// Delete people from a pull device only.
export async function removeUsersFromDevice(device, codes) {
  { const B = await import('./brands.js'); if (B.isBranded(device)) return B.removeUsersBranded(device, codes); }
  const zk = await openDevice(device);
  try {
    const have = new Map(((await zk.getUsers()).data ?? []).map(u => [String(u.userId), u])); let n = 0;
    for (const c of codes) {
      const u = have.get(String(c)); if (!u) continue;
      const b = Buffer.alloc(2); b.writeUInt16LE(u.uid, 0);
      const r = await zk.zklibTcp.executeCmd(18, b);
      if (!r || r.readUInt16LE(0) !== 2000) throw new Error(`The device refused to delete ${c}`);
      n++;
    }
    await zk.zklibTcp.executeCmd(1013, '').catch(() => {});
    return { removed: n };
  } finally { try { await zk.disconnect(); } catch {} }
}
// ---- fingerprints on a pull device ----
export const enrolling = new Set(); // device ids that are busy with an enrolment: the scheduled read leaves them alone
const GET_FP = Buffer.from([1, 7, 0, 2, 0, 0, 0, 0, 0, 0, 0]); // CMD_DB_RRQ, table FCT_FINGERTMP
export async function readFingerprints(zk) {
  const tcp = zk.zklibTcp; await tcp.freeData();
  const raw = await tcp.readWithBuffer(GET_FP); await tcp.freeData();
  let buf = raw.data; if (buf.length < 4) return [];
  let left = buf.readInt32LE(0); buf = buf.subarray(4); const out = [];
  while (left > 0 && buf.length >= 6) { const size = buf.readUInt16LE(0); out.push({ uid: buf.readUInt16LE(2), fid: buf.readInt8(4), valid: buf.readInt8(5), data: Buffer.from(buf.subarray(6, size)) }); buf = buf.subarray(size); left -= size; }
  return out;
}
// Read the fingerprints the device holds and keep them in Optix (encrypted, and only when "Keep fingerprint and face templates" is on; otherwise just the counts), so they can be copied to other devices.
export async function storeFingerprints(zk, device, onlyCode = null) {
  const users = (await zk.getUsers()).data ?? [], byUid = new Map(users.map(u => [u.uid, String(u.userId)]));
  const keep = !!getSettings().store_templates, up = db.prepare(`INSERT INTO biodata(employee_id, kind, fid, size, device_id, data) VALUES(?,?,?,?,?,?)
    ON CONFLICT(employee_id, kind, fid) DO UPDATE SET size=excluded.size, device_id=excluded.device_id, received=datetime('now','localtime'), data=COALESCE(excluded.data, biodata.data)`);
  let n = 0; db.exec('BEGIN');
  try {
    for (const t of await readFingerprints(zk)) {
      const code = byUid.get(t.uid); if (!code || (onlyCode && code !== String(onlyCode))) continue;
      const e = db.prepare('SELECT id FROM employees WHERE code=?').get(code); if (!e) continue;
      up.run(e.id, 'fp', t.fid, t.data.length, device.id, keep ? encrypt(t.data.toString('base64')) : null); n++;
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return n;
}
export async function readTemplatesNow(device) { const zk = await openDevice(device); try { return await storeFingerprints(zk, device); } finally { try { await zk.disconnect(); } catch {} } }
const fpCount = async (zk) => { const r = await zk.zklibTcp.executeCmd(50, ''); return r && r.length >= 8 + 4 * 7 ? r.readInt32LE(8 + 4 * 6) : null; };
// Open the device's own enrolment screen for one person (CMD_STARTENROLL), then watch for the new fingerprint and keep it. Returns as soon as the device has accepted; the watching goes on in the background.
export async function startEnroll(device, person, fid = 0) {
  if (!(fid >= 0 && fid <= 9)) throw new Error('Choose a finger from 0 to 9');
  await sendUsersToDevice(device, [{ code: person.code, name: person.name, card: person.card_no, role: person.device_priv ?? 0, password: person.pin ?? undefined }]); // the person must exist on the device first
  const zk = await openDevice(device); enrolling.add(device.id);
  try {
    await zk.zklibTcp.executeCmd(62, ''); // CMD_CANCELCAPTURE: clear whatever the device was doing
    const b = Buffer.alloc(26); Buffer.from(String(person.code).slice(0, 23), 'ascii').copy(b, 0); b[24] = fid; b[25] = 1;
    const r = await zk.zklibTcp.executeCmd(61, b);
    if (!r || r.readUInt16LE(0) !== 2000) throw new Error('The device did not open its enrolment screen');
  } catch (e) { enrolling.delete(device.id); try { await zk.disconnect(); } catch {} throw e; }
  (async () => { // up to two minutes for the person to put the finger on the device
    let done = false;
    try {
      const t0 = Date.now(); const before = Number(device.dev_fp) || 0;
      while (Date.now() - t0 < 120000) {
        await new Promise(r => setTimeout(r, 3000));
        const n = await fpCount(zk).catch(() => null);
        if (n !== null && n > before) { done = true; db.prepare('UPDATE devices SET dev_fp=? WHERE id=?').run(n, device.id); await storeFingerprints(zk, device, person.code).catch(() => 0); logEvent(device.id, 'enrolled', `${person.code} ${person.name}: fingerprint enrolled on the device`); break; }
      }
      if (!done) { await zk.zklibTcp.executeCmd(62, '').catch(() => {}); logEvent(device.id, 'enroll_timeout', `${person.code} ${person.name}: nobody enrolled within 2 minutes, the enrolment screen was closed`); }
    } catch (e) { logEvent(device.id, 'sync_error', 'Enrolment watch failed: ' + e.message); }
    finally { enrolling.delete(device.id); try { await zk.disconnect(); } catch {} }
  })();
  return { started: true };
}
// ---- write a person and their fingerprints to a pull device (CMD_SAVE_USERTEMPS, the format the device itself uses) ----
async function sendBuffer(zk, buf) {
  const t = zk.zklibTcp, size = Buffer.alloc(4); size.writeUInt32LE(buf.length);
  let r = await t.executeCmd(1500, size); // CMD_PREPARE_DATA
  if (!r || r.readUInt16LE(0) !== 2000) throw new Error('The device refused the data transfer');
  for (let i = 0; i < buf.length; i += 1024) { r = await t.executeCmd(1501, buf.subarray(i, i + 1024)); if (!r || r.readUInt16LE(0) !== 2000) throw new Error('The device stopped the data transfer'); } // CMD_DATA, 1 KB at a time
}
export async function saveUserTemplates(zk, u, fingers) { // u: {uid, code, name, card, role, password}; fingers: [{fid, data}]
  const up = Buffer.alloc(73); up[0] = 2; up.writeUInt16LE(u.uid, 1); up[3] = u.role ?? 0; Buffer.from(String(u.password ?? '').slice(0, 8), 'ascii').copy(up, 4);
  Buffer.from(String(u.name || u.code).replace(/[^\x20-\x7e]/g, '?').slice(0, 23), 'ascii').copy(up, 12); up.writeUInt32LE(Number(u.card) || 0, 36); up[40] = 1; Buffer.from(String(u.code).slice(0, 23), 'ascii').copy(up, 49);
  const table = Buffer.alloc(8 * fingers.length), packs = []; let off = 0;
  fingers.forEach((f, i) => { const pk = Buffer.alloc(2 + f.data.length); pk.writeUInt16LE(f.data.length, 0); f.data.copy(pk, 2); table[i * 8] = 2; table.writeUInt16LE(u.uid, i * 8 + 1); table[i * 8 + 3] = 0x10 + f.fid; table.writeUInt32LE(off, i * 8 + 4); off += pk.length; packs.push(pk); });
  const fpack = Buffer.concat(packs), head = Buffer.alloc(12); head.writeUInt32LE(up.length, 0); head.writeUInt32LE(table.length, 4); head.writeUInt32LE(fpack.length, 8);
  await zk.zklibTcp.freeData(); await sendBuffer(zk, Buffer.concat([head, up, table, fpack])); // the sizes travel with the data
  const cs = Buffer.alloc(8); cs.writeUInt32LE(12, 0); cs.writeUInt16LE(0, 4); cs.writeUInt16LE(8, 6);
  const r = await zk.zklibTcp.executeCmd(110, cs); // CMD_SAVE_USERTEMPS
  if (!r || r.readUInt16LE(0) !== 2000) throw new Error('The device did not accept the fingerprints');
  await zk.zklibTcp.executeCmd(1013, '').catch(() => {}); // refresh
}
// Copy the fingerprints Optix holds (templates kept from other devices) onto a pull device, for the people it should have. Nothing is overwritten that the device already has.
export async function sendFingerprintsToDevice(device, people) {
  { const B = await import('./brands.js'); if (B.isBranded(device)) return { fingerprints: 0, people: 0 }; } // fingerprints are enrolled on these devices themselves
  const zk = await openDevice(device);
  try {
    const users = (await zk.getUsers()).data ?? [], byCode = new Map(users.map(u => [String(u.userId), u]));
    const have = new Set((await readFingerprints(zk)).map(t => t.uid + ':' + t.fid));
    let n = 0, who = 0;
    for (const p of people) {
      const dev = byCode.get(String(p.code)); if (!dev) continue;
      const rows = db.prepare("SELECT b.fid, b.data FROM biodata b JOIN employees e ON e.id=b.employee_id WHERE e.code=? AND b.kind='fp' AND b.data IS NOT NULL").all(String(p.code));
      const fresh = rows.filter(r => !have.has(dev.uid + ':' + r.fid)).map(r => ({ fid: r.fid, data: Buffer.from(decrypt(r.data), 'base64') }));
      if (!fresh.length) continue;
      await saveUserTemplates(zk, { uid: dev.uid, code: p.code, name: dev.name || p.name, card: dev.cardno, role: dev.role, password: dev.password }, fresh); n += fresh.length; who++;
    }
    return { fingerprints: n, people: who };
  } finally { try { await zk.disconnect(); } catch {} }
}
// Read-only: which people and fingerprints each of two pull devices holds that the other lacks.
export async function compareDevices(da, dbb) {
  const one = async (d) => { const zk = await openDevice(d); try { const users = (await zk.getUsers()).data ?? [], code = new Map(users.map(u => [u.uid, String(u.userId)])); const fps = (await readFingerprints(zk)).map(t => (code.get(t.uid) ?? '?' + t.uid) + ':' + t.fid); return { users: new Set(users.map(u => String(u.userId))), fps: new Set(fps) }; } finally { try { await zk.disconnect(); } catch {} } };
  const A = await one(da), B = await one(dbb), only = (x, y) => [...x].filter(v => !y.has(v));
  return { a: { users: A.users.size, fingerprints: A.fps.size }, b: { users: B.users.size, fingerprints: B.fps.size }, users_only_a: only(A.users, B.users), users_only_b: only(B.users, A.users), fps_only_a: only(A.fps, B.fps), fps_only_b: only(B.fps, A.fps) };
}
// Put the server's time on a pull device.
export async function setDeviceClock(device) {
  { const B = await import('./brands.js'); if (B.isBranded(device)) return B.setClockBranded(device); }
  const zk = await openDevice(device);
  try {
    const b = Buffer.alloc(4); b.writeUInt32LE(encodeTime(new Date()));
    const r = await zk.zklibTcp.executeCmd(202, b);
    if (!r || r.readUInt16LE(0) !== 2000) throw new Error('The device did not accept the new time');
    db.prepare('UPDATE devices SET clock_diff_s=0 WHERE id=?').run(device.id);
    return { time: fmt(new Date()) };
  } finally { try { await zk.disconnect(); } catch {} }
}
// Empty the device's punch memory, but only after every punch on it is safely in Optix.
export async function clearDeviceLogs(device) {
  const r = await syncDevice(device, true);
  if (r.read === 0 && !r.skipped) throw new Error('Nothing was read from the device, so nothing was cleared');
  const zk = await openDevice(device);
  try {
    const info = await zk.getInfo();
    if (info.logCounts !== r.read) throw new Error(`A new punch arrived while reading (${r.read} read, ${info.logCounts} on the device). Nothing was cleared; try again.`);
    await zk.clearAttendanceLog();
    db.prepare('UPDATE devices SET log_count=0 WHERE id=?').run(device.id);
    logEvent(device.id, 'logs_cleared', `${r.read} punches were copied to Optix and then removed from the device`);
    return { cleared: r.read };
  } finally { try { await zk.disconnect(); } catch {} }
}

// Pull users + attendance logs from a ZKTeco device over TCP (default port 4370).
export async function syncDevice(device, force = false) {
  { const B = await import('./brands.js'); if (B.isBranded(device)) return B.syncBranded(device); }
  const status = (st) => db.prepare('UPDATE devices SET last_sync=?, last_status=? WHERE id=?').run(fmt(new Date()), st, device.id);
  let zk;
  try {
    zk = await openDevice(device);
    const info = await zk.getInfo().catch(() => null);
    if (info?.logCounts != null) {
      db.prepare('UPDATE devices SET log_capacity=? WHERE id=?').run(info.logCapacity || null, device.id);
      if (info.logCapacity && info.logCounts >= info.logCapacity * 0.9) { // a full device stops recording or overwrites the oldest punches
        const last = db.prepare("SELECT ts FROM device_events WHERE device_id=? AND kind='memory_low' ORDER BY id DESC LIMIT 1").get(device.id);
        if (!last || last.ts < new Date(Date.now() - 86400000).toLocaleString('sv')) {
          const msg = `${device.name}: ${info.logCounts} of ${info.logCapacity} punches stored (${Math.round(info.logCounts * 100 / info.logCapacity)}%). Clear the device's attendance data (Device > Data Clean) before it fills up.`;
          logEvent(device.id, 'memory_low', msg); notify({ title: 'Device memory almost full', body: msg, link: 'Devices', kind: 'device_memory' });
        }
      }
    }
    try { // who the device says it is: serial number and model (shown in the Device list)
      const opt = async (k) => { const r = await zk.zklibTcp.executeCmd(11, Buffer.from(k + '\0')); const t = r && r.length > 8 ? r.subarray(8).toString('latin1').replace(/\0+$/, '') : ''; return t.includes('=') ? t.slice(t.indexOf('=') + 1).trim() : ''; };
      const [sn, nm] = [await opt('~SerialNumber'), await opt('~DeviceName')];
      if (sn || nm) db.prepare('UPDATE devices SET dev_serial=COALESCE(NULLIF(?,\'\'),dev_serial), model=COALESCE(NULLIF(model,\'\'), NULLIF(?,\'\')) WHERE id=?').run(sn, nm, device.id);
    } catch {}
    try { // what the device holds in biometrics (CMD_GET_FREE_SIZES: fingerprints at word 6, faces at word 20)
      const fs = await zk.zklibTcp.executeCmd(50, '');
      if (fs && fs.length >= 8 + 4 * 21) {
        const nfp = fs.readInt32LE(8 + 4 * 6); db.prepare('UPDATE devices SET dev_fp=?, dev_face=? WHERE id=?').run(nfp, fs.readInt32LE(8 + 4 * 20), device.id);
        if (getSettings().store_templates && nfp !== (device.dev_fp ?? null)) await storeFingerprints(zk, device).catch(() => 0); // new fingerprints on the device: keep them
      }
    } catch {}
    try { // a wrong device clock puts punches on the wrong day
      const c = await readClock(zk);
      if (c) {
        const diff = Math.round((toMs(c) - Date.now()) / 1000); db.prepare('UPDATE devices SET clock_diff_s=? WHERE id=?').run(diff, device.id);
        if (Math.abs(diff) > 300) { const last = db.prepare("SELECT ts FROM device_events WHERE device_id=? AND kind='clock_off' ORDER BY id DESC LIMIT 1").get(device.id); if (!last || last.ts < new Date(Date.now() - 3600000).toLocaleString('sv')) logEvent(device.id, 'clock_off', `The device clock is ${Math.abs(Math.round(diff / 60))} min ${diff > 0 ? 'ahead of' : 'behind'} the server. Use Device > Set Time.`); }
      }
    } catch {}
    if (!force && info?.logCounts != null && device.log_count === info.logCounts && info.logCounts < (info.logCapacity || Infinity)) { adoptArea(device.id); status(`OK: no new punches (${info.logCounts} on the device)`); return { read: 0, added: 0, users: info.userCounts ?? 0, skipped: true }; }
    const users = (await zk.getUsers()).data ?? [];
    const logs = await readLogs(zk);

    const insEmp = db.prepare('INSERT OR IGNORE INTO employees(code, name) VALUES(?,?)');
    for (const u of users) { insEmp.run(String(u.userId), u.name || `User ${u.userId}`); db.prepare("INSERT INTO device_users(device_id, code, name) VALUES(?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name, seen=datetime('now','localtime')").run(device.id, String(u.userId), u.name || null); }

    const added = saveLogs(logs, device.id); adoptArea(device.id);
    if (db.prepare('SELECT 1 FROM logs WHERE device_id=? AND (state IS NULL OR verify IS NULL) LIMIT 1').get(device.id)) { // punches saved before the punch code was read get it now
      const up = db.prepare('UPDATE logs SET state=COALESCE(state,?), verify=COALESCE(verify,?) WHERE device_id=? AND emp_code=? AND ts=? AND (state IS NULL OR verify IS NULL)');
      db.exec('BEGIN'); try { for (const l of logs) if (l.state !== null || l.verify != null) up.run(l.state, l.verify ?? null, device.id, l.code, l.ts); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    if (info?.logCounts != null) db.prepare('UPDATE devices SET log_count=? WHERE id=?').run(info.logCounts, device.id);
    status(`OK: ${logs.length} logs read, ${added} new, ${users.length} users`);
    return { read: logs.length, added, users: users.length };
  } catch (e) {
    const msg = e?.message || e?.err?.message || String(e);
    status('ERROR: ' + msg);
    throw new Error(msg);
  } finally {
    try { await zk?.disconnect(); } catch {}
  }
}
