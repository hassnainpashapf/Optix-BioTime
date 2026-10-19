import express from 'express';
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createConnection } from 'node:net';
import { db } from './db.js';
import { CATALOG } from './reports.js';
import { makeXlsx } from './xlsx.js';
import { makePdf } from './pdf.js';
import { toCsvCols, csvCell } from './csv.js';
import { sysLog } from './zk-log.js';

// Integration (scheduled exports to files) and Middleware tables (rows submitted here are applied to the real tables by a processor).
export const integrationRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const txt = (v, n = 200) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger))].slice(0, 2000);
const stamp = (d = new Date()) => d.toLocaleString('sv');
const ymd = (d) => d.toLocaleDateString('sv');
const EXPORT_DIR = () => process.env.EXPORT_DIR || join('data', 'exports');

// ======================= export tasks =======================
db.exec(`CREATE TABLE IF NOT EXISTS zk_exports(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, code TEXT, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, file_prefix TEXT NOT NULL DEFAULT '{cur_date}', format TEXT NOT NULL DEFAULT 'csv',
  template TEXT, query_field INTEGER NOT NULL DEFAULT 3, policy INTEGER NOT NULL DEFAULT 1, interval_min INTEGER NOT NULL DEFAULT 0, frequency INTEGER NOT NULL DEFAULT 0, month_day INTEGER NOT NULL DEFAULT 1, week_day INTEGER NOT NULL DEFAULT 1,
  export_time TEXT NOT NULL DEFAULT '00:01', period INTEGER NOT NULL DEFAULT 1, export_type INTEGER NOT NULL DEFAULT 1, path TEXT, ftp_id INTEGER, ftp_path TEXT, report_type TEXT, report_template INTEGER, contains_heads INTEGER NOT NULL DEFAULT 1,
  last_run TEXT, last_log_id INTEGER NOT NULL DEFAULT 0, last_status TEXT, last_file TEXT);`);
export const DEFAULT_TEMPLATE = '{emp_code}\\t{first_name}\\t{last_name}\\t{dept_code}\\t{dept_name}\\t{date}\\t{time}\\t{verify_type}\\t{punch_state}\\t{work_code}\\t{card_number}\\t{area_name}\\t{terminal_alias}\\t{terminal_sn}\\n';
const TOKENS = ['emp_code', 'first_name', 'last_name', 'dept_code', 'dept_name', 'date', 'time', 'verify_type', 'punch_state', 'work_code', 'card_number', 'area_name', 'terminal_alias', 'terminal_sn'];
const FORMATS = { tx: ['xls', 'csv', 'txt'], report: ['xls', 'csv', 'txt', 'pdf'] };
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);

