// Hikvision (ISAPI + Digest), Dahua (CGI) and Suprema (BioStar 2) devices, against small fake servers speaking those APIs
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from './e2e-lib.js';
import { anvizFrame, anvizCrc } from './brands.js';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok(s)); });
const body = (req) => new Promise((ok) => { let t = ''; req.on('data', (c) => t += c); req.on('end', () => ok(t)); });
const digest = (user, pass) => (req, res) => { // true when authorised
  const a = req.headers.authorization || '';
  if (/^Digest/.test(a)) { const p = Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((m) => [m[1], m[2] ?? m[3]])); const ha1 = md5(`${user}:cam:${pass}`), ha2 = md5(`${req.method}:${p.uri}`); if (p.username === user && p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:auth:${ha2}`)) return true; }
  res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="cam", qop="auth", nonce="abc123", opaque="x"' }); res.end(); return false;
};
const hikUsers = new Map([['7', 'Seven']]);
const hikTime = [];
const hik = await listen(async (req, res) => {
  if (!digest('admin', 'hikpw')(req, res)) return; const u = new URL(req.url, 'http://x'), b = await body(req), j = b && b[0] === '{' ? JSON.parse(b) : {};
  if (u.pathname === '/ISAPI/System/time') { hikTime.push(b); return res.end('<ResponseStatus><statusCode>1</statusCode></ResponseStatus>'); }
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/ISAPI/System/deviceInfo') return res.end('<DeviceInfo><model>DS-K1T343</model><serialNumber>HK123456</serialNumber></DeviceInfo>');
  if (u.pathname === '/ISAPI/AccessControl/AcsEvent') { const all = [{ employeeNoString: '7', time: '2026-10-19T09:01:02+05:00', currentVerifyMode: 'faceOrFpOrCardOrPw' }, { employeeNoString: '8', time: '2026-10-19T09:05:00+05:00', currentVerifyMode: 'card' }, { time: '2026-10-19T09:06:00+05:00' }], pos = j.AcsEventCond.searchResultPosition, page = all.slice(pos, pos + 2); return json({ AcsEvent: { InfoList: page, responseStatusStrg: pos + 2 < all.length ? 'MORE' : 'OK' } }); }
  if (u.pathname === '/ISAPI/AccessControl/UserInfo/Search') return json({ UserInfoSearch: { UserInfo: [...hikUsers].map(([employeeNo, name]) => ({ employeeNo, name })), responseStatusStrg: 'OK' } });
  if (u.pathname === '/ISAPI/AccessControl/UserInfo/Record') { hikUsers.set(j.UserInfo.employeeNo, j.UserInfo.name); return json({ statusCode: 1 }); }
  if (u.pathname === '/ISAPI/AccessControl/UserInfo/Delete') { for (const e of j.UserInfoDelCond.EmployeeNoList) hikUsers.delete(e.employeeNo); return json({ statusCode: 1 }); }
  res.writeHead(404); res.end();
});
const dahUsers = new Map([['21', 'Twenty One']]);
const dah = await listen((req, res) => {
  if (!digest('admin', 'dahpw')(req, res)) return; const u = new URL(req.url, 'http://x'), q = u.searchParams;
  if (u.pathname === '/cgi-bin/magicBox.cgi') return res.end('serialNumber=DH987\ndeviceType=ASI7213Y\n');
  if (u.pathname === '/cgi-bin/recordFinder.cgi' && q.get('name') === 'AccessControlCardRec') return res.end(`records[0].UserID=21\nrecords[0].CreateTime=${Date.parse('2026-10-19T04:00:00Z') / 1000}\nrecords[0].Method=4\nrecords[1].UserID=22\nrecords[1].CreateTime=${Date.parse('2026-10-19T05:00:00Z') / 1000}\nrecords[1].Method=1\n`);
  if (u.pathname === '/cgi-bin/recordFinder.cgi') return res.end([...dahUsers].map(([id, n], i) => `records[${i}].UserID=${id}\nrecords[${i}].UserName=${n}`).join('\n'));
  if (u.pathname === '/cgi-bin/recordUpdater.cgi') { if (q.get('action') === 'insert') dahUsers.set(q.get('UserID'), q.get('UserName')); if (q.get('action') === 'remove') dahUsers.delete(q.get('recno')); return res.end('OK'); }
  res.writeHead(404); res.end();
});

// Anviz TC_B fake: speaks the frames of Anviz's manual
const anvRecs = [[1001, 'early'], [1002, 'later']].map(([id, _], i) => { const b = Buffer.alloc(14); b.writeUIntBE(id, 0, 5); b.writeUInt32BE(Math.floor((Date.UTC(2026, 9, 19, 9, 1 + i, 2) - Date.UTC(2000, 0, 2)) / 1000), 5); b[9] = 1; b[10] = 0; return b; });
let anvNew = anvRecs.length, anvFlagged = 0; const anvUsers = new Map([[1001, 'Anv One']]), anvTimeSet = [];
const anviz = await new Promise((ok) => { const srv = net.createServer((sock) => { let buf = Buffer.alloc(0); sock.on('data', (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= 10) { const len = buf.readUInt16BE(6), total = 8 + len + 2; if (buf.length < total) break; const f = buf.subarray(0, total); buf = buf.subarray(total); if (f.readUInt16LE(total - 2) !== anvizCrc(f.subarray(0, total - 2))) { sock.destroy(); return; } const cmd = f[5], data = f.subarray(8, 8 + len); let ack = 0, out = Buffer.alloc(0);
  if (cmd === 0x30) out = Buffer.concat([Buffer.from('V1.2.3  '), Buffer.alloc(10)]);
  else if (cmd === 0x24) out = Buffer.from('ANV0000000000001');
  else if (cmd === 0x40) { const n = data[0] === 2 && anvNew ? anvNew : 0; out = Buffer.concat([Buffer.from([n]), ...anvRecs.slice(0, n)]); }
  else if (cmd === 0x4e) { anvFlagged = data.readUIntBE(1, 3); anvNew = 0; out = Buffer.from([0, 0, anvFlagged]); }
  else if (cmd === 0x72) { const list = [...anvUsers]; if (data[0] !== 1) out = Buffer.from([0]); else { const rows = list.slice(0, data[1]).map(([id, name]) => { const u = Buffer.alloc(30, 0xff); u.writeUIntBE(id, 0, 5); const nm = Buffer.alloc(10); nm.write(name, 'latin1'); nm.copy(u, 12); return u; }); out = Buffer.concat([Buffer.from([rows.length]), ...rows]); } }
  else if (cmd === 0x73) { const u = data.subarray(1, 31); anvUsers.set(u.readUIntBE(0, 5), u.subarray(12, 22).toString('latin1').replace(/\0+$/, '')); out = Buffer.from([0, 1]); }
  else if (cmd === 0x4c) { const id = data.readUIntBE(0, 5); if (!anvUsers.delete(id)) ack = 6; }
  else if (cmd === 0x39) anvTimeSet.push([...data]);
  else ack = 1;
  const head = Buffer.alloc(9); head[0] = 0xa5; head[5] = cmd | 0x80; head[6] = ack; head.writeUInt16BE(out.length, 7); const body = Buffer.concat([head, out]), crc = Buffer.alloc(2); crc.writeUInt16LE(anvizCrc(body)); sock.write(Buffer.concat([body, crc])); } }); sock.on('error', () => {}); }).listen(0, '127.0.0.1', () => ok(srv)); });
const S = await startServer({}), api = S.api;
try {
  const test = (o) => api('devices/test-connection', 'POST', o);
  const h = hik.address().port, d = dah.address().port;
  assert.equal((await test({ brand: 'hikvision', ip: '127.0.0.1', port: h, dev_user: 'admin', dev_pass: 'hikpw' })).serial, 'HK123456');
  await assert.rejects(test({ brand: 'hikvision', ip: '127.0.0.1', port: h, dev_user: 'admin', dev_pass: 'wrong' }), /refused the user name or password/);
  assert.equal((await test({ brand: 'dahua', ip: '127.0.0.1', port: d, dev_user: 'admin', dev_pass: 'dahpw' })).model, 'ASI7213Y');
  const hid = (await api('devices', 'POST', { name: 'Hik Gate', brand: 'hikvision', ip: '127.0.0.1', port: h, dev_user: 'admin', dev_pass: 'hikpw' })).id;
  const did = (await api('devices', 'POST', { name: 'Dahua Door', brand: 'dahua', ip: '127.0.0.1', port: d, dev_user: 'admin', dev_pass: 'dahpw' })).id;
  const list = await api('devices'); assert.equal(list.find((x) => x.id === hid).brand, 'hikvision'); assert.equal(list.find((x) => x.id === hid).dev_pass, undefined, 'the password is never sent back'); assert.equal(list.find((x) => x.id === hid).has_pass, true);
  let r = await api(`devices/${hid}/sync`, 'POST', {}); assert.equal(r.read, 2); assert.equal(r.added, 2);
  r = await api(`devices/${did}/sync`, 'POST', {}); assert.equal(r.read, 2); assert.equal(r.users, 1);
  const logs = await api('logs?date=2026-10-19'); const rows = (logs.rows ?? logs); assert.ok(rows.some((l) => (l.emp_code ?? l.code) === '7' && /09:01:02/.test(l.ts ?? l.time)), 'the Hikvision punch keeps the device time');
  assert.equal((await api('devices')).find((x) => x.id === hid).model, 'DS-K1T343');
  // Anviz
  const ap = anviz.address().port;
  assert.match((await test({ brand: 'anviz', ip: '127.0.0.1', port: ap })).model, /V1\.2\.3/);
  const aid = (await api('devices', 'POST', { name: 'Anviz Gate', brand: 'anviz', ip: '127.0.0.1', port: ap })).id;
  r = await api(`devices/${aid}/sync`, 'POST', {}); assert.equal(r.read, 2); assert.equal(r.added, 2); assert.equal(anvFlagged, 2, 'the downloaded punches are flagged as read, only after they were saved');
  assert.equal((await api(`devices/${aid}/sync`, 'POST', {})).read, 0, 'nothing new the second time');
  const arows = (await api('logs?date=2026-10-19')); assert.ok((arows.rows ?? arows).some((l) => (l.emp_code ?? l.code) === '1001' && /09:01:02/.test(l.ts ?? l.time)), 'Anviz punch time decoded');
  await api('employees', 'POST', { code: '2001', name: 'Anviz New' });
  await api(`devices/${aid}/users/send`, 'POST', { ids: ['2001'], codes: ['2001'] }); assert.equal(anvUsers.get(2001), 'Anviz New');
  await api(`devices/${aid}/users/remove`, 'POST', { ids: ['2001'], codes: ['2001'] }); assert.equal(anvUsers.has(2001), false);
  await api(`devices/${aid}/time-sync`, 'POST', {}); assert.equal(anvTimeSet.length, 1);
  await api(`devices/${hid}/time-sync`, 'POST', {}); assert.equal(hikTime.length, 1); assert.match(hikTime[0], /<timeMode>manual<\/timeMode><localTime>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d<\/localTime>/);
  // people written to / removed from the devices
  const emp = (await api('employees', 'POST', { code: '501', name: 'New Person' })).id;
  await api(`devices/${hid}/users/send`, 'POST', { ids: ['501'], codes: ['501'] });
  assert.equal(hikUsers.get('501'), 'New Person', 'the person was written to the Hikvision device');
  await api(`devices/${did}/users/send`, 'POST', { ids: ['501'], codes: ['501'] }); assert.equal(dahUsers.get('501'), 'New Person');
  await api(`devices/${hid}/users/remove`, 'POST', { ids: ['501'], codes: ['501'] }); assert.equal(hikUsers.has('501'), false, 'and removed again');
  console.log('e2e-brands passed: Hikvision + Dahua + Anviz test, wrong password, sync of punches and people, password hidden');
} catch (e) { console.error('E2E-BRANDS FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); hik.close(); dah.close(); anviz.close(); setTimeout(() => process.exit(), 200); }
