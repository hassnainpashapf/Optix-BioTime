import express from 'express';
import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { db, getSettings } from './db.js';
import { saveLogs } from './zk.js';
import { logEvent, ipAllowed } from './devsync.js';
import { encrypt, decrypt } from './bio.js';
import { notify } from './notify.js';
import { recordUpload, recordOp, recordCommandResult, autoApprove } from './zk-device.js';

// ZKTeco "iclock"/ADMS push protocol (what BioTime's /iclock/cdata, /getrequest, /devicecmd endpoints speak).
// The device calls us; we reply with plain text.
export const admsRouter = express.Router();

const now = () => new Date().toLocaleString('sv'); // local "YYYY-MM-DD HH:MM:SS"
const text = (res, s) => res.type('text/plain').send(s);

// Raw record of every device request. Firmware differs between models, so this is how a real-device problem gets diagnosed.
const LOG_DIR = process.env.LOG_DIR || 'logs';
admsRouter.use((req, _res, next) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const f = join(LOG_DIR, 'adms.log');
    try { if (statSync(f).size > 5e6) renameSync(f, f + '.1'); } catch {}
    const body = typeof req.body === 'string' ? req.body.slice(0, 2000).replace(/TMP=[A-Za-z0-9+/=]{40,}/gi, 'TMP=[template hidden]') : ''; // never write biometric templates to the log
    appendFileSync(f, `${now()} ${req.ip} ${req.method} ${req.originalUrl}${body ? '\n' + JSON.stringify(body) : ''}\n`);
  } catch {}
  next();
});

// Unknown serial numbers register as unapproved; their data is accepted only after the admin approves them.
function device(sn, req) {
  sn = typeof sn === 'string' ? sn.trim().slice(0, 64) : '';
  if (!sn) return null;
  let d = db.prepare('SELECT * FROM devices WHERE sn=?').get(sn);
  if (!d) {
    db.prepare('INSERT INTO devices(name, sn, approved, ip) VALUES(?,?,?,?)').run(`New device ${sn}`, sn, autoApprove() ? 1 : 0, req.ip?.replace('::ffff:', ''));
    d = db.prepare('SELECT * FROM devices WHERE sn=?').get(sn);
    logEvent(d.id, 'registered', `New device ${sn} connected from ${d.ip}. Waiting for approval.`);
  }
  if (!ipAllowed(req.ip, d.allowed_ips)) { // the serial number alone is not a secret, so a device can be tied to the addresses it really connects from
    req.blocked = true;
    const last = db.prepare("SELECT ts FROM device_events WHERE device_id=? AND kind='blocked_ip' ORDER BY id DESC LIMIT 1").get(d.id);
    if (!last || last.ts < new Date(Date.now() - 600000).toLocaleString('sv')) logEvent(d.id, 'blocked_ip', `A request for this serial number came from ${String(req.ip).replace('::ffff:', '')}, which is not on its allow-list.`);
    return null;
  }
  // remember what the device says about itself (firmware, push version, language)
  const q = req.query, info = d.info ? JSON.parse(d.info) : {};
  for (const [k, v] of Object.entries({ pushver: q.pushver, language: q.language, devicetype: q.DeviceType ?? q.devicetype, info: q.INFO })) if (v) info[k] = String(v).slice(0, 200);
  const fw = q.INFO ? String(q.INFO).split(',')[0].trim().slice(0, 60) : d.firmware;
  db.prepare("UPDATE devices SET last_seen=?, last_status='Push: online', info=?, firmware=?, ip=COALESCE(?, ip) WHERE id=?").run(now(), JSON.stringify(info), fw ?? null, d.sn && !d.ip ? req.ip?.replace('::ffff:', '') : null, d.id);
  return db.prepare('SELECT * FROM devices WHERE id=?').get(d.id);
}

// Handshake: device asks for its options. Stamps "None" make it upload everything it holds (duplicates are ignored).
admsRouter.get('/cdata', (req, res) => {
  const d = device(req.query.SN, req);
  if (!d) return res.status(req.blocked ? 403 : 400).send(req.blocked ? 'ERROR: not allowed' : 'ERROR: SN required');
  text(res, [`GET OPTION FROM: ${d.sn}`, 'ATTLOGStamp=None', 'OPERLOGStamp=None', `ErrorDelay=${d.error_delay ?? 30}`, `Delay=${d.delay ?? 10}`,
    'TransTimes=00:00;14:05', 'TransInterval=1', 'TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFACE\tUserPic', `Realtime=${d.realtime ?? 1}`, 'Encrypt=0'].join('\n') + '\n');
});

