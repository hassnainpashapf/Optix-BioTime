import express from 'express';
import { db, getSettings } from './db.js';
import { dateStr } from './dates.js';
import { notify } from './notify.js';
import { emit } from './events.js';

export const visitorsRouter = express.Router();
const D = /^\d{4}-\d\d-\d\d$/, T = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const now = () => new Date().toLocaleString('sv');

function clean(b, partial) {
  const o = {}, txt = (k, max) => { if (k in b) o[k] = b[k] === '' || b[k] === null ? null : String(b[k]).trim().slice(0, max); };
  txt('name', 100); txt('company', 100); txt('phone', 20); txt('id_no', 30); txt('purpose', 200); txt('vehicle', 30); txt('notes', 500);
  if (!partial && !o.name) return { error: 'The visitor\'s name is required' }; if ('name' in b && !o.name) return { error: 'The visitor\'s name is required' };
  if (o.phone && !/^[\d+\-\s()]{5,20}$/.test(o.phone)) return { error: 'Phone number looks wrong' };
  if (b.expected_date) { if (!D.test(b.expected_date)) return { error: 'Expected date must be YYYY-MM-DD' }; o.expected_date = b.expected_date; }
  if (b.expected_time) { if (!T.test(b.expected_time)) return { error: 'Expected time must be HH:MM' }; o.expected_time = b.expected_time; }
  if ('host_id' in b || 'host_code' in b) {
    const h = b.host_id ? db.prepare('SELECT id FROM employees WHERE id=?').get(b.host_id) : b.host_code ? db.prepare('SELECT id FROM employees WHERE code=?').get(String(b.host_code)) : null;
    if ((b.host_id || b.host_code) && !h) return { error: 'Unknown host employee' }; o.host_id = h?.id ?? null;
  }
  return { o };
}
const blocked = (v) => db.prepare(`SELECT reason FROM visitor_blocklist WHERE (id_no IS NOT NULL AND id_no=?) OR (phone IS NOT NULL AND phone=?) OR (id_no IS NULL AND phone IS NULL AND name=? COLLATE NOCASE) LIMIT 1`).get(v.id_no ?? '', v.phone ?? '', v.name ?? '');
const view = (v, S = getSettings()) => ({ ...v, host: v.host ?? null, minutes_in: v.status === 'in' ? Math.round((Date.now() - Date.parse(v.checked_in.replace(' ', 'T'))) / 60000) : v.checked_out ? Math.round((Date.parse(v.checked_out.replace(' ', 'T')) - Date.parse(v.checked_in.replace(' ', 'T'))) / 60000) : null,
  overstay: v.status === 'in' && (Date.now() - Date.parse(v.checked_in.replace(' ', 'T'))) > S.visitor_max_hours * 3600000 });
const SEL = `SELECT v.*, e.name AS host, e.code AS host_code FROM visitors v LEFT JOIN employees e ON e.id=v.host_id`;

visitorsRouter.get('/visitors/blocklist', (_q, res) => res.json(db.prepare('SELECT * FROM visitor_blocklist ORDER BY id DESC').all()));
visitorsRouter.post('/visitors/blocklist', (req, res) => {
  const b = req.body ?? {}, name = String(b.name ?? '').trim().slice(0, 100) || null, id_no = String(b.id_no ?? '').trim().slice(0, 30) || null, phone = String(b.phone ?? '').trim().slice(0, 20) || null;
  if (!name && !id_no && !phone) return fail(res, 'Give a name, an ID number or a phone number');
  res.json({ id: Number(db.prepare('INSERT INTO visitor_blocklist(name, id_no, phone, reason) VALUES(?,?,?,?)').run(name, id_no, phone, String(b.reason ?? '').slice(0, 200)).lastInsertRowid) });
});
visitorsRouter.delete('/visitors/blocklist/:id', (req, res) => { db.prepare('DELETE FROM visitor_blocklist WHERE id=?').run(req.params.id); res.json({ ok: true }); });

