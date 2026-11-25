// Fake ZKTeco device speaking the iclock/ADMS push protocol. Use it to test the server without hardware:
//   node sim-device.js http://localhost:8080 SN12345 10
import { addDays, dateStr } from './dates.js';

const TAB = '\t';
export const SIM_USERS = [
  { pin: '101', name: 'Ali Raza' },    // always on time, leaves 18:05
  { pin: '102', name: 'Sara Khan' },   // always 40 min late
  { pin: '103', name: 'Omar Farooq' }, // absent on one day
  { pin: '104', name: 'Zain Ahmed' },  // 2 h overtime every day
  { pin: '105', name: 'Hina Malik' },  // forgets to punch out on the latest day
];

// Workdays are Mon-Sat; the days list ends yesterday.
export const simDays = (n, today = dateStr(new Date())) =>
  Array.from({ length: n }, (_, i) => addDays(today, -(n - i))).filter(d => new Date(d + 'T00:00:00Z').getUTCDay() !== 0);

export function simPunches(days) {
  const rows = [];
  const last = days.at(-1), absentDay = days.at(-3);
  for (const d of days) for (const u of SIM_USERS) {
    const [i, o] = { 101: ['08:55', '18:05'], 102: ['09:40', '18:00'], 103: ['08:50', '18:10'], 104: ['08:58', '20:05'], 105: ['08:58', '18:00'] }[u.pin];
    if (u.pin === '103' && d === absentDay) continue;
    rows.push(`${u.pin}${TAB}${d} ${i}:00${TAB}0${TAB}1${TAB}0${TAB}0`);
    if (!(u.pin === '105' && d === last)) rows.push(`${u.pin}${TAB}${d} ${o}:00${TAB}1${TAB}1${TAB}0${TAB}0`);
  }
  return rows;
}

export async function runSim(base, sn, nDays = 10, log = () => {}) {
  const q = (p, extra = '') => `${base}/iclock/${p}?SN=${sn}${extra}`;
  const send = async (url, body) => {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    const t = await r.text(); log(`${body === undefined ? 'GET ' : 'POST'} ${url.replace(base, '')} -> ${t.trim().split('\n')[0]}`); return t;
  };
  await send(q('cdata', '&options=all&pushver=2.4.1'));
  await send(q('cdata', '&table=OPERLOG&Stamp=1'), SIM_USERS.map(u => `USER PIN=${u.pin}${TAB}Name=${u.name}${TAB}Pri=0${TAB}Passwd=${TAB}Card=${TAB}Grp=1`).join('\n'));
  const att = simPunches(simDays(nDays));
  const res = await send(q('cdata', '&table=ATTLOG&Stamp=1'), att.join('\n'));
  await send(q('getrequest'));
  return { sent: att.length, reply: res.trim() };
}