function cleanTask(kind, b, old) {
  const o = {}; const get = (k, d) => (k in b ? b[k] : old?.[k] ?? d);
  o.name = txt(get('name', null) ?? b.task_name, 80); if (!o.name) return { error: 'Name required' };
  o.enabled = get('enabled', 1) && get('enabled', 1) !== '0' ? 1 : 0;
  o.file_prefix = txt(get('file_prefix', kind === 'tx' ? '{cur_date}' : '{report_template}_{cur_date}'), 100); if (!o.file_prefix) return { error: 'File Name required' };
  o.format = String(get('format', 'csv')); if (!FORMATS[kind].includes(o.format)) return { error: `File Format must be one of ${FORMATS[kind].join(', ')}` };
  o.query_field = Number(get('query_field', 3)); if (![1, 2, 3].includes(o.query_field)) return { error: 'Unknown Filter By' };
  o.policy = Number(get('policy', 1)); if (![1, 2].includes(o.policy)) return { error: 'Export Policy is By Timing or By Interval' };
  o.interval_min = Number(get('interval_min', 0)); if (o.policy === 2 && !(Number.isInteger(o.interval_min) && o.interval_min >= 1 && o.interval_min <= 44640)) return { error: 'Interval is 1 to 44640 minutes' };
  o.frequency = Number(get('frequency', 0)); if (![0, 1, 2].includes(o.frequency)) return { error: 'Frequency is Daily, Weekly or Monthly' };
  o.month_day = Number(get('month_day', 1)); if (!(Number.isInteger(o.month_day) && o.month_day >= 1 && o.month_day <= 28)) return { error: 'Day of the month is 1 to 28' };
  o.week_day = Number(get('week_day', 1)); if (!(Number.isInteger(o.week_day) && o.week_day >= 0 && o.week_day <= 6)) return { error: 'Unknown weekday' };
  o.export_time = String(get('export_time', '00:01')); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(o.export_time)) return { error: 'Export Time is HH:MM' };
  o.period = Number(get('period', 1)) ? 1 : 0; o.export_type = Number(get('export_type', 1)) === 2 ? 2 : 1;
  const path = String(get('path', kind === 'tx' ? 'AutoExport' : 'AutoAttExport') ?? '').replace(/\\/g, '/').split('/').filter(Boolean); if (path.some(s => s === '..' || !/^[\w .-]+$/.test(s))) return { error: 'Export Path: folder names with letters, digits, spaces, . _ - only' }; o.path = path.join('/');
  o.ftp_id = get('ftp_id', null) ? Number(get('ftp_id', null)) : null; if (o.ftp_id && !db.prepare('SELECT 1 FROM zk_ftp WHERE id=?').get(o.ftp_id)) return { error: 'Unknown FTP server' };
  o.ftp_path = txt(get('ftp_path', null), 200); o.contains_heads = get('contains_heads', 1) && get('contains_heads', 1) !== '0' ? 1 : 0;
  if (kind === 'tx') { o.template = String(get('template', null) ?? b.data_template ?? DEFAULT_TEMPLATE).slice(0, 2000); if (!/\{(\w+)\}/.test(o.template)) return { error: 'Data Template needs at least one {field}' }; const bad = [...o.template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).find(t => !TOKENS.includes(t)); if (bad) return { error: `Unknown field {${bad}} in the Data Template` }; o.report_type = null; o.report_template = null; }
  else { o.report_type = String(get('report_type', '')); if (!CATALOG[o.report_type]) return { error: 'Choose a Report Type' }; o.report_template = get('report_template', null) ? Number(get('report_template', null)) : null;
    if (o.report_template && !db.prepare('SELECT 1 FROM saved_reports WHERE id=? AND type=?').get(o.report_template, o.report_type)) return { error: 'That Report Template is not for this report type' }; o.template = null; }
  return { o };
}
const taskRow = (r) => ({ ...r, export_by: ['', 'Punch Time', 'Upload Time', 'Flag'][r.query_field], format_label: { xls: 'Excel', csv: 'Csv', txt: 'Txt', pdf: 'PDF' }[r.format] ?? r.format, report_type_label: r.report_type ? CATALOG[r.report_type]?.title ?? r.report_type : '',
  template_name: r.report_template ? db.prepare('SELECT name FROM saved_reports WHERE id=?').get(r.report_template)?.name ?? '' : '', ftp: r.ftp_id ? db.prepare('SELECT host FROM zk_ftp WHERE id=?').get(r.ftp_id)?.host ?? '' : '' });
