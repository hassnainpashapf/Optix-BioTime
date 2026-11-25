// "Attendance Device = No" (access-control only): its punches are ignored by attendance. Room can be tied to a device.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const e = await api('employees', 'POST', { name: 'Door Only', join_date: '2025-01-01' }), code = (await api('employees')).find(x => x.id === e.id).code;
  const d = await api('devices', 'POST', { name: 'Door reader', sn: 'DOOR-001', approved: 1 });
  const day = new Date().toLocaleDateString('sv'), db = new DatabaseSync(join(S.dir, 'e2e.db'));
  db.prepare('INSERT INTO logs(emp_code, ts, device_id) VALUES(?,?,?)').run(code, `${day} 09:00:00`, d.id); db.prepare('INSERT INTO logs(emp_code, ts, device_id) VALUES(?,?,?)').run(code, `${day} 17:00:00`, d.id);
  const row = async () => (await api(`report/daily?from=${day}&to=${day}`)).find(r => r.code === code);
  const withFlag = await row(); assert.ok(withFlag.first_in || withFlag.in || withFlag.worked_min > 0 || (withFlag.punches ?? 0) >= 1 || withFlag.status !== 'Absent', 'a normal device counts: ' + JSON.stringify(withFlag).slice(0, 200));
  await api('devices/' + d.id, 'PUT', { att_device: 0 }); assert.equal((await api('devices')).find(x => x.id === d.id).att_device, 0);
  const without = await row(); assert.ok(!without || (without.status === 'Absent' || without.status === 'Pending' || (without.worked_min || 0) === 0), 'punches from a non-attendance device are ignored: ' + JSON.stringify(without).slice(0, 200));
  await api('devices/' + d.id, 'PUT', { att_device: 1 }); const again = await row(); assert.deepEqual(again, withFlag, 'switching it back restores attendance');
  const room = await api('rooms', 'POST', { name: 'Hall', capacity: 10, device_id: d.id }); assert.equal((await api('rooms')).find(r => r.id === room.id).device, 'Door reader');
  db.close();
  console.log('e2e-attdevice passed: attendance flag ignores/uses a device, room device');
} finally { S.stop(); }
