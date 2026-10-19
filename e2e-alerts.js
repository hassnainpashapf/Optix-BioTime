// Alerts (kinds, on/off, quiet hours, watch list, live punch alerts, employee portal) and automation rules.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const P = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const stamp = (offMin = 0) => new Date(Date.now() + offMin * 60000).toLocaleString('sv');
const hhmm = (offMin) => stamp(offMin).slice(11, 16);
const feed = async (q = '') => api('alerts/feed' + q);
try {
  // ---- people, a shift that makes any punch "late", a device
  await api('shifts', 'POST', { name: 'AllDay', code: 'A', start: '00:01', end: '23:59', grace_min: 0, workdays: '0,1,2,3,4,5,6' });
  const sh = (await api('shifts')).at(-1).id, today = stamp().slice(0, 10);
  const mk = (name, extra = {}) => api('employees', 'POST', { name, shift_id: sh, join_date: `${new Date().getFullYear()}-01-01`, ...extra });
  const M = await mk('Manager Mona'), R1 = await mk('Report One'), R2 = await mk('Report Two'), X = await mk('Outsider Omar');
  for (const r of [R1, R2]) await api('employees/' + r.id, 'PUT', { manager_id: M.id });
  const code = async (r) => (await api('employees')).find(e => e.id === r.id).code, [cM, c1, c2, cX] = await Promise.all([M, R1, R2, X].map(code));
  await api('devices', 'POST', { name: 'Gate', sn: 'ALERT-001' }); const sim = new SimDevice(S.base, 'ALERT-001'); await sim.poll();

  // ---- the catalogue and preferences (staff)
  let a = await api('alerts'); const by = Object.fromEntries(a.prefs.map(p => [p.kind, p]));
  assert.equal(by.late.enabled, true); assert.equal(by.punch.enabled, false, 'arrival alerts are off until asked for'); assert.equal(by.device_status.enabled, true);
  assert.equal(by.my_punch, undefined, 'staff do not see employee-only alerts');
  await assert.rejects(api('alerts/prefs', 'PUT', { kind: 'nope', enabled: true }), /Unknown alert/); await assert.rejects(api('alerts/prefs', 'PUT', { kind: 'my_punch', enabled: true }), /Unknown alert/);
  await assert.rejects(api('alerts/options', 'PUT', { quiet_start: '22:00' }), /both the start and the end/); await assert.rejects(api('alerts/options', 'PUT', { quiet_start: '25:00', quiet_end: '07:00' }), /HH:MM/);
  await assert.rejects(api('alerts/options', 'PUT', { watch_mode: 'some' }), /everyone or only/);

  // ---- live punch alerts: nothing for punches that are not news, a late alert for a late arrival
  await sim.uploadPunches([{ pin: c1, ts: stamp(-3) }]); await sleep(500);
  let f = await feed(); assert.ok(f.some(x => x.kind === 'late' && /Report One is late/.test(x.title)), 'late alert');
  assert.ok(!f.some(x => x.kind === 'punch'), 'punch alerts are off by default');
  await sim.uploadPunches([{ pin: c1, ts: '2020-01-01 09:00:00' }]); await sleep(300); assert.ok(!(await feed()).some(x => /2020|09:00/.test(x.title)), 'old punches synced from a device are not alerts');
  await api('alerts/prefs', 'PUT', { kind: 'punch', enabled: true });
  await sim.uploadPunches([{ pin: c1, ts: stamp(-1) }]); await sleep(500);
  f = await feed(); assert.ok(f.some(x => x.kind === 'punch' && /Report One punched out/.test(x.title)), 'a later punch is a departure'); assert.ok(f.some(x => x.kind === 'punch' && x.body.includes('Gate')), 'it says which device');
  // watch list: only the people on it
  await api('alerts/watch', 'POST', { employee_id: R2.id }); await api('alerts/options', 'PUT', { watch_mode: 'watch' });
  assert.ok(!(await feed()).some(x => /Report One/.test(x.title) && ['punch', 'late'].includes(x.kind)), 'Report One is no longer followed');
  await sim.uploadPunches([{ pin: c2, ts: stamp(-2) }]); await sleep(500);
  f = await feed(); assert.ok(f.some(x => /Report Two punched in/.test(x.title)) && f.some(x => /Report Two is late/.test(x.title)));
  a = await api('alerts'); assert.deepEqual(a.watch.map(w => w.code), [c2]);
  await api(`alerts/watch/${R2.id}`, 'DELETE'); await api('alerts/options', 'PUT', { watch_mode: 'all' }); assert.ok((await feed()).some(x => /Report One punched/.test(x.title)), 'back to everyone');
  // switching a kind off hides it, switching it on brings the history back
  await api('alerts/prefs', 'PUT', { kind: 'late', enabled: false }); assert.ok(!(await feed()).some(x => x.kind === 'late')); await api('alerts/prefs', 'PUT', { kind: 'late', enabled: true }); assert.ok((await feed()).some(x => x.kind === 'late'));
  // quiet hours mark items silent (the phone shows them without sound)
  await api('alerts/options', 'PUT', { quiet_start: hhmm(-600), quiet_end: hhmm(600) }); assert.ok((await feed()).every(x => x.silent));
  await api('alerts/options', 'PUT', { quiet_start: hhmm(120), quiet_end: hhmm(180) }); assert.ok((await feed()).every(x => !x.silent));
  assert.ok((await feed(`?since=${(await feed())[0].id}`)).length === 0, 'since= returns only newer items');
  // the bell follows the same switches
  await api('alerts/test', 'POST'); assert.ok((await api('notifications')).items.some(i => i.title === 'Test alert'));
  await api('alerts/prefs', 'PUT', { kind: 'automation', enabled: false }); assert.ok(!(await api('notifications')).items.some(i => i.title === 'Test alert'), 'switched off kinds leave the bell too'); await api('alerts/prefs', 'PUT', { kind: 'automation', enabled: true });

  // ---- employees: their own preferences, manager sees the team
  const made = await api('portal-accounts', 'POST', { all: true }); const pw = Object.fromEntries(made.accounts.map(x => [x.code, x.password]));
  const tokenOf = async (c) => { const l = await P('login', 'POST', { code: c, password: pw[c] }); await P('password', 'POST', { current: pw[c], password: 'new-password-' + c }, l.body.token); return (await P('login', 'POST', { code: c, password: 'new-password-' + c })).body.token; };
  const tM = await tokenOf(cM), t1 = await tokenOf(c1);
  const ea = await P('alerts', 'GET', undefined, t1); const eby = Object.fromEntries(ea.body.prefs.map(p => [p.kind, p]));
  assert.ok(eby.my_punch && eby.leave_decision); assert.equal(eby.device_status, undefined, 'employees do not see device alerts');
  assert.equal((await P('alerts/prefs', 'PUT', { kind: 'device_status', enabled: true }, t1)).status, 400);
  assert.ok((await P('notifications', 'GET', undefined, t1)).body.items.some(i => /Punch recorded/.test(i.title)), 'own punch confirmations');
  await P('alerts/prefs', 'PUT', { kind: 'my_punch', enabled: false }, t1); assert.ok(!(await P('notifications', 'GET', undefined, t1)).body.items.some(i => /Punch recorded/.test(i.title)), 'switched off for this employee');
  assert.ok((await P('alerts/feed', 'GET', undefined, tM)).body.some(x => /Report One is late/.test(x.title)), 'a manager is told about team lates');
  assert.ok(!(await P('alerts/feed', 'GET', undefined, tM)).body.some(x => x.kind === 'punch'), 'team arrivals are off by default for managers');
  assert.equal((await P('alerts/watch', 'POST', { employee_id: X.id }, tM)).status, 400, 'a manager can only watch their own team'); assert.equal((await P('alerts/watch', 'POST', { employee_id: R1.id }, tM)).status, 200);
  assert.equal((await P('alerts', 'GET')).status, 401);

  // ---- automation rules: validation
  const rule = (b) => api('automations', 'POST', b);
  const note = [{ type: 'notify_admins', title: 'Late: {name}', body: '{name} was {status} at {in}' }];
  await assert.rejects(rule({ name: '', trigger: 'daily', config: { at: '10:00', status: ['Late'] }, actions: note }), /name/);
  await assert.rejects(rule({ name: 'x', trigger: 'nope', actions: note }), /when the rule runs/);
  await assert.rejects(rule({ name: 'x', trigger: 'daily', config: { at: '25:00', status: ['Late'] }, actions: note }), /HH:MM/);
  await assert.rejects(rule({ name: 'x', trigger: 'daily', config: { at: '10:00', status: ['Nonsense'] }, actions: note }), /status/);
  await assert.rejects(rule({ name: 'x', trigger: 'daily', config: { at: '10:00', status: ['Late'] }, actions: [] }), /1 to 8 actions/);
  await assert.rejects(rule({ name: 'x', trigger: 'daily', config: { at: '10:00', status: ['Late'], mode: 'summary' }, actions: [{ type: 'notify_employee' }] }), /one person/);
  await assert.rejects(rule({ name: 'x', trigger: 'daily', config: { at: '10:00', status: ['Late'] }, actions: [{ type: 'approve' }] }), /leave or attendance requests/);
  await assert.rejects(rule({ name: 'x', trigger: 'device.offline', actions: [{ type: 'webhook', url: 'ftp://x' }] }), /http/);
  await assert.rejects(rule({ name: 'x', trigger: 'monthly_count', config: { at: '10:00', status: ['Late'], threshold: 0 }, actions: note }), /from 1 to 31/);
  await assert.rejects(rule({ name: 'x', trigger: 'device.offline', actions: [{ type: 'email', to: 'not-an-address' }] }), /E-mail goes to/);

  // ---- scheduled rule: preview changes nothing, run acts once per person per day
  const rid = (await rule({ name: 'Late warning', trigger: 'daily', config: { at: '10:00', status: ['Late'] }, actions: [...note, { type: 'notify_employee', title: 'You were late', body: 'Please arrive on time.' }, { type: 'notify_manager' }] })).id;
  const before = (await api('notifications')).items.length;
  const pv = await api(`automations/${rid}/preview`, 'POST'); assert.ok(pv.matched >= 2); assert.ok(pv.sample[0].results.length === 3 && pv.sample[0].results.every(r => r.ok || /no manager/.test(r.text)));
  assert.equal((await api('notifications')).items.length, before, 'a preview does nothing'); assert.equal((await api('automations')).log.length, 0);
  const run1 = await api(`automations/${rid}/run`, 'POST'); assert.ok(run1.acted >= 2 && run1.already === 0);
  const nb = (await api('notifications')).items; assert.ok(nb.some(i => i.title === 'Late: Report One' && /was Late at/.test(i.body)), 'templates are filled in');
  assert.ok((await P('notifications', 'GET', undefined, t1)).body.items.some(i => i.title === 'You were late'), 'the person is alerted');
  assert.ok((await P('notifications', 'GET', undefined, tM)).body.items.some(i => i.title === 'Late warning: Report One'), 'the manager is alerted (default text)');
  const run2 = await api(`automations/${rid}/run`, 'POST'); assert.equal(run2.acted, 0); assert.equal(run2.already, run1.acted, 'nobody is told twice for the same day');
  const lg = (await api('automations')).log; assert.ok(lg.length >= 6 && lg.every(l => l.rule === 'Late warning'));
  // summary mode, filter by department, minimum minutes
  const sid = (await rule({ name: 'Late summary', trigger: 'daily', config: { at: '10:00', status: ['Late'], mode: 'summary' }, actions: [{ type: 'notify_admins' }] })).id;
  const sr = await api(`automations/${sid}/run`, 'POST'); assert.equal(sr.acted, 1); assert.ok((await api('notifications')).items.some(i => /Late summary: \d+ people/.test(i.title) && /Report One/.test(i.body)));
  const dep = (await api('departments', 'POST', { name: 'Nobody' })).id;
  const fid = (await rule({ name: 'Filtered', trigger: 'daily', config: { at: '10:00', status: ['Late'], dept_id: dep }, actions: note })).id; assert.equal((await api(`automations/${fid}/preview`, 'POST')).matched, 0, 'department filter');
  // monthly count: acts when the number is reached, again at double
  const mid = (await rule({ name: 'Three lates', trigger: 'monthly_count', config: { at: '10:00', status: ['Late'], threshold: 1 }, actions: [{ type: 'notify_admins', title: '{name}: {count} lates in {month}' }] })).id;
  const m1 = await api(`automations/${mid}/run`, 'POST'); assert.ok(m1.acted >= 2); assert.ok((await api('notifications')).items.some(i => /Report One: 1 lates in/.test(i.title)));
  assert.equal((await api(`automations/${mid}/run`, 'POST')).acted, 0);
  // editing a rule resets its schedule marker but keeps history; disabling works
  await api('automations/' + mid, 'PUT', { name: 'Three lates', trigger: 'monthly_count', config: { at: '10:00', status: ['Late'], threshold: 2 }, actions: note }); assert.equal((await api('automations')).rules.find(r => r.id === mid).config.threshold, 2);
  await api('automations/' + mid, 'PUT', { enabled: false }); assert.equal((await api('automations')).rules.find(r => r.id === mid).enabled, 0);

  // ---- event rules: auto-approve small leave, tell the employee about a request
  await api('leave_types', 'POST', { name: 'Errand', paid: 1, quota: 0, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 });
  const lid = (await rule({ name: 'Approve one-day errands', trigger: 'leave.requested', config: { leave_type: 'Errand', max_days: 1 }, actions: [{ type: 'approve' }, { type: 'notify_admins', title: 'Auto-approved {name}', body: '{type} {from}' }] })).id;
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10), leave = (n, len) => api('leaves', 'POST', { employee_id: R1.id, type: 'Errand', from_date: day(n), to_date: day(n + len - 1) });
  const l1 = await leave(5, 1), l2 = await leave(9, 3); await sleep(600);
  const leaves = await api('leaves'); const st = (id) => leaves.find(l => l.id === id);
  assert.equal(st(l1.id).status, 'approved'); assert.match(st(l1.id).decided_by, /^automation:Approve one-day errands/); assert.equal(st(l2.id).status, 'pending', 'longer than max_days: left for a person');
  assert.ok((await api('notifications')).items.some(i => i.title === 'Auto-approved Report One'));
  assert.ok((await api('automations')).log.some(l => /Approved the request/.test(l.outcome)));
  await api('automations/' + lid, 'PUT', { enabled: false }); const l3 = await leave(14, 1); await sleep(400); assert.equal((await api('leaves')).find(l => l.id === l3.id).status, 'pending', 'a disabled rule does nothing');
  const rq = (await rule({ name: 'Tell me about punch requests', trigger: 'attendance_request.created', config: { req_kind: 'add_punch' }, actions: [{ type: 'notify_employee', title: 'We got your request', body: '{date} {time}' }] })).id;
  await api('attendance/requests', 'POST', { employee_id: R1.id, date: day(-1), kind: 'add_punch', time: '09:30', reason: 'forgot' }); await sleep(500);
  assert.ok((await P('notifications', 'GET', undefined, t1)).body.items.some(i => i.title === 'We got your request' && /09:30/.test(i.body)));
  await api('attendance/requests', 'POST', { employee_id: R2.id, date: day(-1), kind: 'on_duty', status_text: 'On Duty', reason: 'visit' }); await sleep(400);
  assert.ok(!(await P('notifications', 'GET', undefined, (await tokenOf(c2)))).body.items.some(i => i.title === 'We got your request'), 'the request kind condition filters');
  const prev = await api(`automations/${rq}/preview`, 'POST'); assert.equal(prev.sample[0].results[0].ok, true);
  await assert.rejects(api(`automations/${rq}/run`, 'POST'), /runs when the event happens/);
  // device offline rule, webhook action to a local receiver
  const hits = []; const srv = (await import('node:http')).createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { hits.push(JSON.parse(b)); r.end('ok'); }); }); await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  await rule({ name: 'Offline hook', trigger: 'device.offline', actions: [{ type: 'webhook', url: `http://127.0.0.1:${srv.address().port}/x` }] });
  const dp = (await api('automations')).rules.find(r => r.name === 'Offline hook'); const pr = await api(`automations/${dp.id}/preview`, 'POST'); assert.match(pr.sample[0].results[0].text, /Would call/); assert.equal(hits.length, 0, 'preview does not call out'); srv.close();
  // delete removes history; permissions
  await api('automations/' + rid, 'DELETE'); assert.ok(!(await api('automations')).log.some(l => l.rule === 'Late warning'));
  await api('users', 'POST', { username: 'viewer2', password: 'password1', role: 'viewer' }); const vt = await S.login('viewer2', 'password1');
  assert.equal((await S.raw('automations', 'POST', { name: 'x' }, vt)).status, 403); assert.equal((await S.raw('alerts', 'GET', undefined, vt)).status, 200, 'every staff login can manage their own alerts');
  console.log('e2e-alerts passed: alert kinds on/off, quiet hours, watch list, live punch/late alerts, employee + manager alerts, automation (scheduled, monthly count, leave auto-approve, requests, webhook preview, dedupe, permissions)');
} catch (e) { console.error('E2E-ALERTS FAILED:', (e.stack || '').split('\n').filter(l => /e2e-alerts.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
