import express from 'express';
import { db } from './db.js';
import { attendanceReport } from './report.js';
import { dateStr, addDays } from './dates.js';
import { notify } from './notify.js';
import { onEvent, checkUrl } from './events.js';
import { sendMail, emailEnabled } from './rules.js';
import { decideLeave } from './leave.js';
import { configured, sendMessage, normalizePhone, adminPhones } from './gateway.js';
import { decideAttendanceRequest } from './requests.js';

const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = ['Late', 'Absent', 'Pending', 'Missing Out', 'Half Day', 'Short Hours', 'Present', 'Leave', 'Unpaid Leave'];
export const TRIGGERS = [
  { id: 'daily', label: 'Every day at a time: check attendance', kind: 'schedule', desc: 'At the chosen time, look at the attendance of today (or yesterday) and act for everyone who matches.' },
  { id: 'monthly_count', label: 'Every day: someone reached a count this month', kind: 'schedule', desc: 'For example 3 lates in one month. Acts once each time the count reaches the number (3, then 6...).' },
  { id: 'leave.requested', label: 'A leave request is made', kind: 'event', desc: 'Acts as soon as someone applies for leave that needs a decision.' },
  { id: 'attendance_request.created', label: 'An attendance request is made', kind: 'event', desc: 'Someone asks to add a punch or mark on-duty / work from home.' },
  { id: 'device.offline', label: 'A device goes offline', kind: 'event', desc: 'A device stopped talking to the server.' },
  { id: 'employee.created', label: 'A new employee is added', kind: 'event', desc: 'Acts when an employee record is created.' },
];
export const ACTIONS = [
  { id: 'notify_admins', label: 'Alert the admins', needs: [] }, { id: 'notify_employee', label: 'Alert the person it is about', needs: ['person'] },
  { id: 'notify_manager', label: 'Alert the person\'s manager', needs: ['person'] }, { id: 'email', label: 'Send an e-mail', needs: [] },
  { id: 'sms', label: 'Send an SMS', needs: [] }, { id: 'whatsapp', label: 'Send a WhatsApp message', needs: [] },
  { id: 'sms', label: 'Send an SMS', needs: [] }, { id: 'whatsapp', label: 'Send a WhatsApp message', needs: [] },
  { id: 'webhook', label: 'Call a web address (webhook)', needs: [] }, { id: 'approve', label: 'Approve the request', needs: ['request'] }, { id: 'reject', label: 'Reject the request', needs: ['request'] },
];
const PERSON = ['daily-each', 'monthly_count', 'leave.requested', 'attendance_request.created', 'employee.created'];
const DEFAULT_TEXT = {
  daily: ['{rule}: {name}', '{name} ({code}) is {status} on {date}.'], 'daily-summary': ['{rule}: {n} people', '{names}'],
  monthly_count: ['{rule}: {name}', '{name} has {count} {status} days in {month} (limit {threshold}).'],
  'leave.requested': ['{rule}: {name}', '{name} asked for {type} leave, {from} to {to} ({days} day(s)).'],
  'attendance_request.created': ['{rule}: {name}', '{name} sent an attendance request for {date}.'],
  'device.offline': ['{rule}: {device}', '{device} went offline. {detail}'], 'employee.created': ['{rule}: {name}', '{name} ({code}) was added.'],
};
const render = (t, v) => String(t ?? '').replace(/\{(\w+)\}/g, (_m, k) => (v[k] ?? ''));
const person = (id) => id ? db.prepare('SELECT e.id, e.code, e.name, e.email, e.phone, e.manager_id, e.department_id, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=?').get(id) : null;
const adminMails = () => String(process.env.ADMIN_EMAIL ?? '').split(',').map(x => x.trim()).filter(Boolean);

