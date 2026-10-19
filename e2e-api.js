// Public API (API keys) and webhooks.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer({ API_RATE_PER_MIN: '60' }), api = S.api;
const V = async (path, key, method = 'GET', body) => { const r = await fetch(S.base + '/api/v1' + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
const mkKey = async (name, scopes) => (await api('api-keys', 'POST', { name, scopes })).key;
// a receiver that records every webhook it is sent
const hits = []; let answer = 200;
const rx = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { hits.push({ headers: req.headers, body: d, json: (() => { try { return JSON.parse(d); } catch { return null; } })() }); res.statusCode = answer; res.end('ok'); }); });
await new Promise(r => rx.listen(0, '127.0.0.1', r)); const RX = `http://127.0.0.1:${rx.address().port}/hook`;
const run = (force = false) => api('webhooks/run', 'POST', { force });
const events = () => hits.map(h => h.json?.event);
try {
  // ---- keys
  await assert.rejects(api('api-keys', 'POST', { name: '', scopes: ['employees:read'] }), /name/); await assert.rejects(api('api-keys', 'POST', { name: 'x', scopes: [] }), /what this key may do/); await assert.rejects(api('api-keys', 'POST', { name: 'x', scopes: ['everything'] }), /what this key may do/);
  const hrms = await mkKey('HRMS', ['employees:read', 'employees:write']), att = await mkKey('Attendance reader', ['attendance:read']), pay = await mkKey('Payroll system', ['payroll:read', 'employees:read']);
  assert.match(hrms, /^ak_[A-Za-z0-9_-]{30,}$/);
  const list = await api('api-keys'); assert.equal(list.keys.length, 3); assert.ok(list.keys.every(k => k.prefix.startsWith('ak_') && !('key' in k) && !('key_hash' in k)), 'the key itself is never listed');
  assert.equal((await V('/ping')).status, 401); assert.equal((await V('/ping', 'nonsense')).status, 401); assert.equal((await V('/ping', S.token)).status, 401, 'a staff login token is not an API key');
  assert.deepEqual((await V('/ping', hrms)).body.scopes.sort(), ['employees:read', 'employees:write']);
  assert.ok((await (await fetch(S.base + '/api/v1/docs')).json()).endpoints.length > 5, 'the docs list needs no key');

  // ---- employees: create / update / validation / permissions
  await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' });
  const c1 = await V('/employees', hrms, 'POST', { name: 'Hamza Ali', department: 'Engineering', branch: 'Lahore', designation: 'Developer', group: 'Staff', shift: 'office', email: 'hamza@x.com', phone: '0300', join_date: '2026-01-05', gender: 'male' });
  assert.equal(c1.status, 201); assert.equal(c1.body.created, true); assert.equal(c1.body.data.department, 'Engineering'); assert.equal(c1.body.data.shift, 'Office'); const code = c1.body.data.code; assert.equal(code, '1');
  assert.ok(!('salary' in c1.body.data), 'salary is hidden without the payroll scope');
  assert.ok((await api('departments')).some(d => d.name === 'Engineering'), 'missing departments are created by name');
  const u1 = await V('/employees', hrms, 'POST', { code, phone: '0311' }); assert.equal(u1.status, 200); assert.equal(u1.body.created, false); assert.equal(u1.body.data.phone, '0311'); assert.equal(u1.body.data.name, 'Hamza Ali', 'fields that were not sent stay as they were');
  for (const [b, re] of [[{ name: 'X', email: 'nope' }, /email/i], [{ name: 'X', gender: 'robot' }, /Gender/], [{ name: 'X', shift: 'Nope' }, /Unknown shift/], [{ name: 'X', code: 'a b' }, /Code/], [{ name: 'X', card_no: 'abc' }, /digits/], [{ name: 'X', join_date: '5/1/2026' }, /YYYY-MM-DD/], [{}, /Name/]])
    { const r = await V('/employees', hrms, 'POST', b); assert.equal(r.status, 400); assert.match(r.body.error, re); }
  await V('/employees', hrms, 'POST', { name: 'Carded', card_no: '4455' }); assert.equal((await V('/employees', hrms, 'POST', { name: 'Dup card', card_no: '4455' })).status, 400);
  assert.equal((await V('/employees', att, 'POST', { name: 'Nope' })).status, 403); assert.equal((await V('/employees', att)).status, 403);
  await api('employees/' + (await api('employees')).find(e => e.code === code).id, 'PUT', { salary: 50000 });
  assert.equal((await V('/employees/' + code, pay)).body.data.salary, 50000); assert.ok(!('salary' in (await V('/employees/' + code, hrms)).body.data));
  assert.equal((await V('/employees/999', hrms)).status, 404);
  for (const n of ['Iqra', 'Junaid', 'Kiran']) await V('/employees', hrms, 'POST', { name: n, department: 'Sales', branch: 'Karachi' });
  const pg = await V('/employees?limit=2&offset=0', hrms); assert.equal(pg.body.total, 5); assert.equal(pg.body.data.length, 2);
  assert.equal((await V('/employees?limit=2&offset=3', hrms)).body.data.length, 2); assert.equal((await V('/employees?department=sales', hrms)).body.total, 3); assert.equal((await V('/employees?q=iqra', hrms)).body.total, 1);
  assert.equal((await V('/departments', hrms)).body.data.length, 2); assert.equal((await V('/shifts', hrms)).body.data[0].name, 'Office');

  // ---- status changes
  assert.equal((await V('/employees/3/status', hrms, 'PUT', { status: 'resigned', date: '2026-07-31', reason: 'Moved abroad' })).status, 200);
  assert.equal((await V('/employees?status=resigned', hrms)).body.total, 1); assert.equal((await V('/employees?status=inactive', hrms)).body.data[0].exit_date, '2026-07-31');
  assert.equal((await V('/employees/3/status', hrms, 'PUT', { status: 'terminated' })).status, 400); assert.equal((await V('/employees/3/status', hrms, 'PUT', { status: 'sleeping' })).status, 400); assert.equal((await V('/employees/404/status', hrms, 'PUT', { status: 'active' })).status, 404);
  assert.equal((await V('/employees/3/status', hrms, 'PUT', { status: 'active', date: '2026-09-01' })).status, 200);
  const hist = await api(`employees/${(await api('employees')).find(e => e.code === '3').id}/history`); assert.deepEqual(hist.map(h => h.kind).sort(), ['registered', 'rejoin', 'resignation']); assert.equal(hist.find(h => h.kind === 'rejoin').by_user, 'api:HRMS'); assert.equal(hist.find(h => h.kind === 'registered').by_user, 'api:HRMS');

  // ---- attendance, incremental punches, leave, payroll
  const dev = (await api('devices', 'POST', { name: 'Gate', sn: 'API-DEV-1' })).id; void dev; const sim = new SimDevice(S.base, 'API-DEV-1');
  await sim.upload('ATTLOG', ['1\t2026-07-06 09:00:00\t0\t1', '1\t2026-07-06 18:00:00\t1\t1', '4\t2026-07-06 09:30:00\t0\t1']);
  const p1 = await V('/attendance/punches?since_id=0', att); assert.equal(p1.body.data.length, 3); assert.equal(p1.body.data[0].device, 'API-DEV-1'); const cur = p1.body.next_since_id;
  assert.equal((await V('/attendance/punches?since_id=' + cur, att)).body.data.length, 0, 'nothing new since last time');
  await sim.upload('ATTLOG', ['4\t2026-07-06 17:30:00\t1\t1']); const p2 = await V('/attendance/punches?since_id=' + cur, att); assert.equal(p2.body.data.length, 1); assert.equal(p2.body.data[0].code, '4'); assert.ok(p2.body.next_since_id > cur);
  const dly = await V('/attendance/daily?from=2026-07-06&to=2026-07-06&employee_code=1', att); assert.equal(dly.body.data.length, 1); assert.equal(dly.body.data[0].in, '09:00'); assert.equal(dly.body.data[0].worked_min, 540);
  assert.equal((await V('/attendance/daily?from=2026-01-01&to=2026-12-31', att)).status, 400); assert.equal((await V('/attendance/daily?employee_code=9999', att)).status, 404); assert.equal((await V('/attendance/daily?department=Nope', att)).status, 404);
  assert.equal((await V('/attendance/daily', hrms)).status, 403, 'a key needs the attendance permission');
  await api('leaves', 'POST', { employee_id: (await api('employees')).find(e => e.code === '1').id, type: 'Casual', from_date: '2026-07-08', to_date: '2026-07-08' });
  assert.equal((await V('/leaves?status=pending', att)).body.data.length, 1);
  assert.equal((await V('/payroll/2026-07', pay)).status, 404); assert.equal((await V('/payroll/2026-07?draft=1', pay)).body.status, 'draft'); assert.equal((await V('/payroll/July', pay)).status, 400); assert.equal((await V('/payroll/2026-07', hrms)).status, 403);
  await api('payroll/finalize', 'POST', { month: '2026-07', force: true }); const fp = await V('/payroll/2026-07', pay); assert.equal(fp.body.status, 'finalized'); assert.ok(fp.body.data.some(r => r.code === '1'));

  // ---- rate limit and revoking
  const lim = await mkKey('Busy', ['employees:read']); let last; for (let i = 0; i < 62; i++) last = await V('/ping', lim);
  assert.equal(last.status, 429); assert.ok(last.headers.get('retry-after')); assert.equal((await V('/ping', hrms)).status, 200, 'the limit is per key');
  const kid = (await api('api-keys')).keys.find(k => k.name === 'HRMS').id; await api('api-keys/' + kid, 'PUT', { active: false }); assert.equal((await V('/ping', hrms)).status, 401, 'a switched-off key stops working at once');
  await api('api-keys/' + kid, 'PUT', { active: true }); assert.equal((await V('/ping', hrms)).status, 200);
  assert.ok((await api('api-keys')).keys.find(k => k.id === kid).requests > 5);

  // ---- webhooks: validation
  const wh = (b) => api('webhooks', 'POST', b);
  await assert.rejects(wh({ name: 'x', url: 'ftp://host/x' }), /http/); await assert.rejects(wh({ name: 'x', url: 'not a url' }), /valid URL/); await assert.rejects(wh({ name: 'x', url: 'http://169.254.169.254/latest' }), /not allowed/);
  await assert.rejects(wh({ name: 'x', url: RX, events: ['nope.event'] }), /Unknown event/); await assert.rejects(wh({ name: '', url: RX }), /Name/);
  const h1 = await wh({ name: 'ERP', url: RX, events: ['employee.created', 'leave.requested'] }); assert.match(h1.secret, /^whsec_/);
  const listed = (await api('webhooks')).find(w => w.id === h1.id); assert.ok(listed.secret.includes('…') && !listed.secret.includes(h1.secret.slice(8, 20)), 'the secret is masked after creation'); assert.deepEqual(listed.events, ['employee.created', 'leave.requested']);
  assert.ok((await api('webhooks/events')).includes('punch.created'));

  // ---- delivery, signature, filtering
  const t = await api(`webhooks/${h1.id}/test`, 'POST'); assert.equal(t.ok, true); assert.equal(hits.at(-1).json.event, 'test.ping');
  const verify = (hit, secret) => hit.headers['x-signature'] === 'sha256=' + createHmac('sha256', secret).update(hit.body).digest('hex');
  assert.ok(verify(hits.at(-1), h1.secret), 'the signature matches the secret'); assert.equal(hits.at(-1).headers['x-webhook-event'], 'test.ping');
  hits.length = 0;
  await api('employees', 'POST', { name: 'Webhook Wasim' }); await api('departments', 'POST', { name: 'Noise' });
  await sim.upload('ATTLOG', ['1\t2026-07-07 09:00:00\t0\t1']);                    // punch.created: this webhook did not ask for it
  await run(); assert.deepEqual(events(), ['employee.created']); assert.equal(hits[0].json.data.name, 'Webhook Wasim'); assert.ok(hits[0].json.id && hits[0].json.created);
  hits.length = 0; await api('leaves', 'POST', { employee_id: (await api('employees')).find(e => e.code === '1').id, type: 'Casual', from_date: '2026-07-20', to_date: '2026-07-21' }); await run();
  assert.deepEqual(events(), ['leave.requested']); assert.equal(hits[0].json.data.code, '1'); assert.equal(hits[0].json.data.days, 2);

  // ---- everything-webhook, device and payroll events, inactive hooks, secret rotation
  const all = await wh({ name: 'Everything', url: RX, events: ['*'] }); hits.length = 0;
  await sim.upload('ATTLOG', ['1\t2026-07-08 09:00:00\t0\t1', '4\t2026-07-08 09:10:00\t0\t1']); await run();
  const punch = hits.find(h => h.json.event === 'punch.created'); assert.equal(punch.json.data.count, 2); assert.deepEqual(punch.json.data.punches.map(p => p.code).sort(), ['1', '4']);
  assert.ok(verify(punch, all.secret)); assert.equal(hits.filter(h => h.json.event === 'punch.created').length, 1, 'only the wildcard hook got the punches');
  await api('webhooks/' + all.id, 'PUT', { name: 'Everything', url: RX, events: ['*'], active: false }); hits.length = 0; await api('employees', 'POST', { name: 'Quiet one' }); await run(); assert.deepEqual(events(), ['employee.created'], 'a switched-off webhook is not called');
  const rot = await api(`webhooks/${h1.id}/rotate`, 'POST'); hits.length = 0; await api(`webhooks/${h1.id}/test`, 'POST'); assert.ok(verify(hits.at(-1), rot.secret) && !verify(hits.at(-1), h1.secret), 'signatures use the rotated secret');

  // ---- failures: retry later, then give up; manual retry
  answer = 500; hits.length = 0; await api('employees', 'POST', { name: 'Retry Rana' }); await run();
  let dl = (await api(`webhooks/${h1.id}/deliveries`)).find(d => d.event === 'employee.created' && d.status !== 'done'); assert.equal(dl.status, 'pending'); assert.equal(dl.attempts, 1); assert.match(dl.error, /500/);
  assert.equal((await api('webhooks')).find(w => w.id === h1.id).failures >= 1, true); assert.match((await api('webhooks')).find(w => w.id === h1.id).last_status, /500/);
  assert.deepEqual(await run(), { delivered: 0, failed: 0 }, 'not due yet: the receiver is left alone for a while');
  answer = 200; assert.deepEqual(await run(true), { delivered: 1, failed: 0 }); dl = (await api(`webhooks/${h1.id}/deliveries`)).find(d => d.id === dl.id); assert.equal(dl.status, 'done'); assert.equal(dl.attempts, 2);
  assert.equal((await api('webhooks')).find(w => w.id === h1.id).last_status, 'ok');
  answer = 500; await api('employees', 'POST', { name: 'Hopeless Hina' }); for (let i = 0; i < 6; i++) await run(true);
  dl = (await api(`webhooks/${h1.id}/deliveries`)).find(d => d.status === 'failed'); assert.ok(dl, 'after the last attempt it is marked failed'); assert.equal(dl.attempts, 6);
  answer = 200; await api(`webhooks/deliveries/${dl.id}/retry`, 'POST'); await run(true); assert.equal((await api(`webhooks/${h1.id}/deliveries`)).find(d => d.id === dl.id).status, 'done');
  await assert.rejects(api(`webhooks/deliveries/${dl.id}/retry`, 'POST'), /Nothing to retry/);

  // ---- a receiver that is down never breaks the app
  const dead = await wh({ name: 'Dead', url: 'http://127.0.0.1:1/x', events: ['employee.created'] }); await api('employees', 'POST', { name: 'Still works' }); await run();
  assert.match((await api('webhooks')).find(w => w.id === dead.id).last_status, /ECONNREFUSED|refused|fetch/i);

  // ---- permissions
  await api('users', 'POST', { username: 'hr1', password: 'password1', role: 'hr' }); const ht = await S.login('hr1', 'password1');
  for (const p of ['api-keys', 'webhooks']) assert.equal((await S.raw(p, 'GET', undefined, ht)).status, 403, p + ' is admin only');
  console.log('e2e-api passed: keys + scopes, employees upsert/status, incremental punches, attendance, payroll, rate limit, webhooks (signature, filters, retry, give-up)');
} catch (e) { console.error('E2E-API FAILED:', (e.stack || '').split('\n').filter(l => /e2e-api.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message.split('\n')[0]); process.exitCode = 1; }
finally { rx.close(); S.stop(); }
