// Full flow against a real server process with a throwaway database, using the fake device.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSim, simDays } from './sim-device.js';
import { dateStr } from './dates.js';

const dir = mkdtempSync(join(tmpdir(), 'att-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000), base = `http://localhost:${PORT}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_FILE: join(dir, 'e2e.db'), BACKUP_DIR: join(dir, 'bk'), LOG_DIR: join(dir, 'logs'), ADMIN_PASSWORD: 'e2e-pass' }, stdio: 'pipe' });
let token = '';
const api = async (path, method = 'GET', body) => {
  const r = await fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`); return j;
};
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/iclock/ping'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  assert.equal((await fetch(base + '/api/employees')).status, 401, 'API must require login');
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x' }) });
  assert.equal(bad.status, 401);
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'e2e-pass' }) })).json()).token;
  assert.ok(token);

  // Device appears unapproved and its data is ignored
  const N = 10, SN = 'SIM0001';
  await runSim(base, SN, N);
  let devs = await api('devices'); assert.equal(devs.length, 1); assert.equal(devs[0].approved, 0);
  assert.equal((await api('employees')).length, 0, 'unapproved device must not create employees');

  // Approve, device pushes again
  await api(`devices/${devs[0].id}`, 'PUT', { approved: 1 });
  const out = await runSim(base, SN, N);
  assert.match(out.reply, /^OK: \d+/);
  const emps = await api('employees'); assert.equal(emps.length, 5);
  assert.ok(emps.some(e => e.name === 'Ali Raza'));
  const again = await runSim(base, SN, N);               // re-upload must not duplicate
  const days = simDays(N);
  const logsDay = await api('logs?date=' + days.at(-1));
  assert.equal(logsDay.filter(l => l.emp_code === '101').length, 2);

  // App-side employee changes reach the device as commands it fetches on its next poll
  const devId = devs[0].id, poll = async () => (await fetch(`${base}/iclock/getrequest?SN=${SN}`)).text();
  const np = await api('employees', 'POST', { code: '777', name: 'Test Person' });
  const p1 = await poll();
  assert.match(p1, /C:\d+:DATA UPDATE USERINFO PIN=777\tName=Test Person/);
  const cid = p1.match(/C:(\d+):/)[1];
  assert.equal(await poll(), 'OK', 'a delivered command is not delivered twice');
  await fetch(`${base}/iclock/devicecmd?SN=${SN}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: `ID=${cid}&Return=0&CMD=DATA` });
  assert.equal((await api(`devices/${devId}/commands`)).find(c => c.id == cid).status, 'done');
  await api(`employees/${np.id}`, 'PUT', { active: 0 });           // deactivate = remove from device
  assert.match(await poll(), /DATA DELETE USERINFO PIN=777/);
  assert.equal((await api('employees')).find(x => x.id === np.id).active, 0);
  await api(`employees/${np.id}`, 'DELETE'); await poll();
  assert.equal((await api(`devices/${devId}/push-users`, 'POST')).queued, 5, 'push all active employees to the device');
  await poll();

  // Shift + assign everyone, then check the report numbers
  const shiftId = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5,6' })).id;
  for (const e of emps) await api(`employees/${e.id}`, 'PUT', { shift_id: shiftId, salary: 30000 });
  const q = `from=${days[0]}&to=${days.at(-1)}`;
  const sum = Object.fromEntries((await api('report/summary?' + q)).map(s => [s.code, s]));
  const W = days.length;
  assert.equal(sum['101'].present, W); assert.equal(sum['101'].late, 0); assert.equal(sum['101'].overtime_min, 0);
  assert.equal(sum['102'].late, W); assert.equal(sum['102'].late_min, 40 * W);
  assert.equal(sum['103'].absent, 1); assert.equal(sum['103'].present, W - 1);
  assert.equal(sum['104'].overtime_min, 120 * W);
  const hina = (await api('report/daily?' + q)).filter(r => r.code === '105' && r.status === 'Missing Out');
  assert.equal(hina.length, 1); assert.equal(hina[0].date, days.at(-1));

  // Manual punch fixes a missing punch-out; a viewer account can read but not write
  const hinaDay = hina[0].date;
  await api('logs/manual', 'POST', { emp_code: '105', ts: `${hinaDay}T18:02` });
  const fixed = (await api('report/daily?' + q)).find(r => r.code === '105' && r.date === hinaDay);
  assert.equal(fixed.status, 'Present'); assert.equal(fixed.out, '18:02');
  const manualId = (await api('logs?date=' + hinaDay)).find(l => l.source === 'manual').id;
  await assert.rejects(api('logs/1', 'DELETE'), /manual/);               // device punches cannot be deleted
  await api('logs/' + manualId, 'DELETE');
  await api('users', 'POST', { username: 'boss', password: 'viewonly1', role: 'viewer' });
  const vt = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'viewonly1' }) })).json()).token;
  const asViewer = (path, method = 'GET') => fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vt }, body: method === 'GET' ? undefined : '{}' });
  assert.equal((await asViewer('report/summary?' + q)).status, 200);
  assert.equal((await asViewer('employees', 'POST')).status, 403);
  assert.equal((await asViewer('users')).status, 403);
  const boss = (await api('users')).find(u => u.username === 'boss');
  await assert.rejects(api('users/1', 'PUT', { role: 'viewer' }), /at least one admin/);
  await api('users/' + boss.id, 'PUT', { password: 'newpass99' });
  assert.equal((await asViewer('report/summary?' + q)).status, 401, 'password change signs the user out');
  const relog = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'newpass99' }) });
  assert.equal(relog.status, 200);
  await api('users/' + boss.id, 'DELETE');
  assert.equal((await asViewer('report/summary?' + q)).status, 401, 'deleted user loses access');

  // Payroll for the month of the latest punch day, CSV, settings, backup
  const month = days.at(-1).slice(0, 7);
  const pv = await api('report/payroll?month=' + month); const pay = pv.rows;
  assert.equal(pv.status, 'draft'); assert.ok(pay.length >= 1 && pay.every(p => p.net >= 0));
  // adjustments change net pay; finalize locks the month; paid; reopen
  const ali = emps.find(x => x.code === '101'), net0 = pay.find(x => x.code === '101').net;
  await api('payroll/items', 'POST', { employee_id: ali.id, month, kind: 'allowance', amount: 1000, note: 'Fuel' });
  await api('payroll/items', 'POST', { employee_id: ali.id, month, kind: 'advance', amount: 400 });
  assert.equal(Math.round(((await api('report/payroll?month=' + month)).rows.find(x => x.code === '101').net - net0) * 100) / 100, 600);
  if (!pay[0].final) await assert.rejects(api('payroll/finalize', 'POST', { month }), /not over/);
  await api('payroll/finalize', 'POST', { month, force: true });
  assert.equal((await api('report/payroll?month=' + month)).status, 'finalized');
  await assert.rejects(api('payroll/items', 'POST', { employee_id: ali.id, month, kind: 'bonus', amount: 5 }), /finalized/);
  await api('payroll/paid', 'POST', { month });
  const locked = await api('report/payroll?month=' + month); assert.equal(locked.status, 'paid'); assert.ok(locked.paid_at);
  await api('settings', 'PUT', { ot_mult_work: 3 });                  // policy change must not alter a finalized month
  assert.equal(locked.rows.find(x => x.code === '104').net, (await api('report/payroll?month=' + month)).rows.find(x => x.code === '104').net);
  await api('settings', 'PUT', { ot_mult_work: 1.5 });
  await api('payroll/reopen', 'POST', { month });
  assert.equal((await api('report/payroll?month=' + month)).status, 'draft');
  const csv = await fetch(`${base}/api/report/payroll.csv?month=${month}`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /^code,name/);
  assert.equal((await api('settings', 'PUT', { late_to_absent_min: 30 })).late_to_absent_min, 30);
  const sum2 = Object.fromEntries((await api('report/summary?' + q)).map(s => [s.code, s]));
  assert.equal(sum2['102'].absent, W, 'late-to-absent rule must apply to a 40 min late employee');
  const bk = await fetch(base + '/api/backup', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(bk.status, 200); assert.equal(Buffer.from(await bk.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.ok(existsSync(join(dir, 'bk', `attendance-${dateStr(new Date())}.db`)), 'daily backup file');
  assert.match(readFileSync(join(dir, 'logs', 'adms.log'), 'utf8'), /table=ATTLOG/, 'raw device requests are logged');
  assert.equal((await fetch(base + '/')).status, 200);
  console.log('e2e passed: device push -> approve -> employees -> reports -> payroll -> backup');
} catch (e) { console.error('E2E FAILED:', e.message); process.exitCode = 1; }
finally { srv.kill(); rmSync(dir, { recursive: true, force: true }); }
