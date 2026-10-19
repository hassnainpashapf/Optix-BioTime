// Server Setting: HTTP and HTTPS on chosen ports, automatic self-signed certificate, uploaded certificate checks, redirect that spares devices.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { makeSelfSigned } from './selfsigned.js';

const dir = mkdtempSync(join(tmpdir(), 'optix-https-')), hp = 19000 + Math.floor(Math.random() * 400), sp = hp + 500;
const env = { ...process.env, DB_FILE: join(dir, 'e.db'), BACKUP_DIR: join(dir, 'bk'), LOG_DIR: join(dir, 'logs'), UPLOAD_DIR: join(dir, 'up'), ADMIN_PASSWORD: 'e2e-pass' }; delete env.PORT; delete env.TLS_CERT; delete env.TLS_KEY;
writeFileSync(join(dir, 'server.json'), JSON.stringify({ http: { enabled: true, port: hp }, https: { enabled: true, port: sp, source: 'auto', host: 'optix.test' }, redirect: false }));
let srv;
const start = async () => { srv = spawn('node', ['server.js'], { env, stdio: 'pipe' }); srv.exited = new Promise(r => srv.once('exit', r)); for (let i = 0; i < 100; i++) { try { await fetch(`http://localhost:${hp}/iclock/ping`); return; } catch { await new Promise(r => setTimeout(r, 100)); } } throw new Error('server did not start'); };
const sget = (port, path = '/') => new Promise((ok, no) => https.get({ host: 'localhost', port, path, rejectUnauthorized: false }, r => { const cert = r.socket.getPeerCertificate(); let b = ''; r.on('data', d => b += d); r.on('end', () => ok({ status: r.statusCode, body: b, cert })); }).on('error', no));
const call = async (base, path, method = 'GET', body, tok) => { const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(e => { throw new Error(method + ' ' + path + ': ' + e.message + ' / ' + (e.cause && e.cause.message)); }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
try {
  await start();
  const base = `http://localhost:${hp}`, tok = (await call(base, 'login', 'POST', { username: 'admin', password: 'e2e-pass' })).body.token;
  const h = await sget(sp, '/api/login'); assert.ok(h.status >= 200 && h.status < 500, 'https answers on the chosen port');
  assert.match(h.cert.subjectaltname, /optix\.test/, 'the automatic certificate carries the server name'); assert.match(h.cert.subjectaltname, /localhost/);
  assert.equal(h.cert.subject.CN, 'optix.test');
  const st = (await call(base, 'system/server', 'GET', undefined, tok)).body; assert.equal(st.running.http, hp); assert.equal(st.running.https, sp); assert.equal(st.restart_needed, false); assert.ok(st.cert.self_signed);
  // validation
  const put = (b) => call(base, 'system/server', 'PUT', b, tok);
  assert.equal((await put({ http: { enabled: false }, https: { enabled: false } })).status, 400);
  assert.equal((await put({ http: { enabled: true, port: 70000 }, https: { enabled: false } })).status, 400);
  assert.equal((await put({ http: { enabled: true, port: 9000 }, https: { enabled: true, port: 9000 } })).status, 400, 'two services cannot share a port');
  assert.equal((await put({ http: { enabled: true, port: hp }, https: { enabled: false, port: sp }, redirect: true })).status, 400, 'redirect needs https');
  const good = makeSelfSigned({ hosts: ['upload.test'] }), other = makeSelfSigned({ hosts: ['other.test'] });
  assert.equal((await put({ http: { enabled: true, port: hp }, https: { enabled: true, port: sp, source: 'upload' }, cert: 'junk', key: 'junk' })).status, 400, 'junk is not a certificate');
  assert.match((await put({ http: { enabled: true, port: hp }, https: { enabled: true, port: sp, source: 'upload' }, cert: good.cert, key: other.key })).body.error, /does not belong/, 'a key from another certificate is refused');
  assert.equal((await put({ http: { enabled: true, port: hp }, https: { enabled: true, port: sp, source: 'upload' } })).status, 400, 'upload needs the files');
  const ok = await put({ http: { enabled: true, port: hp }, https: { enabled: true, port: sp + 1, source: 'upload' }, redirect: true, cert: good.cert, key: good.key }); assert.equal(ok.status, 200); assert.equal(ok.body.restart_needed, true);
  assert.equal((await call(base, 'system/server', 'GET', undefined, tok)).body.restart_needed, true, 'saved settings differ from the running ones');
  assert.equal((await call(base, 'system/server', 'GET')).status, 401, 'login is required');
  // restart applies it: new https port, uploaded certificate, redirect that spares /iclock
  await call(base, 'system/server/restart', 'POST', {}, tok); await srv.exited; await start();
  const h2 = await sget(sp + 1, '/'); assert.equal(h2.cert.subject.CN, 'upload.test', 'the uploaded certificate is served');
  const r1 = await fetch(`${base}/`, { redirect: 'manual' }); assert.equal(r1.status, 301); assert.equal(r1.headers.get('location'), `https://localhost:${sp + 1}/`);
  const r2 = await fetch(`${base}/iclock/ping`, { redirect: 'manual' }); assert.notEqual(r2.status, 301, 'devices are not redirected');
  assert.ok(existsSync(join(dir, 'certs', 'server.key')));
  console.log('e2e-https passed: ports, automatic + uploaded certificate, validation, restart, redirect sparing devices');
} finally { srv?.kill(); rmSync(dir, { recursive: true, force: true }); }
