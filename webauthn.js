// Fingerprint punching from the browser (WebAuthn: the laptop's own scanner, e.g. Touch ID / Windows Hello) and fingerprint enrolment on devices.
// A browser fingerprint is a passkey: the scanner never gives us the fingerprint, only a signed "this person touched it". We verify that signature ourselves.
import express from 'express';
import { createHash, randomBytes, verify as cverify } from 'node:crypto';
import { db, getSettings } from './db.js';
import { queueCommand, userCmd, clean } from './devsync.js';
import { scopeClause } from './rbac.js';
import { pushOnline } from './devices.js';

export const webauthnRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const stamp = () => new Date().toLocaleString('sv');
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const sha = (b) => createHash('sha256').update(b).digest();

db.exec(`CREATE TABLE IF NOT EXISTS webauthn_creds(id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, cred_id TEXT NOT NULL UNIQUE, jwk TEXT NOT NULL, alg INTEGER NOT NULL,
  counter INTEGER DEFAULT 0, label TEXT, fid INTEGER DEFAULT 0, created TEXT DEFAULT (datetime('now','localtime')), last_used TEXT);`);

// ---------- a very small CBOR reader (enough for attestation objects and COSE keys) ----------
function cbor(buf, o = { i: 0 }) {
  const b = buf, ib = b[o.i++], mt = ib >> 5; let ai = ib & 31, n;
  const len = () => { if (ai < 24) return ai; if (ai === 24) return b[o.i++]; if (ai === 25) { n = b.readUInt16BE(o.i); o.i += 2; return n; } if (ai === 26) { n = b.readUInt32BE(o.i); o.i += 4; return n; } throw new Error('Unsupported CBOR length'); };
  if (mt === 0) return len(); if (mt === 1) return -1 - len();
  if (mt === 2) { const l = len(), v = b.subarray(o.i, o.i + l); o.i += l; return v; }
  if (mt === 3) { const l = len(), v = b.subarray(o.i, o.i + l).toString('utf8'); o.i += l; return v; }
  if (mt === 4) { const l = len(), a = []; for (let k = 0; k < l; k++) a.push(cbor(b, o)); return a; }
  if (mt === 5) { const l = len(), m = new Map(); for (let k = 0; k < l; k++) { const key = cbor(b, o); m.set(key, cbor(b, o)); } return m; }
  if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; }
  throw new Error('Unsupported CBOR type');
}

// ---------- challenges (in memory, 3 minutes, one use) ----------
const CH = new Map();
const newChallenge = (extra) => { const token = randomBytes(12).toString('hex'), challenge = randomBytes(32); CH.set(token, { challenge, exp: Date.now() + 180000, ...extra }); for (const [k, v] of CH) if (v.exp < Date.now()) CH.delete(k); return { token, challenge: b64u(challenge) }; };
const takeChallenge = (token, type) => { const c = CH.get(token); CH.delete(token); if (!c || c.exp < Date.now() || c.type !== type) throw new Error('This scan expired. Try again.'); return c; };
const rpOf = (req) => { const host = String(req.headers.host ?? '').replace(/:\d+$/, ''); return host; };
function checkClient(req, clientDataJSON, type, challenge) {
  const cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  if (cd.type !== type) throw new Error('Wrong scan type');
  if (!unb64u(cd.challenge).equals(challenge)) throw new Error('The scan does not match this request');
  const u = new URL(cd.origin); if (u.hostname !== rpOf(req)) throw new Error('The scan came from a different address');
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('Fingerprint scanning needs https (or localhost)');
}
function parseAuthData(ad, rpId, needUv = true) {
  if (ad.length < 37) throw new Error('Bad authenticator data');
  if (!ad.subarray(0, 32).equals(sha(rpId))) throw new Error('The scan is for a different site');
  const flags = ad[32]; if (!(flags & 1)) throw new Error('No touch detected'); if (needUv && !(flags & 4)) throw new Error('The fingerprint was not verified by the scanner');
  return { flags, counter: ad.readUInt32BE(33) };
}
function coseToJwk(key) {
  const kty = key.get(1), alg = key.get(3);
  if (kty === 2 && key.get(-1) === 1) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(key.get(-2)), y: b64u(key.get(-3)) } };
  if (kty === 3) return { alg: -257, jwk: { kty: 'RSA', n: b64u(key.get(-1)), e: b64u(key.get(-2)) } };
  throw new Error('This scanner uses a key type we do not support (alg ' + alg + ')');
}

