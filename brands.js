// Devices of other brands, reached over their own network APIs (the server connects to them, like a ZKTeco pull device):
//   hikvision  ISAPI over HTTP(S), Digest login
//   dahua      CGI API over HTTP(S), Digest login
//   suprema    BioStar 2 server REST API (the BioStar 2 server collects the Suprema terminals; Optix reads it)
//   anviz      Anviz TC_B protocol over TCP (port 5010), from Anviz's published "TC_B Communication Protocol" manual
// Each driver offers: info, events(from, to), users, addUser, delUser. Fingerprints and faces are enrolled on the device itself.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { db } from './db.js';
import { decrypt } from './bio.js';
import { saveLogs } from './zk.js';

export const BRANDS = { zkteco: 'ZKTeco', hikvision: 'Hikvision', dahua: 'Dahua', suprema: 'Suprema (BioStar 2)', anviz: 'Anviz' };
export const DEFAULT_PORT = { zkteco: 4370, hikvision: 80, dahua: 80, suprema: 443, anviz: 5010 };
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// ---------- HTTP with Basic / Digest ----------
function once(o, headers, body) {
  return new Promise((ok, no) => {
    const mod = o.tls ? https : http;
    const r = mod.request({ host: o.host, port: o.port, path: o.path, method: o.method, headers, timeout: o.timeout ?? 15000, rejectUnauthorized: false }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(new Error(`No answer from ${o.host}:${o.port}`)); });
    r.on('error', (e) => no(new Error(e.code === 'ECONNREFUSED' ? `Cannot reach ${o.host}:${o.port} (connection refused)` : e.message)));
    if (body) r.write(body); r.end();
  });
}
export async function request(d, method, path, { json, session, xml } = {}) {
  const user = d.dev_user ?? '', pass = d.dev_pass ? decrypt(d.dev_pass) : '', body = xml !== undefined ? xml : json === undefined ? null : JSON.stringify(json);
  const o = { host: d.ip, port: d.port || DEFAULT_PORT[d.brand] || 80, path, method, tls: Number(d.port) === 443 };
  const base = { Accept: '*/*', ...(body ? { 'Content-Type': xml !== undefined ? 'application/xml' : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(session ? { 'bs-session-id': session } : {}) };
  let r = await once(o, base, body);
  if (r.status === 401 && !session) {
    const ch = String(r.headers['www-authenticate'] ?? '');
    if (/^digest/i.test(ch)) {
      const p = Object.fromEntries([...ch.matchAll(/(\w+)="?([^",]+)"?/g)].map((m) => [m[1].toLowerCase(), m[2]]));
      const cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001', qop = p.qop ? 'auth' : '';
      const ha1 = md5(`${user}:${p.realm}:${pass}`), ha2 = md5(`${method}:${path}`);
      const resp = qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
      const auth = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${resp}"${p.opaque ? `, opaque="${p.opaque}"` : ''}${qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : ''}`;
      r = await once(o, { ...base, Authorization: auth }, body);
    } else if (/^basic/i.test(ch)) r = await once(o, { ...base, Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') }, body);
  }
  if (r.status === 401) throw new Error('The device refused the user name or password');
  if (r.status >= 400) throw new Error(`The device answered ${r.status}: ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`);
  return r;
}
const tag = (xml, t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] ?? '';
const kv = (text) => Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

// ---------- Hikvision (ISAPI) ----------
const hik = {
  // ISAPI System/time: manual mode with the local time and its UTC offset
  async setTime(d, when = new Date()) { const off = -when.getTimezoneOffset(), tz = (off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
    await request(d, 'PUT', '/ISAPI/System/time', { xml: `<?xml version="1.0" encoding="UTF-8"?><Time version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><timeMode>manual</timeMode><localTime>${local(when).replace(' ', 'T')}${tz}</localTime></Time>` }); },
  async info(d) { const r = await request(d, 'GET', '/ISAPI/System/deviceInfo'); return { serial: tag(r.text, 'serialNumber'), model: tag(r.text, 'model') }; },
  async events(d, from, to) {
    const out = [], off = -new Date().getTimezoneOffset(), tz = (off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60), iso = (x) => local(x).replace(' ', 'T') + tz;
    for (let pos = 0; pos < 100000;) {
      const r = await request(d, 'POST', '/ISAPI/AccessControl/AcsEvent?format=json', { json: { AcsEventCond: { searchID: 'optix', searchResultPosition: pos, maxResults: 30, major: 5, minor: 0, startTime: iso(from), endTime: iso(to) } } });
      const a = JSON.parse(r.text).AcsEvent ?? {}, list = a.InfoList ?? [];
      for (const e of list) if (e.employeeNoString && e.time) out.push({ code: String(e.employeeNoString), ts: String(e.time).slice(0, 19).replace('T', ' '), verify: /face/i.test(e.currentVerifyMode ?? '') ? 15 : /fp|finger/i.test(e.currentVerifyMode ?? '') ? 1 : /card/i.test(e.currentVerifyMode ?? '') ? 4 : /pw|pass/i.test(e.currentVerifyMode ?? '') ? 0 : null, state: null });
      pos += list.length; if (!list.length || a.responseStatusStrg !== 'MORE') break;
    }
    return out;
  },
  async users(d) {
    const out = [];
    for (let pos = 0; pos < 100000;) {
      const r = await request(d, 'POST', '/ISAPI/AccessControl/UserInfo/Search?format=json', { json: { UserInfoSearchCond: { searchID: 'optix', searchResultPosition: pos, maxResults: 30 } } });
      const a = JSON.parse(r.text).UserInfoSearch ?? {}, list = a.UserInfo ?? [];
      for (const u of list) out.push({ code: String(u.employeeNo), name: u.name || '' });
      pos += list.length; if (!list.length || a.responseStatusStrg !== 'MORE') break;
    }
    return out;
  },
  async addUser(d, p) {
    const body = { UserInfo: { employeeNo: String(p.code), name: String(p.name || p.code).slice(0, 32), userType: 'normal', Valid: { enable: true, beginTime: '2020-01-01T00:00:00', endTime: '2037-12-31T23:59:59' }, doorRight: '1', RightPlan: [{ doorNo: 1, planTemplateNo: '1' }] } };
    try { await request(d, 'POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', { json: body }); } catch (e) { if (!/ 400:|exist/i.test(e.message)) throw e; await request(d, 'PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', { json: body }); }
  },
  async delUser(d, code) { await request(d, 'PUT', '/ISAPI/AccessControl/UserInfo/Delete?format=json', { json: { UserInfoDelCond: { EmployeeNoList: [{ employeeNo: String(code) }] } } }); },
};

// ---------- Dahua (CGI) ----------
const dah = {
  async info(d) { const r = await request(d, 'GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo'), k = kv(r.text); return { serial: k.serialNumber ?? '', model: k.deviceType ?? '' }; },
  async events(d, from, to) {
    const r = await request(d, 'GET', `/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&condition.StartTime=${Math.floor(from / 1000)}&condition.EndTime=${Math.floor(to / 1000)}&count=4096`), k = kv(r.text), out = [];
    for (const key of Object.keys(k)) { const m = key.match(/^records\[(\d+)\]\.CreateTime$/); if (!m) continue; const i = m[1], code = k[`records[${i}].UserID`]; if (!code) continue;
      const method = Number(k[`records[${i}].Method`] ?? -1); out.push({ code, ts: local(new Date(Number(k[key]) * 1000)), verify: method === 1 ? 4 : method === 4 ? 15 : method === 3 ? 1 : method === 0 ? 0 : null, state: null }); }
    return out;
  },
  async users(d) {
    const r = await request(d, 'GET', '/cgi-bin/recordFinder.cgi?action=find&name=AccessUserInfo&count=4096'), k = kv(r.text), out = [];
    for (const key of Object.keys(k)) { const m = key.match(/^records\[(\d+)\]\.UserID$/); if (m) out.push({ code: k[key], name: k[`records[${m[1]}].UserName`] ?? '' }); }
    return out;
  },
  async addUser(d, p) {
    const q = `UserID=${encodeURIComponent(p.code)}&UserName=${encodeURIComponent(String(p.name || p.code).slice(0, 32))}&Authority=2&Doors[0]=0&ValidDateStart=${encodeURIComponent('20200101 000000')}&ValidDateEnd=${encodeURIComponent('20371231 235959')}`;
    const had = (await dah.users(d)).some((u) => u.code === String(p.code));
    await request(d, 'GET', `/cgi-bin/recordUpdater.cgi?action=${had ? 'update' : 'insert'}&name=AccessUserInfo&${q}${had ? '&recno=' + encodeURIComponent(p.code) : ''}`);
  },
  async setTime(d, when = new Date()) { await request(d, 'GET', `/cgi-bin/global.cgi?action=setCurrentTime&time=${encodeURIComponent(local(when))}`); },
  async delUser(d, code) { await request(d, 'GET', `/cgi-bin/recordUpdater.cgi?action=remove&name=AccessUserInfo&recno=${encodeURIComponent(code)}`); },
};

// ---------- Suprema through the BioStar 2 server ----------
async function bsSession(d) {
  const user = d.dev_user ?? '', pass = d.dev_pass ? decrypt(d.dev_pass) : '';
  const o = { host: d.ip, port: d.port || 443, path: '/api/login', method: 'POST', tls: Number(d.port || 443) !== 80 }, body = JSON.stringify({ User: { login_id: user, password: pass } });
  const r = await once(o, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  const sid = r.headers['bs-session-id']; if (r.status >= 400 || !sid) throw new Error('BioStar 2 refused the login (check the user name and password)');
  return sid;
}
const bs = {
  async call(d, method, path, json) { const s = await bsSession(d); return JSON.parse((await request({ ...d, port: d.port || 443 }, method, path, { json, session: s })).text || '{}'); },
  async info(d) { const j = await bs.call(d, 'GET', '/api/devices'); const rows = j.DeviceCollection?.rows ?? []; return { serial: '', model: `BioStar 2, ${rows.length} terminal(s)` }; },
  async events(d, from, to) {
    const j = await bs.call(d, 'POST', '/api/events/search', { Query: { limit: 5000, conditions: [{ column: 'datetime', operator: 3, values: [from.toISOString(), to.toISOString()] }], orders: [{ column: 'datetime', descending: false }] } }), out = [];
    for (const e of j.EventCollection?.rows ?? []) { const code = e.user_id?.user_id; if (!code || !e.datetime) continue; out.push({ code: String(code), ts: local(new Date(e.datetime)), verify: null, state: null }); }
    return out;
  },
  async users(d) { const j = await bs.call(d, 'GET', '/api/users?limit=5000&offset=0'); return (j.UserCollection?.rows ?? []).map((u) => ({ code: String(u.user_id), name: u.name || '' })); },
  async addUser(d, p) {
    const body = { User: { user_id: String(p.code), name: String(p.name || p.code).slice(0, 48), start_datetime: '2020-01-01T00:00:00.00Z', expiry_datetime: '2037-12-31T23:59:00.00Z' } };
    try { await bs.call(d, 'POST', '/api/users', body); } catch (e) { if (!/ 40\d:/.test(e.message)) throw e; await bs.call(d, 'PUT', '/api/users/' + encodeURIComponent(p.code), body); }
  },
  async delUser(d, code) { await bs.call(d, 'DELETE', '/api/users/' + encodeURIComponent(code)); },
};

// ---------- Anviz (TC_B protocol, TCP) ----------
// Frame: A5 | device id (4, 0 = any) | command | length (2, big endian) | data | CRC16 (low byte, high byte). A reply has command|0x80, then a result byte (0 = ok) before the length.
export const anvizCrc = (buf) => { let c = 0xffff; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; } return c & 0xffff; };
export const anvizFrame = (cmd, data = Buffer.alloc(0), id = 0) => { const h = Buffer.alloc(8); h[0] = 0xa5; h.writeUInt32BE(id >>> 0, 1); h[5] = cmd; h.writeUInt16BE(data.length, 6); const b = Buffer.concat([h, data]), c = Buffer.alloc(2); c.writeUInt16LE(anvizCrc(b)); return Buffer.concat([b, c]); };
const ANVIZ_EPOCH = Date.UTC(2000, 0, 2); // seconds count from 2000-01-02 on real devices (the manual says 01-01, implementations tested on devices use 01-02)
const anvizTime = (s) => { const d = new Date(ANVIZ_EPOCH + s * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
function anvizSession(d) {
  const port = d.port || 5010, sock = net.connect({ host: d.ip, port, timeout: 8000 }); let buf = Buffer.alloc(0), waiter = null, failed = null;
  const wake = () => waiter && waiter();
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); wake(); });
  sock.on('timeout', () => { failed = new Error(`No answer from ${d.ip}:${port}`); sock.destroy(); wake(); });
  sock.on('error', (e) => { failed = new Error(e.code === 'ECONNREFUSED' ? `Cannot reach ${d.ip}:${port} (connection refused)` : e.message); wake(); });
  sock.on('close', () => { failed ??= new Error(`${d.ip}:${port} closed the connection without answering`); wake(); });
  const take = async () => { // one complete, CRC-checked reply
    for (;;) {
      const i = buf.indexOf(0xa5); if (i > 0) buf = buf.subarray(i);
      if (buf.length >= 9) { const len = buf.readUInt16BE(7), total = 9 + len + 2; if (buf.length >= total) { const f = buf.subarray(0, total); buf = buf.subarray(total); const crc = f.readUInt16LE(total - 2); if (crc !== anvizCrc(f.subarray(0, total - 2))) throw new Error('A reply from the device failed its checksum'); return { cmd: f[5], ack: f[6], data: f.subarray(9, 9 + len) }; } }
      if (failed) throw failed;
      await new Promise((ok) => { waiter = ok; setTimeout(ok, 8500); }); waiter = null;
      if (!failed && buf.length === 0 && sock.destroyed) throw new Error('The device stopped answering');
    }
  };
  return {
    async call(cmd, data) { if (failed) throw failed; sock.write(anvizFrame(cmd, data)); const r = await take(); if (r.cmd !== (cmd | 0x80)) throw new Error(`Unexpected reply 0x${r.cmd.toString(16)} to command 0x${cmd.toString(16)}`); return r; },
    close() { sock.destroy(); },
  };
}
async function withAnviz(d, fn) { const s = anvizSession(d); try { return await fn(s); } finally { s.close(); } }
const okAck = (r, what) => { if (r.ack !== 0) throw new Error(`The device refused ${what} (code ${r.ack})`); return r; };
const anv = {
  async info(d) { return withAnviz(d, async (s) => { const v = okAck(await s.call(0x30), 'the version request').data, sn = await s.call(0x24).catch(() => null); return { serial: sn && sn.ack === 0 ? sn.data.toString('latin1').replace(/[\0\s]+$/g, '').replace(/[^\x20-\x7e]/g, '') : '', model: 'Anviz ' + v.subarray(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() }; }); },
  async events(d) {
    return withAnviz(d, async (s) => {
      const out = []; let first = true, flagged = 0;
      for (let n = 0; n < 4000; n++) { // 25 records per package; "2" starts at the records not downloaded yet, "0" asks for the next package
        const r = okAck(await s.call(0x40, Buffer.from([first ? 2 : 0, 25])), 'the record download'); first = false;
        const cnt = r.data[0] ?? 0; if (!cnt) break;
        for (let i = 0; i < cnt; i++) { const o = 1 + i * 14; if (o + 14 > r.data.length) break; const id = r.data.readUIntBE(o, 5), t = r.data.readUInt32BE(o + 5), bk = r.data[o + 9]; out.push({ code: String(id), ts: anvizTime(t), verify: bk & 8 ? 4 : bk & 4 ? 0 : bk & 3 ? 1 : null, state: r.data[o + 10] & 0x0f }); }
        flagged += cnt; if (cnt < 25) break;
      }
      d._anvizPending = flagged; return out;
    });
  },
  async markRead(d, n) { if (!n) return; await withAnviz(d, async (s) => { const b = Buffer.alloc(4); b[0] = 2; b.writeUIntBE(Math.min(n, 0xffffff), 1, 3); okAck(await s.call(0x4e, b), 'clearing the new-record flags'); }); },
  async users(d) {
    return withAnviz(d, async (s) => {
      const out = []; let first = true;
      for (let n = 0; n < 2000; n++) {
        const r = okAck(await s.call(0x72, Buffer.from([first ? 1 : 0, 12])), 'the user download'); first = false;
        const cnt = r.data[0] ?? 0; if (!cnt) break; const size = Math.round((r.data.length - 1) / cnt); // 30 bytes per user (ANSI) or 40 (Unicode)
        for (let i = 0; i < cnt; i++) { const o = 1 + i * size, id = r.data.readUIntBE(o, 5); const name = size >= 40 ? r.data.subarray(o + 12, o + 32).toString('utf16le') : r.data.subarray(o + 12, o + 22).toString('latin1'); out.push({ code: String(id), name: name.replace(/[\0￿]+/g, '').replace(/[^\x20-￿]/g, '').trim() }); }
        if (cnt < (size >= 40 ? 8 : 12)) break;
      }
      return out;
    });
  },
  async addUser(d, p) {
    const id = Number(String(p.code).replace(/\D/g, '')); if (!(id >= 0 && id < 2 ** 40)) throw new Error(`Anviz needs a numeric employee code (got "${p.code}")`);
    return withAnviz(d, async (s) => {
      const probe = okAck(await s.call(0x72, Buffer.from([1, 1])), 'the user download').data, size = probe[0] ? Math.round((probe.length - 1) / probe[0]) : 30;
      const u = Buffer.alloc(size, 0xff); u.writeUIntBE(id, 0, 5); // empty fields stay 0xFF
      const name = Buffer.alloc(size >= 40 ? 20 : 10); if (size >= 40) name.write(String(p.name || p.code).slice(0, 10), 'utf16le'); else name.write(String(p.name || p.code).replace(/[^\x20-\x7e]/g, '?').slice(0, 10), 'latin1');
      name.copy(u, 12); u[size >= 40 ? 32 : 22] = 0; u[size >= 40 ? 33 : 23] = 0; u[size >= 40 ? 34 : 24] = 0; u.writeUInt16BE(0, size >= 40 ? 35 : 25); u[size >= 40 ? 37 : 27] = 0; u[size >= 40 ? 38 : 28] = 0; u[size >= 40 ? 39 : 29] = 0x40; // ordinary user
      okAck(await s.call(0x73, Buffer.concat([Buffer.from([1]), u])), 'adding the user');
    });
  },
  async delUser(d, code) { const b = Buffer.alloc(6); b.writeUIntBE(Number(code), 0, 5); b[5] = 0xff; await withAnviz(d, async (s) => { const r = await s.call(0x4c, b); if (r.ack !== 0 && r.ack !== 6) throw new Error(`The device refused removing the user (code ${r.ack})`); }); },
  async setTime(d, when = new Date()) { return withAnviz(d, async (s) => okAck(await s.call(0x39, Buffer.from([when.getFullYear() - 2000, when.getMonth() + 1, when.getDate(), when.getHours(), when.getMinutes(), when.getSeconds()])), 'setting the time')); },
};

const DRIVERS = { hikvision: hik, dahua: dah, suprema: bs, anviz: anv };
export const driverOf = (d) => DRIVERS[d.brand];
export const isBranded = (d) => !!d && !!d.brand && d.brand !== 'zkteco' && !!DRIVERS[d.brand];

// ---------- the same jobs the ZKTeco code does ----------
export async function testDevice(d) { const drv = driverOf(d); if (!drv) throw new Error('Unknown brand'); return drv.info(d); }
export async function syncBranded(device) {
  const status = (st) => db.prepare('UPDATE devices SET last_sync=?, last_status=? WHERE id=?').run(local(new Date()), st, device.id);
  try {
    const drv = driverOf(device), info = await drv.info(device).catch(() => null);
    if (info) db.prepare("UPDATE devices SET dev_serial=COALESCE(NULLIF(?,''),dev_serial), model=COALESCE(NULLIF(model,''), NULLIF(?,'')) WHERE id=?").run(info.serial, info.model, device.id);
    const to = new Date(), last = db.prepare('SELECT MAX(ts) t FROM logs WHERE device_id=?').get(device.id).t, from = last ? new Date(new Date(last.replace(' ', 'T')).getTime() - 3 * 3600000) : new Date(to.getTime() - 30 * 86400000);
    const logs = await drv.events(device, from, to), users = await drv.users(device).catch(() => []);
    const insEmp = db.prepare('INSERT OR IGNORE INTO employees(code, name) VALUES(?,?)');
    for (const u of users) { insEmp.run(u.code, u.name || `User ${u.code}`); db.prepare("INSERT INTO device_users(device_id, code, name) VALUES(?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name, seen=datetime('now','localtime')").run(device.id, u.code, u.name || null); }
    const added = saveLogs(logs, device.id);
    if (drv.markRead) await drv.markRead(device, device._anvizPending); // only after the punches are safely saved
    status(`OK: ${logs.length} logs read, ${added} new, ${users.length} users`);
    return { read: logs.length, added, users: users.length };
  } catch (e) { status('ERROR: ' + e.message); throw e; }
}
export async function sendUsersBranded(device, people) { const drv = driverOf(device); let n = 0; for (const p of people) { await drv.addUser(device, p); n++; } return n; }
export async function removeUsersBranded(device, codes) { const drv = driverOf(device); let n = 0; for (const c of codes) { await drv.delUser(device, c).catch(() => null); n++; } return n; }

export async function setClockBranded(device) { const drv = driverOf(device); if (!drv.setTime) throw new Error('Setting the time from here is not available for this brand'); await drv.setTime(device); return { time: local(new Date()) }; }
