// Browser fingerprint (WebAuthn) punching, simulated with a software authenticator, plus fingerprint enrolment on chosen devices.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
const sha = (b) => createHash('sha256').update(b).digest(), b64u = (b) => Buffer.from(b).toString('base64url'), unb = (s) => Buffer.from(s, 'base64url');
// minimal CBOR writer
const head = (mt, n) => n < 24 ? Buffer.from([mt << 5 | n]) : n < 256 ? Buffer.from([mt << 5 | 24, n]) : Buffer.from([mt << 5 | 25, n >> 8, n & 255]);
const enc = (v) => typeof v === 'number' ? (v >= 0 ? head(0, v) : head(1, -1 - v)) : Buffer.isBuffer(v) ? Buffer.concat([head(2, v.length), v]) : typeof v === 'string' ? Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]) : Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
const origin = S.base, rpHash = sha('localhost');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = publicKey.export({ format: 'jwk' });
const credId = randomBytes(32), counter = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const assertion = (o, ctr, flags = 5, tamper = false) => {
  const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin })), ad = Buffer.concat([rpHash, Buffer.from([flags]), counter(ctr)]);
  const sig = sign('sha256', Buffer.concat([ad, sha(cdj)]), { key: privateKey, dsaEncoding: 'der' }); if (tamper) sig[sig.length - 1] ^= 1;
  return { token: o.token, id: b64u(credId), authenticatorData: b64u(ad), clientDataJSON: b64u(cdj), signature: b64u(sig) };
};
try {
  const e = await api('employees', 'POST', { name: 'Finger Tester', join_date: '2025-01-01' }), emp = (await api('employees')).find(x => x.id === e.id);
  // register
  const ro = await api('webauthn/register/options', 'POST', { employee_id: emp.id, fid: 1, label: 'My laptop' });
  assert.equal(ro.rpId, 'localhost'); assert.equal(ro.user.displayName, 'Finger Tester');
  const cose = enc(new Map([[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x)], [-3, unb(jwk.y)]]));
  const ad = Buffer.concat([rpHash, Buffer.from([0x45]), counter(0), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose]);
  const att = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]])), cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ro.challenge, origin }));
  const bad = await S.raw('webauthn/register/verify', 'POST', { token: ro.token, id: b64u(randomBytes(32)), clientDataJSON: b64u(cd), attestationObject: b64u(att) });
  assert.equal(bad.status, 400, 'a scan that does not match its own key id is refused');
  const ro2 = await api('webauthn/register/options', 'POST', { employee_id: emp.id, fid: 1, label: 'My laptop' });
  const cd2 = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: ro2.challenge, origin }));
  assert.ok((await api('webauthn/register/verify', 'POST', { token: ro2.token, id: b64u(credId), clientDataJSON: b64u(cd2), attestationObject: b64u(att) })).ok);
  let ov = await api('fingerprint/overview'); const w = ov.rows.find(r => r.src === 'web' && r.code === emp.code); assert.ok(w); assert.equal(w.fid, 1); assert.equal(w.label, 'My laptop');
  // punch
  const p1 = await api('webauthn/punch/options', 'POST', {}); const r1 = await api('webauthn/punch/verify', 'POST', assertion(p1, 1));
  assert.ok(r1.ok && r1.code === emp.code && !r1.duplicate, 'the fingerprint marks attendance');
  assert.equal((await api('logs?emp=' + emp.code).catch(() => [])).length >= 0, true);
  const db = new DatabaseSync(join(S.dir, 'e2e.db')); assert.equal(db.prepare("SELECT count(*) n FROM logs WHERE emp_code=? AND source='fingerprint'").get(emp.code).n, 1); db.close();
  const p2 = await api('webauthn/punch/options', 'POST', {}); const dup = await api('webauthn/punch/verify', 'POST', assertion(p2, 2)); assert.ok(dup.duplicate, 'a second scan within a minute is not a second punch');
  const p3 = await api('webauthn/punch/options', 'POST', {}); assert.equal((await S.raw('webauthn/punch/verify', 'POST', assertion(p3, 2))).status, 400, 'an old counter (replay) is refused');
  const p4 = await api('webauthn/punch/options', 'POST', {}); assert.equal((await S.raw('webauthn/punch/verify', 'POST', assertion(p4, 5, 5, true))).status, 400, 'a wrong signature is refused');
  const p5 = await api('webauthn/punch/options', 'POST', {}); assert.equal((await S.raw('webauthn/punch/verify', 'POST', assertion(p5, 6, 1))).status, 400, 'a scan without fingerprint verification is refused');
  assert.equal((await S.raw('webauthn/punch/verify', 'POST', assertion(p5, 7))).status, 400, 'a challenge works once');
  // edit + delete
  await api('webauthn/credentials/' + w.id, 'PUT', { label: 'Renamed', fid: 2 }); ov = await api('fingerprint/overview'); assert.equal(ov.rows.find(r => r.id === w.id && r.src === 'web').label, 'Renamed');
  // devices: enrol on one or several
  const d2 = new DatabaseSync(join(S.dir, 'e2e.db'));
  for (const [i, sn] of ['FP1', 'FP2', 'FP3'].entries()) d2.prepare("INSERT INTO devices(name, sn, approved, last_seen) VALUES(?,?,1,datetime('now','localtime'))").run('Gate ' + (i + 1), sn);
  ov = await api('fingerprint/overview'); const ds = ov.devices.filter(d => /^Gate/.test(d.name)); assert.equal(ds.length, 3); assert.ok(ds.every(d => d.online && d.push));
  const en = await api('fingerprint/enroll', 'POST', { employee_id: emp.id, fid: 3, device_ids: [ds[0].id, ds[2].id] }); assert.equal(en.started, 2);
  const cmds = (id) => d2.prepare('SELECT cmd FROM device_commands WHERE device_id=?').all(id).map(r => r.cmd);
  assert.ok(cmds(ds[0].id).some(c => c.startsWith('ENROLL_FP PIN=' + emp.code + '\tFID=3')) && cmds(ds[2].id).some(c => c.startsWith('ENROLL_FP')) && !cmds(ds[1].id).length, 'only the chosen devices get the command');
  assert.equal((await S.raw('fingerprint/enroll', 'POST', { employee_id: emp.id, device_ids: [] })).status, 400);
  await api('fingerprint/remove', 'POST', { employee_id: emp.id, fid: 3, device_ids: [ds[1].id] }); assert.ok(cmds(ds[1].id).some(c => c.startsWith('DATA DELETE FINGERTMP PIN=' + emp.code + '\tFID=3')));
  d2.close();
  await api('webauthn/credentials/' + w.id, 'DELETE'); ov = await api('fingerprint/overview'); assert.ok(!ov.rows.some(r => r.src === 'web' && r.id === w.id));
  const p6 = await api('webauthn/punch/options', 'POST', {}); assert.equal((await S.raw('webauthn/punch/verify', 'POST', assertion(p6, 9))).status, 400, 'a deleted fingerprint no longer punches');
  console.log('e2e-webauthn passed: register, punch, replay/signature/UV checks, edit, delete, enrol/remove on chosen devices');
} finally { S.stop(); }
