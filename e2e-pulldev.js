// Devices added by IP and port (pull): the server tests the connection, adds the device and reads it on a schedule.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './e2e-lib.js';

// something that accepts TCP like a device would (it does not speak the ZKTeco protocol, which is enough for reach tests)
const tcp = net.createServer(s => s.on('error', () => {})); await new Promise(r => tcp.listen(0, '127.0.0.1', r)); const openPort = tcp.address().port;
const closed = net.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r)); const closedPort = closed.address().port; await new Promise(r => closed.close(r));
const S = await startServer(), api = S.api;
try {
  const ok = await api('devices/probe', 'POST', { ip: '127.0.0.1', port: openPort }); assert.equal(ok.ok, true); assert.match(ok.message, /Reached/);
  const no = await api('devices/probe', 'POST', { ip: '127.0.0.1', port: closedPort }); assert.equal(no.ok, false); assert.match(no.message, /No answer/);
  assert.equal((await S.raw('devices/probe', 'POST', { ip: '', port: 4370 })).status, 400); assert.equal((await S.raw('devices/probe', 'POST', { ip: '1.2.3.4', port: 99999 })).status, 400);
  const d = await api('devices', 'POST', { name: 'Office reader', ip: '127.0.0.1', port: openPort, realtime: 1 });
  let row = (await api('devices')).find(x => x.id === d.id); assert.equal(row.approved, 1, 'a device an admin adds by IP is trusted at once'); assert.equal(row.sn, null); assert.equal(row.port, openPort);
  const t = await api(`devices/${d.id}/test`, 'POST', {}); assert.equal(t.mode, 'pull'); assert.equal(t.ok, true);
  await api('devices/check', 'POST', {}); row = (await api('devices')).find(x => x.id === d.id); assert.ok(row.online, 'reachable pull device shows Online');
  const dead = await api('devices', 'POST', { name: 'Away', ip: '127.0.0.1', port: closedPort }); await api('devices/check', 'POST', {}); assert.ok(!(await api('devices')).find(x => x.id === dead.id).online, 'unreachable pull device shows Offline');
  assert.equal((await S.raw('devices', 'POST', { name: 'Neither' })).status, 400, 'a device needs a serial number or an IP address');
} finally { S.stop(); tcp.close(); }
// the schedule: autoPull reads reachable pull devices (here the "device" is not a real ZKTeco, so the read fails and is logged)
const dir = mkdtempSync(join(tmpdir(), 'optix-pull-')); process.env.DB_FILE = join(dir, 'p.db');
const { db } = await import('./db.js'); const dv = await import('./devices.js');
const tcp2 = net.createServer(s => s.on('error', () => {})); await new Promise(r => tcp2.listen(0, '127.0.0.1', r));
try {
  const id = Number(db.prepare("INSERT INTO devices(name, ip, port, approved, online) VALUES('Pull A','127.0.0.1',?,1,1)").run(tcp2.address().port).lastInsertRowid);
  db.prepare("INSERT INTO devices(name, ip, port, approved, online) VALUES('Pull B (off)','127.0.0.1',1,1,0)").run();
  db.prepare("INSERT INTO devices(name, sn, approved) VALUES('Push C','C-1',1)").run();
  const calls = await dv.autoPull(); assert.equal(calls.length, 0, 'a failed read returns nothing');
  const ev = db.prepare("SELECT kind FROM device_events WHERE device_id=?").all(id); assert.ok(ev.some(e => e.kind === 'sync_error'), 'the scheduled read was tried and its failure logged');
  assert.match(db.prepare('SELECT last_status FROM devices WHERE id=?').get(id).last_status, /^ERROR/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_events WHERE device_id IN (SELECT id FROM devices WHERE name<>'Pull A')").get().n, 0, 'offline pull devices and push devices are not read by the schedule');
  db.prepare("UPDATE settings SET value=0 WHERE key='pull_sync_min'").run?.();
  console.log('e2e-pulldev passed: probe, add by IP + port, online/offline, scheduled read');
} finally { tcp2.close(); db.close?.(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }
