// Phone pairing and the alert feed a phone listens to: one-time codes, tokens, long polling, preferences, scope, revoking.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const M = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/m/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const P = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const stamp = (m = 0) => new Date(Date.now() + m * 60000).toLocaleString('sv');
try {
  assert.equal((await M('info')).body.app, 'attendance'); assert.equal((await M('feed')).status, 401, 'no token, no feed'); assert.equal((await M('feed', 'GET', undefined, 'nope')).status, 401);
  const html = await fetch(S.base + '/m'); assert.equal(html.status, 200); assert.match(await html.text(), /Attendance alerts/);

  // ---- a staff user pairs a phone
  const code = (await api('mobile/pair-code', 'POST')).code; assert.match(code, /^\d{8}$/);
  assert.equal((await M('pair', 'POST', { code: '00000000' })).status, 400); const p = await M('pair', 'POST', { code, device_name: 'Pixel' }); assert.equal(p.status, 200); assert.equal(p.body.kind, 'staff'); const tok = p.body.token;
  assert.equal((await M('pair', 'POST', { code })).status, 400, 'a code works once');
  assert.deepEqual((await api('mobile/devices')).map(d => d.label), ['Pixel']);
  const me = await M('me', 'GET', undefined, tok); assert.equal(me.body.name, 'admin'); assert.equal(me.body.kind, 'staff');

  // ---- alerts arrive in the feed; the cursor only returns newer ones; long polling answers as soon as something happens
  await api('alerts/test', 'POST'); let f = await M('feed', 'GET', undefined, tok); assert.ok(f.body.items.some(i => i.title === 'Test alert')); const cursor = f.body.latest;
  assert.equal((await M('feed?since=' + cursor, 'GET', undefined, tok)).body.items.length, 0);
  const t0 = Date.now(), waiting = M(`feed?since=${cursor}&wait=20`, 'GET', undefined, tok); await sleep(1500); await api('alerts/test', 'POST'); const got = await waiting; assert.equal(got.body.items.length, 1); assert.ok(Date.now() - t0 < 6000, 'answered as soon as the alert was created');
  const t1 = Date.now(); const empty = await M(`feed?since=${got.body.latest}&wait=2`, 'GET', undefined, tok); assert.deepEqual(empty.body.items, []); assert.ok(Date.now() - t1 >= 1800, 'an empty wait lasts the full time');

  // ---- preferences through the phone, the same as on the computer
  const ap = await M('alerts', 'GET', undefined, tok); assert.equal(ap.status, 200); assert.ok(ap.body.prefs.some(x => x.kind === 'late'));
  assert.equal((await M('alerts/prefs', 'PUT', { kind: 'automation', enabled: false }, tok)).status, 200); const off = await M(`feed?since=0`, 'GET', undefined, tok); assert.ok(!off.body.items.some(i => i.title === 'Test alert'), 'switched off on the phone, gone from the feed');
  assert.ok(!(await api('alerts')).prefs.find(x => x.kind === 'automation').enabled, 'the same switch as on the computer'); await M('alerts/prefs', 'PUT', { kind: 'automation', enabled: true }, tok);
  assert.equal((await M('alerts/prefs', 'PUT', { kind: 'my_punch', enabled: true }, tok)).status, 400, 'staff phones cannot set employee-only alerts');

  // ---- an employee pairs their own phone and gets their own alerts only
  await api('shifts', 'POST', { name: 'AllDay', start: '00:01', end: '23:59', grace_min: 0, workdays: '0,1,2,3,4,5,6' }); const sh = (await api('shifts')).at(-1).id;
  const E1 = await api('employees', 'POST', { name: 'Emp One', shift_id: sh, join_date: '2025-01-01' }), E2 = await api('employees', 'POST', { name: 'Emp Two', shift_id: sh, join_date: '2025-01-01' });
  const code1 = (await api('employees')).find(e => e.id === E1.id).code, code2 = (await api('employees')).find(e => e.id === E2.id).code;
  const acc = Object.fromEntries((await api('portal-accounts', 'POST', { all: true })).accounts.map(a => [a.code, a.password]));
  const login = async (c) => { const l = await P('login', 'POST', { code: c, password: acc[c] }); await P('password', 'POST', { current: acc[c], password: 'new-password-' + c }, l.body.token); return (await P('login', 'POST', { code: c, password: 'new-password-' + c })).body.token; };
  const pt1 = await login(code1), pt2 = await login(code2);
  const pc = await P('mobile/pair-code', 'POST', undefined, pt1); const pp = await M('pair', 'POST', { code: pc.body.code.toString(), device_name: 'Emp phone' }); assert.equal(pp.body.kind, 'emp'); const etok = pp.body.token;
  assert.equal((await P('mobile/devices', 'GET', undefined, pt1)).body.length, 1); assert.equal((await P('mobile/devices', 'GET', undefined, pt2)).body.length, 0);
  await api('devices', 'POST', { name: 'Gate', sn: 'M-001' }); const sim = new SimDevice(S.base, 'M-001'); await sim.poll();
  await sim.uploadPunches([{ pin: code1, ts: stamp(-2) }, { pin: code2, ts: stamp(-2) }]); await sleep(600);
  const ef = (await M('feed', 'GET', undefined, etok)).body.items; assert.ok(ef.some(i => /Punch recorded/.test(i.title)), 'own punch confirmation'); assert.equal(ef.filter(i => i.kind === 'my_punch').length, 1, 'only my punch, not the other employee\'s');
  assert.ok(!ef.some(i => /Emp Two/.test(i.title)), 'colleagues\' punches stay private');
  assert.equal((await M('alerts/prefs', 'PUT', { kind: 'device_status', enabled: true }, etok)).status, 400); await M('alerts/prefs', 'PUT', { kind: 'my_punch', enabled: false }, etok); assert.ok(!(await M('feed', 'GET', undefined, etok)).body.items.some(i => i.kind === 'my_punch'));
  // ---- scoped staff phone only sees its own part of the company
  const br = (await api('branches', 'POST', { name: 'Karachi' })).id; await api('employees/' + E2.id, 'PUT', { branch_id: br });
  await api('users', 'POST', { username: 'khi', password: 'password1', role: 'manager', branches: [br] }); const kt = await S.login('khi', 'password1');
  const kc = await (await fetch(S.base + '/api/mobile/pair-code', { method: 'POST', headers: { Authorization: 'Bearer ' + kt } })).json(); const kp = await M('pair', 'POST', { code: kc.code }); const ktok = kp.body.token;
  await api('alerts/prefs', 'PUT', { kind: 'punch', enabled: true }); await S.raw('alerts/prefs', 'PUT', { kind: 'punch', enabled: true }, kt); await sim.uploadPunches([{ pin: code1, ts: stamp(-1) }, { pin: code2, ts: stamp(-1) }]); await sleep(600);
  const kf = (await M('feed', 'GET', undefined, ktok)).body.items.filter(i => i.kind === 'punch'); assert.ok(kf.length >= 1 && kf.every(i => /Emp Two/.test(i.title)), 'a branch-scoped phone sees only its branch');
  assert.ok((await M('feed', 'GET', undefined, tok)).body.items.filter(i => i.kind === 'punch').some(i => /Emp One/.test(i.title)), 'the unscoped admin phone sees everybody');
  // ---- revoking and switching accounts off
  const dev = (await api('mobile/devices'))[0]; await api('mobile/devices/' + dev.id, 'DELETE'); assert.equal((await M('feed', 'GET', undefined, tok)).status, 401, 'a removed phone stops working at once'); assert.equal((await api('mobile/devices')).length, 0);
  assert.equal((await M('logout', 'POST', undefined, etok)).status, 200); assert.equal((await M('feed', 'GET', undefined, etok)).status, 401);
  // expired code and attempt limit
  const ex = (await api('mobile/pair-code', 'POST')).code; assert.equal((await M('pair', 'POST', { code: ex.slice(0, 7) + ((+ex[7] + 1) % 10) })).status, 400);
  let last; for (let i = 0; i < 12; i++) last = await M('pair', 'POST', { code: '11111111' }); assert.equal(last.status, 429, 'guessing codes is limited');
  console.log('e2e-mobile passed: pairing (single use, limits), token feed, long polling, preferences from the phone, employee and scoped phones, revoking');
} catch (e) { console.error('E2E-MOBILE FAILED:', (e.stack || '').split('\n').filter(l => /e2e-mobile.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
