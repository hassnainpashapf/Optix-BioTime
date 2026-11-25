import express from 'express';
import os from 'node:os';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from './db.js';
import { als, userScope } from './rbac.js';
import { feedFor, ownerOf } from './notify.js';
import { mountAlertRoutes } from './alerts.js';

const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const sha = (t) => createHash('sha256').update(t).digest('hex');
const stamp = () => new Date().toLocaleString('sv');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- pairing codes: made by a signed-in staff user or employee, used once by the phone ----------
export function makePairCode(kind, ref) {
  db.prepare('DELETE FROM mobile_pair WHERE expires<?').run(Date.now());
  const code = String(randomInt(0, 1e8)).padStart(8, '0');
  db.prepare('INSERT INTO mobile_pair(code, kind, ref, expires) VALUES(?,?,?,?)').run(code, kind, String(ref), Date.now() + 10 * 60000);
  return { code, expires_in: 600 };
}
export const phonesOf = (kind, ref) => db.prepare('SELECT id, label, created, last_seen FROM mobile_devices WHERE kind=? AND ref=? AND revoked=0 ORDER BY id DESC').all(kind, String(ref));
export const removePhone = (kind, ref, id) => db.prepare('UPDATE mobile_devices SET revoked=1 WHERE id=? AND kind=? AND ref=?').run(id, kind, String(ref)).changes > 0;

// Staff side (after staff login): any staff user manages their own phones.
export const mobileAdminRouter = express.Router();
export const serverInfo = (req) => ({ addresses: Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address), port: Number(process.env.PORT || 8080), host: req.headers.host ?? null });
mobileAdminRouter.get('/mobile/server-info', (req, res) => res.json(serverInfo(req)));
mobileAdminRouter.post('/mobile/pair-code', (req, res) => res.json(makePairCode('staff', req.user)));
mobileAdminRouter.get('/mobile/devices', (req, res) => res.json(phonesOf('staff', req.user)));
mobileAdminRouter.delete('/mobile/devices/:id', (req, res) => removePhone('staff', req.user, req.params.id) ? res.json({ ok: true }) : fail(res, 'No such phone', 404));

// ---------- the phone itself: /api/m/* ----------
export const mobileRouter = express.Router();
const tries = new Map(); // pairing attempts per address: 10 a minute
mobileRouter.get('/info', (_q, res) => res.json({ app: 'attendance', v: 1 }));
mobileRouter.post('/pair', (req, res) => {
  const ip = req.ip, now = Date.now(), t = (tries.get(ip) ?? []).filter(x => now - x < 60000);
  if (t.length >= 10) return fail(res, 'Too many attempts. Wait a minute.', 429); t.push(now); tries.set(ip, t);
  const code = String(req.body?.code ?? '').replace(/\D/g, ''), row = db.prepare('SELECT * FROM mobile_pair WHERE code=?').get(code);
  if (!row || row.expires < now) return fail(res, 'That code is wrong or has expired. Make a new one on the computer.', 400);
  db.prepare('DELETE FROM mobile_pair WHERE code=?').run(code); // single use
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO mobile_devices(token_hash, kind, ref, label, last_seen) VALUES(?,?,?,?,?)').run(sha(token), row.kind, row.ref, String(req.body?.device_name ?? 'Phone').slice(0, 60), stamp());
  const who = row.kind === 'staff' ? row.ref : db.prepare('SELECT name FROM employees WHERE id=?').get(row.ref)?.name;
  res.json({ token, kind: row.kind, name: who });
});

mobileRouter.use((req, res, next) => { // everything below needs a paired phone
  const tok = (req.headers.authorization || '').replace('Bearer ', ''); if (!tok) return fail(res, 'Not paired', 401);
  const d = db.prepare('SELECT * FROM mobile_devices WHERE token_hash=? AND revoked=0').get(sha(tok)); if (!d) return fail(res, 'This phone is no longer paired', 401);
  let ctx;
  if (d.kind === 'staff') { const u = db.prepare('SELECT * FROM users WHERE username=?').get(d.ref); if (!u) { db.prepare('UPDATE mobile_devices SET revoked=1 WHERE id=?').run(d.id); return fail(res, 'This account no longer exists', 401); } req.user = u.username; req.role = u.role; ctx = { scope: userScope(u), user: u.username }; }
  else { const e = db.prepare('SELECT e.id, e.name FROM employees e JOIN employee_accounts a ON a.employee_id=e.id WHERE e.id=? AND e.active=1 AND a.enabled=1').get(d.ref); if (!e) { db.prepare('UPDATE mobile_devices SET revoked=1 WHERE id=?').run(d.id); return fail(res, 'This account is switched off', 401); } req.me = e; ctx = { scope: {}, user: 'emp:' + e.id }; }
  req.mobile = d; db.prepare('UPDATE mobile_devices SET last_seen=? WHERE id=?').run(stamp(), d.id);
  als.run(ctx, next);
});
const ctxOf = (req) => req.mobile.kind === 'staff' ? { owner: ownerOf.staff(req.user), staff: true } : { owner: ownerOf.emp(req.me.id), staff: false, employeeId: req.me.id };
mobileRouter.get('/me', (req, res) => { const c = ctxOf(req); res.json({ kind: req.mobile.kind, name: req.mobile.kind === 'staff' ? req.user : req.me.name, label: req.mobile.label, server_time: stamp(), latest: feedFor(c.owner, { ...c, limit: 1 })[0]?.id ?? 0 }); });
// Alerts newer than `since`. With wait=N (up to 25) the request is held until something arrives, so a phone can listen without polling every few seconds.
mobileRouter.get('/feed', async (req, res) => {
  const c = ctxOf(req), since = Number(req.query.since) || 0, limit = Math.min(Number(req.query.limit) || 50, 100), wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), 25) * 1000, end = Date.now() + wait;
  let closed = false; req.on('close', () => { closed = true; });
  for (;;) {
    const items = feedFor(c.owner, { ...c, since, limit });
    if (items.length || Date.now() >= end || closed) return closed ? undefined : res.json({ items, latest: items[0]?.id ?? since, server_time: stamp() });
    await sleep(1000);
  }
});
mobileRouter.post('/logout', (req, res) => { db.prepare('UPDATE mobile_devices SET revoked=1 WHERE id=?').run(req.mobile.id); res.json({ ok: true }); });
// alert preferences (the same screens as on the computer), picked by who the phone belongs to
const staffAlerts = express.Router(), empAlerts = express.Router();
mountAlertRoutes(staffAlerts, 's', ctxOf); mountAlertRoutes(empAlerts, 'e', ctxOf, (req, id) => !!db.prepare('SELECT 1 FROM employees WHERE id=? AND manager_id=?').get(id, req.me.id));
mobileRouter.use('/alerts', (req, res, next) => { req.url = '/alerts' + (req.url === '/' ? '' : req.url); (req.mobile.kind === 'staff' ? staffAlerts : empAlerts)(req, res, next); });
mobileRouter.get('/team', (req, res) => req.mobile.kind === 'staff' ? res.json(db.prepare('SELECT id, code, name FROM employees WHERE active=1 ORDER BY name LIMIT 500').all()) : res.json(db.prepare('SELECT id, code, name FROM employees WHERE manager_id=? AND active=1 ORDER BY name').all(req.me.id)));
