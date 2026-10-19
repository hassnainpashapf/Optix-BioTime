import express from 'express';
import { db } from './db.js';
import { notify } from './notify.js';

export const meetingsRouter = express.Router();
const fail = (res, msg, code = 400) => res.status(code).json({ error: msg });
const TS = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d$/, ts = (s) => String(s).replace('T', ' ').slice(0, 16);

// ---------- rooms ----------
meetingsRouter.get('/rooms', (_q, res) => res.json(db.prepare('SELECT r.*, d.name AS device FROM rooms r LEFT JOIN devices d ON d.id=r.device_id ORDER BY r.name').all()));
meetingsRouter.post('/rooms', (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 60), cap = req.body?.capacity === '' || req.body?.capacity == null ? null : Number(req.body.capacity);
  if (!name) return fail(res, 'Name required'); if (cap !== null && !(Number.isInteger(cap) && cap >= 1 && cap <= 5000)) return fail(res, 'Capacity must be a whole number');
  try { res.json({ id: Number(db.prepare('INSERT INTO rooms(name, capacity, location, device_id) VALUES(?,?,?,?)').run(name, cap, String(req.body?.location ?? '').slice(0, 100) || null, req.body?.device_id ? Number(req.body.device_id) : null).lastInsertRowid) }); } catch { fail(res, 'A room with this name exists'); }
});
meetingsRouter.put('/rooms/:id', (req, res) => {
  const b = req.body ?? {}; if ('name' in b && !String(b.name).trim()) return fail(res, 'Name required');
  try { db.prepare('UPDATE rooms SET name=COALESCE(?,name), capacity=COALESCE(?,capacity), location=COALESCE(?,location), active=COALESCE(?,active), device_id=CASE WHEN ? THEN ? ELSE device_id END WHERE id=?').run(b.name ? String(b.name).trim().slice(0, 60) : null, b.capacity ? Number(b.capacity) : null, b.location ?? null, 'active' in b ? (b.active ? 1 : 0) : null, 'device_id' in b ? 1 : 0, b.device_id ? Number(b.device_id) : null, req.params.id); res.json({ ok: true }); } catch { fail(res, 'A room with this name exists'); }
});
meetingsRouter.delete('/rooms/:id', (req, res) => { db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id); res.json({ ok: true }); });
meetingsRouter.get('/rooms/availability', (req, res) => {
  const { start, end } = req.query; if (!TS.test(start ?? '') || !TS.test(end ?? '') || ts(end) <= ts(start)) return fail(res, 'Give a start and an end (YYYY-MM-DD HH:MM)');
  res.json(db.prepare(`SELECT r.* FROM rooms r WHERE r.active=1 AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.room_id=r.id AND m.status='scheduled' AND m.start_ts<? AND m.end_ts>?) ORDER BY r.name`).all(ts(end), ts(start)));
});

