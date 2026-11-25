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
  try { res.json({ id: Number(db.prepare('INSERT INTO rooms(name, capacity, location, device_id, remark) VALUES(?,?,?,?,?)').run(name, cap, String(req.body?.location ?? '').slice(0, 100) || null, req.body?.device_id ? Number(req.body.device_id) : null, String(req.body?.remark ?? '').slice(0, 200) || null).lastInsertRowid) }); } catch { fail(res, 'A room with this name exists'); }
});
meetingsRouter.put('/rooms/:id', (req, res) => {
  const b = req.body ?? {}; if ('remark' in b) db.prepare('UPDATE rooms SET remark=? WHERE id=?').run(String(b.remark ?? '').slice(0, 200) || null, req.params.id); if ('name' in b && !String(b.name).trim()) return fail(res, 'Name required');
  try { db.prepare('UPDATE rooms SET name=COALESCE(?,name), capacity=COALESCE(?,capacity), location=COALESCE(?,location), active=COALESCE(?,active), device_id=CASE WHEN ? THEN ? ELSE device_id END WHERE id=?').run(b.name ? String(b.name).trim().slice(0, 60) : null, b.capacity ? Number(b.capacity) : null, b.location ?? null, 'active' in b ? (b.active ? 1 : 0) : null, 'device_id' in b ? 1 : 0, b.device_id ? Number(b.device_id) : null, req.params.id); res.json({ ok: true }); } catch { fail(res, 'A room with this name exists'); }
});
meetingsRouter.delete('/rooms/:id', (req, res) => { db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id); res.json({ ok: true }); });
meetingsRouter.get('/rooms/availability', (req, res) => {
  const { start, end } = req.query; if (!TS.test(start ?? '') || !TS.test(end ?? '') || ts(end) <= ts(start)) return fail(res, 'Give a start and an end (YYYY-MM-DD HH:MM)');
  res.json(db.prepare(`SELECT r.* FROM rooms r WHERE r.active=1 AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.room_id=r.id AND m.status='scheduled' AND m.start_ts<? AND m.end_ts>?) ORDER BY r.name`).all(ts(end), ts(start)));
});