const parseKv = (line, skip) => { const o = {}; for (const p of line.slice(skip).split('\t')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1); } return o; };
const cardOf = (v) => { const c = String(v ?? '').replace(/[\[\]\s]/g, '').replace(/^0+/, ''); return /^\d+$/.test(c) ? c : null; }; // leading zeros dropped; "0" means no card // "[0001234567]" and "0" (no card) both occur

function saveTemplate(d, S, e, kind, fid, size, tmpl) {
  const enc = S.store_templates && tmpl ? encrypt(tmpl) : null; // the template itself is kept only when HR switched this on
  db.prepare(`INSERT INTO biodata(employee_id, kind, fid, size, device_id, data) VALUES(?,?,?,?,?,?)
              ON CONFLICT(employee_id, kind, fid) DO UPDATE SET size=excluded.size, device_id=excluded.device_id, received=datetime('now','localtime'), data=COALESCE(excluded.data, biodata.data)`)
    .run(e.id, kind, fid, size, d.id, enc);
}

// Data upload. ATTLOG: PIN \t time \t status \t verify ...    OPERLOG: "USER PIN=1\tName=Ali\tCard=..." and fingerprint/face lines
admsRouter.post('/cdata', (req, res) => {
  const d = device(req.query.SN, req);
  if (!d) return res.status(req.blocked ? 403 : 400).send(req.blocked ? 'ERROR: not allowed' : 'ERROR: SN required');
  if (!d.approved) { // acknowledge but do not store until approved; note it (at most every 10 minutes)
    const last = db.prepare("SELECT ts FROM device_events WHERE device_id=? AND kind='rejected_data' ORDER BY id DESC LIMIT 1").get(d.id);
    if (!last || last.ts < new Date(Date.now() - 600000).toLocaleString('sv')) logEvent(d.id, 'rejected_data', 'Data arrived from a device that is not approved yet and was ignored.');
    return text(res, 'OK: 0');
  }
  const lines = String(typeof req.body === 'string' ? req.body : '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const table = String(req.query.table || '').toUpperCase();
  let count = 0;

  if (table === 'ATTLOG') {
    const rows = [];
    for (const l of lines) {
      const f = l.split('\t');
      if (f[0] && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(f[1] ?? '')) {
        // some face-and-temperature models append "mask flag, temperature" after the usual columns (kept only when they look right)
        const t = f.length >= 9 ? Number(f[8]) : NaN;
        rows.push({ code: f[0], ts: f[1], temp_c: t >= 30 && t <= 45 ? t : null, mask: f.length >= 8 && ['0', '1'].includes(f[7]) ? Number(f[7]) : null });
      }
    }
    saveLogs(rows, d.id);
    const hot = getSettings().temp_alert_c;
    if (hot > 0) for (const r of rows.filter(r => r.temp_c !== null && r.temp_c >= hot).slice(0, 5)) {
      logEvent(d.id, 'high_temperature', `${r.code}: ${r.temp_c} °C at ${r.ts}`);
      notify({ title: `High temperature: ${r.code} ${r.temp_c} °C`, body: `${d.name}, ${r.ts}`, link: 'Devices' , kind: 'high_temp'});
    }
    count = rows.length;
  } else {
    const S = getSettings();
    const upsertUser = db.prepare(`INSERT INTO employees(code, name) VALUES(?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name WHERE employees.name LIKE 'User %'`);
    for (const l of lines) {
      if (l.startsWith('USER ')) { // names fill a placeholder; a card number enrolled on the device is adopted unless HR already set one
        const kv = parseKv(l, 5);
        if (!kv.pin) continue;
        upsertUser.run(kv.pin, kv.name || `User ${kv.pin}`); count++;
        db.prepare("INSERT INTO device_users(device_id, code, name, card) VALUES(?,?,?,?) ON CONFLICT(device_id, code) DO UPDATE SET name=excluded.name, card=excluded.card, seen=datetime('now','localtime')").run(d.id, kv.pin, kv.name || null, cardOf(kv.card));
        const card = cardOf(kv.card), e = db.prepare('SELECT id, card_no FROM employees WHERE code=?').get(kv.pin);
        if (card && e && e.card_no !== card) {
          const owner = db.prepare('SELECT code FROM employees WHERE card_no=? AND id!=?').get(card, e.id);
          if (owner) logEvent(d.id, 'card_conflict', `Card ${card} on ${kv.pin} is already assigned to ${owner.code}`);
          else if (!e.card_no) db.prepare('UPDATE employees SET card_no=? WHERE id=?').run(card, e.id);
        }
      } else if (/^(FP|FACE|BIODATA) /i.test(l)) { // enrolled fingerprints and faces: always counted, kept only when switched on
        const kind0 = l.split(' ')[0].toUpperCase(), kv = parseKv(l, kind0.length + 1), pin = kv.pin;
        const e = pin ? db.prepare('SELECT id FROM employees WHERE code=?').get(pin) : null; if (!e) continue;
        let kind = kind0 === 'FP' ? 'fp' : kind0 === 'FACE' ? 'face' : ({ 1: 'fp', 2: 'face', 9: 'face' })[kv.type];
        if (!kind) continue;
        saveTemplate(d, S, e, kind, Number(kv.fid ?? kv.index ?? kv.no ?? 0) || 0, Number(kv.size) || null, kv.tmp ?? kv.template ?? null); count++;
      }
    }
  }
  db.prepare('UPDATE devices SET last_sync=?, last_status=? WHERE id=?').run(now(), `Push: ${table || 'data'} ${count} records`, d.id);
  recordUpload(d.id, table || 'DATA', `${table || 'data'}: ${lines.length} line(s) received`, count, Math.max(0, lines.length - count));
  if (table === 'OPERLOG') for (const l of lines.filter(l => !/^(FP|FACE|BIODATA|FINGERTMP) /i.test(l)).slice(0, 50)) recordOp(d.id, 'Device', l.split(/[ \t]/)[0], (parseKv(l, l.indexOf(' ') + 1).pin ?? ''), l.replace(/(TMP|Template)=\S+/gi, '$1=[hidden]').slice(0, 200)); // biometric templates never go into a log
  text(res, `OK: ${count}`);
});

// Device polls for commands: hand over everything queued for it ("C:<id>:<command>" per line).
admsRouter.get('/getrequest', (req, res) => {
  const d = device(req.query.SN, req);
  if (req.blocked) return res.status(403).send('ERROR: not allowed');
  if (!d || !d.approved) return text(res, 'OK');
  const cmds = db.prepare("SELECT id, cmd FROM device_commands WHERE device_id=? AND status='pending' ORDER BY id LIMIT 20").all(d.id);
  for (const c of cmds) db.prepare("UPDATE device_commands SET status='sent', sent=datetime('now','localtime') WHERE id=?").run(c.id);
  const fill = (cmd) => cmd.replace(/\{\{bio:(\d+)\}\}/g, (_m, id) => { const r = db.prepare('SELECT data FROM biodata WHERE id=?').get(id); try { return r?.data ? decrypt(r.data) : ''; } catch { return ''; } });
  text(res, cmds.length ? cmds.map(c => `C:${c.id}:${fill(c.cmd)}`).join('\n') + '\n' : 'OK');
});
// Device reports command results: "ID=5&Return=0&CMD=DATA" (Return=0 means success).
admsRouter.post('/devicecmd', (req, res) => {
  const d = device(req.query.SN, req);
  if (d) for (const l of String(typeof req.body === 'string' ? req.body : '').split(/\r?\n/)) {
    const m = l.match(/ID=(\d+)&Return=(-?\d+)/);
    if (!m) continue;
    const ok = m[2] === '0', c = db.prepare('SELECT cmd FROM device_commands WHERE id=? AND device_id=?').get(m[1], d.id);
    db.prepare('UPDATE device_commands SET status=?, result=? WHERE id=? AND device_id=?').run(ok ? 'done' : 'failed', 'Return=' + m[2], m[1], d.id);
    recordCommandResult(d.id, Number(m[1]), c?.cmd, m[2]);
    if (!ok && c) logEvent(d.id, 'command_failed', `${c.cmd.split('\t')[0].slice(0, 60)} returned ${m[2]}`);
  }
  text(res, 'OK');
});
admsRouter.get('/ping', (_req, res) => text(res, 'OK'));