// ---------- validation ----------
function clean(b) {
  const name = String(b.name ?? '').trim().slice(0, 80); if (!name) return { error: 'Give the rule a name' };
  const tr = TRIGGERS.find(t => t.id === b.trigger); if (!tr) return { error: 'Choose when the rule runs' };
  const c = b.config ?? {}, cfg = {}, num = (v, lo, hi, label) => { const n = Number(v); if (!(Number.isFinite(n) && n >= lo && n <= hi)) throw new Error(`${label} must be a number from ${lo} to ${hi}`); return n; };
  try {
    if (tr.kind === 'schedule') {
      if (!HHMM.test(c.at ?? '')) throw new Error('Time must be HH:MM');
      cfg.at = c.at; cfg.days = (Array.isArray(c.days) && c.days.length ? c.days : [0, 1, 2, 3, 4, 5, 6]).map(Number); if (cfg.days.some(d => !(d >= 0 && d <= 6))) throw new Error('Days are 0 (Sunday) to 6 (Saturday)');
      cfg.status = (Array.isArray(c.status) ? c.status : [c.status ?? 'Late']).filter(Boolean); if (!cfg.status.length || cfg.status.some(s => !STATUSES.includes(s))) throw new Error('Choose which attendance status to look for');
      if (c.dept_id) cfg.dept_id = Number(c.dept_id); if (c.branch_id) cfg.branch_id = Number(c.branch_id);
      if (b.trigger === 'daily') { cfg.day = c.day === 'yesterday' ? 'yesterday' : 'today'; cfg.mode = c.mode === 'summary' ? 'summary' : 'each'; if (c.min_late_min) cfg.min_late_min = num(c.min_late_min, 0, 1440, 'Minimum late minutes'); }
      else cfg.threshold = num(c.threshold, 1, 31, 'The count');
    } else if (b.trigger === 'leave.requested') { if (c.leave_type) cfg.leave_type = String(c.leave_type).slice(0, 40); if (c.max_days !== undefined && c.max_days !== '') cfg.max_days = num(c.max_days, 0.5, 365, 'Maximum days'); if (c.dept_id) cfg.dept_id = Number(c.dept_id); }
    else if (b.trigger === 'attendance_request.created') { if (c.req_kind) { if (!['add_punch', 'on_duty'].includes(c.req_kind)) throw new Error('Request kind is add_punch or on_duty'); cfg.req_kind = c.req_kind; } }
  } catch (e) { return { error: e.message }; }
  const acts = Array.isArray(b.actions) ? b.actions : []; if (!acts.length || acts.length > 8) return { error: 'Add 1 to 8 actions' };
  const mode = b.trigger === 'daily' ? 'daily-' + cfg.mode : b.trigger, out = [];
  for (const a of acts) {
    const def = ACTIONS.find(x => x.id === a.type); if (!def) return { error: 'Unknown action' };
    if (def.needs.includes('person') && !PERSON.includes(mode)) return { error: `"${def.label}" needs a rule that is about one person each time` };
    if (def.needs.includes('request') && !['leave.requested', 'attendance_request.created'].includes(b.trigger)) return { error: `"${def.label}" works only for leave or attendance requests` };
    const o = { type: a.type, title: String(a.title ?? '').slice(0, 200), body: String(a.body ?? '').slice(0, 1000) };
    if (a.type === 'email') { o.to = a.to ?? 'admins'; if (!['employee', 'manager', 'admins'].includes(o.to) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.to)) return { error: 'E-mail goes to the person, the manager, the admins or one address' }; if (['employee', 'manager'].includes(o.to) && !PERSON.includes(mode)) return { error: 'E-mail to the person or manager needs a rule about one person' }; }
    if (a.type === 'sms' || a.type === 'whatsapp') {
      o.to = a.to ?? 'admins'; if (!['employee', 'manager', 'admins'].includes(o.to) && !normalizePhone(o.to)) return { error: 'The message goes to the person, the manager, the admins or one phone number' };
      if (['employee', 'manager'].includes(o.to) && !PERSON.includes(mode)) return { error: 'A message to the person or manager needs a rule about one person' };
    }
    if (a.type === 'webhook') { o.url = String(a.url ?? '').trim(); const bad = checkUrl(o.url); if (bad) return { error: bad }; }
    out.push(o);
  }
  return { o: { name, trigger: b.trigger, config: JSON.stringify(cfg), actions: JSON.stringify(out), enabled: b.enabled === false || b.enabled === 0 ? 0 : 1 }, mode };
}

