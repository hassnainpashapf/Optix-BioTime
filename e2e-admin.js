// Backup download, restore (with validation), and what survives a restart.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const b64 = (buf) => Buffer.from(buf).toString('base64');
try {
  await api('employees', 'POST', { name: 'Keep One' }); await api('employees', 'POST', { name: 'Keep Two' });
  await api('users', 'POST', { username: 'helper', password: 'password1', role: 'hr' });
  const backup = Buffer.from(await (await S.raw('backup')).arrayBuffer());
  assert.equal(backup.subarray(0, 15).toString(), 'SQLite format 3');
  await api('employees', 'POST', { name: 'Added After Backup' });
  assert.equal((await api('employees')).length, 3);

  // bad uploads are refused and change nothing
  await assert.rejects(api('restore', 'POST', { data: '' }), /Choose a backup/);
  await assert.rejects(api('restore', 'POST', { data: b64('this is not a database') }), /not a backup file/);
  const other = join(S.dir, 'other.db'); const o = new DatabaseSync(other); o.exec('CREATE TABLE foo(x); INSERT INTO foo VALUES(1)'); o.close();
  await assert.rejects(api('restore', 'POST', { data: b64((await import('node:fs')).readFileSync(other)) }), /missing: employees/);
  const hdr = Buffer.from(backup); hdr.fill(0, 100, 4096); writeFileSync(join(S.dir, 'x'), hdr);   // header intact, body wrecked
  await assert.rejects(api('restore', 'POST', { data: b64(hdr) }), /damaged|Cannot read|missing/);
  assert.equal((await api('employees')).length, 3, 'a refused restore leaves the data alone');
  const ht = await S.login('helper', 'password1');
  assert.equal((await S.raw('restore', 'POST', { data: b64(backup) }, ht)).status, 403, 'only admin can restore');
  assert.equal((await S.raw('backup', 'GET', undefined, ht)).status, 403, 'only admin can download a backup');

  // a good backup: the server accepts it, stops, and comes back with the old data
  const r = await api('restore', 'POST', { data: 'data:application/octet-stream;base64,' + b64(backup) });
  assert.equal(r.restart, true);
  await S.restart();
  const after = await api('employees');
  assert.deepEqual(after.map(e => e.name).sort(), ['Keep One', 'Keep Two'], 'data is back to the moment of the backup');
  assert.ok(readdirSync(S.dir).some(f => f.startsWith('e2e.db.before-restore-')), 'the database from before the restore is kept');
  assert.ok(!readdirSync(S.dir).some(f => f.endsWith('.restore') || f.endsWith('.restore.tmp')), 'no half-finished restore files are left');
  assert.equal((await S.login('helper', 'password1')) !== undefined, true, 'accounts come from the backup too');
  // the restored system keeps working
  await api('employees', 'POST', { name: 'After Restore' }); assert.equal((await api('employees')).length, 3);
  console.log('e2e-admin passed: backup, restore validation, restore + restart, previous database kept');
} catch (e) { console.error('E2E-ADMIN FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); }