// A fake device that behaves like a real push device: it polls for commands, carries them out and reports back.
// It lets the server's device features be tested without hardware (it follows our reading of the protocol, not a real device).
export class SimDevice {
  constructor(base, sn, { info = 'Ver 6.60 Sep 2019,0,0,0,192.168.1.201' } = {}) {
    Object.assign(this, { base, sn, info, users: new Map(), templates: [], punches: [], rebooted: 0, clock: null, failCommands: [], seen: [] });
  }
  async req(path, body, query = '') {
    const r = await fetch(`${this.base}/iclock/${path}?SN=${this.sn}${query}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    return { status: r.status, text: await r.text(), date: r.headers.get('date') };
  }
  handshake() { return this.req('cdata', undefined, '&options=all&pushver=2.4.1&language=69&DeviceType=att'); }
  upload(table, lines) { return this.req('cdata', lines.join('\n'), `&table=${table}&Stamp=1`); }
  uploadUsers() { return this.upload('OPERLOG', [...this.users].map(([pin, u]) => `USER PIN=${pin}${TAB}Name=${u.name}${TAB}Pri=0${TAB}Passwd=${TAB}Card=${u.card ? '[' + u.card.padStart(10, '0') + ']' : '0'}${TAB}Grp=1`)); }
  uploadTemplates() { return this.upload('OPERLOG', this.templates.map(t => t.kind === 'fp' ? `FP PIN=${t.pin}${TAB}FID=${t.fid}${TAB}Size=${t.tmpl.length}${TAB}Valid=1${TAB}TMP=${t.tmpl}` : `BIODATA Pin=${t.pin}${TAB}No=${t.fid}${TAB}Index=0${TAB}Valid=1${TAB}Type=9${TAB}Format=0${TAB}Tmp=${t.tmpl}`)); }
  uploadPunches(rows = this.punches) { return this.upload('ATTLOG', rows.map(p => `${p.pin}${TAB}${p.ts}${TAB}0${TAB}1${TAB}0${TAB}0${p.mask != null || p.temp != null ? `${TAB}0${TAB}${p.mask ?? ''}${TAB}${p.temp ?? ''}` : ''}`)); }
  kv(cmd) { const o = {}; for (const p of cmd.split(TAB)) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1); } return o; }
  async run(cmd) {
    if (this.failCommands.some(f => cmd.startsWith(f))) return -1;
    if (cmd.startsWith('DATA UPDATE USERINFO')) { const k = this.kv(cmd.slice(21)); this.users.set(k.pin, { name: k.name, card: k.card || '' }); return 0; }
    if (cmd.startsWith('DATA DELETE USERINFO')) { const pin = this.kv(cmd.slice(21)).pin; this.users.delete(pin); this.templates = this.templates.filter(t => t.pin !== pin); return 0; }
    if (/^DATA UPDATE (FINGERTMP|FACE)/.test(cmd)) { const k = this.kv(cmd.slice(cmd.indexOf(' ', 12) + 1)); this.templates.push({ kind: cmd.includes('FINGERTMP') ? 'fp' : 'face', pin: k.pin, fid: +k.fid, tmpl: k.tmp }); return 0; }
    if (cmd.startsWith('ENROLL_FP')) { const k = this.kv(cmd.slice(10)); this.enrolled = { pin: k.pin, fid: +k.fid, retry: +k.retry, overwrite: k.overwrite }; this.templates = this.templates.filter(t => !(t.kind === 'fp' && t.pin === k.pin && t.fid === +k.fid)); this.templates.push({ kind: 'fp', pin: k.pin, fid: +k.fid, tmpl: Buffer.from('SIMFP-' + k.pin + '-' + k.fid + '-' + 'x'.repeat(40)).toString('base64') }); return 0; }
    if (cmd.startsWith('DATA DELETE FINGERTMP')) { const k = this.kv(cmd.slice(22)); this.templates = this.templates.filter(t => !(t.kind === 'fp' && t.pin === k.pin && (k.fid === undefined || t.fid === +k.fid))); return 0; }
    if (cmd === 'REBOOT') { this.rebooted++; return 0; }
    if (cmd.startsWith('SET OPTION DateTime=')) { this.clock = cmd.slice(20); return 0; }
    if (cmd.startsWith('DATA QUERY ATTLOG')) { const k = this.kv(cmd.slice(18)); await this.uploadPunches(this.punches.filter(p => p.ts >= k.starttime && p.ts <= k.endtime)); return 0; }
    if (cmd.startsWith('DATA QUERY tablename=USERINFO')) { await this.uploadUsers(); return 0; }
    return -1; // not supported
  }
  // one check-in with the server: fetch commands, run them, report each result
  async poll() {
    const r = await this.req('getrequest', undefined, `&INFO=${encodeURIComponent(this.info)}`), done = [];
    for (const line of r.text.split('\n').filter(l => l.startsWith('C:'))) {
      const m = line.match(/^C:(\d+):([\s\S]*)$/), cmd = m[2]; this.seen.push(cmd);
      const ret = await this.run(cmd); await this.req('devicecmd', `ID=${m[1]}&Return=${ret}&CMD=${cmd.split(' ')[0]}`); done.push({ id: +m[1], ret });
    }
    return done;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [base = 'http://localhost:8080', sn = 'SIM0001', days = '10'] = process.argv.slice(2);
  console.log(await runSim(base, sn, +days, console.log));
}