const kindOf = (req) => (req.params.kind === 'report' ? 'report' : req.params.kind === 'tx' ? 'tx' : null);
integrationRouter.get('/zk/exports-meta', (_q, res) => res.json({ tokens: TOKENS, default_template: DEFAULT_TEMPLATE, reports: Object.entries(CATALOG).map(([id, d]) => ({ id, title: d.title })), templates: db.prepare('SELECT id, name, type FROM saved_reports ORDER BY name').all() }));
integrationRouter.get('/zk/exports/:kind', (req, res) => { const k = kindOf(req); if (!k) return fail(res, 'Unknown task kind', 404); res.json(db.prepare('SELECT * FROM zk_exports WHERE kind=? ORDER BY id').all(k).map(taskRow)); });
integrationRouter.post('/zk/exports/:kind', (req, res) => {
  const k = kindOf(req); if (!k) return fail(res, 'Unknown task kind', 404); const { o, error } = cleanTask(k, req.body ?? {}); if (error) return fail(res, error);
  const n = db.prepare('SELECT COUNT(*) n FROM zk_exports WHERE kind=?').get(k).n + 1, code = `${k === 'tx' ? 'TX' : 'RP'}${String(n).padStart(3, '0')}`; const c = Object.keys(o);
  const id = Number(db.prepare(`INSERT INTO zk_exports(kind, code, ${c}) VALUES(?,?,${c.map(() => '?')})`).run(k, code, ...c.map(x => o[x])).lastInsertRowid); db.prepare('UPDATE zk_exports SET code=? WHERE id=?').run(`${k === 'tx' ? 'TX' : 'RP'}${String(id).padStart(3, '0')}`, id); res.json({ id });
});
integrationRouter.put('/zk/exports/:kind/:id', (req, res) => {
  const k = kindOf(req), old = db.prepare('SELECT * FROM zk_exports WHERE id=? AND kind=?').get(req.params.id, k); if (!old) return fail(res, 'No such task', 404);
  const { o, error } = cleanTask(k, req.body ?? {}, old); if (error) return fail(res, error); const c = Object.keys(o); db.prepare(`UPDATE zk_exports SET ${c.map(x => x + '=?')} WHERE id=?`).run(...c.map(x => o[x]), old.id); res.json({ ok: true });
});
integrationRouter.delete('/zk/exports/:kind/:id', (req, res) => { db.prepare('DELETE FROM zk_exports WHERE id=? AND kind=?').run(req.params.id, kindOf(req)); res.json({ ok: true }); });
integrationRouter.post('/zk/exports/:kind/enable', (req, res) => { const l = ids(req.body?.ids); if (!l.length) return fail(res, 'Choose at least one task'); let n = 0; for (const id of l) n += Number(db.prepare('UPDATE zk_exports SET enabled=? WHERE id=? AND kind=?').run(req.body?.enable ? 1 : 0, id, kindOf(req)).changes); res.json({ updated: n }); });
integrationRouter.post('/zk/exports/:kind/:id/run', async (req, res) => { // Manual Export
  const t = db.prepare('SELECT * FROM zk_exports WHERE id=? AND kind=?').get(req.params.id, kindOf(req)); if (!t) return fail(res, 'No such task', 404);
  const D = /^\d{4}-\d\d-\d\d$/, b = req.body ?? {}, from = b.from || ymd(new Date()), to = b.to || from; if (!D.test(from) || !D.test(to) || from > to) return fail(res, 'Dates are YYYY-MM-DD, from not after to');
  if (Date.parse(to) - Date.parse(from) > 366 * 86400000) return fail(res, 'At most one year at a time');
  try { res.json(await runExport(t, { from, to, manual: true })); } catch (e) { fail(res, 'Export failed: ' + e.message, 500); }
});
integrationRouter.post('/zk/exports-tick', async (_q, res) => res.json({ ran: await exportTick() })); // run every enabled task that is due right now
integrationRouter.get('/zk/exports/:kind/:id/files', (req, res) => {
  const t = db.prepare('SELECT * FROM zk_exports WHERE id=? AND kind=?').get(req.params.id, kindOf(req)); if (!t) return fail(res, 'No such task', 404); const dir = join(EXPORT_DIR(), t.path || '');
  res.json(existsSync(dir) ? readdirSync(dir).filter(f => statSync(join(dir, f)).isFile()).map(f => ({ name: f, size: statSync(join(dir, f)).size, time: statSync(join(dir, f)).mtime.toLocaleString('sv') })).sort((a, b) => b.time.localeCompare(a.time)) : []);
});
integrationRouter.get('/zk/exports/:kind/:id/files/:name', (req, res) => {
  const t = db.prepare('SELECT * FROM zk_exports WHERE id=? AND kind=?').get(req.params.id, kindOf(req)); if (!t) return fail(res, 'No such task', 404);
  const dir = resolve(join(EXPORT_DIR(), t.path || '')), f = resolve(join(dir, req.params.name)); if (!f.startsWith(dir + sep) || !existsSync(f)) return fail(res, 'No such file', 404); res.download(f);
});

