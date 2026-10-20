// MTD reports: Daily Details, Department Summary, Abnormal Details; every punch counts as checked (no temperature = 0.0, no mask = "No").
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const dept = (await api('org/departments', 'POST', { code: '5', name: 'Ops' })).id;
  const mk = async (name) => { const r = await api('employees', 'POST', { name, department_id: dept, join_date: '2026-01-01' }); return (await api('employees')).find(x => x.id === r.id).code; };
  const A = await mk('Ali'), B = await mk('Bilal');
  await api('devices', 'POST', { name: 'Temp gate', sn: 'MTD-9', approved: 1 });
  const day = new Date().toLocaleDateString('sv');
  // A: normal (36.6, mask worn) and a hot one (38.2); B: a device that sends neither
  const body = [`${A}\t${day} 09:00:00\t0\t1\t0\t0\t0\t1\t36.6`, `${A}\t${day} 12:00:00\t0\t1\t0\t0\t0\t1\t38.2`, `${B}\t${day} 09:10:00\t0\t1\t0\t0`].join('\n') + '\n';
  await fetch(`${S.base}/iclock/cdata?SN=MTD-9&table=ATTLOG&Stamp=1`, { method: 'POST', body });
  const q = `from=${day}&to=${day}`;
  const daily = await api('mtd/daily?' + q); const a = daily.find(r => r.code === A), b = daily.find(r => r.code === B);
  assert.equal(a.qty, 2); assert.equal(a.temps, '36.6,38.2'); assert.equal(b.qty, 1); assert.equal(b.temps, '0.0', 'no temperature shows as 0.0');
  const dep = (await api('mtd/deptsummary?' + q)).find(r => r.dept_name === 'Ops' && r.date === day);
  assert.deepEqual({ e: dep.employees, c: dep.checked, r: dep.regular, ab: dep.abnormal, t: dep.abnormal_temp, p: dep.persons, np: dep.not_persons }, { e: 2, c: 3, r: 1, ab: 2, t: 1, p: 2, np: 0 });
  const ab = await api('mtd/abnormal?' + q); assert.equal(ab.length, 2); assert.ok(ab.some(r => r.code === B && r.with_mask === 'No' && r.temp === null)); assert.ok(ab.some(r => r.code === A && r.hot));
  assert.equal((await api(`mtd/daily?${q}&employees=${(await api('employees')).find(x => x.code === A).id}`)).length, 1, 'the employee filter works');
  await api('settings', 'PUT', { mtd_mask_alarm: 0 }); assert.equal((await api('mtd/abnormal?' + q)).length, 1, 'with Mask Alarm off only the hot temperature is abnormal');
  console.log('e2e-mtdrep passed: daily details, department summary, abnormal details, filters, mask alarm');
} finally { S.stop(); }