const empOf = (id) => { const sc = scopeClause('e'); return db.prepare(`SELECT e.* FROM employees e WHERE e.id=?${sc.sql}`).get(id, ...sc.args); };

// ---------- overview: devices and what is enrolled ----------
webauthnRouter.get('/fingerprint/overview', (_q, res) => {
  const sc = scopeClause('e'), S = getSettings(), now = Date.now();
  const devices = db.prepare("SELECT id, name, sn, ip, online, last_seen, alert_min FROM devices WHERE approved=1 ORDER BY name").all().map(d => ({ id: d.id, name: d.name || d.sn || ('Device ' + d.id), sn: d.sn, push: !!d.sn, online: d.sn ? pushOnline(d, now, S) : !!d.online }));
  const web = db.prepare(`SELECT w.id, 'web' AS src, e.id AS employee_id, e.code, e.name, w.fid, w.label, w.created, w.last_used FROM webauthn_creds w JOIN employees e ON e.id=w.employee_id WHERE 1=1${sc.sql} ORDER BY w.id DESC`).all(...sc.args);
  const dev = db.prepare(`SELECT b.id, 'device' AS src, e.id AS employee_id, e.code, e.name, b.fid, d.name AS label, b.received AS created FROM biodata b JOIN employees e ON e.id=b.employee_id LEFT JOIN devices d ON d.id=b.device_id WHERE b.kind='fp'${sc.sql} ORDER BY b.id DESC LIMIT 1000`).all(...sc.args);
  res.json({ devices, rows: [...web, ...dev], secure: true });
});

// ---------- browser fingerprint: register ----------
webauthnRouter.post('/webauthn/register/options', (req, res) => {
  const e = empOf(Number(req.body?.employee_id)); if (!e) return fail(res, 'Choose the employee', 404);
  const c = newChallenge({ type: 'create', employee_id: e.id, fid: Math.max(0, Math.min(9, Number(req.body?.fid) || 0)), label: String(req.body?.label ?? '').slice(0, 60) });
  const ex = db.prepare('SELECT cred_id FROM webauthn_creds WHERE employee_id=?').all(e.id).map(r => ({ type: 'public-key', id: r.cred_id }));
  res.json({ ...c, rpId: rpOf(req), rpName: 'Optix', user: { id: b64u(String(e.id)), name: e.code, displayName: e.name }, exclude: ex });
});
webauthnRouter.post('/webauthn/register/verify', (req, res) => {
  try {
    const b = req.body ?? {}, c = takeChallenge(b.token, 'create');
    checkClient(req, unb64u(b.clientDataJSON), 'webauthn.create', c.challenge);
    const att = cbor(unb64u(b.attestationObject)), ad = att.get('authData'), rp = rpOf(req), { flags, counter } = parseAuthData(ad, rp);
    if (!(flags & 64)) throw new Error('The scanner did not return a key');
    const idLen = ad.readUInt16BE(53), credId = ad.subarray(55, 55 + idLen), key = cbor(ad, { i: 55 + idLen }), { alg, jwk } = coseToJwk(key);
    if (!b64u(credId) || b64u(credId) !== String(b.id)) throw new Error('The scan did not match');
    const label = c.label || `Laptop fingerprint ${new Date().toLocaleDateString('sv')}`;
    const id = Number(db.prepare('INSERT INTO webauthn_creds(employee_id, cred_id, jwk, alg, counter, label, fid) VALUES(?,?,?,?,?,?,?)').run(c.employee_id, b64u(credId), JSON.stringify(jwk), alg, counter, label, c.fid).lastInsertRowid);
    res.json({ ok: true, id });
  } catch (e) { fail(res, e.message); }
});

