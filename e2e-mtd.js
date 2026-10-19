// MTD: /api/mtd/records flags punches at or above the alert temperature
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const e = await api('employees', 'POST', { name: 'Temp Tester', join_date: '2025-01-01' }); const code = (await api('employees')).find(x => x.id === e.id).code;
  await api('settings', 'PUT', { temp_alert_c: 37.5 });
  const t = new Date().toLocaleDateString('sv'), db = new DatabaseSync(join(S.dir, 'e2e.db'));
  for (const [tm, tp] of [['09:00:00', 38.1], ['09:05:00', 36.6]]) db.prepare('INSERT INTO logs(emp_code,ts,temp_c,source) VALUES(?,?,?,?)').run(code, `${t} ${tm}`, tp, 'device');
  const db2 = db;
  const r = await api('mtd/records'), hot = r.rows.find(x => x.temp_c === 38.1), ok = r.rows.find(x => x.temp_c === 36.6);
  assert.equal(r.threshold, 37.5); assert.ok(hot?.abnormal, 'at or above the alert temperature is abnormal'); assert.ok(ok && !ok.abnormal, 'below is normal'); assert.ok(r.abnormal >= 1);
  assert.equal(hot.mask, null, 'no mask value when the device did not report one');
  db2.prepare('INSERT INTO logs(emp_code,ts,temp_c,mask,source) VALUES(?,?,?,?,?)').run(code, `${t} 10:00:00`, 36.5, 0, 'device'); db2.prepare('INSERT INTO logs(emp_code,ts,temp_c,mask,source) VALUES(?,?,?,?,?)').run(code, `${t} 10:05:00`, 36.5, 1, 'device');
  const rm = await api('mtd/records'); assert.ok(rm.rows.find(x => x.ts.endsWith('10:00:00')).abnormal, 'no mask is abnormal even with a normal temperature'); assert.ok(!rm.rows.find(x => x.ts.endsWith('10:05:00')).abnormal, 'mask on and normal temperature is fine');
  await api('settings', 'PUT', { temp_alert_c: 0 }); assert.equal((await api('mtd/records')).rows.filter(x => x.hot).length, 0, 'alert 0 = temperature check off'); db2.close();
  console.log('e2e-mtd passed: abnormal = at or above the alert temperature, 0 turns it off');
} finally { S.stop(); }
