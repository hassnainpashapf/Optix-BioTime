// System module (ZKT layout): users, API permissions, notifications, backups, migrate, logs, settings pages, FTP, bookmarks, exports, middleware tables.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hits = [];
const gw = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { hits.push({ url: q.url, body: b }); r.writeHead(200); r.end('ok'); }); });
await new Promise(ok => gw.listen(0, '127.0.0.1', ok)); const gp = gw.address().port;
// a tiny passive FTP server that records what it is sent
const ftpGot = [];
const ftp = net.createServer((c) => {
  c.on('error', () => {}); c.write('220 ready\r\n'); let dsrv = null;
  c.on('data', (d) => { for (const line of String(d).split('\r\n').filter(Boolean)) {
    const [cmd, ...rest] = line.split(' ');
    if (cmd === 'USER') c.write('331 pw\r\n'); else if (cmd === 'PASS') c.write(rest[0] === 'ftp-pass' ? '230 ok\r\n' : '530 no\r\n'); else if (cmd === 'TYPE') c.write('200 ok\r\n');
    else if (cmd === 'PASV') { dsrv = net.createServer((ds) => { ds.on('error', () => {}); let buf = ''; ds.on('data', (x) => buf += x); ds.on('end', () => { ftpGot.push({ name: dsrv.stor, data: buf }); c.write('226 done\r\n'); dsrv.close(); }); }); dsrv.listen(0, '127.0.0.1', () => { const p = dsrv.address().port; c.write(`227 Entering Passive Mode (127,0,0,1,${p >> 8},${p & 255})\r\n`); }); }
    else if (cmd === 'STOR') { dsrv.stor = rest.join(' '); c.write('150 go\r\n'); } else if (cmd === 'QUIT') { c.write('221 bye\r\n'); c.end(); } else c.write('502 no\r\n'); } });
});
await new Promise(ok => ftp.listen(0, '127.0.0.1', ok)); const fp = ftp.address().port;
const exportDir = mkdtempSync(join(tmpdir(), 'zk-exp-'));
const S = await startServer({ WA_URL: `http://127.0.0.1:${gp}/wa?to={to}&text={text}`, EXPORT_DIR: exportDir }), api = S.api;
const dir = mkdtempSync(join(tmpdir(), 'zk-mig-'));
try {
  // ---------- users ----------
  const users0 = await api('zk/users'); assert.equal(users0.length, 1); assert.equal(users0[0].username, 'admin'); assert.equal(users0[0].superuser, 1); assert.equal(users0[0].enabled, 1); assert.equal(users0[0].login_count >= 1, true); assert.ok(users0[0].last_login);
  await assert.rejects(api('zk/users', 'POST', { username: 'a b', password: 'secret1', usergroup: 'viewer' }), /Username/); await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'secret1', password2: 'other', usergroup: 'viewer' }), /do not match/);
  await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'abc', usergroup: 'viewer' }), /6 characters/); await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'secret1' }), /UserGroup/);
  await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'secret1', usergroup: 'nope' }), /Unknown UserGroup/); await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'secret1', usergroup: 'viewer', email: 'bad' }), /valid email/);
  const sam = (await api('zk/users', 'POST', { username: 'sam', password: 'secret1', usergroup: 'viewer', first_name: 'Sam', last_name: 'Lee', email: 'sam@x.com' })).id;
  await assert.rejects(api('zk/users', 'POST', { username: 'sam', password: 'secret1', usergroup: 'viewer' }), /already exists/);
  let row = (await api('zk/users')).find(u => u.id === sam); assert.deepEqual([row.first_name, row.last_name, row.email, row.usergroup, row.superuser, row.enabled, row.twofa, row.login_count], ['Sam', 'Lee', 'sam@x.com', 'viewer', 0, 1, 0, 0]);
  const st = await S.login('sam', 'secret1'); assert.ok(st); row = (await api('zk/users')).find(u => u.id === sam); assert.equal(row.login_count, 1); assert.ok(row.last_login);
  assert.equal((await S.raw('zk/users', 'GET', undefined, st)).status, 403, 'only admin manages users');
  // disable: login refused and a live session ends
  await api('zk/users/' + sam, 'PUT', { enabled: false }); assert.equal((await S.raw('me', 'GET', undefined, st)).status, 401); const lr = await fetch(S.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sam', password: 'secret1' }) }); assert.equal(lr.status, 403);
  await assert.rejects(api('zk/users/1', 'PUT', { enabled: false }), /yourself/); await api('zk/users/' + sam, 'PUT', { enabled: true, first_name: 'Samuel' }); assert.equal((await api('zk/users')).find(u => u.id === sam).first_name, 'Samuel'); assert.ok(await S.login('sam', 'secret1'));
  // superuser flag = admin role; cannot remove the last superuser
  await api('zk/users/' + sam, 'PUT', { superuser: true }); assert.equal((await api('zk/users')).find(u => u.id === sam).usergroup, 'admin'); await api('zk/users/' + sam, 'PUT', { superuser: false, usergroup: 'viewer' }); assert.equal((await api('zk/users')).find(u => u.id === sam).superuser, 0);
  await assert.rejects(api('zk/users/1', 'PUT', { superuser: false, usergroup: 'viewer' }), /at least one superuser/); await assert.rejects(api('zk/users/1', 'DELETE'), /yourself/);
  // password change + policy
  await assert.rejects(api(`zk/users/${sam}/password`, 'POST', { password: 'abc' }), /6 characters/); await assert.rejects(api(`zk/users/${sam}/password`, 'POST', { password: 'abcdef1', password2: 'x' }), /do not match/);
  await api(`zk/users/${sam}/password`, 'POST', { password: 'newsecret1' }); assert.ok(await S.login('sam', 'newsecret1')); assert.ok(!(await S.login('sam', 'secret1')));
  // 2FA flag
  const tf = await api('zk/users/2fa', 'POST', { ids: [sam], enable: true }); assert.equal(tf.updated, 1); assert.equal((await api('zk/users')).find(u => u.id === sam).twofa, 1); await api('zk/users/2fa', 'POST', { ids: [sam], enable: false }); assert.equal((await api('zk/users')).find(u => u.id === sam).twofa, 0);
  await assert.rejects(api('zk/users/2fa', 'POST', { ids: [] }), /at least one user/);

  // ---------- security settings are really enforced ----------
  assert.equal((await api('zk/settings/security')).password_level, 1); await assert.rejects(api('zk/settings/security', 'PUT', { password_level: 9 }), /Password strength/); await assert.rejects(api('zk/settings/security', 'PUT', { lock_failed_count: 0 }), /Failed login/);
  await api('zk/settings/security', 'PUT', { password_level: 3, failed_locked: true, lock_failed_count: 3, lock_duration: 5, single_login: true, session_timeout: 0 });
  await assert.rejects(api(`zk/users/${sam}/password`, 'POST', { password: 'abcdef12' }), /Strong/); await assert.rejects(api('users', 'POST', { username: 'weak', password: 'abcdef', role: 'viewer' }), /Strong|Normal/);
  await api('zk/users', 'POST', { username: 'strong1', password: 'Abcdef1!x', usergroup: 'viewer' });
  assert.ok((await api('zk/users')).some(u => u.username === 'strong1'));
  assert.equal((await S.raw('password', 'POST', { password: 'abcdefgh' })).status, 400, 'the own-password route follows the policy too');
  // lockout: 3 wrong passwords lock the account, even for the right password
  const bad = () => fetch(S.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'strong1', password: 'wrong' }) });
  for (let i = 0; i < 3; i++) assert.equal((await bad()).status, 401); const lk = await fetch(S.base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'strong1', password: 'Abcdef1!x' }) }); assert.equal(lk.status, 429); assert.match((await lk.json()).error, /locked/);
  await api(`zk/users/${(await api('zk/users')).find(u => u.username === 'strong1').id}/password`, 'POST', { password: 'Abcdef1!y' }); assert.ok(await S.login('strong1', 'Abcdef1!y'), 'an administrator password reset unlocks the account');
  // single login: a second login ends the first
  const t1 = await S.login('strong1', 'Abcdef1!y'), t2 = await S.login('strong1', 'Abcdef1!y'); assert.equal((await S.raw('me', 'GET', undefined, t1)).status, 401); assert.equal((await S.raw('me', 'GET', undefined, t2)).status, 200);
  await api('zk/settings/security', 'PUT', { password_level: 1, failed_locked: false, single_login: false });

  // ---------- user log ----------
  const ul = await api('zk/userlog'); const login = ul.find(r => r.action === 'Login' && r.status === 'Failed'); assert.ok(login, 'failed logins are logged'); assert.ok(ul.some(r => r.action === 'Login' && r.status === 'Success' && r.user === 'sam'));
  assert.ok(ul.every(r => 'ip' in r && 'ctype' in r)); const created = ul.find(r => r.action === 'Create'); assert.ok(created, 'writes are logged with Create/Update/Delete'); assert.ok(created.ip, 'with the client address');
  await api('zk/userlog', 'POST', { action: 'Export', ctype: 'attendance | Report', object: 'Daily', description: 'manual note' }); assert.ok((await api('zk/userlog')).some(r => r.action === 'Export' && r.description === 'manual note'));
  await assert.rejects(api('zk/userlog', 'POST', {}), /Action/); const delId = (await api('zk/userlog'))[3].id; await api('zk/userlog/' + delId, 'DELETE'); assert.ok(!(await api('zk/userlog')).some(r => r.id === delId));

  // ---------- user groups = roles (existing API) ----------
  assert.ok((await api('zk/modules')).includes('access')); await api('roles', 'POST', { name: 'guards', perms: { access: 'edit' } }); assert.ok((await api('roles')).some(r => r.name === 'guards'));
  await api('zk/users', 'POST', { username: 'gate', password: 'gatepass1', usergroup: 'guards' }); assert.equal((await api('zk/users')).find(u => u.username === 'gate').usergroup, 'guards'); await assert.rejects(api('roles/guards', 'DELETE'), /still have this role/);
  await api('zk/users/' + (await api('zk/users')).find(u => u.username === 'gate').id, 'DELETE'); await api('roles/guards', 'DELETE');

  // ---------- API permissions + API request log ----------
  const key = await api('api-keys', 'POST', { name: 'ERP', scopes: ['employees:read'] }); const ap = await api('zk/api-permissions'); assert.ok(ap.endpoints.length >= 5 && ap.scopes.some(s => s.scope === 'payroll:read')); const kid = ap.keys.find(k => k.name === 'ERP').id;
  await assert.rejects(api('zk/api-permissions/' + kid, 'PUT', { scopes: ['bogus:all'] }), /Unknown permission/); await api('zk/api-permissions/' + kid, 'PUT', { scopes: ['employees:read', 'attendance:read'] }); assert.deepEqual((await api('zk/api-permissions')).keys.find(k => k.id === kid).scopes, ['employees:read', 'attendance:read']);
  const v1 = (p, k = key.key) => fetch(S.base + '/api/v1/' + p, { headers: { 'X-API-Key': k } }); assert.equal((await v1('ping')).status, 200); assert.equal((await v1('payroll/2026-01')).status, 403); assert.equal((await v1('ping', 'ak_wrong_wrong_wrong_wrong_1')).status, 401);
  const ar = await api('zk/apireq'); assert.ok(ar.some(r => r.user === 'ERP' && r.path === '/api/v1/ping' && r.method === 'GET' && r.status === 200 && r.ip)); assert.ok(ar.some(r => r.status === 403)); assert.ok(ar.some(r => r.status === 401 && !r.user)); assert.ok(ar.every(r => r.ms >= 0));
  await api('zk/apireq/' + ar[0].id, 'DELETE'); assert.equal((await api('zk/apireq')).length, ar.length - 1);

  // ---------- notifications ----------
  await assert.rejects(api('zk/notifications', 'POST', { title: 'x' }), /required/); const nid = (await api('zk/notifications', 'POST', { title: 'Late In', body: 'Ali was late' })).id;
  let nl = await api('notifications'); const n1 = nl.items.find(n => n.id === nid); assert.equal(n1.is_read, 0); assert.equal(n1.read_time, null); assert.equal(nl.unread >= 1, true);
  await api('notifications/read', 'POST', {}); nl = await api('notifications'); assert.equal(nl.unread, 0); assert.match(nl.items.find(n => n.id === nid).read_time, /^\d{4}-\d\d-\d\d \d\d:\d\d/, 'read time is recorded');
  await api('zk/notifications/' + nid, 'DELETE'); assert.ok(!(await api('notifications')).items.some(n => n.id === nid)); assert.equal((await S.raw('zk/notifications', 'POST', { title: 'a', body: 'b' }, await S.login('sam', 'newsecret1'))).status, 403);

  // ---------- backup ----------
  const emp = await api('employees', 'POST', { name: 'Backup Person', join_date: '2025-01-01' });
  const bk = await api('zk/backups', 'POST', { remark: 'before restore' }); let bl = await api('zk/backups'); const b1 = bl.find(b => b.id === bk.id); assert.deepEqual([b1.status, b1.db_type, b1.operator, b1.remark, b1.exists], ['Success', 'SQLite', 'admin', 'before restore', true]); assert.equal(b1.db_name, 'e2e.db'); assert.ok(existsSync(b1.path));
  const dl = await fetch(S.base + `/api/zk/backups/${bk.id}/download`, { headers: { Authorization: 'Bearer ' + S.token } }); assert.equal(dl.status, 200); assert.equal((await dl.arrayBuffer()).byteLength > 4096, true);
  await assert.rejects(api('zk/backups/auto', 'PUT', { enabled: true, frequency: 'hourly', time: '02:00', keep: 3 }), /Frequency/); await assert.rejects(api('zk/backups/auto', 'PUT', { enabled: true, frequency: 'daily', time: '25:00', keep: 3 }), /HH:MM/); await assert.rejects(api('zk/backups/auto', 'PUT', { enabled: true, frequency: 'daily', time: '02:00', keep: 0 }), /Keep/);
  assert.equal((await api('zk/backups/auto/run', 'POST')).ran, false, 'off by default'); await api('zk/backups/auto', 'PUT', { enabled: true, frequency: 'daily', time: '00:00', keep: 2 }); assert.equal((await api('zk/backups/auto/run', 'POST')).ran, true); assert.equal((await api('zk/backups/auto/run', 'POST')).ran, false, 'once per day');
  bl = await api('zk/backups'); assert.ok(bl.some(b => b.remark === 'Automatic backup' && b.operator === 'system' && b.exists));
  await assert.rejects(api('zk/backups/restore', 'POST', { id: 99999 }), /Choose a backup/); await api('employees/' + emp.id, 'PUT', { name: 'Changed After' });
  const rb = await api('zk/backups/restore', 'POST', { id: bk.id }); assert.equal(rb.restart, true); await S.restart();
  assert.equal((await api('employees')).find(e => e.id === emp.id).name, 'Backup Person', 'the restore brought back the backup'); assert.ok((await api('zk/backups')).some(b => b.id === bk.id), 'the list survives');
  const del = (await api('zk/backups')).find(b => b.id === bk.id); await api('zk/backups/' + bk.id, 'DELETE'); assert.ok(!existsSync(del.path), 'deleting removes the file'); assert.ok(!(await api('zk/backups')).some(b => b.id === bk.id));
  assert.equal((await S.raw('zk/backups', 'POST', {}, await S.login('sam', 'newsecret1'))).status, 403);

  // ---------- migrate (from a SQLite file) ----------
  const src = join(dir, 'other.db'), o = new DatabaseSync(src);
  o.exec(`CREATE TABLE personnel_area(id INTEGER PRIMARY KEY, area_code TEXT, area_name TEXT); CREATE TABLE personnel_department(id INTEGER PRIMARY KEY, dept_code TEXT, dept_name TEXT); CREATE TABLE personnel_position(id INTEGER PRIMARY KEY, position_code TEXT, position_name TEXT);
    CREATE TABLE personnel_employee(id INTEGER PRIMARY KEY, emp_code TEXT, first_name TEXT, last_name TEXT, department_id INT, position_id INT, area_id INT, card_no TEXT, hire_date TEXT, gender TEXT, birthday TEXT, email TEXT, is_active INT);
    CREATE TABLE iclock_transaction(id INTEGER PRIMARY KEY, emp_code TEXT, punch_time TEXT);
    INSERT INTO personnel_area VALUES(1,'A1','Head Office'),(2,'A2','Factory'); INSERT INTO personnel_department VALUES(1,'D1','Finance'),(2,'D2','Stores'); INSERT INTO personnel_position VALUES(1,'P1','Accountant');
    INSERT INTO personnel_employee VALUES(1,'9001','Zara','Noor',1,1,1,'1234','2024-02-01','F','1990-05-05','zara@x.com',1),(2,'9002','Omar','Shah',2,NULL,2,NULL,NULL,'M',NULL,NULL,0);
    INSERT INTO iclock_transaction VALUES(1,'9001','2026-03-02 08:01:00'),(2,'9001','2026-03-02 17:01:00'),(3,'9002','2026-04-02 09:00:00');`); o.close();
  await assert.rejects(api('zk/migrate', 'POST', { database_type: 'mysql', items: ['employee'] }), /Only SQLite/); await assert.rejects(api('zk/migrate', 'POST', { database_type: 'sqlite', items: [] , sqlite_file: src }), /Choose what to migrate/);
  await assert.rejects(api('zk/migrate', 'POST', { database_type: 'sqlite', items: ['employee'], sqlite_file: join(dir, 'nope.db') }), /does not exist/); writeNot(join(dir, 'junk.db')); await assert.rejects(api('zk/migrate', 'POST', { database_type: 'sqlite', items: ['employee'], sqlite_file: join(dir, 'junk.db') }), /not a SQLite/);
  await assert.rejects(api('zk/migrate', 'POST', { database_type: 'sqlite', items: ['transaction'], sqlite_file: src, period: { from: 'x' } }), /YYYY-MM-DD/);
  const mg = await api('zk/migrate', 'POST', { database_type: 'sqlite', sqlite_file: src, items: ['area', 'department', 'position', 'employee', 'transaction'], period: { from: '2026-03-01', to: '2026-03-31' } });
  assert.deepEqual(mg.result.area, { added: 2, existing: 0 }); assert.deepEqual(mg.result.department, { added: 2, existing: 0 }); assert.equal(mg.result.employee.added, 2); assert.deepEqual(mg.result.transaction, { added: 2, skipped: 1 }, 'only the period');
  const zara = (await api('employees')).find(e => e.code === '9001'); assert.equal(zara.name, 'Zara Noor'); assert.equal((await api('employees')).find(e => e.code === '9002').active, 0);
  assert.equal((await api('departments')).filter(d => ['Finance', 'Stores'].includes(d.name)).length, 2); assert.ok((await api('branches')).some(b => b.name === 'Factory'));
  const again = await api('zk/migrate', 'POST', { database_type: 'sqlite', sqlite_file: src, items: ['department', 'employee'] }); assert.deepEqual(again.result.department, { added: 0, existing: 2 }); assert.equal(again.result.employee.existing, 2, 'running it again adds nothing');
  const viaUpload = await api('zk/migrate', 'POST', { database_type: 'sqlite', data: 'data:application/octet-stream;base64,' + readFileSync(src).toString('base64'), items: ['position'] }); assert.deepEqual(viaUpload.result.position, { added: 0, existing: 1 });
  assert.ok((await api('zk/syslog')).some(r => r.operation === 'Database migrate' && r.result === 'Success'));

  // ---------- system log, calculation log ----------
  await api('zk/syslog', 'POST', { operation: 'Manual note', result: 'Success', description: 'hello' }); let sl = await api('zk/syslog'); assert.ok(sl.some(r => r.operation === 'Manual note')); await assert.rejects(api('zk/syslog', 'POST', {}), /Operation/);
  await assert.rejects(api('zk/calclog', 'POST', { from: '2026-02-02', to: '2026-02-01' }), /not after/); await assert.rejects(api('zk/calclog', 'POST', { from: '2026-01-01', to: '2026-12-31' }), /93 days/);
  await api('zk/calclog', 'POST', { from: '2026-03-01', to: '2026-03-03' }); const cl = (await api('zk/calclog'))[0]; assert.deepEqual([cl.task, cl.started_by, cl.result, cl.dates, cl.run_group], ['Attendance calculation', 'admin', 'Success', '2026-03-01 to 2026-03-03', 'All employees']); assert.ok(cl.employees >= 1); assert.ok(cl.seconds >= 0);
  await api('zk/calclog/' + cl.id, 'DELETE'); await api('zk/syslog/delete', 'POST', { ids: sl.filter(r => r.operation === 'Manual note').map(r => r.id) }); assert.ok(!(await api('zk/syslog')).some(r => r.operation === 'Manual note'));

  // ---------- WhatsApp log (gateway hook) + resend ----------
  const wa = await api('employees', 'POST', { name: 'Wa Person', phone: '0300 777-8899', join_date: '2025-01-01' }); const { _sendTest } = { _sendTest: null }; void _sendTest;
  await api('automations', 'POST', { name: 'wa', trigger: 'employee.created', actions: [{ type: 'whatsapp', to: '0300 777-8899', title: 'Welcome', body: 'hello there' }] }); await api('employees', 'POST', { name: 'Trigger Person', join_date: '2025-01-01' }); await sleep(900);
  let wl = await api('zk/walog'); assert.ok(wl.length >= 1, 'a WhatsApp send is logged'); const w1 = wl[0]; assert.equal(w1.status, 'Success'); assert.equal(w1.phone, '+923007778899'); assert.match(w1.content, /Welcome/); assert.equal(w1.emp_code, (await api('employees')).find(e => e.id === wa.id).code, 'matched to the employee by phone');
  const before = hits.length; const rs = await api('zk/walog/resend', 'POST', { ids: [w1.id] }); assert.deepEqual([rs.sent, rs.failed], [1, 0]); assert.equal(hits.length, before + 1); assert.equal((await api('zk/walog')).length, wl.length + 1, 'the resend is logged too'); await assert.rejects(api('zk/walog/resend', 'POST', { ids: [] }), /at least one/);

  // ---------- background task + retention ----------
  assert.equal((await api('zk/settings/bgtask')).retention, 30); await assert.rejects(api('zk/settings/bgtask', 'PUT', { retention: 0 }), /Retention/); const bg = await api('zk/settings/bgtask', 'PUT', { meeting: true, payroll: false, ep: true, access: true, retention: 7 }); assert.equal(bg.payroll, false); assert.equal(bg.retention, 7);
  await assert.rejects(api('zk/settings/nope'), /Unknown settings/);

  // ---------- LDAP, Zoom, Twilio (stored, secrets masked) ----------
  await assert.rejects(api('zk/settings/ldap', 'PUT', { emp_sync: true, host: '' }), /Host Address/); await assert.rejects(api('zk/settings/ldap', 'PUT', { host: 'h', port: 99999 }), /Port/); await assert.rejects(api('zk/settings/ldap', 'PUT', { host: 'h', sync_time: '7pm' }), /HH:MM:SS/);
  const lc = await api('zk/settings/ldap', 'PUT', { host: '127.0.0.1', port: fp, username: 'cn=admin', password: 'ldap-secret', emp_sync: true, sync_frequency: 2 }); assert.equal(lc.password, ''); assert.equal(lc.has_password, true); assert.equal((await api('zk/settings/ldap')).host, '127.0.0.1');
  await api('zk/settings/ldap', 'PUT', { host: '127.0.0.1', username: 'cn=root' }); assert.equal((await api('zk/settings/ldap')).has_password, true, 'a blank secret keeps the stored one'); assert.match((await api('zk/settings/ldap/test', 'POST')).message, /accepts connections/);
  await api('zk/settings/ldap', 'PUT', { host: '127.0.0.1', port: 1 }); await assert.rejects(api('zk/settings/ldap/test', 'POST'), /Cannot reach/);
  await assert.rejects(api('zk/settings/zoom', 'PUT', { zoom_enable: true, account_id: 'a' }), /required/); const zc = await api('zk/settings/zoom', 'PUT', { account_id: 'acc', client_id: 'cid', client_secret: 'zs', zoom_enable: true }); assert.equal(zc.zoom_enable, true); assert.equal(zc.client_secret, '');
  await assert.rejects(api('zk/settings/twilio', 'PUT', { twilio_enable: true, mobile: '+15005550006' }), /required/); await assert.rejects(api('zk/settings/twilio', 'PUT', { mobile: '0300' }), /international/);
  const tc = await api('zk/settings/twilio', 'PUT', { mobile: '+15005550006', account_sid: 'AC123', auth_token: 'tok', twilio_enable: true }); assert.equal(tc.has_auth_token, true); assert.equal((await api('automations')).sms, true, 'Twilio makes SMS available to the automation rules');
  // email templates
  const et = await api('zk/email-templates'); assert.ok(et.events.length >= 5 && et.macros.includes('{employee}')); await assert.rejects(api('zk/email-templates/late', 'PUT', { enable: true, subject: '', template: '' }), /required/); await assert.rejects(api('zk/email-templates/bogus', 'PUT', {}), /Unknown event/);
  await api('zk/email-templates/late', 'PUT', { enable: true, subject: 'Late: {employee}', template: 'Hello {receiver}, {employee} was late on {date}' }); assert.equal((await api('zk/email-templates')).events.find(e => e.event === 'late').enable, true);

  // ---------- FTP ----------
  await assert.rejects(api('zk/ftp', 'POST', { host: '', username: 'u' }), /Host/); await assert.rejects(api('zk/ftp', 'POST', { host: 'h', username: '' }), /Username/); await assert.rejects(api('zk/ftp', 'POST', { host: 'h', username: 'u', port: 70000 }), /Port/);
  const fid = (await api('zk/ftp', 'POST', { host: '127.0.0.1', port: fp, username: 'ftpuser', password: 'ftp-pass', is_sftp: 0 })).id; const fl = (await api('zk/ftp')).find(f => f.id === fid); assert.deepEqual([fl.host, fl.port, fl.username, fl.is_sftp, fl.has_password], ['127.0.0.1', fp, 'ftpuser', 0, true]); assert.ok(!('password' in fl));
  await api('zk/ftp/' + fid, 'PUT', { host: '127.0.0.1', port: fp, username: 'ftpuser', is_sftp: 0 }); assert.equal((await api('zk/ftp')).find(f => f.id === fid).has_password, true, 'password kept when left blank');
  const sftpId = (await api('zk/ftp', 'POST', { host: 's.example.com', port: 22, username: 'u', is_sftp: 1 })).id;

  // ---------- bookmarks ----------
  await assert.rejects(api('bookmarks', 'POST', { title: '', content_type: 'Doors' }), /Title/); await assert.rejects(api('bookmarks', 'POST', { title: 'x' }), /Choose the page/);
  const bm1 = (await api('bookmarks', 'POST', { title: 'My doors', content_type: 'Doors', filters: 'open=1', shared: true })).id; await assert.rejects(api('bookmarks', 'POST', { title: 'My doors', content_type: 'Doors' }), /already have/);
  const bm2 = (await api('bookmarks', 'POST', { title: 'Private', content_type: 'Employees' })).id; const sT = await S.login('sam', 'newsecret1');
  const sb = await (await S.raw('bookmarks', 'GET', undefined, sT)).json(); assert.ok(sb.some(b => b.id === bm1 && !b.mine) && !sb.some(b => b.id === bm2), 'others see only shared bookmarks');
  const mine = await (await S.raw('bookmarks', 'POST', { title: 'Sam page', content_type: 'Leaves' }, sT)).json(); assert.ok(mine.id, 'every signed-in user can bookmark');
  assert.equal((await S.raw('bookmarks/' + bm1, 'DELETE', undefined, sT)).status, 403, 'not someone else\'s'); assert.equal((await S.raw('bookmarks/' + mine.id, 'DELETE', undefined, sT)).status, 200); await api('bookmarks/' + bm2, 'PUT', { shared: true }); assert.ok((await (await S.raw('bookmarks', 'GET', undefined, sT)).json()).some(b => b.id === bm2));
  const ab = (await api('bookmarks')).find(b => b.id === bm1); assert.deepEqual([ab.title, ab.user, ab.content_type, ab.filters, ab.shared, ab.mine], ['My doors', 'admin', 'Doors', 'open=1', 1, true]); assert.match(ab.saved, /^\d{4}-/); await api('bookmarks/' + bm1, 'DELETE');

  // ---------- integration: attendance transaction export ----------
  const e1 = await api('employees', 'POST', { name: 'Exp One', join_date: '2025-01-01' }), e2 = await api('employees', 'POST', { name: 'Exp Two', join_date: '2025-01-01' }); const codes = (await api('employees')); const c1 = codes.find(e => e.id === e1.id).code, c2 = codes.find(e => e.id === e2.id).code;
  await api('logs/manual', 'POST', { emp_code: c1, ts: '2026-05-04 08:00:00' }); await api('logs/manual', 'POST', { emp_code: c2, ts: '2026-05-04 09:10:00' }); await api('logs/manual', 'POST', { emp_code: c1, ts: '2026-05-05 08:05:00' });
  const meta = await api('zk/exports-meta'); assert.ok(meta.tokens.includes('emp_code') && meta.reports.length > 5 && meta.default_template.includes('{terminal_sn}'));
  await assert.rejects(api('zk/exports/tx', 'POST', { name: '' }), /Name/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', format: 'pdf' }), /File Format/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', template: 'no tokens' }), /\{field\}/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', template: '{bogus}' }), /Unknown field/);
  await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', path: '../escape' }), /Export Path/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', export_time: '25:61' }), /HH:MM/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', policy: 2, interval_min: 0 }), /Interval/); await assert.rejects(api('zk/exports/tx', 'POST', { name: 'x', ftp_id: 9999 }), /Unknown FTP/);
  const tx = (await api('zk/exports/tx', 'POST', { name: 'Punches', file_prefix: 'punch_{cur_date}', format: 'csv', template: '{emp_code}\\t{first_name}\\t{date}\\t{time}', query_field: 1, export_type: 1, path: 'AutoExport', enabled: false })).id;
  let tl = (await api('zk/exports/tx'))[0]; assert.deepEqual([tl.name, tl.format_label, tl.export_by, tl.enabled, tl.last_run], ['Punches', 'Csv', 'Punch Time', 0, null]); assert.match(tl.code, /^TX\d+$/);
  await assert.rejects(api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-06', to: '2026-05-01' }), /not after/);
  const r1 = await api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-04', to: '2026-05-04' }); assert.equal(r1.rows, 2); assert.match(r1.file, /^punch_\d{8}\.csv$/); assert.ok(r1.path.startsWith(exportDir), 'files go under the export folder'); const csv = readFileSync(r1.path, 'utf8'); assert.match(csv, /emp_code/); assert.ok(csv.includes('2026-05-04') && !csv.includes('2026-05-05'), 'only the chosen day'); assert.ok(csv.includes('Exp'));
  tl = (await api('zk/exports/tx'))[0]; assert.ok(tl.last_run && tl.last_status === 'Success' && tl.last_file === r1.file); assert.ok((await api(`zk/exports/tx/${tx}/files`)).some(f => f.name === r1.file)); const fdl = await fetch(S.base + `/api/zk/exports/tx/${tx}/files/${r1.file}`, { headers: { Authorization: 'Bearer ' + S.token } }); assert.equal(fdl.status, 200); assert.equal((await fetch(S.base + `/api/zk/exports/tx/${tx}/files/..%2F..%2Fx`, { headers: { Authorization: 'Bearer ' + S.token } })).status, 404);
  // txt uses the data template with real tabs; xls is a real workbook; incremental only exports what is new
  await api(`zk/exports/tx/${tx}`, 'PUT', { name: 'Punches', format: 'txt', template: '{emp_code}\\t{date} {time}\\n', query_field: 1 }); const r2 = await api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' }); const txt = readFileSync(r2.path, 'utf8'); assert.equal(r2.rows, 3); assert.equal(txt.trim().split('\n').length, 3); assert.ok(txt.split('\n')[0].includes('\t'), 'tab separated'); assert.match(txt, new RegExp(c1 + '\t2026-05-04 08:00:00'));
  await api(`zk/exports/tx/${tx}`, 'PUT', { name: 'Punches', format: 'xls', template: '{emp_code}\\t{date}', query_field: 3, export_type: 2 }); const r3 = await api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' }); assert.match(r3.file, /\.xlsx$/); assert.equal(readFileSync(r3.path).subarray(0, 2).toString(), 'PK'); assert.equal(r3.rows, 3);
  const r4 = await api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' }); assert.equal(r4.rows, 0, 'flagged/incremental: nothing new since the last export'); await api('logs/manual', 'POST', { emp_code: c2, ts: '2026-05-05 09:00:00' }); assert.equal((await api(`zk/exports/tx/${tx}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' })).rows, 1, 'only the new punch');
  // enable/disable + the scheduler runs due tasks (By Timing, daily at 00:00 is always due once today)
  await assert.rejects(api('zk/exports/tx/enable', 'POST', { ids: [] }), /at least one/); await api('zk/exports/tx/enable', 'POST', { ids: [tx], enable: true }); assert.equal((await api('zk/exports/tx'))[0].enabled, 1);
  const auto = (await api('zk/exports/tx', 'POST', { name: 'Nightly', file_prefix: 'nightly_{cur_date}', format: 'csv', template: '{emp_code}\\t{date}', query_field: 3, export_type: 2, policy: 1, frequency: 0, export_time: '00:00', path: 'Nightly', enabled: true, ftp_id: fid, ftp_path: 'in' })).id;
  await api('logs/manual', 'POST', { emp_code: c1, ts: '2026-05-06 08:00:00' }); const tk = await api('zk/exports-tick', 'POST'); assert.ok(tk.ran >= 1); const nt = (await api('zk/exports/tx')).find(t => t.id === auto); assert.equal(nt.last_status, 'Success'); assert.ok(readdirSync(join(exportDir, 'Nightly')).some(f => /^nightly_\d{8}\.csv$/.test(f)));
  assert.equal((await api('zk/exports-tick', 'POST')).ran, 0, 'a task runs once a day'); assert.ok(ftpGot.length >= 1 && /^in\/nightly_/.test(ftpGot[0].name), 'and the file was sent to the FTP server'); assert.match(ftpGot[0].data, /emp_code/);
  const sft = (await api('zk/exports/tx', 'POST', { name: 'To sftp', format: 'csv', template: '{emp_code}', path: 'Sftp', ftp_id: sftpId, enabled: false })).id; const rsf = await api(`zk/exports/tx/${sft}/run`, 'POST', { from: '2026-05-04', to: '2026-05-04' }); assert.match(rsf.ftp, /SFTP upload is not supported/);
  await api(`zk/exports/tx/${auto}`, 'PUT', { name: 'Nightly', policy: 2, interval_min: 30 }); assert.equal((await api('zk/exports-tick', 'POST')).ran, 0, 'interval policy: not due 30 minutes after the last run');
  // ---------- integration: attendance report export ----------
  const rep0 = meta.reports.map(r => r.id); assert.ok(rep0.includes('daily')); await assert.rejects(api('zk/exports/report', 'POST', { name: 'r', report_type: 'nope' }), /Report Type/); await assert.rejects(api('zk/exports/report', 'POST', { name: 'r', report_type: 'daily', format: 'doc' }), /File Format/);
  await api('reports/saved', 'POST', { name: 'Daily for Exp', type: 'daily', params: { employee_id: String(e1.id) } }); const tpl = (await api('zk/exports-meta')).templates.find(t => t.name === 'Daily for Exp'); await assert.rejects(api('zk/exports/report', 'POST', { name: 'r', report_type: 'late', report_template: tpl.id }), /not for this report type/);
  const rp = (await api('zk/exports/report', 'POST', { name: 'Daily export', report_type: 'daily', report_template: tpl.id, file_prefix: '{report_template}_{cur_date}', format: 'csv', path: 'Rep', enabled: false })).id;
  const rr = await api(`zk/exports/report/${rp}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' }); assert.match(rr.file, /^Daily_for_Exp_\d{8}\.csv$/); const rcsv = readFileSync(rr.path, 'utf8'); assert.ok(rcsv.includes('Exp One') && !rcsv.includes('Exp Two'), 'the saved template filters to its employee'); assert.ok(rcsv.split('\n')[0].includes('Date'));
  for (const f of ['xls', 'txt', 'pdf']) { await api(`zk/exports/report/${rp}`, 'PUT', { name: 'Daily export', report_type: 'daily', report_template: tpl.id, format: f, path: 'Rep' }); const x = await api(`zk/exports/report/${rp}/run`, 'POST', { from: '2026-05-04', to: '2026-05-05' }); const head = readFileSync(x.path).subarray(0, 4).toString(); assert.ok(f === 'xls' ? head.startsWith('PK') : f === 'pdf' ? head.startsWith('%PDF') : x.file.endsWith('.txt'), f); }
  const rl = (await api('zk/exports/report'))[0]; assert.deepEqual([rl.report_type_label, rl.template_name, rl.format_label], ['Daily attendance', 'Daily for Exp', 'PDF']); assert.match(rl.code, /^RP/);
  assert.ok((await api('zk/syslog')).some(r => /export/i.test(r.operation))); await api(`zk/exports/report/${rp}`, 'DELETE'); assert.equal((await api('zk/exports/report')).length, 0);

  // ---------- middleware tables ----------
  await assert.rejects(api('zk/mw/dept', 'POST', { code: '', name: 'x' }), /Code/); await assert.rejects(api('zk/mw/dept', 'POST', { code: 'D9' }), /Name/); await assert.rejects(api('zk/mw/bogus', 'POST', {}), /Unknown middleware/);
  const md = (await api('zk/mw/dept', 'POST', { code: 'D77', name: 'Logistics' })).id; let m = (await api('zk/mw/dept')).find(r => r.id === md); assert.equal(m.state, 'Success'); assert.ok(m.target_time); assert.equal(m.flag_label, 'Add/Update'); assert.ok((await api('departments')).some(d => d.name === 'Logistics'), 'applied to the real table');
  await api('zk/mw/dept', 'POST', { code: 'D77', name: 'Logistics & Supply' }); assert.ok((await api('departments')).some(d => d.name === 'Logistics & Supply'), 'update by code/name'); assert.ok(!(await api('departments')).some(d => d.name === 'Logistics'));
  const pm = (await api('zk/mw/pos', 'POST', { code: 'P5', name: 'Driver' })).id; assert.equal((await api('zk/mw/pos')).find(r => r.id === pm).state, 'Success'); assert.ok((await api('designations')).some(d => d.name === 'Driver'));
  const am = (await api('zk/mw/area', 'POST', { code: 'A5', name: 'Warehouse' })).id; assert.equal((await api('zk/mw/area')).find(r => r.id === am).state, 'Success'); assert.ok((await api('branches')).some(b => b.name === 'Warehouse'));
  await assert.rejects(api('zk/mw/emp', 'POST', { code: '5001' }), /First Name/); await assert.rejects(api('zk/mw/emp', 'POST', { code: '5001', first_name: 'Dan', hired_date: '01/02/2025' }), /Hired Date/); await assert.rejects(api('zk/mw/emp', 'POST', { code: '5001', first_name: 'Dan', email: 'bad' }), /valid email/);
  const me = (await api('zk/mw/emp', 'POST', { code: '5001', first_name: 'Dan', last_name: 'Cole', dept_code: 'D77', dept_name: 'Logistics & Supply', pos_code: 'P5', pos_name: 'Driver', area_code: 'A5', area_name: 'Warehouse', card_no: '777', hired_date: '2025-03-04', gender: 'M', birthday: '1991-01-02', email: 'dan@x.com', active: 'Yes' })).id;
  const dan = (await api('employees')).find(e => e.code === '5001'); assert.ok(dan, 'employee created'); assert.equal(dan.name, 'Dan Cole'); assert.equal(dan.gender, 'Male'); assert.equal(dan.join_date, '2025-03-04'); assert.equal(dan.email, 'dan@x.com'); assert.equal(dan.active, 1);
  const depts = await api('departments'), poss = await api('designations'), brs = await api('branches'); assert.equal(dan.department_id, depts.find(d => d.name === 'Logistics & Supply').id); assert.equal(dan.designation_id, poss.find(d => d.name === 'Driver').id); assert.equal(dan.branch_id, brs.find(b => b.name === 'Warehouse').id); assert.equal((await api('departments')).filter(d => d.name === 'Logistics & Supply').length, 1, 'no duplicates');
  await api('zk/mw/emp', 'POST', { code: '5001', first_name: 'Daniel', last_name: 'Cole', active: 'No' }); const dan2 = (await api('employees')).find(e => e.code === '5001'); assert.equal(dan2.name, 'Daniel Cole'); assert.equal(dan2.active, 0); assert.equal(dan2.email, 'dan@x.com', 'fields not sent are kept');
  // failures stay visible and can be retried
  const bad2 = (await api('zk/mw/dept', 'POST', { code: 'D77', name: 'x', flag: 1 })).id; let bm = (await api('zk/mw/dept')).find(r => r.id === bad2); assert.equal(bm.state, 'Failed'); assert.match(bm.status, /Failed: Employees still belong/); assert.equal(bm.flag_label, 'Delete');
  await api('employees/' + dan.id, 'PUT', { department_id: null }); const rt = await api(`zk/mw/dept/${bad2}/retry`, 'POST'); assert.deepEqual([rt.applied, rt.failed], [1, 0]); assert.equal((await api('zk/mw/dept')).find(r => r.id === bad2).state, 'Success'); assert.ok(!(await api('departments')).some(d => d.name === 'Logistics & Supply'));
  const delM = (await api('zk/mw/emp', 'POST', { code: '5001', flag: 1 })).id; assert.equal((await api('zk/mw/emp')).find(r => r.id === delM).state, 'Success'); assert.equal((await api('employees')).find(e => e.code === '5001').status, 'resigned', 'delete keeps the history');
  const nf = (await api('zk/mw/emp', 'POST', { code: 'NOPE', flag: 1 })).id; assert.match((await api('zk/mw/emp')).find(r => r.id === nf).status, /No such employee/); await api('zk/mw/emp/' + nf, 'DELETE'); assert.ok(!(await api('zk/mw/emp')).some(r => r.id === nf));
  assert.equal((await S.raw('zk/mw/dept', 'POST', { code: 'X', name: 'Y' }, sT)).status, 403);
  console.log('e2e-zk-system passed: users (disable, 2FA flag, lockout, single login, password policy), API permissions + request log, notifications, backup/restore, migrate, logs, settings, FTP, bookmarks, exports (csv/txt/xlsx/pdf, schedule, FTP), middleware');
} catch (e) { console.error('E2E-ZK-SYSTEM FAILED:', e.stack?.split('\n').slice(0, 5).join('\n') ?? e); process.exitCode = 1; } finally { S.stop(); gw.close(); ftp.close(); rmSync(dir, { recursive: true, force: true }); rmSync(exportDir, { recursive: true, force: true }); setTimeout(() => process.exit(process.exitCode ?? 0), 100); }
function writeNot(p) { writeFileSync(p, 'this is not a sqlite file at all, just text'.repeat(10)); }
