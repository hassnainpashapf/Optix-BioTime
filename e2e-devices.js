// Device management: registry, health monitoring, commands, cards, biometric templates, groups, events.
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from './e2e-lib.js';
import { SimDevice } from './sim-device.js';

const S = await startServer(), api = S.api;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const listen = () => new Promise(ok => { const s = net.createServer(c => c.destroy()); s.listen(0, '127.0.0.1', () => ok(s)); });
const as = (token) => ({ send: async (p, m, b) => { const r = await S.raw(p, m, b, token); return { status: r.status, body: await r.json().catch(() => ({})) }; } });
const servers = [];
try {
  const hq = (await api('branches', 'POST', { name: 'HQ' })).id, khi = (await api('branches', 'POST', { name: 'Karachi' })).id;
  const mk = (name, extra) => api('employees', 'POST', { name, ...extra });
  const A = await mk('Ayesha', { branch_id: hq }), B = await mk('Bilal', { branch_id: hq }), C = await mk('Chand', { branch_id: khi });

  // ---- registry validation
  const post = (b) => api('devices', 'POST', b);
  await assert.rejects(post({}), /Name required/); await assert.rejects(post({ name: 'x' }), /IP address .* or the serial number/);
  await assert.rejects(post({ name: 'x', ip: '999.1.1.1' }), /looks wrong/); await assert.rejects(post({ name: 'x', ip: '1.1.1.1', port: 70000 }), /Port/);
  await assert.rejects(post({ name: 'x', sn: 'a b' }), /Serial number/); await assert.rejects(post({ name: 'x', ip: '10.0.0.5', delay: 0 }), /Check-in interval/);
  const gate = (await post({ name: 'Main gate', sn: 'GATE-001', location: 'Reception' })).id;
  assert.equal((await api('devices')).find(d => d.id === gate).approved, 1, 'a serial number typed in by an admin is trusted at once');
  await assert.rejects(post({ name: 'dup', sn: 'GATE-001' }), /already exists/);
  const gate2 = (await post({ name: 'Karachi gate', sn: 'KHI-001' })).id;
  const grpHq = (await api('device_groups', 'POST', { name: 'HQ devices', branch_id: hq })).id, grpKhi = (await api('device_groups', 'POST', { name: 'Karachi devices', branch_id: khi })).id;
  await assert.rejects(api('device_groups', 'POST', { name: 'HQ devices' }), /exists/); await assert.rejects(api('device_groups', 'POST', { name: 'x', branch_id: 999 }), /Unknown branch/);
  await assert.rejects(api('devices/' + gate, 'PUT', { group_id: 999 }), /Unknown device group/);
  await api('devices/' + gate, 'PUT', { group_id: grpHq, delay: 7, location: 'Reception desk' }); await api('devices/' + gate2, 'PUT', { group_id: grpKhi });
  await assert.rejects(api('device_groups/' + grpHq, 'DELETE'), /still in this group/);
  assert.equal((await api('device_groups')).find(g => g.id === grpHq).devices, 1);
  const sim = new SimDevice(S.base, 'GATE-001'), sim2 = new SimDevice(S.base, 'KHI-001');
  const hs = await sim.handshake(); assert.match(hs.text, /Delay=7/); assert.match(hs.text, /Realtime=1/); assert.ok(hs.date, 'the server clock goes out in the Date header');

  // ---- what the device says about itself
  await sim.poll();
  const g1 = (await api('devices')).find(d => d.id === gate);
  assert.equal(g1.firmware, 'Ver 6.60 Sep 2019'); assert.equal(g1.info.pushver, '2.4.1'); assert.equal(g1.online, true); assert.equal(g1.location, 'Reception desk'); assert.equal(g1.group_name, 'HQ devices');

  // ---- health monitoring: offline / back online, push and pull devices, events and notices
  await api('settings', 'PUT', { device_offline_min: 0.03 });
  const closed = await listen(), closedPort = closed.address().port; closed.close(); await sleep(50);
  const pull = (await post({ name: 'Old terminal', ip: '127.0.0.1', port: closedPort })).id;
  await api('devices/' + pull, 'PUT', { approved: true });
  await sleep(2300);
  let chk = await api('devices/check', 'POST'); const by = (id) => chk.find(c => c.id === id);
  assert.equal(by(gate).online, false); assert.equal(by(pull).online, false); assert.equal(by(gate2).online, null, 'never connected: no verdict');
  assert.ok((await api('device-events?kind=offline')).some(e => e.device === 'Main gate')); assert.ok((await api('notifications')).items.some(n => /Device offline: Main gate/.test(n.title)));
  assert.ok((await api('notifications')).items.some(n => /Device offline: Old terminal/.test(n.title)));
  assert.equal((await api('devices')).find(d => d.id === gate).online, false, 'the list shows the live state');
  await sim.poll(); chk = await api('devices/check', 'POST'); assert.equal(by(gate).online, true);
  assert.ok((await api('devices/' + gate + '/events')).some(e => e.kind === 'online'), 'back online is recorded'); assert.ok((await api('notifications')).items.some(n => /Device back online: Main gate/.test(n.title)));
  const up = await listen(); servers.push(up); await api('devices/' + pull, 'PUT', { port: up.address().port });
  chk = await api('devices/check', 'POST'); assert.equal(by(pull).online, true); assert.ok((await api('devices/' + pull + '/events')).some(e => e.kind === 'online'));
  const t1 = await api('devices/' + pull + '/test', 'POST'); assert.equal(t1.ok, true); assert.match(t1.message, /Reached 127.0.0.1/);
  await api('devices/' + pull, 'PUT', { port: closedPort }); const t2 = await api('devices/' + pull + '/test', 'POST'); assert.equal(t2.ok, false); assert.match(t2.message, /No answer/);
  await api('settings', 'PUT', { device_offline_min: 5 });
  assert.equal((await api('devices/' + gate + '/test', 'POST')).ok, true); assert.equal((await api('devices/' + gate2 + '/test', 'POST')).ok, false);

  // ---- cards: validation, sent to devices, adopted from devices, conflicts
  await assert.rejects(api('employees/' + A.id, 'PUT', { card_no: 'abc' }), /digits only/);
  await api('employees/' + A.id, 'PUT', { card_no: '12345' });
  await assert.rejects(api('employees/' + B.id, 'PUT', { card_no: '12345' }), /already assigned/);
  await api('employees/' + B.id, 'PUT', { card_no: '' });

  // ---- sending people to a device: a device in a branch group only gets that branch
  const pu = await api(`devices/${gate}/push-users`, 'POST'); assert.equal(pu.queued, 2); assert.equal(pu.only_branch, true);
  await sim.poll(); assert.deepEqual([...sim.users.keys()].sort(), [A.code, B.code].sort()); assert.equal(sim.users.get(A.code).card, '12345'); assert.equal(sim.users.get(A.code).name, 'Ayesha');
  assert.equal((await api(`devices/${gate2}/push-users`, 'POST')).queued, 1); await sim2.poll(); assert.deepEqual([...sim2.users.keys()], [C.code]);
  await api('devices/' + gate, 'PUT', { group_id: null }); assert.equal((await api(`devices/${gate}/push-users`, 'POST')).queued, 3, 'no group: everyone'); await sim.poll();
  assert.equal(sim.users.size, 3);
  const pend = await api('employees', 'POST', { name: 'Dina', branch_id: hq }); await sim.poll();                    // creating an employee reaches the device by itself
  assert.ok(sim.users.has(pend.code)); await api(`employees/${pend.id}`, 'PUT', { active: 0 }); await sim.poll(); assert.ok(!sim.users.has(pend.code), 'deactivating removes them from the device');
  // a person enrolled on the device: name and card come back
  sim.users.set('9001', { name: 'Walk-in Wasim', card: '777' }); sim.users.set(B.code, { name: 'Bilal', card: '12345' });   // 12345 belongs to Ayesha
  await api(`devices/${gate}/fetch-users`, 'POST'); await sim.poll();
  const emps = await api('employees'); const w = emps.find(e => e.code === '9001'); assert.ok(w); assert.equal(w.name, 'Walk-in Wasim'); assert.equal(w.card_no, '777');
  assert.equal(emps.find(e => e.id === B.id).card_no, null, 'a card already owned by someone else is not taken over');
  assert.ok((await api('device-events?kind=card_conflict')).some(e => /12345/.test(e.detail)));

  // ---- commands: reboot, clock, failure and retry, cancel, request logs
  const rb = await api(`devices/${gate}/reboot`, 'POST'); await sim.poll(); assert.equal(sim.rebooted, 1);
  let cmds = await api(`devices/${gate}/commands`); assert.equal(cmds.find(c => c.id === rb.command).status, 'done');
  await api(`devices/${gate}/time-sync`, 'POST'); await sim.poll(); assert.match(sim.clock, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  sim.failCommands = ['REBOOT']; const rb2 = await api(`devices/${gate}/reboot`, 'POST'); await sim.poll();
  cmds = await api(`devices/${gate}/commands`); assert.equal(cmds.find(c => c.id === rb2.command).status, 'failed'); assert.equal(cmds.find(c => c.id === rb2.command).result, 'Return=-1');
  assert.ok((await api(`devices/${gate}/events`)).some(e => e.kind === 'command_failed' && /REBOOT/.test(e.detail)));
  sim.failCommands = []; await api(`devices/commands/${rb2.command}/retry`, 'POST'); await sim.poll(); assert.equal(sim.rebooted, 2);
  assert.equal((await api(`devices/${gate}/commands`)).find(c => c.id === rb2.command).status, 'done');
  await assert.rejects(api(`devices/commands/${rb2.command}/retry`, 'POST'), /failed or cancelled/);
  const rb3 = await api(`devices/${gate}/reboot`, 'POST'); await api(`devices/commands/${rb3.command}/cancel`, 'POST'); await sim.poll(); assert.equal(sim.rebooted, 2, 'a cancelled command is never delivered');
  await assert.rejects(api(`devices/commands/${rb3.command}/cancel`, 'POST'), /not been fetched/);
  assert.ok((await api(`devices/${gate}/commands/clear`, 'POST')).cleared >= 3);
  await assert.rejects(api(`devices/${pull}/reboot`, 'POST'), /push devices only/); await assert.rejects(api(`devices/${pull}/time-sync`, 'POST'), /not supported for pull/);
  sim.punches = [{ pin: A.code, ts: '2026-03-02 09:00:00' }, { pin: A.code, ts: '2026-03-02 18:00:00' }, { pin: B.code, ts: '2026-04-10 09:05:00' }];
  await assert.rejects(api(`devices/${gate}/request-logs`, 'POST', { from: '2026-03-02' }), /from and to/);
  await api(`devices/${gate}/request-logs`, 'POST', { from: '2026-03-01', to: '2026-03-31' }); await sim.poll();
  assert.equal((await api('logs?date=2026-03-02')).length, 2); assert.equal((await api('logs?date=2026-04-10')).length, 0, 'only the requested period came back');

  // ---- biometric templates: counted always, stored only when switched on, encrypted, copied between devices
  const FP = 'TEMPLATEFP' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.repeat(3), FACE = 'FACETMPL' + 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkjihgfedcba9876543210'.repeat(3);
  sim.templates = [{ kind: 'fp', pin: A.code, fid: 0, tmpl: FP }, { kind: 'face', pin: A.code, fid: 0, tmpl: FACE }]; await sim.uploadTemplates();
  let bio = await api(`employees/${A.id}/biometrics`); assert.equal(bio.fingerprints, 1); assert.equal(bio.faces, 1); assert.equal(bio.stored, 0); assert.equal(bio.storage_on, false); assert.equal(bio.card_no, '12345');
  assert.ok(!JSON.stringify(bio).includes('TEMPLATEFP'), 'the API never returns template data');
  await assert.rejects(api(`devices/${gate2}/sync-bio`, 'POST', {}), /switched off/);
  await api('settings', 'PUT', { store_templates: 1 }); await sim.uploadTemplates();
  bio = await api(`employees/${A.id}/biometrics`); assert.equal(bio.stored, 2); assert.equal(bio.storage_on, true);
  await api('devices/' + gate2, 'PUT', { group_id: null });
  const sb = await api(`devices/${gate2}/sync-bio`, 'POST', {}); assert.equal(sb.queued, 2); assert.equal(sb.employees, 1);
  assert.ok(!(await api(`devices/${gate2}/commands`)).some(c => c.cmd.includes('TEMPLATEFP')), 'queued commands hold no template text');
  await sim2.poll(); const got = sim2.templates; assert.deepEqual(got.map(t => `${t.kind}:${t.pin}:${t.tmpl === (t.kind === 'fp' ? FP : FACE)}`).sort(), [`face:${A.code}:true`, `fp:${A.code}:true`], 'templates arrive intact');
  assert.ok(sim2.users.has(A.code));
  await api('devices/' + gate2, 'PUT', { group_id: grpKhi }); assert.equal((await api(`devices/${gate2}/sync-bio`, 'POST', {})).queued, 0, 'a Karachi device does not receive an HQ employee\'s templates');
  const backup = Buffer.from(await (await S.raw('backup')).arrayBuffer()).toString('latin1');
  assert.ok(!backup.includes('TEMPLATEFP') && !backup.includes('FACETMPL'), 'templates are encrypted inside the database and its backups');
  assert.equal(await (await S.raw('biodata', 'DELETE', undefined, await (async () => { await api('users', 'POST', { username: 'hr1', password: 'password1', role: 'hr' }); return S.login('hr1', 'password1'); })())).status, 403, 'only admin can wipe templates');
  assert.ok((await api('biodata', 'DELETE')).erased >= 2); assert.equal((await api(`employees/${A.id}/biometrics`)).stored, 0); assert.equal((await api(`employees/${A.id}/biometrics`)).fingerprints, 1, 'counts remain, templates are gone');
  await api('employees/' + A.id + '/biometrics', 'DELETE'); assert.equal((await api(`employees/${A.id}/biometrics`)).fingerprints, 0);
  await api('settings', 'PUT', { store_templates: 0 });

  // ---- unknown devices and events
  const rogue = new SimDevice(S.base, 'ROGUE-77'); await rogue.upload('ATTLOG', [`${A.code}\t2026-05-05 09:00:00\t0\t1\t0\t0`]);
  const rd = (await api('devices')).find(d => d.sn === 'ROGUE-77'); assert.equal(rd.approved, 0);
  const evs = (await api('devices/' + rd.id + '/events')).map(e => e.kind); assert.ok(evs.includes('registered') && evs.includes('rejected_data'));
  assert.equal((await api('logs?date=2026-05-05')).length, 0, 'data from an unapproved device is not stored');
  await api('devices/' + rd.id, 'PUT', { approved: true }); await rogue.upload('ATTLOG', [`${A.code}\t2026-05-05 09:00:00\t0\t1\t0\t0`]); assert.equal((await api('logs?date=2026-05-05')).length, 1);
  assert.ok((await api('device-events')).length >= 5);

  // ---- permissions
  await api('users', 'POST', { username: 'viewer1', password: 'password1', role: 'viewer' });
  const vw = as(await S.login('viewer1', 'password1')); assert.equal((await vw.send('devices', 'GET')).status, 200); assert.equal((await vw.send(`devices/${gate}/reboot`, 'POST')).status, 403);
  assert.equal((await vw.send('device-events', 'GET')).status, 200);
  await api('users', 'POST', { username: 'scoped', password: 'password1', role: 'hr', branches: [hq] });
  const sc = as(await S.login('scoped', 'password1')); assert.equal((await sc.send(`devices/${gate}/reboot`, 'POST')).status, 403, 'devices are company-wide equipment');
  console.log('e2e-devices passed: registry, monitoring, commands, cards, biometrics (encrypted, copied), groups, events, permissions');
} catch (e) { console.error('E2E-DEVICES FAILED:', (e.stack || '').split('\n').filter(l => /e2e-devices.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message.split('\n')[0]); process.exitCode = 1; }
finally { for (const s of servers) s.close(); S.stop(); }
