// Employee portal: accounts, login, phone punches with GPS, self-service, manager approvals, payslips, announcements, HTTPS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import https from 'node:https';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const iso = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10), today = iso(0);
const P = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const nap = () => new Promise(r => setTimeout(r, 1100)); // punches by one person in the same second are the same record
const LAHORE = { lat: 31.5204, lng: 74.3587 }, FAR = { lat: 31.55, lng: 74.40 };      // FAR is about 5 km away
let servers = [S];
try {
  // ---- organization and people
  const office = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' })).id;
  const eng = (await api('departments', 'POST', { name: 'Engineering' })).id, ops = (await api('departments', 'POST', { name: 'Operations' })).id;
  const hq = (await api('branches', 'POST', { name: 'HQ' })).id, khi = (await api('branches', 'POST', { name: 'Karachi' })).id;
  const mk = (name, extra = {}) => api('employees', 'POST', { name, shift_id: office, join_date: `${new Date().getFullYear()}-01-01`, department_id: eng, branch_id: hq, gender: 'male', ...extra });
  const M = await mk('Manager Mona'), R1 = await mk('Report One'), R2 = await mk('Report Two'), X = await mk('Outsider Omar', { department_id: ops, branch_id: khi });
  for (const r of [R1, R2]) await api('employees/' + r.id, 'PUT', { manager_id: M.id });
  await assert.rejects(api('employees/' + M.id, 'PUT', { manager_id: 999 }), /Unknown/);

  // ---- accounts and login
  const made = await api('portal-accounts', 'POST', { all: true });
  assert.equal(made.created, 4); const pw = Object.fromEntries(made.accounts.map(a => [a.code, a.password]));
  assert.ok(Object.values(pw).every(p => p.length === 10)); assert.equal((await api('portal-accounts', 'POST', { all: true })).created, 0, 'existing accounts are not touched');
  assert.equal((await api('portal-accounts')).filter(a => a.has_account).length, 4);
  const login = async (e, password = pw[e.code]) => P('login', 'POST', { code: e.code, password });
  assert.equal((await P('login', 'POST', { code: '99999', password: 'whatever' })).status, 401); assert.equal((await login(R1, 'wrongpass')).status, 401);
  assert.equal((await P('login', 'POST', { code: R1.code, password: 'wrongpass' })).body.error, (await P('login', 'POST', { code: '99999', password: 'x' })).body.error, 'unknown ID and wrong password look identical');
  const first = await login(M); assert.equal(first.status, 200); assert.equal(first.body.must_change, true);
  assert.equal((await P('punch', 'POST', LAHORE, first.body.token)).status, 403, 'nothing works before the password is changed');
  assert.equal((await P('me', 'GET', undefined, first.body.token)).body.must_change, true);
  await assert.equal((await P('password', 'POST', { current: pw[M.code], password: 'short' }, first.body.token)).status, 400);
  assert.equal((await P('password', 'POST', { current: 'nope', password: 'a-good-password' }, first.body.token)).status, 400);
  assert.equal((await P('password', 'POST', { current: pw[M.code], password: M.code }, first.body.token)).status, 400);
  assert.equal((await P('password', 'POST', { current: pw[M.code], password: 'manager-pass-1' }, first.body.token)).status, 200);
  assert.equal((await login(M)).status, 401, 'the old password stops working'); const mt = (await login(M, 'manager-pass-1')).body.token;
  const tok = {}; tok.M = mt;
  for (const [k, e] of [['R1', R1], ['R2', R2], ['X', X]]) { const t = (await login(e)).body.token; await P('password', 'POST', { current: pw[e.code], password: k + '-secret-pass' }, t); tok[k] = (await login(e, k + '-secret-pass')).body.token; pw[e.code] = k + '-secret-pass'; }
  // tokens do not cross over
  assert.equal((await fetch(S.base + '/api/employees', { headers: { Authorization: 'Bearer ' + tok.R1 } })).status, 401, 'an employee token is not a staff token');
  assert.equal((await P('me', 'GET', undefined, S.token)).status, 401, 'a staff token is not an employee token');
  assert.equal((await P('me')).status, 401);
  // lockout after five wrong passwords
  for (let i = 0; i < 5; i++) await login(X, 'bad-bad-bad');
  const locked = await login(X); assert.equal(locked.status, 429); assert.match(locked.body.error, /locked/);
  await api('portal-accounts', 'POST', { employee_ids: [X.id], reset: true }); // HR reset clears the lock
  const xr = (await api('portal-accounts')).find(a => a.employee_id === X.id); assert.equal(xr.locked_until, null);
  pw[X.code] = (await api('portal-accounts', 'POST', { employee_ids: [X.id], reset: true })).accounts[0].password;
  const xt = (await login(X)).body.token; await P('password', 'POST', { current: pw[X.code], password: 'X-secret-pass' }, xt); tok.X = (await login(X, 'X-secret-pass')).body.token;

  // ---- my profile
  const me = (await P('me', 'GET', undefined, tok.R1)).body;
  assert.equal(me.employee.name, 'Report One'); assert.equal(me.employee.manager, 'Manager Mona'); assert.equal(me.is_manager, false); assert.equal(me.can_punch, true);
  assert.equal((await P('me', 'GET', undefined, tok.M)).body.is_manager, true);
  assert.equal(me.employee.password, undefined, 'no secrets in the profile');

  // ---- phone punches: strict mode (default)
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 10 }, tok.R1)).status, 403); assert.match((await P('punch', 'POST', { ...LAHORE, accuracy: 10 }, tok.R1)).body.error, /No work location/);
  const site = (await api('geo_sites', 'POST', { name: 'Head office', lat: LAHORE.lat, lng: LAHORE.lng, radius_m: 150, max_accuracy_m: 100, all_employees: 1 })).id;
  await assert.rejects(api('geo_sites', 'POST', { name: 'bad', lat: 95, lng: 0 }), /Latitude/); await assert.rejects(api('geo_sites', 'POST', { name: 'bad', lat: 1, lng: 1, radius_m: 2 }), /Radius/);
  await assert.rejects(api('geo_sites', 'POST', { name: 'Head office', lat: 1, lng: 1 }), /exists/);
  assert.equal((await P('punch', 'POST', { lat: 'x', lng: 'y' }, tok.R1)).status, 400);
  const far = await P('punch', 'POST', { ...FAR, accuracy: 10 }, tok.R1); assert.equal(far.status, 403); assert.match(far.body.error, /You are \d+ m from Head office/); assert.ok(far.body.distance_m > 4000);
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 500 }, tok.R1)).status, 422, 'a vague GPS fix is refused');
  assert.equal((await P('punch', 'POST', { ...LAHORE }, tok.R1)).status, 422, 'no accuracy figure is refused in strict mode');
  const ok1 = await P('punch', 'POST', { ...LAHORE, accuracy: 20, device_id: 'phone-A' }, tok.R1);
  assert.equal(ok1.status, 200); assert.equal(ok1.body.kind, 'in'); assert.equal(ok1.body.site, 'Head office'); assert.equal(ok1.body.flagged, false); assert.ok(ok1.body.distance_m < 5);
  const again = await P('punch', 'POST', { ...LAHORE, accuracy: 20, device_id: 'phone-A' }, tok.R1); assert.equal(again.status, 429); assert.match(again.body.error, /Wait 2 minutes/);
  assert.equal((await api('logs?date=' + today)).find(l => l.emp_code === R1.code).source, 'mobile');
  await api('settings', 'PUT', { portal_min_gap_min: 0 });
  await new Promise(r => setTimeout(r, 1100)); // two punches in the same second would be the same record
  const ok2 = await P('punch', 'POST', { ...LAHORE, accuracy: 20, device_id: 'phone-A' }, tok.R1); assert.equal(ok2.status, 200); assert.equal(ok2.body.kind, 'out', 'the second punch of the day is a check-out');
  assert.equal((await P('me', 'GET', undefined, tok.R1)).body.today.punches.length, 2);

  // site rules: assigned employees only, or a branch's employees
  await api('geo_sites/' + site, 'PUT', { all_employees: false });
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.R2)).status, 403, 'site is no longer open to everyone');
  await api('geo_sites/' + site + '/employees', 'PUT', { employee_ids: [R2.id] });
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.R2)).status, 200, 'assigned employee may punch');
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.M)).status, 403);
  await api('geo_sites/' + site, 'PUT', { branch_id: hq });                                    // everyone in branch HQ
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.M)).status, 200, 'branch rule');
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.X)).status, 403, 'other branch');
  await api('portal-accounts/' + X.id, 'PUT', { mobile_enabled: false });

  // flag mode, record-only mode, new phone, switched-off phone attendance
  await api('settings', 'PUT', { portal_gps: 1 }); await nap();
  const fl = await P('punch', 'POST', { ...FAR, accuracy: 10, device_id: 'phone-B' }, tok.R1);
  assert.equal(fl.status, 200); assert.equal(fl.body.flagged, true); assert.match(fl.body.note, /m from Head office/); assert.match(fl.body.note, /New phone/);
  const review = await api('attendance/mobile?flagged=1'); assert.ok(review.some(r => r.code === R1.code && /New phone/.test(r.note)));
  assert.ok(review.every(r => r.flagged === 1));
  await api('settings', 'PUT', { portal_gps: 0 }); await nap();
  assert.equal((await P('punch', 'POST', { device_id: 'phone-B' }, tok.R2)).status, 200, 'record-only mode needs no location');
  await api('settings', 'PUT', { portal_gps: 2 });
  assert.equal((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.X)).status, 403); assert.match((await P('punch', 'POST', { ...LAHORE, accuracy: 20 }, tok.X)).body.error, /not switched on/);
  const flaggedLog = (await api('logs?date=' + today)).find(l => l.emp_code === R1.code && l.source === 'mobile');
  await api('logs/' + flaggedLog.id, 'DELETE');                                                 // HR can remove a bad phone punch

  // ---- history, leave, requests, shifts
  const h = (await P('history', 'GET', undefined, tok.R1)).body; assert.equal(h.month, today.slice(0, 7)); assert.ok(h.days.find(d => d.date === today)); assert.ok(h.summary);
  assert.equal((await P('history?month=2020-01', 'GET', undefined, tok.R1)).body.days.length, 0);
  const bal = (await P('leave/balances', 'GET', undefined, tok.R1)).body.balances; assert.equal(bal.find(b => b.type === 'Casual').available, 10);
  const lv = await P('leaves', 'POST', { type: 'Casual', from_date: iso(5), to_date: iso(6), note: 'Family', auto_approve: true, employee_id: X.id }, tok.R1);
  assert.equal(lv.status, 200); assert.equal(lv.body.status, 'pending', 'the portal never auto-approves, whatever the request says');
  assert.equal((await api('leaves?employee_id=' + X.id)).length, 0, 'and it cannot apply for somebody else'); assert.equal((await api('leaves?employee_id=' + R1.id)).length, 1);
  assert.equal((await P('leaves', 'POST', { type: 'Casual', from_date: iso(5), to_date: iso(5) }, tok.R1)).status, 400);
  assert.equal((await P('leaves/' + lv.body.id + '/cancel', 'POST', {}, tok.R2)).status, 404, 'cannot touch a colleague\'s leave');
  assert.equal((await P('leaves/' + lv.body.id + '/cancel', 'POST', {}, tok.R1)).status, 200);
  const lvA = await P('leaves', 'POST', { type: 'Casual', from_date: iso(8), to_date: iso(8), note: 'Doctor' }, tok.R1);
  const lvX = await P('leaves', 'POST', { type: 'Sick', from_date: iso(9), to_date: iso(9), note: 'Fever' }, tok.X);
  const rq = await P('attendance/requests', 'POST', { date: iso(-1), kind: 'add_punch', time: '18:05', reason: 'Forgot to scan' }, tok.R1); assert.equal(rq.body.status, 'pending');
  assert.equal((await P('attendance/requests', 'POST', { date: iso(-1), kind: 'add_punch', time: '18:05' }, tok.R1)).status, 400);
  const rq2 = await P('attendance/requests', 'POST', { date: iso(-2), kind: 'on_duty', status_text: 'Work From Home', reason: 'Plumber' }, tok.R2);
  const sr = await P('shifts/requests', 'POST', { kind: 'change', shift_id: office, from_date: iso(3), to_date: iso(3), reason: 'Appointment' }, tok.R1); assert.equal(sr.status, 200);
  const sw = await P('shifts/requests', 'POST', { kind: 'swap', other_employee_id: R2.id, from_date: iso(4), to_date: iso(4), reason: 'Swap' }, tok.R1);
  assert.equal((await P('notifications', 'GET', undefined, tok.R2)).body.items.some(n => /asked to swap/.test(n.title)), true);
  assert.equal((await P('shifts/requests', 'GET', undefined, tok.R2)).body.some(r => r.id === sw.body.id && r.mine === 0), true, 'the swap partner sees it too');
  const cal = (await P('shifts/calendar?month=' + today.slice(0, 7), 'GET', undefined, tok.R1)).body; assert.equal(cal.cells.length, cal.days.length); assert.equal((await P('shifts/list', 'GET', undefined, tok.R1)).body[0].name, 'Office');
  assert.equal((await P('shifts/requests/' + sw.body.id + '/cancel', 'POST', {}, tok.R2)).status, 404, 'only the requester can cancel');
  assert.equal((await P('shifts/requests/' + sw.body.id + '/cancel', 'POST', {}, tok.R1)).status, 200);

  // ---- the reporting manager's view
  const team = (await P('team', 'GET', undefined, tok.M)).body.members.map(m => m.name).sort(); assert.deepEqual(team, ['Report One', 'Report Two']);
  assert.equal((await P('team', 'GET', undefined, tok.R1)).body.members.length, 0, 'a non-manager has no team');
  const pend = (await P('team/pending', 'GET', undefined, tok.M)).body;
  assert.deepEqual(pend.leaves.map(l => l.employee), ['Report One'], 'only the team\'s requests, not the outsider\'s');
  assert.equal(pend.attendance.length, 2); assert.equal(pend.shifts.length, 1);
  assert.equal((await P(`team/leave/${lvX.body.id}/approve`, 'POST', {}, tok.M)).status, 403, 'a request from outside the team is refused');
  assert.equal((await P(`team/leave/${lvA.body.id}/approve`, 'POST', {}, tok.R2)).status, 403, 'a colleague cannot approve');
  assert.equal((await P(`team/leave/${lvA.body.id}/approve`, 'POST', { note: 'Get well' }, tok.M)).status, 200);
  const lA = (await api('leaves?employee_id=' + R1.id)).find(l => l.id === lvA.body.id); assert.equal(lA.status, 'approved'); assert.equal(lA.decided_by, `emp:${M.code}`);
  assert.equal((await P(`team/leave/${lvA.body.id}/approve`, 'POST', {}, tok.M)).status, 400, 'already decided');
  assert.equal((await P(`team/attendance/${rq.body.id}/approve`, 'POST', {}, tok.M)).status, 200);
  assert.ok((await api('logs?date=' + iso(-1))).some(l => l.emp_code === R1.code && l.ts.endsWith('18:05:00')), 'the approved punch is on the record');
  assert.equal((await P(`team/attendance/${rq2.body.id}/reject`, 'POST', { note: 'No proof' }, tok.M)).status, 200);
  assert.equal((await P(`team/shift/${sr.body.id}/approve`, 'POST', {}, tok.M)).status, 200);
  assert.equal((await P('team/bogus/1/approve', 'POST', {}, tok.M)).status, 400);
  assert.equal((await P('team/pending', 'GET', undefined, tok.M)).body.leaves.length, 0);
  const note = (await P('notifications', 'GET', undefined, tok.R1)).body; assert.ok(note.unread >= 2); assert.ok(note.items.some(n => /leave was approved/.test(n.title)));
  assert.ok((await P('notifications', 'GET', undefined, tok.M)).body.items.some(n => /Leave request: Report One/.test(n.title)), 'the manager was told about the request');
  await P('notifications/read', 'POST', {}, tok.R1); assert.equal((await P('notifications', 'GET', undefined, tok.R1)).body.unread, 0);
  // overtime sign-off by the manager
  const pol = (await api('ot_policies', 'POST', { name: 'Needs approval', post: 1, pre: 0, weekend: 1, holiday: 1, min_minutes: 30, round_minutes: 15, mult_work: 1.5, mult_weekend: 2, mult_holiday: 2, daily_max: 0, monthly_max: 0, approval: 1 })).id;
  await api('employees/' + R2.id, 'PUT', { ot_policy_id: pol });
  await api('logs/import', 'POST', { csv: `${R2.code},${iso(-3)} 09:00\n${R2.code},${iso(-3)} 19:30` });
  await api(`overtime/requests?from=${iso(-4)}&to=${iso(-1)}`);
  const ot = (await P('team/pending', 'GET', undefined, tok.M)).body.overtime; assert.equal(ot.length, 1); assert.equal(ot[0].calc_minutes, 90);
  assert.equal((await P(`team/overtime/${ot[0].id}/approve`, 'POST', {}, tok.M)).status, 200);
  assert.equal((await api(`report/daily?from=${iso(-3)}&to=${iso(-3)}&employee_id=${R2.id}`))[0].ot_approved_min, 90);

  // ---- payslips: only after finalizing, only your own
  assert.equal((await P('payslips', 'GET', undefined, tok.R1)).body.length, 0);
  const month = today.slice(0, 7); await api('payroll/finalize', 'POST', { month, force: true });
  const slips = (await P('payslips', 'GET', undefined, tok.R1)).body; assert.equal(slips.length, 1); assert.equal(slips[0].month, month); assert.equal(slips[0].code, R1.code); assert.equal(slips[0].status, 'finalized');
  assert.ok(!JSON.stringify(slips).includes(R2.code + '"') || slips[0].code === R1.code);
  assert.deepEqual((await P('payslips', 'GET', undefined, tok.R2)).body.map(s => s.code), [R2.code]);

  // ---- announcements
  const ann = (b) => api('announcements', 'POST', b);
  await ann({ title: 'Eid holidays', body: 'Office closed 3 days', audience: 'all', pinned: true });
  await ann({ title: 'Engineering offsite', audience: 'department', department_id: eng });
  await ann({ title: 'Karachi power cut', audience: 'branch', branch_id: khi });
  await ann({ title: 'Old news', audience: 'all', ends: iso(-5) }); await ann({ title: 'Coming soon', audience: 'all', starts: iso(5) });
  await assert.rejects(ann({ title: '', audience: 'all' }), /Title/); await assert.rejects(ann({ title: 'x', audience: 'department' }), /department/); await assert.rejects(ann({ title: 'x', ends: '2020-01-01', starts: '2021-01-01' }), /before/);
  const seen = async (t) => (await P('announcements', 'GET', undefined, t)).body.map(a => a.title);
  assert.deepEqual(await seen(tok.R1), ['Eid holidays', 'Engineering offsite']); assert.deepEqual(await seen(tok.X), ['Eid holidays', 'Karachi power cut']);

  // ---- staff scope and audit trail
  await api('users', 'POST', { username: 'eng_hr', password: 'password1', role: 'hr', departments: [eng] });
  const ht = await S.login('eng_hr', 'password1'), hr = async (p, m = 'GET', b) => { const r = await S.raw(p, m, b, ht); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  assert.equal((await hr('portal-accounts', 'POST', { employee_ids: [X.id], reset: true })).status, 403, 'an employee outside the scope');
  assert.equal((await hr('portal-accounts', 'POST', { all: true, reset: true })).body.created, 3, 'a bulk reset only reaches the scoped employees');
  assert.equal((await hr('geo_sites', 'POST', { name: 'mine', lat: 1, lng: 1 })).status, 403); assert.equal((await hr('announcements', 'POST', { title: 'x' })).status, 403);
  assert.ok((await hr('attendance/mobile')).body.every(r => r.employee !== 'Outsider Omar'));
  const audit = await api('audit'); assert.ok(audit.some(a => a.user === `emp:${M.code}` && /team\/leave/.test(a.path))); assert.ok(audit.filter(a => a.user.startsWith('emp:')).every(a => !/"(lat|lng)":\s*-?\d/.test(a.summary)), "an employee's coordinates are not copied into the audit trail");
  assert.ok(audit.every(a => !/manager-pass|secret-pass|password\":\"[^\[]/.test(a.summary)), 'no passwords in the audit trail');

  // ---- HTTPS (phones need it for GPS)
  let https_ok = 'skipped (openssl not found)';
  try {
    const dir = join(S.dir, 'tls'); execFileSync('mkdir', ['-p', dir]);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    const port = String(19000 + Math.floor(Math.random() * 900));
    const T = await startServer({ TLS_CERT: join(dir, 'c.pem'), TLS_KEY: join(dir, 'k.pem'), HTTPS_PORT: port }); servers.push(T);
    const get = (path) => new Promise((ok, no) => { const rq = https.request({ host: 'localhost', port, path, rejectUnauthorized: false }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => ok({ status: r.statusCode, body: d })); }); rq.on('error', no); rq.end(); });
    let page; for (let i = 0; i < 30; i++) { try { page = await get('/portal'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.equal(page.status, 200); assert.ok(page.body.includes('<title>')); assert.equal((await fetch(T.base + '/iclock/ping')).status, 200, 'devices still use plain http');
    https_ok = 'https portal reachable, device http still works';
  } catch (e) { if (!/ENOENT/.test(String(e.message))) throw e; }
  console.log(`e2e-portal passed: accounts, login+lockout, GPS punches (strict/flag/off), self-service, manager approvals, payslips, announcements, scope, audit; ${https_ok}`);
} catch (e) { console.error('E2E-PORTAL FAILED:', (e.stack || '').split('\n').filter(l => /e2e-portal.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message.split('\n')[0]); process.exitCode = 1; }
finally { for (const s of servers) s.stop(); }
