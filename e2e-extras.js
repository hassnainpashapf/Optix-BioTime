// Live monitor, dashboard widgets, visitors, meetings, notification rules, temperature readings, device IP allow-list, security headers.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer({ SMTP_URL: 'json:' }), api = S.api;
const iso = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA'), today = iso(0), sleep = (ms) => new Promise(r => setTimeout(r, ms));
const as = (token) => ({ send: async (p, m, b) => { const r = await S.raw(p, m, b, token); return { status: r.status, body: await r.json().catch(() => ({})) }; } });
const P = async (path, token, method = 'GET', body) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const sessions = new Map();
const portal = async (emp) => { // a signed-in employee session (one per person)
  if (sessions.has(emp.id)) return sessions.get(emp.id);
  const pw = (await api('portal-accounts', 'POST', { employee_ids: [emp.id] })).accounts[0].password;
  const t = (await P('login', null, 'POST', { code: emp.code, password: pw })).body.token; await P('password', t, 'POST', { current: pw, password: 'new-password-' + emp.code });
  const tok = (await P('login', null, 'POST', { code: emp.code, password: 'new-password-' + emp.code })).body.token; sessions.set(emp.id, tok); return tok;
};
try {
  const hq = (await api('branches', 'POST', { name: 'HQ' })).id, khi = (await api('branches', 'POST', { name: 'Karachi' })).id, eng = (await api('departments', 'POST', { name: 'Engineering' })).id;
  await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '23:59', grace_min: 10, workdays: '0,1,2,3,4,5,6' });
  const mk = (name, extra) => api('employees', 'POST', { name, shift_id: 1, join_date: iso(-400), department_id: eng, ...extra });
  const boss = await mk('Boss Bilal', { branch_id: hq, email: 'boss@x.com' }), a1 = await mk('Aamir', { branch_id: hq, manager_id: boss.id, email: 'aamir@x.com' }), a2 = await mk('Bushra', { branch_id: hq, manager_id: boss.id }), k1 = await mk('Kamran', { branch_id: khi }), k2 = await mk('Komal', { branch_id: khi });
  const grpH = (await api('device_groups', 'POST', { name: 'HQ', branch_id: hq })).id, grpK = (await api('device_groups', 'POST', { name: 'KHI', branch_id: khi })).id;
  const dH = (await api('devices', 'POST', { name: 'HQ gate', sn: 'HQ-1', group_id: grpH })).id, dK = (await api('devices', 'POST', { name: 'KHI gate', sn: 'KHI-1', group_id: grpK })).id; void dH; void dK;
  const simH = new SimDevice(S.base, 'HQ-1'), simK = new SimDevice(S.base, 'KHI-1'); await simH.poll(); await simK.poll();
  await simH.upload('ATTLOG', [`${a1.code}\t${today} 08:55:00\t0\t1`, `${boss.code}\t${today} 10:30:00\t0\t1`]);                     // Aamir on time, the boss late
  await simK.upload('ATTLOG', [`${k1.code}\t${today} 08:50:00\t0\t1`]);

  // ---- live monitor
  const mon = await api('monitor'); const b = Object.fromEntries(mon.branches.map(x => [x.name, x]));
  assert.equal(b.HQ.employees, 3); assert.equal(b.HQ.present, 2); assert.equal(b.HQ.late, 1); assert.equal(b.HQ.not_in, 1); assert.equal(b.Karachi.present, 1); assert.equal(b.Karachi.not_in, 1);
  assert.equal(b.HQ.devices, 1); assert.equal(b.HQ.devices_online, 1); assert.equal(mon.totals.employees, 5); assert.equal(mon.totals.present, 3);
  assert.equal(mon.feed.length, 3); assert.ok(mon.feed[0].id > mon.feed[1].id, 'newest first'); assert.equal(mon.feed.find(f => f.code === a1.code).branch, 'HQ'); assert.equal((await api('monitor?limit=1')).feed.length, 1);
  await api('users', 'POST', { username: 'khi_mgr', password: 'password1', role: 'manager', branches: [khi] }); const km = as(await S.login('khi_mgr', 'password1'));
  const kmon = (await km.send('monitor', 'GET')).body; assert.deepEqual(kmon.branches.filter(x => x.employees).map(x => x.name), ['Karachi'], 'a scoped login only sees its own branch'); assert.equal(kmon.feed.every(f => f.branch === 'Karachi'), true);

  // ---- dashboard widgets
  const pr = await api('dashboard/prefs'); assert.deepEqual(pr.widgets, ['pending', 'not_in', 'late_today', 'live']); assert.ok(pr.available.length >= 10);
  await assert.rejects(api('dashboard/prefs', 'PUT', { widgets: ['nope'] }), /Unknown widget/); await api('dashboard/prefs', 'PUT', { widgets: ['late_today', 'headcount', 'trend7', 'devices', 'birthdays', 'anniversaries', 'live', 'pending', 'not_in', 'on_leave'] });
  assert.equal((await api('dashboard/prefs')).widgets[0], 'late_today', 'order is remembered per person');
  assert.deepEqual((await api('users')).length >= 2 && (await S.raw('dashboard/prefs', 'GET', undefined, S.token)).status, 200);
  const md = (n) => iso(n).slice(5), yr = new Date().getFullYear();
  await api('employees/' + k2.id, 'PUT', { dob: `${yr - 30}-${md(3)}`, join_date: `${yr - 3}-${md(5)}` });
  const w = await api('dashboard/widgets?ids=late_today,not_in,on_leave,live,trend7,devices,birthdays,anniversaries,headcount,pending');
  assert.deepEqual(w.late_today.map(x => x.name), ['Boss Bilal']); assert.deepEqual(w.not_in.map(x => x.name).sort(), ['Bushra', 'Komal']);
  assert.equal(w.birthdays[0].name, 'Komal'); assert.equal(w.birthdays[0].in_days, 3); assert.equal(w.anniversaries[0].years, 3); assert.equal(w.anniversaries[0].in_days, 5);
  assert.equal(w.headcount[0].n, 5); assert.equal(w.devices.total, 2); assert.equal(w.devices.online, 2); assert.equal(w.live.length, 3); assert.ok(w.trend7.length >= 1); assert.equal(w.pending.leaves, 0);
  assert.deepEqual((await api('dashboard/widgets?ids=bogus')), {}, 'unknown widgets are ignored');
  await api('users', 'POST', { username: 'nodash', password: 'password1', role: 'viewer' }); await api('roles', 'POST', { name: 'blind', perms: {} }); await api('users', 'POST', { username: 'blind1', password: 'password1', role: 'blind' });
  assert.deepEqual((await as(await S.login('blind1', 'password1')).send('dashboard/widgets?ids=late_today', 'GET')).body, {}, 'no attendance access, no people on the dashboard');

  // ---- visitors
  const hostTok = await portal(boss);
  const v = (b) => api('visitors', 'POST', b);
  await assert.rejects(v({}), /name is required/); await assert.rejects(v({ name: 'X', phone: 'abc' }), /Phone/); await assert.rejects(v({ name: 'X', expected_date: '1/1/2026' }), /YYYY-MM-DD/); await assert.rejects(v({ name: 'X', host_code: '999999' }), /Unknown host/);
  const v1 = await v({ name: 'Sara Supplier', company: 'Acme Ltd', phone: '0300-1234567', id_no: '35202-1', purpose: 'Contract meeting', host_code: boss.code, expected_date: today, expected_time: '11:00' }); assert.equal(v1.status, 'expected');
  const ci = await api(`visitors/${v1.id}/check-in`, 'POST', {}); assert.equal(ci.badge_no, '1');
  const v2 = await v({ name: 'Walk-in Wali', purpose: 'Delivery', check_in: true }); assert.equal(v2.status, 'in'); assert.equal(v2.badge_no, '2');
  const v3 = await v({ name: 'Third Tariq', expected_date: today }); await assert.rejects(api(`visitors/${v3.id}/check-in`, 'POST', { badge_no: '2' }), /already in use/); assert.equal((await api(`visitors/${v3.id}/check-in`, 'POST', { badge_no: 'V-9' })).badge_no, 'V-9');
  await assert.rejects(api(`visitors/${v1.id}/check-in`, 'POST', {}), /already signed in/);
  const note = (await P('notifications', hostTok)).body.items.find(n => /visitor has arrived/.test(n.title)); assert.ok(note && /Sara Supplier/.test(note.body) && /Badge 1/.test(note.body), 'the host is told in the portal');
  assert.ok((await api('notifications')).items.some(n => /Visitor: Sara Supplier/.test(n.title)));
  assert.deepEqual((await api('visitors?status=in')).map(x => x.name).sort(), ['Sara Supplier', 'Third Tariq', 'Walk-in Wali']); assert.equal((await api('visitors?q=acme')).length, 1); assert.equal((await api(`visitors?date=${today}`)).length, 3);
  await api('settings', 'PUT', { visitor_max_hours: 0.0005 }); await sleep(2100); assert.equal((await api('visitors?status=in')).every(x => x.overstay), true, 'signed in for too long is flagged'); await api('settings', 'PUT', { visitor_max_hours: 8 });
  await api(`visitors/${v1.id}/check-out`, 'POST'); await assert.rejects(api(`visitors/${v1.id}/check-out`, 'POST'), /not signed in/); assert.equal((await api('visitors?status=out'))[0].overstay, false); assert.ok((await api('visitors?status=out'))[0].minutes_in >= 0);
  assert.equal((await v({ name: 'Fresh Face', check_in: true })).badge_no, '1', 'a free badge number is reused');
  const exp = await v({ name: 'Maybe Mubeen', expected_date: today }); await api(`visitors/${exp.id}/cancel`, 'POST'); await assert.rejects(api(`visitors/${exp.id}/cancel`, 'POST'), /expected visit/);
  await api('visitors/blocklist', 'POST', { id_no: '99999-9', reason: 'Trespassed before' }); await api('visitors/blocklist', 'POST', { name: 'Banned Bashir' }); await assert.rejects(api('visitors/blocklist', 'POST', {}), /name, an ID/);
  await assert.rejects(v({ name: 'Anyone', id_no: '99999-9' }), /blocked list: Trespassed before/); await assert.rejects(v({ name: 'banned bashir' }), /blocked list/);
  const vcsv = await (await S.raw(`reports/visitors/export?from=${today}&to=${today}&format=csv`)).text(); assert.ok(vcsv.includes('Sara Supplier') && vcsv.includes('Acme Ltd'));
  assert.equal((await S.raw('visitors', 'GET', undefined, (await (async () => { await api('users', 'POST', { username: 'v1', password: 'password1', role: 'viewer' }); return S.login('v1', 'password1'); })()))).status, 200);

  // ---- meetings
  const room = (await api('rooms', 'POST', { name: 'Board room', capacity: 4, location: 'Floor 2' })).id; await assert.rejects(api('rooms', 'POST', { name: 'Board room' }), /exists/); await assert.rejects(api('rooms', 'POST', { name: 'x', capacity: 0 }), /Capacity/);
  const small = (await api('rooms', 'POST', { name: 'Huddle', capacity: 2 })).id;
  const t0 = `${iso(2)} 10:00`, t1 = `${iso(2)} 11:00`, mk2 = (b) => api('meetings', 'POST', { title: 'Weekly sync', start: t0, end: t1, room_id: room, organizer_id: boss.id, attendees: [boss.id, a1.id], ...b });
  await assert.rejects(mk2({ title: '' }), /Title/); await assert.rejects(mk2({ start: 'tomorrow' }), /2026|look like/); await assert.rejects(mk2({ end: t0 }), /after it starts/); await assert.rejects(mk2({ end: `${iso(3)} 23:00` }), /12 hours/);
  await assert.rejects(mk2({ room_id: small, attendees: [boss.id, a1.id, a2.id] }), /seats 2/); await assert.rejects(mk2({ attendees: [999] }), /unknown/);
  const m1 = await mk2({}); assert.deepEqual(m1.warnings, []);
  await assert.rejects(mk2({ title: 'Clash', start: `${iso(2)} 10:30`, end: `${iso(2)} 11:30` }), /Board room is already booked: "Weekly sync" 10:00-11:00/);
  const free = await api(`rooms/availability?start=${iso(2)}+10:15&end=${iso(2)}+10:45`); assert.deepEqual(free.map(r => r.name), ['Huddle']);
  await api('leaves', 'POST', { employee_id: a2.id, type: 'Casual', from_date: iso(3), to_date: iso(3), auto_approve: true });
  const m2 = await api('meetings', 'POST', { title: 'Planning', start: `${iso(3)} 15:00`, end: `${iso(3)} 16:00`, room_id: small, attendees: [a1.id, a2.id] }); assert.ok(m2.warnings.some(x => /Bushra is on approved leave/.test(x)));
  const m3 = await api('meetings', 'POST', { title: 'Overlapping', start: `${iso(2)} 10:30`, end: `${iso(2)} 11:30`, room_id: small, attendees: [a1.id] }); assert.ok(m3.warnings.some(x => /Aamir is already in "Weekly sync"/.test(x)), 'double-booked people are warned, not blocked');
  const aTok = await portal(a1); const mine = (await P('meetings', aTok)).body; assert.deepEqual(mine.map(x => x.title).sort(), ['Overlapping', 'Planning', 'Weekly sync']); assert.equal(mine.find(x => x.title === 'Weekly sync').place, 'Board room');
  assert.ok((await P('notifications', aTok)).body.items.some(n => /Meeting invitation: Weekly sync/.test(n.title)));
  assert.equal((await P(`meetings/${m1.id}/rsvp`, aTok, 'POST', { rsvp: 'yes' })).status, 200); assert.equal((await P(`meetings/${m1.id}/rsvp`, aTok, 'POST', { rsvp: 'maybe' })).status, 400); assert.equal((await P(`meetings/${m1.id}/rsvp`, hostTok, 'POST', { rsvp: 'no' })).status, 200);
  assert.equal((await P(`meetings/${m2.id}/rsvp`, await portal(k1), 'POST', { rsvp: 'yes' })).status, 404, 'cannot answer for a meeting you are not invited to');
  let det = await api('meetings/' + m1.id); assert.deepEqual(det.attendees.map(x => `${x.name}:${x.rsvp}`).sort(), ['Aamir:yes', 'Boss Bilal:no']);
  const lst = await api(`meetings?from=${iso(2)}&to=${iso(2)}`); assert.equal(lst.find(x => x.id === m1.id).yes, 1); assert.equal(lst.find(x => x.id === m1.id).no, 1); assert.equal((await api(`meetings?employee_id=${a2.id}`)).length, 1);
  await api('meetings/' + m1.id, 'PUT', { start: `${iso(2)} 14:00`, end: `${iso(2)} 15:00`, attendees: [boss.id, a1.id, k1.id] });
  det = await api('meetings/' + m1.id); assert.equal(det.start_ts, `${iso(2)} 14:00`); assert.ok(det.attendees.every(x => x.rsvp === 'pending'), 'a new time asks everyone again'); assert.ok((await P('notifications', aTok)).body.items.some(n => /Meeting changed: Weekly sync/.test(n.title)));
  assert.ok((await P('notifications', await portal(k1))).body.items.some(n => /Meeting invitation/.test(n.title)), 'a newly added person is invited');
  await api('meetings/' + m1.id + '/attendance', 'POST', { attended: [boss.id, k1.id] }); det = await api('meetings/' + m1.id); assert.equal(det.status, 'done'); assert.deepEqual(det.attendees.map(x => `${x.name}:${x.attended}`).sort(), ['Aamir:0', 'Boss Bilal:1', 'Kamran:1']);
  await api(`meetings/${m1.id}/minutes`, 'PUT', { minutes: 'Agreed to ship on Friday' }); assert.equal((await api('meetings/' + m1.id)).minutes, 'Agreed to ship on Friday'); await assert.rejects(api('meetings/' + m1.id, 'PUT', { title: 'x' }), /scheduled meeting/);
  await api(`meetings/${m3.id}/cancel`, 'POST'); assert.ok((await P('notifications', aTok)).body.items.some(n => /Meeting cancelled: Overlapping/.test(n.title))); await assert.rejects(api(`meetings/${m3.id}/cancel`, 'POST'), /not scheduled/);
  assert.deepEqual((await api(`rooms/availability?start=${iso(3)}+15:00&end=${iso(3)}+16:00`)).map(r => r.name), ['Board room']);

  // ---- notification rules
  const rules = await api('notification-rules'); assert.equal(rules.rules.length, 4); assert.equal(rules.smtp, true); assert.ok(rules.rules.every(r => !r.enabled));
  await assert.rejects(api('notification-rules/1', 'PUT', { at: '25:00' }), /HH:MM/); await api('notification-rules/1', 'PUT', { enabled: true, at: '11:15', email: true }); assert.equal((await api('notification-rules')).rules[0].at, '11:15');
  const rid = (k) => rules.rules.find(r => r.kind === k).id;
  const abs = await api(`notification-rules/${rid('absent_summary')}/run`, 'POST'); assert.equal(abs.sent, 1); assert.ok((await api('notifications')).items.some(n => /people have not punched in yet/.test(n.title) && /Bushra/.test(n.body)));
  const late = await api(`notification-rules/${rid('late_alert')}/run`, 'POST'); assert.equal(late.sent, 1, 'the late boss has no manager, so only the admins hear about it');
  await api('employees/' + boss.id, 'PUT', { manager_id: a2.id }); const bt = await portal(a2); const late2 = await api(`notification-rules/${rid('late_alert')}/run`, 'POST'); assert.equal(late2.sent, 2);
  assert.ok((await P('notifications', bt)).body.items.some(n => /was late today/.test(n.title) && /Boss Bilal/.test(n.body)), 'the manager is told who in their team was late');
  await api('logs/import', 'POST', { csv: `${a1.code},${iso(-1)} 09:00` });
  const mp = await api(`notification-rules/${rid('missing_punch')}/run`, 'POST'); assert.equal(mp.sent, 1); assert.ok((await P('notifications', aTok)).body.items.some(n => /forgot to punch out yesterday/.test(n.title)));
  assert.equal((await api(`notification-rules/${rid('leave_pending')}/run`, 'POST')).sent, 0, 'nothing is waiting long enough');
  assert.equal((await api('notification-rules/test-email', 'POST', { to: 'someone@x.com' })).ok, true); assert.equal((await api('notification-rules/999/run', 'POST').catch(e => e.message)).includes('404'), true);

  // ---- temperature readings (models that report them)
  await simH.upload('ATTLOG', [`${a2.code}\t${today} 09:05:00\t0\t1\t0\t0\t0\t1\t36.6`, `${a1.code}\t${today} 17:00:00\t1\t1\t0\t0\t0\t0\t38.2`, `${k1.code}\t${today} 17:05:00\t1\t1\t0\t0\t0\t1\t99.9`]);
  const lg = (await api('logs?date=' + today)).reduce((m, l) => ({ ...m, [l.ts + l.emp_code]: l }), {});
  assert.equal(lg[`${today} 09:05:00${a2.code}`].temp_c, 36.6); assert.equal(lg[`${today} 09:05:00${a2.code}`].mask, 1); assert.equal(lg[`${today} 17:05:00${k1.code}`].temp_c, null, 'an impossible reading is ignored');
  assert.ok((await api('notifications')).items.some(n => /High temperature: .* 38.2/.test(n.title))); assert.ok((await api(`devices/${dH}/events`)).some(e => e.kind === 'high_temperature' && /38.2/.test(e.detail)));
  assert.ok(!(await api('notifications')).items.some(n => /36.6/.test(n.title))); await api('settings', 'PUT', { temp_alert_c: 0 }); const nBefore = (await api('notifications')).items.length;
  await simH.upload('ATTLOG', [`${a2.code}\t${today} 17:30:00\t1\t1\t0\t0\t0\t1\t39.5`]); assert.equal((await api('notifications')).items.length, nBefore, 'alerts can be switched off');
  assert.match(await (await S.raw(`reports/transactions/export?from=${today}&to=${today}&format=csv`)).text(), /"Temp \(°C\)"/);

  // ---- device IP allow-list
  await assert.rejects(api('devices/' + dH, 'PUT', { allowed_ips: 'not-an-ip' }), /Allowed addresses/); await assert.rejects(api('devices/' + dH, 'PUT', { allowed_ips: '10.0.0.0/40' }), /Allowed addresses/);
  await api('devices/' + dH, 'PUT', { allowed_ips: '10.9.8.7, 192.168.0.0/16' });
  const blocked = await simH.req('getrequest'); assert.equal(blocked.status, 403); assert.equal((await simH.req('cdata', `${a2.code}\t${today} 18:00:00\t1\t1`, '&table=ATTLOG')).status, 403);
  assert.ok((await api(`devices/${dH}/events`)).some(e => e.kind === 'blocked_ip' && /allow-list/.test(e.detail)));
  assert.equal((await api('logs?date=' + today)).some(l => l.ts === `${today} 18:00:00`), false, 'nothing is stored from a blocked address');
  await api('devices/' + dH, 'PUT', { allowed_ips: '127.0.0.0/8, ::1' }); assert.equal((await simH.req('getrequest')).status, 200); await api('devices/' + dH, 'PUT', { allowed_ips: '' }); assert.equal((await simH.req('getrequest')).status, 200);

  // ---- security headers
  const hdr = (await fetch(S.base + '/api/me')).headers; assert.equal(hdr.get('x-content-type-options'), 'nosniff'); assert.equal(hdr.get('x-frame-options'), 'DENY'); assert.equal(hdr.get('referrer-policy'), 'no-referrer'); assert.equal(hdr.get('x-powered-by'), null);

  // ---- permissions
  await api('users', 'POST', { username: 'hr1', password: 'password1', role: 'hr' }); const hr = as(await S.login('hr1', 'password1'));
  assert.equal((await hr.send('notification-rules', 'GET')).status, 403, 'rules need Settings access'); assert.equal((await hr.send('visitors', 'POST', { name: 'Front desk' })).status, 200, 'hr may register visitors'); assert.equal((await hr.send('meetings', 'GET')).status, 200);
  const vw = as(await S.login('v1', 'password1')); assert.equal((await vw.send('visitors', 'POST', { name: 'Nope' })).status, 403); assert.equal((await vw.send('rooms', 'POST', { name: 'Nope' })).status, 403); assert.equal((await vw.send('meetings', 'GET')).status, 200);
  console.log('e2e-extras passed: live monitor, dashboard widgets, visitors, meetings, notification rules, temperature, device IP allow-list, security headers');
} catch (e) { console.error('E2E-EXTRAS FAILED:', (e.stack || '').split('\n').filter(l => /e2e-extras.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message.split('\n')[0]); process.exitCode = 1; }
finally { S.stop(); }
