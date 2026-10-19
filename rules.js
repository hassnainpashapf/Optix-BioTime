import express from 'express';
import { db } from './db.js';
import { attendanceReport } from './report.js';
import { dateStr, addDays } from './dates.js';
import { notify } from './notify.js';
import { emit } from './events.js';

// ---------- e-mail (optional): set SMTP_URL, e.g. smtps://user:pass@smtp.example.com. SMTP_URL=json: keeps messages in memory (tests). ----------
export const mailbox = [];
let transporter = null;
export const emailEnabled = () => !!process.env.SMTP_URL;
export async function sendMail(to, subject, text) {
  if (!process.env.SMTP_URL || !to) return false;
  try {
    const nm = (await import('nodemailer')).default;
    transporter ??= nm.createTransport(process.env.SMTP_URL === 'json:' ? { jsonTransport: true } : process.env.SMTP_URL);
    const info = await transporter.sendMail({ from: process.env.MAIL_FROM || 'attendance@localhost', to, subject, text });
    if (process.env.SMTP_URL === 'json:') mailbox.push(JSON.parse(info.message));
    return true;
  } catch { return false; }
}

const WAITING = ['Pending', 'Absent'];
const list = (names, max = 20) => names.slice(0, max).join(', ') + (names.length > max ? ` and ${names.length - max} more` : '');

// Each rule looks at the data, tells the right people inside the app (and by e-mail when asked), and reports the event to webhooks.
export async function runRule(rule, today = dateStr(new Date())) {
  let sent = 0, mails = 0;
  const people = new Map(db.prepare('SELECT id, name, email, manager_id FROM employees WHERE active=1').all().map(e => [e.id, e]));
  const KIND = { absent_summary: 'absent_summary', late_alert: 'late', missing_punch: 'missing_punch', leave_pending: 'leave_pending' }[rule.kind];
  const tell = async (e, title, body, link) => { notify({ audience: 'employee', employee_id: e.id, title, body, link, kind: KIND }); sent++; if (rule.email && e.email && await sendMail(e.email, title, body)) mails++; };
  const admins = async (title, body, link) => { notify({ title, body, link, kind: KIND }); sent++; for (const a of String(process.env.ADMIN_EMAIL ?? '').split(',').map(x => x.trim()).filter(Boolean)) if (rule.email && await sendMail(a, title, body)) mails++; };
  if (rule.kind === 'absent_summary') {
    const names = attendanceReport(today, today).filter(r => WAITING.includes(r.status)).map(r => r.name);
    if (names.length) await admins(`${names.length} people have not punched in yet`, list(names), 'Exceptions');
  } else if (rule.kind === 'late_alert') {
    const late = attendanceReport(today, today).filter(r => r.status === 'Late'), byManager = new Map();
    for (const r of late) { const m = people.get(r.employee_id)?.manager_id; if (m && people.get(m)) { if (!byManager.has(m)) byManager.set(m, []); byManager.get(m).push(`${r.name} (${r.in}, ${r.late_min} min late)`); } }
    for (const [m, rows] of byManager) await tell(people.get(m), `${rows.length} of your team ${rows.length === 1 ? 'was' : 'were'} late today`, list(rows), 'Team');
    if (late.length) await admins(`${late.length} late arrival${late.length === 1 ? '' : 's'} today`, list(late.map(r => r.name)), 'Exceptions');
  } else if (rule.kind === 'missing_punch') {
    const y = addDays(today, -1);
    for (const r of attendanceReport(y, y).filter(r => r.status === 'Missing Out')) { const e = people.get(r.employee_id); if (e) await tell(e, 'You forgot to punch out yesterday', `On ${y} you punched in at ${r.in} but there is no punch-out. Send a request so HR can fix it.`, 'Requests'); }
  } else if (rule.kind === 'leave_pending') {
    const old = db.prepare("SELECT l.type, l.from_date, e.id AS eid, e.name FROM leaves l JOIN employees e ON e.id=l.employee_id WHERE l.status='pending' AND substr(l.applied_at,1,10)<=?").all(addDays(today, -2)), byManager = new Map();
    for (const l of old) { const m = people.get(l.eid)?.manager_id; if (m && people.get(m)) { if (!byManager.has(m)) byManager.set(m, []); byManager.get(m).push(`${l.name} (${l.type} from ${l.from_date})`); } }
    for (const [m, rows] of byManager) await tell(people.get(m), `${rows.length} leave request${rows.length === 1 ? '' : 's'} waiting more than 2 days`, list(rows), 'Team');
    if (old.length) await admins(`${old.length} leave request${old.length === 1 ? '' : 's'} waiting more than 2 days`, list(old.map(l => `${l.name} (${l.type})`)), 'Leaves');
  }
  if (sent) emit('notification.sent', { kind: rule.kind, notices: sent, emails: mails });
  return { sent, emails: mails };
}
// Called every minute: a rule runs once a day, at or after its time.
export async function tickRules(now = new Date()) {
  const today = dateStr(now), hhmm = now.toTimeString().slice(0, 5);
  for (const r of db.prepare('SELECT * FROM notification_rules WHERE enabled=1').all()) {
    if (hhmm >= r.at && r.last_run !== today) { db.prepare('UPDATE notification_rules SET last_run=? WHERE id=?').run(today, r.id); await runRule(r, today).catch(() => {}); }
  }
}
export function startRules() { setInterval(() => tickRules().catch(() => {}), 60000).unref(); }

export const rulesRouter = express.Router();
rulesRouter.get('/notification-rules', (_q, res) => res.json({ smtp: emailEnabled(), rules: db.prepare('SELECT * FROM notification_rules ORDER BY id').all() }));
rulesRouter.put('/notification-rules/:id', (req, res) => {
  const b = req.body ?? {}; if ('at' in b && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.at)) return res.status(400).json({ error: 'Time must be HH:MM' });
  if (!db.prepare('SELECT 1 FROM notification_rules WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'No such rule' });
  db.prepare('UPDATE notification_rules SET enabled=COALESCE(?,enabled), at=COALESCE(?,at), email=COALESCE(?,email) WHERE id=?').run('enabled' in b ? (b.enabled ? 1 : 0) : null, b.at ?? null, 'email' in b ? (b.email ? 1 : 0) : null, req.params.id); res.json({ ok: true });
});
rulesRouter.post('/notification-rules/test-email', async (req, res) => {
  if (!emailEnabled()) return res.status(400).json({ error: 'E-mail is not set up. Set SMTP_URL (see the README) and restart the server.' });
  const ok = await sendMail(String(req.body?.to ?? ''), 'Test from the attendance system', 'If you can read this, e-mail is working.'); ok ? res.json({ ok: true }) : res.status(502).json({ error: 'The mail server did not accept the message. Check SMTP_URL.' });
});
rulesRouter.post('/notification-rules/:id/run', async (req, res) => {
  const r = db.prepare('SELECT * FROM notification_rules WHERE id=?').get(req.params.id); if (!r) return res.status(404).json({ error: 'No such rule' });
  res.json(await runRule(r));
});
