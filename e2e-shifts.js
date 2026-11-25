// Shift definitions, rotations, department shift, calendar, auto-assign, change and swap requests.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const iso = (d) => d.toISOString().slice(0, 10), addD = (n) => iso(new Date(Date.now() + n * 864e5));
const as = (token) => ({ send: async (p, m, b) => { const r = await S.raw(p, m, b, token); return { status: r.status, body: await r.json().catch(() => ({})) }; } });
try {
  // ---- shift definitions and their validation
  const mk = (b) => api('shifts', 'POST', b);
  const morning = (await mk({ name: 'Morning', code: 'M', start: '06:00', end: '14:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' })).id;
  const evening = (await mk({ name: 'Evening', code: 'E', start: '14:00', end: '22:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' })).id;
  const flexi = (await mk({ name: 'Flexi', type: 'flexible', start: '07:00', end: '22:00', grace_min: 0, workdays: '1,2,3,4,5', required_min: 480 })).id;
  const split = (await mk({ name: 'Split', type: 'split', start: '09:00', end: '13:00', seg2_start: '17:00', seg2_end: '21:00', grace_min: 10, workdays: '1,2,3,4,5', break_start: '', break_end: '' })).id;
  await assert.rejects(mk({ name: 'x', start: '9am', end: '18:00' }), /HH:MM/);
  await assert.rejects(mk({ name: 'x', type: 'weird', start: '09:00', end: '18:00' }), /Type must be/);
  await assert.rejects(mk({ name: 'x', type: 'flexible', start: '07:00', end: '22:00' }), /hours to work/);
  await assert.rejects(mk({ name: 'x', type: 'split', start: '09:00', end: '13:00', seg2_start: '12:00', seg2_end: '21:00' }), /in order/);
  await assert.rejects(mk({ name: 'x', start: '09:00', end: '18:00', break_start: '13:00' }), /both break start and break end/);
  await assert.rejects(mk({ name: 'x', start: '09:00', end: '18:00', alt_off: '9:1' }), /Alternate off/);
  await assert.rejects(mk({ name: 'x', start: '09:00', end: '18:00', workdays: '1,9' }), /Work days/);
  await assert.rejects(mk({ name: 'x', start: '09:00', end: '18:00', ot_policy_id: 999 }), /overtime policy/);
  await assert.rejects(mk({ name: '', start: '09:00', end: '18:00' }), /Name/);
  await api('shifts/' + morning, 'PUT', { grace_min: 15, break_start: '10:00', break_end: '10:30' });
  const got = (await api('shifts')).find(s => s.id === morning); assert.equal(got.grace_min, 15); assert.equal(got.break_end, '10:30'); assert.equal(got.name, 'Morning', 'a partial update keeps the rest');
  await assert.rejects(api('shifts/' + morning, 'PUT', { start: 'bad' }), /HH:MM/);

  // ---- employees, department default shift
  const eng = (await api('departments', 'POST', { name: 'Plant' })).id;
  const emp = async (name, extra = {}) => { const r = await api('employees', 'POST', { name, join_date: '2026-06-01', ...extra }); return r; };
  const A = await emp('Ayesha', { shift_id: morning }), B = await emp('Bilal', { shift_id: evening }), C = await emp('Chand'), D = await emp('Danish', { department_id: eng });
  await api('departments/' + eng + '/shift', 'PUT', { shift_id: flexi });
  await assert.rejects(api('departments/' + eng + '/shift', 'PUT', { shift_id: 999 }), /Unknown shift/);
  const month = addD(3).slice(0, 7);
  const calendar = async () => api('shifts/calendar?month=' + month);
  const cell = (cal, emp, date) => cal.rows.find(r => r.code === emp.code).cells[cal.days.indexOf(date)];
  let cal = await calendar();
  assert.equal(cell(cal, D, addD(3)).c !== undefined, true);
  assert.equal(cell(cal, D, addD(3)).source === 'department' || cell(cal, D, addD(3)).c === 'OFF', true, 'Danish takes his department\'s shift');
  assert.equal(cell(cal, C, addD(3)).c, '-', 'no shift anywhere');

  // ---- rotation
  const rot = async (b) => api('rotations', 'POST', b);
  await assert.rejects(rot({ name: 'bad', steps: [] }), /1 to 30 steps/);
  await assert.rejects(rot({ name: 'bad', steps: [{ shift_id: morning, days: 0 }] }), /1 to 60/);
  await assert.rejects(rot({ name: 'bad', steps: [{ shift_id: 999, days: 2 }] }), /Unknown shift/);
  const r1 = (await rot({ name: '2M-1off-2E', steps: [{ shift_id: morning, days: 2 }, { shift_id: null, days: 1 }, { shift_id: evening, days: 2 }] })).id;
  await assert.rejects(rot({ name: '2M-1off-2E', steps: [{ shift_id: morning, days: 1 }] }), /exists/);
  await assert.rejects(api('employees/' + C.id, 'PUT', { rotation_id: r1 }), /rotation starts/);
  const anchor = addD(3);
  await api('employees/' + C.id, 'PUT', { rotation_id: r1, rotation_anchor: anchor });
  cal = await calendar();
  const seq = [0, 1, 2, 3, 4, 5].map(i => cell(cal, C, addD(3 + i)));
  const day = (i) => addD(3 + i);
  if ([0, 1, 2, 3, 4, 5].every(i => day(i).startsWith(month))) assert.deepEqual(seq.map(c => c.c), ['M', 'M', 'OFF', 'E', 'E', 'M']);
  assert.equal((await api('rotations'))[0].employees, 1);
  await assert.rejects(api('rotations/' + r1, 'DELETE'), /still on this rotation/);
  await assert.rejects(api('shifts/' + morning, 'DELETE'), /still used by/);
  await api('rotations/' + r1, 'PUT', { steps: [{ shift_id: evening, days: 3 }, { shift_id: null, days: 1 }] });
  assert.equal((await api('rotations'))[0].steps.length, 2);

  // ---- roster entries cut older ones
  const dA = addD(10);
  await api('schedules', 'POST', { employee_id: A.id, shift_id: evening, from_date: dA, to_date: addD(14) });
  await api('schedules', 'POST', { employee_id: A.id, shift_id: morning, from_date: addD(11), to_date: addD(12) });
  const entries = (await api('schedules')).filter(s => s.employee_id === A.id).sort((a, b) => a.from_date.localeCompare(b.from_date));
  assert.deepEqual(entries.map(e => `${e.shift[0]} ${e.from_date}..${e.to_date}`), [`E ${dA}..${dA}`, `M ${addD(11)}..${addD(12)}`, `E ${addD(13)}..${addD(14)}`]);
  await assert.rejects(api('schedules', 'POST', { employee_id: A.id, shift_id: evening, from_date: addD(5), to_date: addD(4) }), /dates/);

  // ---- change and swap requests
  const when = addD(20), when2 = addD(21);
  const month2 = when.slice(0, 7), monthCal = async () => api('shifts/calendar?month=' + month2);
  const at = async (e, d) => { const c = await monthCal(); return c.rows.find(r => r.code === e.code).cells[c.days.indexOf(d)].c; };
  await assert.rejects(api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: morning, from_date: addD(-3), to_date: addD(-2), reason: 'x' }), /today or later/);
  await assert.rejects(api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: morning, from_date: when, to_date: when }), /reason/);
  await assert.rejects(api('shifts/requests', 'POST', { kind: 'swap', employee_id: B.id, other_employee_id: B.id, from_date: when, to_date: when, reason: 'x' }), /different/);
  const ch = await api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: morning, from_date: when, to_date: when2, reason: 'Exam in the evening' });
  assert.equal(ch.status, 'pending'); assert.equal(await at(B, when), 'E', 'nothing changes until approved');
  assert.ok((await api('notifications')).items.some(n => /Shift change request/.test(n.title)));
  await api(`shifts/requests/${ch.id}/approve`, 'POST', {});
  assert.equal(await at(B, when), 'M'); assert.equal(await at(B, when2), 'M');
  await assert.rejects(api(`shifts/requests/${ch.id}/approve`, 'POST', {}), /Only pending/);
  // swap: A works Morning, B now Morning too -> same shifts is an error; make B Evening again via a direct change first
  await api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: evening, from_date: when, to_date: when2, reason: 'back', auto_approve: true });
  assert.equal(await at(B, when), 'E');
  const sw = await api('shifts/requests', 'POST', { kind: 'swap', employee_id: A.id, other_employee_id: B.id, from_date: when, to_date: when2, reason: 'Swapping weekends' });
  await api(`shifts/requests/${sw.id}/approve`, 'POST', {});
  assert.equal(await at(A, when), 'E'); assert.equal(await at(B, when), 'M'); assert.equal(await at(A, when2), 'E'); assert.equal(await at(B, when2), 'M', 'both sides swapped');
  const same = await api('shifts/requests', 'POST', { kind: 'swap', employee_id: A.id, other_employee_id: B.id, from_date: when, to_date: when, reason: 'swap back' });
  await api(`shifts/requests/${same.id}/approve`, 'POST', {}); assert.equal(await at(A, when), 'M');                         // swapping back works
  const rj = await api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: morning, from_date: addD(30), to_date: addD(30), reason: 'nope' });
  await api(`shifts/requests/${rj.id}/reject`, 'POST', { note: 'Short staffed' });
  const cn = await api('shifts/requests', 'POST', { kind: 'change', employee_id: B.id, shift_id: morning, from_date: addD(31), to_date: addD(31), reason: 'meh' });
  await api(`shifts/requests/${cn.id}/cancel`, 'POST', {});
  assert.deepEqual((await api('shifts/requests?status=rejected')).map(r => r.decision_note), ['Short staffed']);

  // ---- auto-assign from real punches
  const E1 = await emp('Early bird'), E2 = await emp('Late bird'), E3 = await emp('New joiner');
  const L = [];
  for (let i = 1; i <= 8; i++) { const d = addD(-i); L.push(`${E1.code},${d} 06:05`, `${E1.code},${d} 14:00`, `${E2.code},${d} 14:10`, `${E2.code},${d} 22:00`); }
  L.push(`${E3.code},${addD(-1)} 09:00`);
  await api('logs/import', 'POST', { csv: L.join('\n') });
  const dry = await api('shifts/auto-assign', 'POST', { days: 30 });
  const by = Object.fromEntries(dry.results.map(r => [r.code, r]));
  assert.equal(by[E1.code].suggestion, 'Morning'); assert.equal(by[E2.code].suggestion, 'Evening'); assert.equal(by[E3.code].suggestion, null); assert.match(by[E3.code].reason, /Only 1 days/);
  assert.equal(dry.applied, 0); assert.equal((await api('employees/' + E1.id)).shift, null, 'a dry run changes nothing');
  assert.equal(by[A.code], undefined, 'people who already have a shift are left alone');
  const real = await api('shifts/auto-assign', 'POST', { days: 30, apply: true });
  assert.equal(real.applied >= 2, true); assert.equal((await api('employees/' + E1.id)).shift, 'Morning'); assert.equal((await api('employees/' + E3.id)).shift, null);

  const nos = await api('shifts/requests', 'POST', { kind: 'swap', employee_id: A.id, other_employee_id: E3.id, from_date: addD(40), to_date: addD(40), reason: 'x' });
  await assert.rejects(api(`shifts/requests/${nos.id}/approve`, 'POST', {}), /has no shift that day/);
  assert.equal((await api('shifts/requests?status=pending')).some(r => r.id === nos.id), true, 'a failed approval leaves the request pending');

  // ---- alternate shifts per employee, report type
  await api('employees/' + A.id + '/shifts', 'PUT', { shift_ids: [evening] });
  assert.deepEqual(await api('employees/' + A.id + '/shifts'), [evening]);
  await assert.rejects(api('employees/' + A.id + '/shifts', 'PUT', { shift_ids: [999] }), /Unknown shift/);
  const csv = await (await S.raw(`reports/shift_calendar/export?month=${month2}&format=csv`)).text();
  assert.match(csv.split('\n')[0], /"ID","Name","Department","01"/); assert.ok(csv.includes('Ayesha'));

  // ---- permissions: a scoped HR login may handle shift requests for its own people only
  await api('users', 'POST', { username: 'plant_hr', password: 'password1', role: 'hr', departments: [eng] });
  await api('users', 'POST', { username: 'viewer1', password: 'password1', role: 'viewer' });
  const hr = as(await S.login('plant_hr', 'password1')), vw = as(await S.login('viewer1', 'password1'));
  assert.equal((await hr.send('shifts/requests', 'POST', { kind: 'change', employee_id: A.id, shift_id: morning, from_date: addD(50), to_date: addD(50), reason: 'x' })).status, 403, 'outside the scope');
  assert.equal((await hr.send('shifts/requests', 'POST', { kind: 'change', employee_id: D.id, shift_id: morning, from_date: addD(50), to_date: addD(50), reason: 'x' })).status, 200);
  assert.equal((await hr.send('shifts/requests', 'POST', { kind: 'swap', employee_id: D.id, other_employee_id: A.id, from_date: addD(50), to_date: addD(50), reason: 'x' })).status, 403, 'a swap partner outside the scope is refused too');
  assert.equal((await hr.send('shifts', 'POST', { name: 'Mine', start: '09:00', end: '17:00' })).status, 403, 'shift definitions are company-wide');
  assert.equal((await hr.send('rotations', 'POST', { name: 'r', steps: [{ days: 1 }] })).status, 403);
  assert.equal((await vw.send('shifts', 'POST', { name: 'Mine', start: '09:00', end: '17:00' })).status, 403);
  assert.equal((await vw.send('shifts/calendar?month=' + month, 'GET')).status, 200);
  console.log('e2e-shifts passed: shift types, validation, rotation, department shift, roster carving, requests, auto-assign, scope');
} catch (e) { console.error('E2E-SHIFTS FAILED:', (e.stack || '').split('\n').filter(l => /e2e-shifts.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message.split('\n')[0]); process.exitCode = 1; }
finally { S.stop(); }
