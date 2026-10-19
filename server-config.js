// How the server listens: HTTP and/or HTTPS, each on a port the administrator chooses (like the options of the ZKTeco installer).
// Kept in a small file next to the database (server.json) because it is needed before the database and the web server start.
// Environment variables still work and win: PORT, HTTPS_PORT, TLS_CERT + TLS_KEY.
import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces, hostname } from 'node:os';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { makeSelfSigned } from './selfsigned.js';

const DB = process.env.DB_FILE || 'biotime.db', DIR = dirname(DB) === '.' ? '.' : dirname(DB);
export const CONFIG_FILE = process.env.SERVER_CONFIG || join(DIR, 'server.json'), CERT_DIR = process.env.CERT_DIR || join(DIR, 'certs');
export const DEFAULTS = { http: { enabled: true, port: 8080 }, https: { enabled: false, port: 8443, source: 'auto', host: '' }, redirect: false };
const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

export function readConfig() {
  let f = {}; try { f = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { /* none yet */ }
  return { http: { ...DEFAULTS.http, ...(f.http ?? {}) }, https: { ...DEFAULTS.https, ...(f.https ?? {}) }, redirect: !!f.redirect };
}
// what the server really uses: the file, then the environment on top
export function effectiveConfig() {
  const c = readConfig();
  if (process.env.PORT) c.http = { enabled: true, port: Number(process.env.PORT) };
  if (process.env.TLS_CERT && process.env.TLS_KEY) c.https = { ...c.https, enabled: true, port: Number(process.env.HTTPS_PORT) || c.https.port || 8443, source: 'files', certFile: process.env.TLS_CERT, keyFile: process.env.TLS_KEY };
  if (!c.http.enabled && !c.https.enabled) c.http.enabled = true;   // never leave the server with no way in
  return c;
}
export const lanAddresses = () => Object.values(networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
const certPaths = (kind) => ({ cert: join(CERT_DIR, kind + '.crt'), key: join(CERT_DIR, kind + '.key') });

// the certificate + key the HTTPS listener should use (made on first use when the choice is "auto")
export function httpsCredentials(c = effectiveConfig()) {
  if (c.https.source === 'files') return { cert: readFileSync(c.https.certFile), key: readFileSync(c.https.keyFile) };
  mkdirSync(CERT_DIR, { recursive: true });
  const p = certPaths(c.https.source === 'upload' ? 'server' : 'auto');
  if (c.https.source === 'upload') { if (!existsSync(p.cert) || !existsSync(p.key)) throw new Error('No uploaded certificate found'); return { cert: readFileSync(p.cert), key: readFileSync(p.key) }; }
  const hosts = [c.https.host, hostname(), ...lanAddresses()].filter(Boolean);
  if (!existsSync(p.cert) || !existsSync(p.key) || !sameHosts(p.cert, hosts)) { const r = makeSelfSigned({ hosts }); writeFileSync(p.cert, r.cert); writeFileSync(p.key, r.key, { mode: 0o600 }); }
  return { cert: readFileSync(p.cert), key: readFileSync(p.key) };
}
const sameHosts = (certFile, hosts) => { try { const san = new X509Certificate(readFileSync(certFile)).subjectAltName ?? ''; return hosts.every(h => san.includes(h)); } catch { return false; } };
export const certInfo = (c = effectiveConfig()) => { try { const x = new X509Certificate(httpsCredentials(c).cert); return { subject: x.subject.replace(/\n/g, ', '), names: x.subjectAltName, valid_to: x.validTo, self_signed: x.subject === x.issuer }; } catch { return null; } };

// HTTP handler: normal app, or (when asked) a redirect to https that leaves the device paths alone, because devices push over plain http
export const httpHandler = (app, c) => (req, res, next) => {
  if (c.redirect && c.https.enabled && !/^\/(iclock|adms)(\/|$)/i.test(req.url)) { const host = String(req.headers.host ?? 'localhost').replace(/:\d+$/, ''); res.writeHead(301, { Location: `https://${host}${c.https.port === 443 ? '' : ':' + c.https.port}${req.url}` }); return res.end(); }
  return app(req, res, next);
};

function validate(b) {
  const o = { http: { enabled: !!b?.http?.enabled, port: Number(b?.http?.port) }, https: { enabled: !!b?.https?.enabled, port: Number(b?.https?.port), source: b?.https?.source === 'upload' ? 'upload' : 'auto', host: String(b?.https?.host ?? '').trim().slice(0, 100) }, redirect: !!b?.redirect };
  if (!o.http.enabled && !o.https.enabled) throw new Error('Switch on HTTP or HTTPS (or both)');
  if (o.http.enabled && !isPort(o.http.port)) throw new Error('HTTP port must be a number from 1 to 65535');
  if (o.https.enabled && !isPort(o.https.port)) throw new Error('HTTPS port must be a number from 1 to 65535');
  if (o.http.enabled && o.https.enabled && o.http.port === o.https.port) throw new Error('HTTP and HTTPS need different ports');
  if (!isPort(o.http.port)) o.http.port = DEFAULTS.http.port; if (!isPort(o.https.port)) o.https.port = DEFAULTS.https.port;
  if (o.redirect && !o.https.enabled) throw new Error('Redirect to HTTPS needs HTTPS switched on');
  if (o.https.host && !/^[A-Za-z0-9.-]{1,100}$/.test(o.https.host)) throw new Error('Host name: letters, digits, dots and dashes only');
  return o;
}
function saveUpload(certPem, keyPem) {
  let x, k; try { x = new X509Certificate(certPem); } catch { throw new Error('The certificate is not a valid PEM certificate'); } try { k = createPrivateKey(keyPem); } catch { throw new Error('The private key is not a valid PEM key (it must not need a password)'); }
  if (!x.checkPrivateKey(k)) throw new Error('The private key does not belong to this certificate');
  if (new Date(x.validTo) < new Date()) throw new Error('This certificate has expired');
  mkdirSync(CERT_DIR, { recursive: true }); const p = certPaths('server'); writeFileSync(p.cert, certPem); writeFileSync(p.key, keyPem, { mode: 0o600 });
}

export const serverConfigRouter = express.Router();
const RUNNING = effectiveConfig();   // what this process started with
serverConfigRouter.get('/system/server', (_q, res) => {
  const norm = (c) => ({ http: { enabled: !!c.http.enabled, port: +c.http.port }, https: { enabled: !!c.https.enabled, port: +c.https.port, source: c.https.source, host: c.https.host || '' }, redirect: !!c.redirect });
  const f = readConfig(), envLocked = !!(process.env.PORT || process.env.TLS_CERT), restart = !envLocked && JSON.stringify(norm(f)) !== JSON.stringify(norm(RUNNING));
  res.json({ config: f, running: { http: RUNNING.http.enabled ? RUNNING.http.port : null, https: RUNNING.https.enabled ? RUNNING.https.port : null }, restart_needed: restart, env_locked: envLocked, addresses: lanAddresses(), cert: f.https.enabled || RUNNING.https.enabled ? certInfo(f.https.source === 'files' ? RUNNING : { ...f }) : null, has_upload: existsSync(certPaths('server').cert) });
});
serverConfigRouter.put('/system/server', (req, res) => {
  try {
    const o = validate(req.body);
    if (o.https.enabled && o.https.source === 'upload') { if (req.body?.cert && req.body?.key) saveUpload(String(req.body.cert), String(req.body.key)); else if (!existsSync(certPaths('server').cert)) throw new Error('Paste or choose the certificate and the private key'); }
    mkdirSync(dirname(CONFIG_FILE) || '.', { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(o, null, 2));
    res.json({ ok: true, restart_needed: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
serverConfigRouter.post('/system/server/restart', (_q, res) => { res.json({ ok: true, message: 'The server is restarting. It comes back by itself if it runs as a service.' }); res.on('finish', () => setTimeout(() => process.exit(0), 300)); });