// ---------- doing the actions ----------
async function perform(rule, mode, vars, ctx, dry) {
  const out = [], [dt, db_] = DEFAULT_TEXT[mode] ?? DEFAULT_TEXT.daily, V = { rule: rule.name, ...vars };
  for (const a of rule.actions) {
    const title = render(a.title || dt, V), body = render(a.body || db_, V);
    const rec = (ok, text) => out.push({ action: a.type, ok, text });
    try {
      if (a.type === 'notify_admins') { if (!dry) notify({ title, body, link: 'Automation', kind: 'automation' }); rec(true, `Alerted the admins: ${title}`); }
      else if (a.type === 'notify_employee') { if (!ctx.emp) rec(false, 'No person to alert'); else { if (!dry) notify({ audience: 'employee', employee_id: ctx.emp.id, title, body, kind: 'automation' }); rec(true, `Alerted ${ctx.emp.name}: ${title}`); } }
      else if (a.type === 'notify_manager') { const m = ctx.emp?.manager_id; if (!m) rec(false, `${ctx.emp?.name ?? 'The person'} has no manager`); else { if (!dry) notify({ audience: 'employee', employee_id: m, title, body, kind: 'automation' }); rec(true, `Alerted the manager of ${ctx.emp.name}: ${title}`); } }
      else if (a.type === 'email') {
        const to = a.to === 'employee' ? [ctx.emp?.email] : a.to === 'manager' ? [person(ctx.emp?.manager_id)?.email] : a.to === 'admins' ? adminMails() : [a.to];
        const list = to.filter(Boolean); if (!list.length) rec(false, 'No e-mail address to send to');
        else if (!emailEnabled()) rec(false, 'E-mail is not set up (SMTP_URL)');
        else { let sent = 0; if (!dry) for (const x of list) if (await sendMail(x, title, body)) sent++; rec(dry || sent > 0, dry ? `Would e-mail ${list.join(', ')}` : sent ? `E-mailed ${list.join(', ')}` : 'The mail server did not accept the message'); }
      } else if (a.type === 'sms' || a.type === 'whatsapp') {
        const ch = a.type, name = ch === 'sms' ? 'SMS' : 'WhatsApp', text = body ? `${title}\n${body}` : title;
        const to = a.to === 'employee' ? [ctx.emp?.phone] : a.to === 'manager' ? [person(ctx.emp?.manager_id)?.phone] : a.to === 'admins' ? adminPhones() : [a.to];
        const nums = [...new Set(to.map(normalizePhone).filter(Boolean))];
        if (!nums.length) rec(false, `No phone number to send the ${name} to`);
        else if (!configured(ch)) rec(false, `${name} is not set up on the server (see the README: ${ch === 'sms' ? 'SMS_URL' : 'WA_URL'})`);
        else if (dry) rec(true, `Would send a ${name} to ${nums.join(', ')}`);
        else { let ok = 0, last = ''; for (const n of nums) try { await sendMessage(ch, n, text); ok++; } catch (e) { last = e.message; } rec(ok > 0, ok ? `${name} sent to ${nums.join(', ')}` : `${name} failed: ${last}`); }
      } else if (a.type === 'webhook') {
        if (dry) rec(true, `Would call ${a.url}`);
        else { const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000); try { const r = await fetch(a.url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': 'attendance-automation/1' }, body: JSON.stringify({ rule: rule.name, trigger: rule.trigger, title, body, data: vars }) }); rec(r.ok, `Called ${a.url}: ${r.status}`); } finally { clearTimeout(t); } }
      } else if (a.type === 'approve' || a.type === 'reject') {
        if (dry) rec(true, `Would ${a.type} the request`);
        else {
          const who = `automation:${rule.name}`, note = `Automatically ${a.type === 'approve' ? 'approved' : 'rejected'} by the rule "${rule.name}"`;
          const err = ctx.leaveId ? decideLeave(ctx.leaveId, a.type === 'approve' ? 'approved' : 'rejected', note, who) : ctx.requestId ? decideAttendanceRequest(ctx.requestId, a.type, note, who) : 'Nothing to decide';
          rec(!err, err ? `Not done: ${err}` : `${a.type === 'approve' ? 'Approved' : 'Rejected'} the request`);
        }
      }
    } catch (e) { rec(false, `${a.type} failed: ${String(e.message).slice(0, 100)}`); }
  }
  return out;
}
const logRun = (rule, subject, outs) => {
  for (const o of outs) db.prepare('INSERT INTO automation_log(automation_id, subject, outcome, ok) VALUES(?,?,?,?)').run(rule.id, String(subject).slice(0, 120), o.text.slice(0, 300), o.ok ? 1 : 0);
  db.prepare('UPDATE automations SET runs=runs+1 WHERE id=?').run(rule.id);
  db.prepare('DELETE FROM automation_log WHERE automation_id=? AND id NOT IN (SELECT id FROM automation_log WHERE automation_id=? ORDER BY id DESC LIMIT 300)').run(rule.id, rule.id);
};
const load = (r) => ({ ...r, config: JSON.parse(r.config || '{}'), actions: JSON.parse(r.actions || '[]') });
const seen = (rule, key) => !!db.prepare('SELECT 1 FROM automation_seen WHERE automation_id=? AND key=?').get(rule.id, key);
const mark = (rule, key) => { db.prepare('INSERT OR IGNORE INTO automation_seen(automation_id, key) VALUES(?,?)').run(rule.id, key); db.prepare("DELETE FROM automation_seen WHERE ts<datetime('now','localtime','-400 days')").run(); };

// ---------- scheduled rules ----------
export async function runScheduled(rule, { dry = false, today = dateStr(new Date()) } = {}) {
  const c = rule.config, filter = { departmentId: c.dept_id || undefined, branchId: c.branch_id || undefined };
  if (rule.trigger === 'daily') {
    const day = c.day === 'yesterday' ? addDays(today, -1) : today;
    const rows = attendanceReport(day, day, filter).filter(r => c.status.includes(r.status) && (!c.min_late_min || r.late_min >= c.min_late_min));
    if (c.mode === 'summary') {
      const key = `${day}|summary`, done = seen(rule, key);
      if (!rows.length) return { matched: 0, acted: 0, already: 0, sample: [] };
      const vars = { n: rows.length, names: rows.slice(0, 25).map(r => r.name).join(', ') + (rows.length > 25 ? ` and ${rows.length - 25} more` : ''), date: day, status: c.status.join('/') };
      if (done && !dry) return { matched: rows.length, acted: 0, already: 1, sample: [] };
      const outs = await perform(rule, 'daily-summary', vars, {}, dry); if (!dry) { mark(rule, key); logRun(rule, `${rows.length} people on ${day}`, outs); }
      return { matched: rows.length, acted: 1, already: done ? 1 : 0, sample: [{ subject: `${rows.length} people`, results: outs }] };
    }
    let acted = 0, already = 0; const sample = [];
    for (const r of rows.slice(0, 500)) {
      const key = `${day}|${r.code}`; if (seen(rule, key)) { already++; if (!dry) continue; }
      const emp = person(r.employee_id), vars = { name: r.name, code: r.code, dept: r.dept ?? '', date: day, status: r.status, in: r.in ?? '', out: r.out ?? '', late_min: r.late_min, worked: r.worked_min };
      const outs = await perform(rule, 'daily', vars, { emp }, dry); acted++;
      if (dry) { if (sample.length < 10) sample.push({ subject: r.name, results: outs }); } else { mark(rule, key); logRun(rule, `${r.name} (${r.code}) ${day}`, outs); }
    }
    return { matched: rows.length, acted, already, sample };
  }
  // monthly_count
  const month = today.slice(0, 7), rows = attendanceReport(month + '-01', today, filter).filter(r => c.status.includes(r.status)), by = new Map();
  for (const r of rows) { const e = by.get(r.employee_id) ?? { n: 0, r }; e.n++; by.set(r.employee_id, e); }
  let acted = 0, already = 0, matched = 0; const sample = [];
  for (const [id, { n, r }] of by) {
    const level = Math.floor(n / c.threshold); if (level < 1) continue; matched++;
    const key = `${month}|${r.code}|${level}`; if (seen(rule, key)) { already++; if (!dry) continue; }
    const emp = person(id), vars = { name: r.name, code: r.code, dept: r.dept ?? '', count: n, threshold: c.threshold, month, status: c.status.join('/') };
    const outs = await perform(rule, 'monthly_count', vars, { emp }, dry); acted++;
    if (dry) { if (sample.length < 10) sample.push({ subject: r.name, results: outs }); } else { mark(rule, key); logRun(rule, `${r.name}: ${n} in ${month}`, outs); }
  }
  return { matched, acted, already, sample };
}
export async function tickAutomations(now = new Date()) {
  const today = dateStr(now), hhmm = now.toTimeString().slice(0, 5), dow = now.getDay();
  for (const r0 of db.prepare("SELECT * FROM automations WHERE enabled=1 AND trigger IN ('daily','monthly_count')").all()) {
    const r = load(r0); if (!r.config.days.includes(dow) || hhmm < r.config.at || r.last_run === today) continue;
    db.prepare('UPDATE automations SET last_run=? WHERE id=?').run(today, r.id); await runScheduled(r, { today }).catch(() => {});
  }
}
export function startAutomations() { setInterval(() => tickAutomations().catch(() => {}), 60000).unref(); }

// ---------- event rules ----------
export async function handleEvent(event, data) {
  for (const r0 of db.prepare('SELECT * FROM automations WHERE enabled=1 AND trigger=?').all(event)) {
    const rule = load(r0), c = rule.config; let emp = null, vars = {}, ctx = {};
    if (event === 'leave.requested') {
      emp = db.prepare('SELECT id FROM employees WHERE code=?').get(data.code); emp = person(emp?.id);
      if ((c.leave_type && c.leave_type !== data.type) || (c.max_days !== undefined && data.days > c.max_days) || (c.dept_id && emp?.department_id !== c.dept_id)) continue;
      vars = { name: data.name, code: data.code, type: data.type, from: data.from, to: data.to, days: data.days }; ctx = { emp, leaveId: data.id };
    } else if (event === 'attendance_request.created') {
      if (c.req_kind && c.req_kind !== data.kind) continue;
      emp = person(db.prepare('SELECT id FROM employees WHERE code=?').get(data.code)?.id);
      vars = { name: emp?.name ?? data.code, code: data.code, kind: data.kind, date: data.date, time: data.time ?? '', status_text: data.status_text ?? '' }; ctx = { emp, requestId: data.id };
    } else if (event === 'device.offline') vars = { device: data.device, serial: data.serial ?? '', detail: data.detail ?? '' };
    else if (event === 'employee.created') { emp = person(db.prepare('SELECT id FROM employees WHERE code=?').get(data.code)?.id); vars = { name: data.name, code: data.code }; ctx = { emp }; }
    const outs = await perform(rule, event, vars, ctx, false); logRun(rule, vars.name ?? vars.device ?? event, outs);
  }
}
onEvent((event, data) => handleEvent(event, data));

// ---------- API ----------
export const automationRouter = express.Router();
const SAMPLE = { 'leave.requested': { name: 'Sample Person', code: '000', type: 'Casual', from: '2026-01-01', to: '2026-01-01', days: 1 }, 'attendance_request.created': { code: '000', kind: 'add_punch', date: '2026-01-01', time: '09:00' }, 'device.offline': { device: 'Main gate', detail: 'last contact 10 minutes ago' }, 'employee.created': { name: 'Sample Person', code: '000' } };
automationRouter.get('/automations', (_q, res) => res.json({ smtp: emailEnabled(), sms: configured('sms'), whatsapp: configured('whatsapp'), triggers: TRIGGERS, actions: ACTIONS, statuses: STATUSES,
  rules: db.prepare('SELECT * FROM automations ORDER BY id').all().map(load), log: db.prepare('SELECT l.id, l.ts, l.subject, l.outcome, l.ok, a.name AS rule FROM automation_log l JOIN automations a ON a.id=l.automation_id ORDER BY l.id DESC LIMIT 150').all() }));
automationRouter.post('/automations', (req, res) => { const { o, error } = clean(req.body ?? {}); if (error) return fail(res, error); const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO automations(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); });
automationRouter.put('/automations/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM automations WHERE id=?').get(req.params.id)) return fail(res, 'No such rule', 404);
  if (Object.keys(req.body ?? {}).length === 1 && 'enabled' in req.body) { db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(req.body.enabled ? 1 : 0, req.params.id); return res.json({ ok: true }); }
  const { o, error } = clean(req.body ?? {}); if (error) return fail(res, error); const c = Object.keys(o);
  db.prepare(`UPDATE automations SET ${c.map(k => k + '=?')}, last_run=NULL WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true });
});
automationRouter.delete('/automations/:id', (req, res) => { db.prepare('DELETE FROM automations WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const getRule = (req, res) => { const r = db.prepare('SELECT * FROM automations WHERE id=?').get(req.params.id); if (!r) { fail(res, 'No such rule', 404); return null; } return load(r); };
// Preview: shows who would be acted on and exactly what would happen, without doing anything.
automationRouter.post('/automations/:id/preview', async (req, res) => {
  const r = getRule(req, res); if (!r) return;
  if (['daily', 'monthly_count'].includes(r.trigger)) return res.json(await runScheduled(r, { dry: true }));
  const emp = person(db.prepare('SELECT id FROM employees WHERE active=1 ORDER BY id LIMIT 1').get()?.id), vars = { ...(SAMPLE[r.trigger] ?? {}), ...(emp && PERSON.includes(r.trigger) ? { name: emp.name, code: emp.code } : {}) };
  const results = await perform(r, r.trigger, vars, { emp }, true);
  res.json({ matched: 1, acted: 1, already: 0, sample: [{ subject: 'Example event (nothing is changed)', results }] });
});
automationRouter.post('/automations/:id/run', async (req, res) => {
  const r = getRule(req, res); if (!r) return;
  if (!['daily', 'monthly_count'].includes(r.trigger)) return fail(res, 'This rule runs when the event happens. Use Preview to see what it would do.');
  db.prepare('UPDATE automations SET last_run=? WHERE id=?').run(dateStr(new Date()), r.id); res.json(await runScheduled(r));
});