const unesc = (s) => s.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
function txRows(t, from, to) { // punches as export rows
  const hasDeptCode = hasCol('departments', 'code'), hasAreaCode = hasCol('branches', 'code'); void hasAreaCode;
  const where = [], args = [];
  if (t.query_field === 3 || t.export_type === 2) { where.push('l.id > ?'); args.push(t.last_log_id); }
  if (t.query_field !== 3 || t.manual) { where.push('l.ts BETWEEN ? AND ?'); args.push(from + ' 00:00:00', to + ' 23:59:59'); }
  const rows = db.prepare(`SELECT l.id, l.emp_code, l.ts, l.source, e.name, e.card_no, d.name AS dept, ${hasDeptCode ? 'd.code' : "''"} AS dept_code, b.name AS area, v.name AS dev_name, v.sn AS dev_sn
    FROM logs l LEFT JOIN employees e ON e.code=l.emp_code LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN devices v ON v.id=l.device_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id LIMIT 200000`).all(...args);
  return rows.map(r => { const [first, ...rest] = String(r.name ?? '').split(' '); return { id: r.id, emp_code: r.emp_code, first_name: first ?? '', last_name: rest.join(' '), dept_code: r.dept_code ?? '', dept_name: r.dept ?? '', date: r.ts.slice(0, 10), time: r.ts.slice(11, 19), verify_type: r.source ?? '', punch_state: '', work_code: '', card_number: r.card_no ?? '', area_name: r.area ?? '', terminal_alias: r.dev_name ?? '', terminal_sn: r.dev_sn ?? '' }; });
}
const fileName = (t, ext, tplName) => { const n = new Date(), p = (x) => String(x).padStart(2, '0'); const s = t.file_prefix.replace(/\{cur_date\}/g, `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}`).replace(/\{cur_time\}/g, `${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`).replace(/\{report_template\}/g, tplName || t.report_type || 'report').replace(/[^\w.-]+/g, '_'); return `${s}.${ext}`; };
export async function runExport(t, { from, to, manual = false } = {}) {
  const dir = join(EXPORT_DIR(), t.path || ''); mkdirSync(dir, { recursive: true }); let buf, ext = t.format === 'xls' ? 'xlsx' : t.format, count = 0, maxId = t.last_log_id, tplName = '';
  try {
    if (t.kind === 'tx') {
      const rows = txRows({ ...t, manual }, from, to); count = rows.length; maxId = rows.reduce((m, r) => Math.max(m, r.id), t.last_log_id); const toks = [...t.template.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
      if (t.format === 'txt') buf = Buffer.from(rows.map(r => unesc(t.template).replace(/\{(\w+)\}/g, (_m, k) => r[k] ?? '')).join(''));
      else { const cols = toks.map(k => ({ key: k, label: k })); buf = t.format === 'xls' ? makeXlsx({ title: 'Transactions', columns: cols, rows }) : Buffer.from('﻿' + (t.contains_heads ? toCsvCols(cols, rows) : rows.map(r => cols.map(c => csvCell(r[c.key])).join(',')).join('\n'))); }
    } else {
      const def = CATALOG[t.report_type]; if (!def) throw new Error('The report type no longer exists'); let params = {}, tpl = null;
      if (t.report_template) { tpl = db.prepare('SELECT * FROM saved_reports WHERE id=?').get(t.report_template); if (tpl) { params = JSON.parse(tpl.params || '{}'); tplName = tpl.name; } }
      const out = def.run({ ...params, from, to, month: from.slice(0, 7) }); count = out.rows.length; const r = { title: def.title, subtitle: `${from} to ${to}`, columns: out.columns, rows: out.rows };
      buf = t.format === 'xls' ? makeXlsx(r) : t.format === 'pdf' ? Buffer.from(makePdf(r)) : t.format === 'txt' ? Buffer.from((t.contains_heads ? r.columns.map(c => c.label).join('\t') + '\n' : '') + r.rows.map(x => r.columns.map(c => String(x[c.key] ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n') + '\n') : Buffer.from('﻿' + (t.contains_heads ? toCsvCols(r.columns, r.rows) : r.rows.map(x => r.columns.map(c => csvCell(x[c.key])).join(',')).join('\n')));
    }
    let name = fileName(t, ext, tplName), file = join(dir, name); if (existsSync(file)) { name = name.replace(/(\.\w+)$/, `_${new Date().toLocaleTimeString('sv').replace(/:/g, '')}$1`); file = join(dir, name); }
    writeFileSync(file, buf); let ftp = '';
    if (t.ftp_id) { const s = db.prepare('SELECT * FROM zk_ftp WHERE id=?').get(t.ftp_id); if (!s) ftp = 'FTP server was deleted'; else if (s.is_sftp) ftp = 'SFTP upload is not supported, the file stays on the server'; else { try { await ftpUpload(s, buf, (t.ftp_path ? t.ftp_path.replace(/\/+$/, '') + '/' : '') + name); ftp = 'uploaded'; } catch (e) { ftp = 'FTP upload failed: ' + e.message; } } }
    db.prepare('UPDATE zk_exports SET last_run=?, last_log_id=?, last_status=?, last_file=? WHERE id=?').run(stamp(), manual && t.query_field !== 3 && t.export_type !== 2 ? t.last_log_id : maxId, ftp.startsWith('FTP upload failed') ? 'Failed' : 'Success', name, t.id);
    sysLog(`${manual ? 'Manual' : 'Auto'} export ${t.code}`, ftp.startsWith('FTP upload failed') ? 'Failed' : 'Success', `${name}: ${count} row(s)${ftp ? '; ' + ftp : ''}`); return { file: name, path: file, rows: count, ftp: ftp || null };
  } catch (e) { db.prepare("UPDATE zk_exports SET last_run=?, last_status='Failed' WHERE id=?").run(stamp(), t.id); sysLog(`${manual ? 'Manual' : 'Auto'} export ${t.code}`, 'Failed', e.message); throw e; }
}
// minimal passive-mode FTP upload (plain FTP only)
function ftpUpload(s, buf, remote) {
  return new Promise((ok, no) => {
    const ctl = createConnection({ host: s.host, port: s.port }); ctl.setTimeout(10000, () => fin(new Error('timeout'))); let data = '', step = 0, dsock = null, uploaded = false, done = false;
    const fin = (e) => { if (done) return; done = true; ctl.destroy(); dsock?.destroy(); e ? no(e) : ok(); }, send = (c) => ctl.write(c + '\r\n');
    ctl.on('error', fin); ctl.on('close', () => fin(uploaded ? null : new Error('connection closed')));
    ctl.on('data', (d) => { data += d; let m; while ((m = data.match(/^(\d{3})([ -])[^\n]*\n/m)) && (data = data.slice(m.index + m[0].length), true)) { if (m[2] === '-') continue; const code = Number(m[1]);
      if (step === 0) { if (code !== 220) return fin(new Error('server said ' + code)); send('USER ' + s.username); step = 1; }
      else if (step === 1) { if (code === 331) { send('PASS ' + (s.password ?? '')); step = 2; } else if (code === 230) { send('TYPE I'); step = 3; } else return fin(new Error('login refused')); }
      else if (step === 2) { if (code !== 230) return fin(new Error('login refused')); send('TYPE I'); step = 3; }
      else if (step === 3) { send('PASV'); step = 4; }
      else if (step === 4) { const p = m[0].match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/); if (code !== 227 || !p) return fin(new Error('passive mode refused')); dsock = createConnection({ host: s.host, port: Number(p[5]) * 256 + Number(p[6]) }); dsock.on('error', fin);
        dsock.once('connect', () => { send('STOR ' + remote); step = 5; }); dsock.on('close', () => {}); }
      else if (step === 5) { if (code === 150 || code === 125) { dsock.end(buf); step = 6; } else return fin(new Error('server refused the file (' + code + ')')); }
      else if (step === 6) { if (code === 226 || code === 250) { uploaded = true; send('QUIT'); step = 7; } else return fin(new Error('upload failed (' + code + ')')); } } });
  });
}
// window of data a scheduled run covers
export function windowOf(t, at) {
  const day = (n) => { const d = new Date(at); d.setDate(d.getDate() + n); return ymd(d); };
  if (t.policy === 2) { const from = t.last_run ? t.last_run.slice(0, 10) : day(0); return { from, to: ymd(at) }; }
  if (t.frequency === 0) return t.period ? { from: day(-1), to: day(-1) } : { from: day(-1), to: day(0) };
  if (t.frequency === 1) { if (!t.period) return { from: day(-7), to: day(0) }; const dow = (at.getDay() + 6) % 7; return { from: day(-dow - 7), to: day(-dow - 1) }; }
  if (!t.period) return { from: day(-30), to: day(0) }; const first = new Date(at.getFullYear(), at.getMonth() - 1, 1), last = new Date(at.getFullYear(), at.getMonth(), 0); return { from: ymd(first), to: ymd(last) };
}
export function isDue(t, at = new Date()) {
  if (!t.enabled) return false; const last = t.last_run ? Date.parse(t.last_run.replace(' ', 'T')) : null;
  if (t.policy === 2) return !last || at.getTime() - last >= t.interval_min * 60000;
  const hm = at.toLocaleTimeString('sv').slice(0, 5); if (hm < t.export_time) return false; const lastDay = t.last_run?.slice(0, 10), today = ymd(at);
  if (lastDay === today) return false; if (t.frequency === 1) return (at.getDay() + 6) % 7 === t.week_day; if (t.frequency === 2) return at.getDate() === t.month_day; return true;
}
let running = false;
export async function exportTick(at = new Date()) {
  if (running) return 0; running = true; let n = 0;
  try { for (const t of db.prepare('SELECT * FROM zk_exports WHERE enabled=1').all()) if (isDue(t, at)) { try { await runExport(t, windowOf(t, at)); n++; } catch {} } } finally { running = false; }
  return n;
}

// ======================= middleware tables =======================
db.exec(`CREATE TABLE IF NOT EXISTS zk_mw(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, code TEXT, name TEXT, data TEXT, submit_time TEXT NOT NULL, flag INTEGER NOT NULL DEFAULT 0, target_time TEXT, status TEXT NOT NULL DEFAULT 'Pending', message TEXT);`);
const MW = { dept: 'department', pos: 'position', area: 'area', emp: 'employee' };
const EMP_FIELDS = ['first_name', 'last_name', 'dept_code', 'dept_name', 'pos_code', 'pos_name', 'area_code', 'area_name', 'multi_area', 'card_no', 'hired_date', 'gender', 'birthday', 'email', 'active'];
const mwRow = (r) => ({ id: r.id, code: r.code, name: r.name, ...(r.data ? JSON.parse(r.data) : {}), submit_time: r.submit_time, flag: r.flag, flag_label: r.flag ? 'Delete' : 'Add/Update', target_time: r.target_time ?? '', status: r.status === 'Failed' ? `Failed: ${r.message ?? ''}` : r.status, state: r.status });
integrationRouter.get('/zk/mw/:kind', (req, res) => { if (!MW[req.params.kind]) return fail(res, 'Unknown middleware table', 404); res.json(db.prepare('SELECT * FROM zk_mw WHERE kind=? ORDER BY id DESC LIMIT 2000').all(req.params.kind).map(mwRow)); });
integrationRouter.post('/zk/mw/:kind', (req, res) => {
  const k = req.params.kind; if (!MW[k]) return fail(res, 'Unknown middleware table', 404); const b = req.body ?? {}, code = txt(b.code, 40), name = txt(b.name, 100), flag = b.flag == 1 || b.flag === 'delete' ? 1 : 0;
  if (!code) return fail(res, `${k === 'emp' ? 'Employee ID' : MW[k][0].toUpperCase() + MW[k].slice(1) + ' Code'} required`); if (!flag && !name && k !== 'emp') return fail(res, `${MW[k][0].toUpperCase() + MW[k].slice(1)} Name required`);
  let data = null; if (k === 'emp') { if (!flag && !txt(b.first_name, 60)) return fail(res, 'First Name required'); const d = {}; for (const f of EMP_FIELDS) if (b[f] !== undefined && b[f] !== null && b[f] !== '') d[f] = String(b[f]).slice(0, 120);
    for (const f of ['hired_date', 'birthday']) if (d[f] && !/^\d{4}-\d\d-\d\d$/.test(d[f])) return fail(res, `${f === 'hired_date' ? 'Hired Date' : 'Birthday'} must be YYYY-MM-DD`); if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return fail(res, 'Enter a valid email address'); data = JSON.stringify(d); }
  const id = Number(db.prepare('INSERT INTO zk_mw(kind, code, name, data, submit_time, flag) VALUES(?,?,?,?,?,?)').run(k, code, name, data, stamp(), flag).lastInsertRowid); processMiddleware(); res.json({ id });
});
integrationRouter.delete('/zk/mw/:kind/:id', (req, res) => { db.prepare('DELETE FROM zk_mw WHERE id=? AND kind=?').run(req.params.id, req.params.kind); res.json({ ok: true }); });
integrationRouter.post('/zk/mw-process', (_q, res) => res.json(processMiddleware()));
// apply pending rows to the real tables (departments, designations = positions, branches = areas, employees)
function upsertOrg(table, code, name, del) {
  const useCode = code && hasCol(table, 'code'); const ex = useCode ? db.prepare(`SELECT id FROM ${table} WHERE code=?`).get(code) ?? db.prepare(`SELECT id FROM ${table} WHERE name=?`).get(name ?? '') : db.prepare(`SELECT id FROM ${table} WHERE name=?`).get(name ?? '');
  if (del) { if (!ex) throw new Error('Nothing to delete: no such record'); if (table === 'departments' && db.prepare('SELECT 1 FROM employees WHERE department_id=?').get(ex.id)) throw new Error('Employees still belong to it');
    const col = { departments: 'department_id', designations: 'designation_id', branches: 'branch_id' }[table]; if (db.prepare(`SELECT 1 FROM employees WHERE ${col}=?`).get(ex.id)) throw new Error('Employees still belong to it'); db.prepare(`DELETE FROM ${table} WHERE id=?`).run(ex.id); return null; }
  if (ex) { db.prepare(`UPDATE ${table} SET name=?${useCode ? ', code=?' : ''} WHERE id=?`).run(name, ...(useCode ? [code] : []), ex.id); return ex.id; }
  return Number(useCode ? db.prepare(`INSERT INTO ${table}(name, code) VALUES(?,?)`).run(name, code).lastInsertRowid : db.prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name).lastInsertRowid);
}
function findOrg(table, code, name) { if (code && hasCol(table, 'code')) { const r = db.prepare(`SELECT id FROM ${table} WHERE code=?`).get(code); if (r) return r.id; } return name ? upsertOrg(table, code, name, false) : null; }
function applyRow(r) {
  const d = r.data ? JSON.parse(r.data) : {};
  if (r.kind === 'dept') return void upsertOrg('departments', r.code, r.name, r.flag);
  if (r.kind === 'pos') return void upsertOrg('designations', r.code, r.name, r.flag);
  if (r.kind === 'area') return void upsertOrg('branches', r.code, r.name, r.flag);
  const emp = db.prepare('SELECT * FROM employees WHERE code=?').get(r.code);
  if (r.flag) { if (!emp) throw new Error('No such employee'); db.prepare("UPDATE employees SET active=0, status='resigned', exit_date=? WHERE id=?").run(ymd(new Date()), emp.id); return; } // deleting a person keeps the history: they are marked as resigned
  const dept = findOrg('departments', d.dept_code, d.dept_name), pos = findOrg('designations', d.pos_code, d.pos_name), area = findOrg('branches', d.area_code, d.area_name);
  const name = [d.first_name, d.last_name].filter(Boolean).join(' ') || emp?.name || r.code, g = String(d.gender ?? '').toUpperCase(), gender = g.startsWith('M') ? 'Male' : g.startsWith('F') ? 'Female' : emp?.gender ?? null, active = d.active === undefined ? 1 : /^(0|no|false|inactive)$/i.test(d.active) ? 0 : 1;
  if (emp) db.prepare('UPDATE employees SET name=?, department_id=COALESCE(?,department_id), designation_id=COALESCE(?,designation_id), branch_id=COALESCE(?,branch_id), card_no=COALESCE(?,card_no), join_date=COALESCE(?,join_date), gender=?, dob=COALESCE(?,dob), email=COALESCE(?,email), active=? WHERE id=?')
    .run(name, dept, pos, area, d.card_no ?? null, d.hired_date ?? null, gender, d.birthday ?? null, d.email ?? null, active, emp.id);
  else db.prepare('INSERT INTO employees(code, name, department_id, designation_id, branch_id, card_no, join_date, gender, dob, email, active) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.code, name, dept, pos, area, d.card_no ?? null, d.hired_date ?? null, gender, d.birthday ?? null, d.email ?? null, active);
}
export function processMiddleware() {
  let ok = 0, failed = 0;
  for (const r of db.prepare("SELECT * FROM zk_mw WHERE status='Pending' ORDER BY id").all()) {
    try { db.exec('BEGIN'); applyRow(r); db.exec('COMMIT'); db.prepare("UPDATE zk_mw SET status='Success', target_time=?, message=NULL WHERE id=?").run(stamp(), r.id); ok++; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} db.prepare("UPDATE zk_mw SET status='Failed', target_time=?, message=? WHERE id=?").run(stamp(), String(e.message).slice(0, 200), r.id); failed++; }
  }
  if (ok + failed) sysLog('Middleware processing', failed ? 'Failed' : 'Success', `${ok} applied, ${failed} failed`);
  return { applied: ok, failed };
}
integrationRouter.post('/zk/mw/:kind/:id/retry', (req, res) => { db.prepare("UPDATE zk_mw SET status='Pending', message=NULL WHERE id=? AND kind=? AND status='Failed'").run(req.params.id, req.params.kind); res.json(processMiddleware()); });

export function startIntegration() {
  setInterval(() => exportTick().catch(() => {}), 60000).unref(); setInterval(() => { try { processMiddleware(); } catch {} }, 15000).unref();
}
