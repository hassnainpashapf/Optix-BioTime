// Visitor (reasons, full form, reservation approval, transactions) and Meeting (full form, approval, manual log, calculation, transactions).
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const host = (await api('employees', 'POST', { name: 'Host Person', join_date: '2026-01-01' })).id;
  // ---- visitors
  assert.equal((await api('visitors/reasons', 'POST', { name: 'Interview' })).id > 0, true); await assert.rejects(api('visitors/reasons', 'POST', { name: 'Interview' }), /already exists/);
  const v = (await api('visitors', 'POST', { name: 'Sana', last_name: 'Malik', cert_type: 'Passport', id_no: 'P123', email: 'sana@x.com', visitor_qty: 2, visit_dept: 'HR', visit_reason: 'Interview', goods: 'Laptop', host_id: host, start_time: '2026-10-20 10:00', end_time: '2026-10-20 12:00' })).id;
  let row = (await api('visitors')).find(x => x.id === v); assert.equal(row.code, String(v), 'the Visitor ID is filled'); assert.equal(row.expected_date, '2026-10-20'); assert.equal(row.visitor_qty, 2); assert.equal(row.res_status, 'Approved');
  { const pw = await api('visitors', 'POST', { name: 'Pw', password: '1234', access_group: 'Default', fp_qty: 2, palm_qty: 0, face_qty: 1 }); const got = (await api('visitors')).find((x) => x.id === pw.id); assert.equal(got.password, '1234'); assert.equal(got.access_group, 'Default'); assert.equal(got.fp_qty, 2); assert.equal(got.face_qty, 1); await assert.rejects(api('visitors', 'POST', { name: 'Q', fp_qty: -1 }), /whole numbers/);
    assert.equal((await api('rooms/daily-used?view_date=2026-10-20')).length >= 0, true); await assert.rejects(api('rooms/daily-used?view_date=x'), /view_date/); }
  await assert.rejects(api('visitors', 'POST', { name: 'X', visitor_qty: 0 }), /Quantity/); await assert.rejects(api('visitors', 'POST', { name: 'X', start_time: '2026-10-20 12:00', end_time: '2026-10-20 10:00' }), /after Start/); await assert.rejects(api('visitors', 'POST', { name: 'X', email: 'nope' }), /Email/);
  // reservations wait for approval; a rejected one cannot be checked in
  const r1 = (await api('visitors', 'POST', { name: 'Reserved', host_id: host, expected_date: '2026-10-21', reservation: true })).id; assert.equal((await api('visitors')).find(x => x.id === r1).res_status, 'Pending');
  await assert.rejects(api(`visitors/${r1}/approval`, 'POST', { action: 'revoke' }), /Only an approved/); await api(`visitors/${r1}/approval`, 'POST', { action: 'reject', comment: 'No' });
  const rr = (await api('visitors')).find(x => x.id === r1); assert.equal(rr.res_status, 'Rejected'); assert.equal(rr.res_comment, 'No'); assert.ok(rr.res_at);
  await assert.rejects(api(`visitors/${r1}/check-in`, 'POST', {}), /rejected/);
  const r2 = (await api('visitors', 'POST', { name: 'Second', host_id: host, expected_date: '2026-10-21', reservation: true })).id; await api(`visitors/${r2}/approval`, 'POST', { action: 'approve' }); await api(`visitors/${r2}/check-in`, 'POST', {}); await api(`visitors/${r2}/check-out`, 'POST', {});
  const tx = await api('visitors/transactions'); assert.equal(tx.filter(t => t.name === 'Second').length, 2, 'a sign-in and a sign-out line'); assert.equal(tx[0].verify, 'Manual');
  // ---- meetings
  const room = (await api('rooms', 'POST', { name: 'Board room', capacity: 10, remark: 'Second floor' })).id; assert.equal((await api('rooms')).find(r => r.id === room).remark, 'Second floor');
  const a = (await api('employees', 'POST', { name: 'Attendee A', join_date: '2026-01-01' })).id, b2 = (await api('employees', 'POST', { name: 'Attendee B', join_date: '2026-01-01' })).id;
  const day = new Date().toLocaleDateString('sv');
  const m = (await api('meetings', 'POST', { title: 'Weekly sync', topic: 'Targets', timezone: 'Asia/Karachi', purpose: 'Plan', auto_approved: false, organizer_id: host, room_id: room, start: `${day} 09:00`, end: `${day} 10:00`, attendees: [a], checkin_required: true, checkin_start: '08:45', checkin_end: '09:15' })).id;
  let mm = (await api('meetings')).find(x => x.id === m); assert.equal(mm.topic, 'Targets'); assert.equal(mm.approval_status, 'Pending'); assert.equal(mm.checkin_start, '08:45'); assert.equal(mm.timezone, 'Asia/Karachi');
  await assert.rejects(api('meetings', 'POST', { title: 'Bad', start: `${day} 11:00`, end: `${day} 12:00`, checkin_start: '9am' }), /09:00/);
  await api(`meetings/${m}/approval`, 'POST', { action: 'approve', comment: 'ok' }); mm = (await api('meetings')).find(x => x.id === m); assert.equal(mm.approval_status, 'Approved'); assert.equal(mm.approval_comment, 'ok'); await assert.rejects(api(`meetings/${m}/approval`, 'POST', { action: 'approve' }), /already/);
  assert.equal((await api(`meetings/${m}/attendees`, 'POST', { employee_ids: [b2] })).added, 1);
  // a manual log needs approval; once approved it counts as attendance and shows as a transaction
  const l = await api('meeting-manual-logs', 'POST', { meeting_id: m, employee_ids: [a], punch_time: `${day} 09:05`, reason: 'Forgot to punch' }); assert.equal(l.added, 1);
  let calc = await api(`meetings/${m}/calculate`, 'POST', {}); assert.equal(calc.attended, 0, 'a pending manual log does not count');
  const lid = (await api('meeting-manual-logs'))[0].id; assert.equal((await api('meeting-manual-logs/action', 'POST', { action: 'approve', ids: [lid] })).done, 1);
  calc = await api(`meetings/${m}/calculate`, 'POST', {}); assert.deepEqual(calc, { attended: 1, invited: 2 });
  const mt = await api('meeting-transactions'); assert.ok(mt.some(t => t.source === 'Manual' && t.name === 'Attendee A'));
  await assert.rejects(api(`meetings/${m}/sync-device`, 'POST', {}), /no room with a device/);
  await api(`meetings/${m}/approval`, 'POST', { action: 'revoke' }); assert.equal((await api('meetings')).find(x => x.id === m).status, 'cancelled', 'a revoked meeting is cancelled');
  console.log('e2e-vmeet passed: visitor form, reasons, reservation approval, transactions, meeting form, approval, manual log, calculation');
} finally { S.stop(); }