// ---------- browser fingerprint: punch ----------
webauthnRouter.post('/webauthn/punch/options', (req, res) => { res.json({ ...newChallenge({ type: 'get' }), rpId: rpOf(req) }); });
webauthnRouter.post('/webauthn/punch/verify', (req, res) => {
  try {
    const b = req.body ?? {}, c = takeChallenge(b.token, 'get');
    const cred = db.prepare('SELECT * FROM webauthn_creds WHERE cred_id=?').get(String(b.id)); if (!cred) throw new Error('This fingerprint is not registered');
    const cdj = unb64u(b.clientDataJSON), ad = unb64u(b.authenticatorData); checkClient(req, cdj, 'webauthn.get', c.challenge);
    const { counter } = parseAuthData(ad, rpOf(req));
    const data = Buffer.concat([ad, sha(cdj)]), jwk = JSON.parse(cred.jwk), sig = unb64u(b.signature);
    const ok = cred.alg === -7 ? cverify('sha256', data, { key: jwk, format: 'jwk', dsaEncoding: 'der' }, sig) : cverify('sha256', data, { key: jwk, format: 'jwk' }, sig);
    if (!ok) throw new Error('The fingerprint could not be verified');
    if (counter && cred.counter && counter <= cred.counter) throw new Error('This scan was already used');
    const e = empOf(cred.employee_id); if (!e) throw new Error('Not allowed for this employee');
    if (!e.active) throw new Error('This employee is not active');
    const ts = stamp(), dup = db.prepare("SELECT 1 FROM logs WHERE emp_code=? AND ts>=datetime(?, '-1 minutes')").get(e.code, ts);
    db.prepare('UPDATE webauthn_creds SET counter=?, last_used=? WHERE id=?').run(counter, ts, cred.id);
    if (dup) return res.json({ ok: true, duplicate: true, code: e.code, name: e.name, ts, message: 'Already punched a moment ago' });
    db.prepare("INSERT OR IGNORE INTO logs(emp_code, ts, source) VALUES(?,?,'fingerprint')").run(e.code, ts);
    res.json({ ok: true, code: e.code, name: e.name, ts });
  } catch (e) { fail(res, e.message); }
});
webauthnRouter.put('/webauthn/credentials/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM webauthn_creds WHERE id=?').get(req.params.id); if (!w || !empOf(w.employee_id)) return fail(res, 'Not found', 404);
  const fid = req.body?.fid == null ? w.fid : Math.max(0, Math.min(9, Number(req.body.fid) || 0)), label = req.body?.label == null ? w.label : String(req.body.label).slice(0, 60);
  db.prepare('UPDATE webauthn_creds SET fid=?, label=? WHERE id=?').run(fid, label, w.id); res.json({ ok: true });
});
webauthnRouter.delete('/webauthn/credentials/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM webauthn_creds WHERE id=?').get(req.params.id); if (!w || !empOf(w.employee_id)) return fail(res, 'Not found', 404);
  db.prepare('DELETE FROM webauthn_creds WHERE id=?').run(w.id); res.json({ ok: true });
});

// ---------- fingerprint on devices: the person scans on the chosen device(s) ----------
const pushDevices = (ids) => db.prepare(`SELECT id, name, sn FROM devices WHERE approved=1 AND sn IS NOT NULL AND id IN (${(ids.length ? ids : [0]).map(() => '?').join(',')})`).all(...ids);
webauthnRouter.post('/fingerprint/enroll', (req, res) => {
  const e = empOf(Number(req.body?.employee_id)); if (!e) return fail(res, 'Choose the employee', 404);
  const ids = (Array.isArray(req.body?.device_ids) ? req.body.device_ids : []).map(Number).filter(Boolean), fid = Math.max(0, Math.min(9, Number(req.body?.fid) || 0));
  const ds = pushDevices(ids); if (!ds.length) return fail(res, 'Choose at least one device that takes push commands');
  for (const d of ds) { queueCommand(d.id, userCmd(e.code, e.name, e.card_no ?? '')); queueCommand(d.id, `ENROLL_FP PIN=${clean(e.code)}\tFID=${fid}\tRETRY=3\tOVERWRITE=1`); }
  res.json({ started: ds.length, devices: ds.map(d => d.name || d.sn) });
});
webauthnRouter.post('/fingerprint/remove', (req, res) => {
  const e = empOf(Number(req.body?.employee_id)); if (!e) return fail(res, 'Choose the employee', 404);
  const ids = (Array.isArray(req.body?.device_ids) ? req.body.device_ids : []).map(Number).filter(Boolean), fid = Math.max(0, Math.min(9, Number(req.body?.fid) || 0));
  const ds = pushDevices(ids); for (const d of ds) queueCommand(d.id, `DATA DELETE FINGERTMP PIN=${clean(e.code)}\tFID=${fid}`);
  db.prepare("DELETE FROM biodata WHERE employee_id=? AND kind='fp' AND fid=?" + (ids.length ? ` AND (device_id IS NULL OR device_id IN (${ids.map(() => '?').join(',')}))` : '')).run(e.id, fid, ...ids);
  res.json({ removed: ds.length });
});