// ---------- meetings ----------
function check(b, existingId = null) {
  const title = String(b.title ?? '').trim().slice(0, 150); if (!title) return { error: 'Title required' };
  if (!TS.test(b.start ?? '') || !TS.test(b.end ?? '')) return { error: 'Start and end must look like 2026-10-20 14:30' };
  const start = ts(b.start), end = ts(b.end); if (end <= start) return { error: 'The meeting must end after it starts' };
  if (Date.parse(end.replace(' ', 'T')) - Date.parse(start.replace(' ', 'T')) > 12 * 3600000) return { error: 'A meeting cannot be longer than 12 hours' };
  let room = null; if (b.room_id) { room = db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(b.room_id); if (!room) return { error: 'Unknown or inactive room' };
    const clash = db.prepare("SELECT title, start_ts, end_ts FROM meetings WHERE room_id=? AND status='scheduled' AND start_ts<? AND end_ts>? AND id IS NOT ?").get(room.id, end, start, existingId);
    if (clash) return { error: `${room.name} is already booked: "${clash.title}" ${clash.start_ts.slice(11)}-${clash.end_ts.slice(11)}` }; }
  if (b.organizer_id && !db.prepare('SELECT 1 FROM employees WHERE id=?').get(b.organizer_id)) return { error: 'Unknown organizer' };
  const ids = [...new Set((b.attendees ?? []).map(Number))]; if (ids.length > 300) return { error: 'At most 300 attendees' };
  const emps = ids.map(id => db.prepare('SELECT id, name FROM employees WHERE id=? AND active=1').get(id)); if (emps.some(e => !e)) return { error: 'An attendee is unknown or no longer active' };
  if (room?.capacity && ids.length > room.capacity) return { error: `${room.name} seats ${room.capacity}, but ${ids.length} people are invited` };
  const warnings = [], day = start.slice(0, 10);
  for (const e of emps) {
    if (db.prepare("SELECT 1 FROM leaves WHERE employee_id=? AND status='approved' AND from_date<=? AND to_date>=?").get(e.id, day, day)) warnings.push(`${e.name} is on approved leave that day`);
    const other = db.prepare("SELECT m.title FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id WHERE a.employee_id=? AND m.status='scheduled' AND m.start_ts<? AND m.end_ts>? AND m.id IS NOT ?").get(e.id, end, start, existingId);
    if (other) warnings.push(`${e.name} is already in "${other.title}" at that time`);
  }
  return { v: { title, start, end, room_id: room?.id ?? null, place: room ? null : String(b.place ?? '').slice(0, 120) || null, organizer_id: b.organizer_id || null, agenda: String(b.agenda ?? '').slice(0, 4000) }, ids, warnings };
}
const invite = (id, ids, title, when, where, verb) => { for (const e of ids) notify({ audience: 'employee', employee_id: e, title: `${verb}: ${title}`, body: `${when}${where ? ' · ' + where : ''}`, link: 'Meetings' , kind: 'meeting'}); };
const place = (v, roomName) => roomName || v.place || '';
meetingsRouter.post('/meetings', (req, res) => {
  const r = check(req.body ?? {}); if (r.error) return fail(res, r.error, r.error.includes('already booked') ? 409 : 400);
  db.exec('BEGIN');
  const id = Number(db.prepare('INSERT INTO meetings(title, organizer_id, room_id, place, start_ts, end_ts, agenda, created_by) VALUES(?,?,?,?,?,?,?,?)').run(r.v.title, r.v.organizer_id, r.v.room_id, r.v.place, r.v.start, r.v.end, r.v.agenda, req.user).lastInsertRowid);
  for (const e of r.ids) db.prepare('INSERT INTO meeting_attendees(meeting_id, employee_id) VALUES(?,?)').run(id, e); db.exec('COMMIT');
  invite(id, r.ids, r.v.title, `${r.v.start.replace(' ', ' at ')}`, place(r.v, r.v.room_id ? db.prepare('SELECT name FROM rooms WHERE id=?').get(r.v.room_id).name : null), 'Meeting invitation');
  res.json({ id, warnings: r.warnings });
});
meetingsRouter.put('/meetings/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404); if (m.status !== 'scheduled') return fail(res, 'Only a scheduled meeting can be changed');
  const cur = db.prepare('SELECT employee_id FROM meeting_attendees WHERE meeting_id=?').all(m.id).map(a => a.employee_id);
  const b = { title: m.title, start: m.start_ts, end: m.end_ts, room_id: m.room_id, place: m.place, organizer_id: m.organizer_id, agenda: m.agenda, attendees: cur, ...req.body };
  const r = check(b, m.id); if (r.error) return fail(res, r.error, r.error.includes('already booked') ? 409 : 400);
  db.exec('BEGIN');
  db.prepare('UPDATE meetings SET title=?, organizer_id=?, room_id=?, place=?, start_ts=?, end_ts=?, agenda=? WHERE id=?').run(r.v.title, r.v.organizer_id, r.v.room_id, r.v.place, r.v.start, r.v.end, r.v.agenda, m.id);
  const moved = r.v.start !== m.start_ts || r.v.end !== m.end_ts || r.v.room_id !== m.room_id;
  db.prepare(`DELETE FROM meeting_attendees WHERE meeting_id=? AND employee_id NOT IN (${r.ids.length ? r.ids.map(() => '?') : 'NULL'})`).run(m.id, ...r.ids);
  const fresh = r.ids.filter(e => !cur.includes(e)); for (const e of fresh) db.prepare('INSERT INTO meeting_attendees(meeting_id, employee_id) VALUES(?,?)').run(m.id, e);
  if (moved) db.prepare("UPDATE meeting_attendees SET rsvp='pending' WHERE meeting_id=?").run(m.id); db.exec('COMMIT');
  const where = place(r.v, r.v.room_id ? db.prepare('SELECT name FROM rooms WHERE id=?').get(r.v.room_id).name : null);
  invite(m.id, fresh, r.v.title, r.v.start.replace(' ', ' at '), where, 'Meeting invitation'); // people added now are invited; people already invited hear about a new time or room
  if (moved) invite(m.id, r.ids.filter(e => cur.includes(e)), r.v.title, r.v.start.replace(' ', ' at '), where, 'Meeting changed');
  res.json({ ok: true, warnings: r.warnings });
});
meetingsRouter.post('/meetings/:id/cancel', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404); if (m.status !== 'scheduled') return fail(res, 'This meeting is not scheduled');
  db.prepare("UPDATE meetings SET status='cancelled' WHERE id=?").run(m.id);
  invite(m.id, db.prepare('SELECT employee_id FROM meeting_attendees WHERE meeting_id=?').all(m.id).map(a => a.employee_id), m.title, m.start_ts.replace(' ', ' at '), null, 'Meeting cancelled'); res.json({ ok: true });
});
// Who actually came. Everyone invited who is not in the list is marked as absent from the meeting.
meetingsRouter.post('/meetings/:id/attendance', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404); if (m.status === 'cancelled') return fail(res, 'This meeting was cancelled');
  const came = new Set((req.body?.attended ?? []).map(Number));
  for (const a of db.prepare('SELECT employee_id FROM meeting_attendees WHERE meeting_id=?').all(m.id)) db.prepare('UPDATE meeting_attendees SET attended=? WHERE meeting_id=? AND employee_id=?').run(came.has(a.employee_id) ? 1 : 0, m.id, a.employee_id);
  db.prepare("UPDATE meetings SET status='done' WHERE id=?").run(m.id); res.json({ ok: true });
});
meetingsRouter.put('/meetings/:id/minutes', (req, res) => { const r = db.prepare('UPDATE meetings SET minutes=? WHERE id=?').run(String(req.body?.minutes ?? '').slice(0, 20000), req.params.id); r.changes ? res.json({ ok: true }) : fail(res, 'No such meeting', 404); });
meetingsRouter.delete('/meetings/:id', (req, res) => { db.prepare('DELETE FROM meetings WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const LIST = `SELECT m.*, r.name AS room, o.name AS organizer, (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id) AS invited, (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.rsvp='yes') AS yes,
  (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.rsvp='no') AS no, (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.attended=1) AS came FROM meetings m LEFT JOIN rooms r ON r.id=m.room_id LEFT JOIN employees o ON o.id=m.organizer_id`;
meetingsRouter.get('/meetings', (req, res) => {
  const w = [], a = [], q = req.query;
  if (q.from) { w.push('m.end_ts>=?'); a.push(q.from.slice(0, 10) + ' 00:00'); } if (q.to) { w.push('m.start_ts<=?'); a.push(q.to.slice(0, 10) + ' 23:59'); }
  if (q.room_id) { w.push('m.room_id=?'); a.push(q.room_id); } if (q.status) { w.push('m.status=?'); a.push(q.status); }
  if (q.employee_id) { w.push('(m.organizer_id=? OR EXISTS (SELECT 1 FROM meeting_attendees x WHERE x.meeting_id=m.id AND x.employee_id=?))'); a.push(q.employee_id, q.employee_id); }
  res.json(db.prepare(`${LIST} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY m.start_ts LIMIT 500`).all(...a));
});
meetingsRouter.get('/meetings/:id', (req, res) => {
  const m = db.prepare(`${LIST} WHERE m.id=?`).get(req.params.id); if (!m) return fail(res, 'No such meeting', 404);
  res.json({ ...m, attendees: db.prepare('SELECT e.id, e.code, e.name, a.rsvp, a.attended FROM meeting_attendees a JOIN employees e ON e.id=a.employee_id WHERE a.meeting_id=? ORDER BY e.name').all(m.id) });
});