// the rooms with what is booked in each on one day (the room picker of the Add Meeting dialog)
meetingsRouter.get('/rooms/daily-used', (req, res) => {
  const d = String(req.query.view_date ?? ''); if (!/^\d{4}-\d\d-\d\d$/.test(d)) return fail(res, 'view_date must be YYYY-MM-DD');
  res.json(db.prepare('SELECT id, name, capacity, location FROM rooms WHERE active=1 ORDER BY name').all().map((r) => ({ ...r,
    been_used: db.prepare("SELECT title, start_ts, end_ts FROM meetings WHERE room_id=? AND status='scheduled' AND substr(start_ts,1,10)<=? AND substr(end_ts,1,10)>=? ORDER BY start_ts").all(r.id, d, d).map((m) => `${m.start_ts.slice(11, 16)}-${m.end_ts.slice(11, 16)} ${m.title}`).join('; ') })));
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
  const x = {}, f = (k, n) => { if (k in b) x[k] = b[k] === '' || b[k] == null ? null : String(b[k]).slice(0, n); }, sw = (k) => { if (k in b) x[k] = b[k] === true || b[k] === 1 || b[k] === '1' ? 1 : 0; };
  f('topic', 200); f('timezone', 60); f('purpose', 500); f('auto_recording', 20); for (const k of ['online', 'auto_approved', 'waiting_room', 'join_before_host', 'mute_entry', 'host_video', 'participant_video', 'checkin_required', 'checkout_required']) sw(k);
  for (const k of ['checkin_start', 'checkin_end', 'checkout_start', 'checkout_end']) if (k in b) { const v = String(b[k] ?? '').trim(); if (v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return { error: 'Check-in and check-out times look like 09:00' }; x[k] = v || null; }
  if (x.auto_approved !== undefined) { x.approval_status = x.auto_approved ? 'Approved' : 'Pending'; }
  return { x, v: { title, start, end, room_id: room?.id ?? null, place: room ? null : String(b.place ?? '').slice(0, 120) || null, organizer_id: b.organizer_id || null, agenda: String(b.agenda ?? '').slice(0, 4000) }, ids, warnings };
}
const dropZoom = (m) => { if (m?.zoom_id) import('./zoom.js').then(z => z.deleteZoomMeeting(m.zoom_id)).catch(() => {}); }; // the Zoom meeting goes when the meeting is cancelled or deleted
const applyX = (id, x) => { const k = Object.keys(x ?? {}); if (k.length) db.prepare(`UPDATE meetings SET ${k.map(c => c + '=?')} WHERE id=?`).run(...k.map(c => x[c]), id); };
const invite = (id, ids, title, when, where, verb) => { for (const e of ids) notify({ audience: 'employee', employee_id: e, title: `${verb}: ${title}`, body: `${when}${where ? ' · ' + where : ''}`, link: 'Meetings' , kind: 'meeting'}); };
const place = (v, roomName) => roomName || v.place || '';
meetingsRouter.post('/meetings', async (req, res) => {
  const r = check(req.body ?? {}); if (r.error) return fail(res, r.error, r.error.includes('already booked') ? 409 : 400);
  db.exec('BEGIN');
  const id = Number(db.prepare('INSERT INTO meetings(title, organizer_id, room_id, place, start_ts, end_ts, agenda, created_by) VALUES(?,?,?,?,?,?,?,?)').run(r.v.title, r.v.organizer_id, r.v.room_id, r.v.place, r.v.start, r.v.end, r.v.agenda, req.user).lastInsertRowid);
  for (const e of r.ids) db.prepare('INSERT INTO meeting_attendees(meeting_id, employee_id) VALUES(?,?)').run(id, e); applyX(id, r.x); db.exec('COMMIT');
  invite(id, r.ids, r.v.title, `${r.v.start.replace(' ', ' at ')}`, place(r.v, r.v.room_id ? db.prepare('SELECT name FROM rooms WHERE id=?').get(r.v.room_id).name : null), 'Meeting invitation');
  const warnings = [...r.warnings];
  if (r.x?.online) {
    const { zoomOn, createZoomMeeting } = await import('./zoom.js');
    if (!zoomOn()) warnings.push('Online Meeting is on, but Zoom is not set up (System > Zoom Setting), so no Zoom link was created');
    else try { const z = await createZoomMeeting(db.prepare('SELECT * FROM meetings WHERE id=?').get(id)); db.prepare('UPDATE meetings SET zoom_id=?, join_url=?, start_url=?, zoom_user=? WHERE id=?').run(z.id, z.join_url, z.start_url, z.host, id); } catch (e) { warnings.push('The Zoom meeting could not be created: ' + e.message); }
  }
  res.json({ id, warnings });
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
  if (moved) db.prepare("UPDATE meeting_attendees SET rsvp='pending' WHERE meeting_id=?").run(m.id); applyX(m.id, r.x); db.exec('COMMIT');
  const where = place(r.v, r.v.room_id ? db.prepare('SELECT name FROM rooms WHERE id=?').get(r.v.room_id).name : null);
  invite(m.id, fresh, r.v.title, r.v.start.replace(' ', ' at '), where, 'Meeting invitation'); // people added now are invited; people already invited hear about a new time or room
  if (moved) invite(m.id, r.ids.filter(e => cur.includes(e)), r.v.title, r.v.start.replace(' ', ' at '), where, 'Meeting changed');
  res.json({ ok: true, warnings: r.warnings });
});
meetingsRouter.post('/meetings/:id/cancel', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404); if (m.status !== 'scheduled') return fail(res, 'This meeting is not scheduled');
  db.prepare("UPDATE meetings SET status='cancelled' WHERE id=?").run(m.id); dropZoom(m);
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
meetingsRouter.delete('/meetings/:id', (req, res) => { dropZoom(db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id)); db.prepare('DELETE FROM meetings WHERE id=?').run(req.params.id); res.json({ ok: true }); });
const LIST = `SELECT m.*, r.name AS room, r.device_id AS room_device, o.name AS organizer, (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id) AS invited, (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id=m.id AND a.rsvp='yes') AS yes,
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

// ---------- approval, attendance calculation, adding people, sending people to the room's device ----------
const now = () => new Date().toLocaleString('sv');
meetingsRouter.post('/meetings/:id/approval', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404);
  const a = String(req.body?.action ?? ''), to = { approve: 'Approved', reject: 'Rejected', revoke: 'Revoked' }[a]; if (!to) return fail(res, 'Choose approve, reject or revoke');
  if (a === 'revoke' && m.approval_status !== 'Approved') return fail(res, 'Only an approved meeting can be revoked'); if (a !== 'revoke' && m.approval_status !== 'Pending') return fail(res, `This meeting is already ${m.approval_status}`);
  db.prepare('UPDATE meetings SET approval_status=?, approval_comment=?, approver=?, approved_at=? WHERE id=?').run(to, String(req.body?.comment ?? '').slice(0, 300) || null, req.user ?? null, now(), m.id);
  if (a !== 'approve') { db.prepare("UPDATE meetings SET status='cancelled' WHERE id=? AND status='scheduled'").run(m.id); dropZoom(m); } res.json({ ok: true, status: to });
});
const inWindow = (m) => { const day = m.start_ts.slice(0, 10), t = (hm, d) => hm ? `${day} ${hm}` : d; return { from: t(m.checkin_start, addMin(m.start_ts, -30)), to: t(m.checkout_end, m.end_ts) }; };
const addMin = (s, n) => new Date(Date.parse(s.replace(' ', 'T')) + n * 60000).toLocaleString('sv').slice(0, 16);
// Who came: a punch inside the meeting's window (at the room's device when it has one) or an approved manual log marks the person as attended.
meetingsRouter.post('/meetings/:id/calculate', (req, res) => {
  const m = db.prepare('SELECT m.*, r.device_id FROM meetings m LEFT JOIN rooms r ON r.id=m.room_id WHERE m.id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404);
  const w = inWindow(m); let came = 0, total = 0;
  for (const a of db.prepare('SELECT a.employee_id, e.code FROM meeting_attendees a JOIN employees e ON e.id=a.employee_id WHERE a.meeting_id=?').all(m.id)) {
    total++;
    const punch = db.prepare(`SELECT 1 FROM logs WHERE emp_code=? AND ts>=? AND ts<=?${m.device_id ? ' AND device_id=?' : ''} LIMIT 1`).get(a.code, w.from + ':00', w.to + ':59', ...(m.device_id ? [m.device_id] : []));
    const manual = db.prepare("SELECT 1 FROM meeting_manual_logs WHERE meeting_id=? AND employee_id=? AND status='Approved' LIMIT 1").get(m.id, a.employee_id);
    const ok = punch || manual ? 1 : 0; came += ok; db.prepare('UPDATE meeting_attendees SET attended=? WHERE meeting_id=? AND employee_id=?').run(ok, m.id, a.employee_id);
  }
  res.json({ attended: came, invited: total });
});
meetingsRouter.post('/meetings/:id/attendees', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404);
  const ids = [...new Set((req.body?.employee_ids ?? []).map(Number).filter(Number.isInteger))]; let n = 0;
  for (const id of ids) { if (!db.prepare('SELECT 1 FROM employees WHERE id=? AND active=1').get(id)) continue; n += Number(db.prepare('INSERT OR IGNORE INTO meeting_attendees(meeting_id, employee_id) VALUES(?,?)').run(m.id, id).changes); }
  invite(m.id, ids, m.title, m.start_ts.replace(' ', ' at '), null, 'Meeting invitation'); res.json({ added: n });
});
// Put the invited people on the room's device so they can punch there.
meetingsRouter.post('/meetings/:id/sync-device', async (req, res) => {
  const m = db.prepare('SELECT m.*, r.device_id FROM meetings m LEFT JOIN rooms r ON r.id=m.room_id WHERE m.id=?').get(req.params.id); if (!m) return fail(res, 'No such meeting', 404);
  const d = m.device_id ? db.prepare('SELECT * FROM devices WHERE id=?').get(m.device_id) : null; if (!d) return fail(res, 'This meeting has no room with a device');
  const people = db.prepare('SELECT e.code, e.name, e.card_no AS card, e.device_priv AS role FROM meeting_attendees a JOIN employees e ON e.id=a.employee_id WHERE a.meeting_id=?').all(m.id);
  try {
    if (d.sn && d.approved) { const { queueCommand, userCmd } = await import('./devsync.js'); for (const p of people) queueCommand(d.id, userCmd(p.code, p.name, p.card ?? '', p.role ?? 0)); return res.json({ sent: people.length, mode: 'push' }); }
    if (d.ip && d.approved) { const { sendUsersToDevice } = await import('./zk.js'); await sendUsersToDevice(d, people); return res.json({ sent: people.length, mode: 'pull' }); }
    fail(res, 'The room device is not approved');
  } catch (e) { fail(res, 'Could not reach the device: ' + e.message, 502); }
});

// ---------- manual log (a punch added by hand for a meeting) and transactions ----------
const STATES = ['Check In', 'Check Out'];
meetingsRouter.get('/meeting-manual-logs', (_q, res) => res.json(db.prepare(`SELECT l.*, m.title AS meeting, e.code, e.name, e.last_name, e.photo IS NOT NULL AS has_photo FROM meeting_manual_logs l JOIN meetings m ON m.id=l.meeting_id JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC LIMIT 1000`).all()));
meetingsRouter.post('/meeting-manual-logs', (req, res) => {
  const b = req.body ?? {}, m = db.prepare('SELECT * FROM meetings WHERE id=?').get(b.meeting_id); if (!m) return fail(res, 'Choose a meeting');
  const ids = [...new Set((b.employee_ids ?? (b.employee_id ? [b.employee_id] : [])).map(Number).filter(Number.isInteger))]; if (!ids.length) return fail(res, 'Choose at least one employee');
  const t = ts(b.punch_time ?? ''); if (!TS.test(t)) return fail(res, 'Punch time looks like 2026-10-20 14:30'); const st = STATES.includes(b.state) ? b.state : 'Check In', auto = !!b.auto_approve; let n = 0;
  for (const id of ids) { if (!db.prepare('SELECT 1 FROM employees WHERE id=?').get(id)) continue; db.prepare('INSERT INTO meeting_manual_logs(meeting_id, employee_id, punch_ts, state, reason, status, decided_by, decided_at, created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(m.id, id, t, st, String(b.reason ?? '').slice(0, 300) || null, auto ? 'Approved' : 'Pending', auto ? req.user : null, auto ? now() : null, req.user); n++; }
  res.json({ added: n });
});
meetingsRouter.post('/meeting-manual-logs/action', (req, res) => {
  const a = String(req.body?.action ?? ''), to = { approve: 'Approved', reject: 'Rejected', revoke: 'Revoked' }[a]; if (!to) return fail(res, 'Choose approve, reject or revoke'); let n = 0;
  for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) { const l = db.prepare('SELECT * FROM meeting_manual_logs WHERE id=?').get(id); if (!l) continue; if (a === 'revoke' ? l.status !== 'Approved' : l.status !== 'Pending') continue; n += Number(db.prepare('UPDATE meeting_manual_logs SET status=?, comment=?, decided_by=?, decided_at=? WHERE id=?').run(to, String(req.body?.comment ?? '').slice(0, 300) || null, req.user, now(), id).changes); }
  res.json({ done: n });
});
meetingsRouter.post('/meeting-manual-logs/delete', (req, res) => { let n = 0; for (const id of (req.body?.ids ?? []).map(Number).filter(Number.isInteger)) n += Number(db.prepare('DELETE FROM meeting_manual_logs WHERE id=?').run(id).changes); res.json({ deleted: n }); });
// Punches that belong to a meeting (inside its window, at the room's device) plus approved manual logs.
meetingsRouter.get('/meeting-transactions', (_q, res) => {
  const out = [];
  for (const m of db.prepare('SELECT m.*, r.device_id, r.name AS room FROM meetings m LEFT JOIN rooms r ON r.id=m.room_id ORDER BY m.start_ts DESC LIMIT 200').all()) {
    const w = inWindow(m);
    for (const l of db.prepare(`SELECT l.id, l.ts, e.code, e.name, e.last_name, d.name AS terminal FROM logs l JOIN employees e ON e.code=l.emp_code JOIN meeting_attendees a ON a.employee_id=e.id AND a.meeting_id=? LEFT JOIN devices d ON d.id=l.device_id WHERE l.ts>=? AND l.ts<=?${m.device_id ? ' AND l.device_id=?' : ''} ORDER BY l.ts`).all(m.id, w.from + ':00', w.to + ':59', ...(m.device_id ? [m.device_id] : [])))
      out.push({ id: 'p' + l.id, meeting: m.title, code: l.code, name: l.name, last_name: l.last_name ?? '', date: l.ts.slice(0, 10), time: l.ts.slice(11, 19), state: '', terminal: l.terminal ?? '', source: 'Device' });
  }
  for (const l of db.prepare("SELECT l.id, l.punch_ts, l.state, m.title, e.code, e.name, e.last_name FROM meeting_manual_logs l JOIN meetings m ON m.id=l.meeting_id JOIN employees e ON e.id=l.employee_id WHERE l.status='Approved'").all())
    out.push({ id: 'm' + l.id, meeting: l.title, code: l.code, name: l.name, last_name: l.last_name ?? '', date: l.punch_ts.slice(0, 10), time: l.punch_ts.slice(11) + ':00', state: l.state, terminal: '', source: 'Manual' });
  res.json(out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)));
});