visitorsRouter.get('/visitors', (req, res) => {
  const w = [], a = [], q = req.query, S = getSettings();
  if (q.status) { w.push('v.status=?'); a.push(q.status); }
  if (q.date) { w.push('(v.expected_date=? OR substr(v.checked_in,1,10)=?)'); a.push(q.date, q.date); }
  if (q.from) { w.push('COALESCE(substr(v.checked_in,1,10), v.expected_date, substr(v.created,1,10))>=?'); a.push(q.from); }
  if (q.to) { w.push('COALESCE(substr(v.checked_in,1,10), v.expected_date, substr(v.created,1,10))<=?'); a.push(q.to); }
  if (q.q) { w.push('(v.name LIKE ? OR v.company LIKE ? OR v.phone LIKE ? OR v.badge_no=?)'); a.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, q.q); }
  res.json(db.prepare(`${SEL} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE v.status WHEN 'in' THEN 0 WHEN 'expected' THEN 1 ELSE 2 END, COALESCE(v.checked_in, v.expected_date || ' ' || COALESCE(v.expected_time,''), v.created) DESC LIMIT 500`).all(...a).map(v => view(v, S)));
});
visitorsRouter.post('/visitors', (req, res) => {
  const { o, error } = clean(req.body ?? {}, false); if (error) return fail(res, error);
  const bl = blocked(o); if (bl) return fail(res, `This visitor is on the blocked list${bl.reason ? ': ' + bl.reason : ''}`, 403);
  const c = Object.keys(o), id = Number(db.prepare(`INSERT INTO visitors(${c}, created_by) VALUES(${c.map(() => '?')}, ?)`).run(...c.map(k => o[k]), req.user).lastInsertRowid);
  if (req.body?.check_in) { const r = checkIn(id, req.body.badge_no, req.user); if (r.error) return fail(res, r.error); return res.json({ id, status: 'in', badge_no: r.badge_no }); }
  res.json({ id, status: 'expected' });
});
function checkIn(id, badge, user) {
  const v = db.prepare(`${SEL} WHERE v.id=?`).get(id);
  if (!v) return { error: 'No such visitor' }; if (v.status !== 'expected') return { error: `This visitor is already ${v.status === 'in' ? 'signed in' : v.status}` };
  const bl = blocked(v); if (bl) return { error: `This visitor is on the blocked list${bl.reason ? ': ' + bl.reason : ''}` };
  const used = new Set(db.prepare("SELECT badge_no FROM visitors WHERE status='in' AND badge_no IS NOT NULL").all().map(r => r.badge_no));
  let b = badge ? String(badge).trim().slice(0, 12) : ''; if (b && used.has(b)) return { error: `Badge ${b} is already in use` };
  if (!b) { let n = 1; while (used.has(String(n))) n++; b = String(n); }
  db.prepare("UPDATE visitors SET status='in', checked_in=?, badge_no=? WHERE id=?").run(now(), b, id);
  const msg = `${v.name}${v.company ? ' (' + v.company + ')' : ''} has arrived${v.purpose ? ' for: ' + v.purpose : ''}. Badge ${b}.`;
  if (v.host_id) notify({ audience: 'employee', employee_id: v.host_id, title: 'Your visitor has arrived', body: msg, link: 'Visitors' , kind: 'visitor'});
  notify({ title: `Visitor: ${v.name}`, body: msg + (v.host ? ` Host: ${v.host}.` : ''), link: 'Visitors' , kind: 'visitor'});
  emit('visitor.checked_in', { id, name: v.name, company: v.company, host: v.host_code ?? null, badge_no: b });
  return { badge_no: b };
}
visitorsRouter.post('/visitors/:id/check-in', (req, res) => { const r = checkIn(Number(req.params.id), req.body?.badge_no, req.user); r.error ? fail(res, r.error, r.error === 'No such visitor' ? 404 : 400) : res.json({ ok: true, badge_no: r.badge_no }); });
visitorsRouter.post('/visitors/:id/check-out', (req, res) => {
  const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(req.params.id); if (!v) return fail(res, 'No such visitor', 404); if (v.status !== 'in') return fail(res, 'This visitor is not signed in');
  db.prepare("UPDATE visitors SET status='out', checked_out=? WHERE id=?").run(now(), v.id); emit('visitor.checked_out', { id: v.id, name: v.name, badge_no: v.badge_no }); res.json({ ok: true });
});
visitorsRouter.post('/visitors/:id/cancel', (req, res) => { const r = db.prepare("UPDATE visitors SET status='cancelled' WHERE id=? AND status='expected'").run(req.params.id); r.changes ? res.json({ ok: true }) : fail(res, 'Only an expected visit can be cancelled'); });
visitorsRouter.put('/visitors/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM visitors WHERE id=?').get(req.params.id); if (!v) return fail(res, 'No such visitor', 404);
  const { o, error } = clean(req.body ?? {}, true); if (error) return fail(res, error); const c = Object.keys(o); if (c.length) db.prepare(`UPDATE visitors SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), v.id); res.json({ ok: true });
});
visitorsRouter.delete('/visitors/:id', (req, res) => { db.prepare('DELETE FROM visitors WHERE id=?').run(req.params.id); res.json({ ok: true }); });
