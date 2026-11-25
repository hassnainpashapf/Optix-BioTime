// Report catalog, filters, CSV / Excel / PDF export, saved reports, statistics.
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const get = async (p, token = S.token) => { const r = await S.raw(p, 'GET', undefined, token); return { status: r.status, r }; };
try {
  const eng = (await api('departments', 'POST', { name: 'Engineering' })).id, sales = (await api('departments', 'POST', { name: 'Sales' })).id;
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const mk = (name, department_id) => api('employees', 'POST', { name, department_id, shift_id: shift, join_date: '2026-07-01' });
  const A = await mk('Alice', eng), B = await mk('Bilal', eng), C = await mk('Chand', sales);
  const L = [];
  const p = (e, d, ...t) => t.forEach(x => L.push(`${e.code},2026-07-${d} ${x}`));
  p(A, '06', '09:00', '18:00'); p(A, '07', '09:30', '18:00'); p(A, '08', '09:00');            // Alice: on time / 30 late / forgot to punch out
  p(B, '06', '09:00', '17:00'); p(B, '08', '09:00', '18:00');                                  // Bilal: left 60 min early / absent Tue
  for (const d of ['06', '07', '08']) p(C, d, '09:00', '18:30');                               // Chand: 30 min overtime daily
  await api('logs/import', 'POST', { csv: L.join('\n') });
  const q = 'from=2026-07-06&to=2026-07-08';

  // catalog
  const cat = await api('reports'); const ids = cat.map(c => c.id);
  for (const id of ['daily', 'summary', 'late', 'early', 'absent', 'missing', 'workhours', 'transactions', 'shift', 'department', 'employee', 'leave', 'overtime', 'payroll', 'custom']) assert.ok(ids.includes(id), id);
  await assert.rejects(api('reports/nope?' + q), /Unknown report/);

  // each report's data
  const run = (t, extra = '') => api(`reports/${t}?${q}${extra}`);
  assert.equal((await run('daily')).rows.length, 9);
  const late = await run('late'); assert.equal(late.rows.length, 1); assert.equal(late.rows[0].name, 'Alice'); assert.equal(late.rows[0].late_min, 30);
  const early = await run('early'); assert.equal(early.rows.length, 1); assert.equal(early.rows[0].name, 'Bilal'); assert.equal(early.rows[0].early_min, 60);
  const abs = await run('absent'); assert.deepEqual(abs.rows.map(r => `${r.name} ${r.date}`), ['Bilal 2026-07-07']);
  const miss = await run('missing'); assert.deepEqual(miss.rows.map(r => `${r.name} ${r.date}`), ['Alice 2026-07-08']);
  const sum = Object.fromEntries((await run('summary')).rows.map(r => [r.name, r]));
  assert.equal(sum.Alice.present, 3); assert.equal(sum.Alice.late, 1); assert.equal(sum.Bilal.absent, 1); assert.equal(sum.Chand.overtime_min, 90);
  const wh = Object.fromEntries((await run('workhours')).rows.map(r => [r.name, r])); assert.equal(wh.Alice.days, 2); assert.equal(wh.Alice.hours, 17.5); assert.equal(wh.Alice.avg, 8.75);
  const dep = Object.fromEntries((await run('department')).rows.map(r => [r.dept, r])); assert.equal(dep.Engineering.employees, 2); assert.equal(dep.Engineering.present, 5); assert.equal(dep.Engineering.rate, 83.3); assert.equal(dep.Sales.rate, 100);
  const sh = (await run('shift')).rows[0]; assert.equal(sh.shift, 'Office'); assert.equal(sh.employees, 3); assert.equal(sh.present, 8); assert.equal(sh.absent, 1);
  assert.equal((await run('transactions')).rows.length, 15);
  await assert.rejects(run('employee'), /Choose an employee/);
  const one = await run('employee', '&employee_id=' + A.id); assert.equal(one.rows.length, 3); assert.match(one.subtitle, /Alice/);
  const cus = await run('custom', '&columns=date,name,status&statuses=Late,Absent'); assert.deepEqual(cus.columns.map(c => c.key), ['date', 'name', 'status']); assert.equal(cus.rows.length, 2);
  assert.equal((await run('custom', '&columns=evil,name')).columns.length, 1, 'unknown columns are ignored');
  assert.equal((await run('daily', '&department_id=' + sales)).rows.length, 3, 'department filter');
  assert.equal((await run('overtime')).rows.length, 1);

  // exports
  const csv = await (await S.raw(`reports/daily/export?${q}&format=csv`)).text();
  assert.match(csv.split('\n')[0], /^"Date","ID","Name"/); assert.equal(csv.split('\n').length, 10);
  const xr = await S.raw(`reports/summary/export?${q}&format=xlsx`);
  assert.match(xr.headers.get('content-type'), /spreadsheetml/); assert.match(xr.headers.get('content-disposition'), /attendance-summary\.xlsx/);
  const z = unzipSync(new Uint8Array(await xr.arrayBuffer())); const sheet = strFromU8(z['xl/worksheets/sheet1.xml']);
  assert.ok(sheet.includes('>Name</t>') && sheet.includes('>Alice</t>')); assert.ok(sheet.includes('<c r="D2"><v>3</v></c>'), 'numbers are numeric cells');
  const pr = await S.raw(`reports/daily/export?${q}&format=pdf`); const pdf = Buffer.from(await pr.arrayBuffer()), txt = pdf.toString('latin1');
  assert.equal(pr.headers.get('content-type'), 'application/pdf'); assert.ok(txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF'));
  const sx = +txt.match(/startxref\n(\d+)/)[1]; assert.equal(txt.slice(sx, sx + 4), 'xref');
  [...txt.slice(sx).matchAll(/(\d{10}) 00000 n /g)].forEach((m, i) => assert.ok(txt.slice(+m[1]).startsWith(`${i + 1} 0 obj`), `xref entry ${i + 1}`));
  assert.ok(txt.includes('(Daily attendance)') && txt.includes('(Alice)') && /Page 1 of \d+/.test(txt));
  assert.equal((await S.raw(`reports/daily/export?${q}&format=docx`)).status, 400);

  // spreadsheet formula safety (CSV is prefixed, xlsx stores text as text)
  const evil = await api('employees', 'POST', { name: '=HYPERLINK("http://evil","x")', department_id: eng, shift_id: shift, join_date: '2026-07-01' });
  await api('logs/import', 'POST', { csv: `${evil.code},2026-07-06 09:00\n${evil.code},2026-07-06 18:00` });
  assert.match(await (await S.raw(`reports/daily/export?${q}&format=csv`)).text(), /"'=HYPERLINK/);
  const sx2 = strFromU8(unzipSync(new Uint8Array(await (await S.raw(`reports/daily/export?${q}&format=xlsx`)).arrayBuffer()))['xl/worksheets/sheet1.xml']);
  assert.ok(sx2.includes('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK') && !sx2.includes('<f>'), 'no formula element anywhere');
  await api('employees/' + evil.id, 'PUT', { active: 0 });

  // payroll export, saved reports
  const pay = await api('reports/payroll?month=2026-07'); assert.ok(pay.rows.length >= 3 && pay.subtitle.startsWith('2026-07'));
  assert.ok((await (await S.raw('reports/payroll/export?month=2026-07&format=csv')).text()).includes('"Net pay"'));
  await api('reports/saved', 'POST', { name: 'Late list for Engineering', type: 'late', params: { department_id: eng } });
  await api('reports/saved', 'POST', { name: 'Exceptions', type: 'custom', params: { columns: 'date,name,status', statuses: 'Absent,Missing Out' } });
  const saved = await api('reports/saved'); assert.equal(saved.length, 2); assert.equal(saved.find(r => r.name.startsWith('Late')).params.department_id, String(eng));
  await assert.rejects(api('reports/saved', 'POST', { name: '', type: 'late' }), /Name/);
  await api('reports/saved/' + saved.find(r => r.name === 'Exceptions').id, 'DELETE'); assert.equal((await api('reports/saved')).length, 1);

  // statistics
  const st = await api('stats?' + q);
  assert.equal(st.totals.present_days, 8); assert.equal(st.totals.absent_days, 1); assert.equal(st.daily.length, 3);
  assert.equal(st.totals.attendance_rate, 88.9); assert.equal(st.totals.punctuality_rate, 87.5);
  assert.equal(st.departments.find(d => d.dept === 'Sales').rate, 100);
  assert.equal(st.top_late[0].name, 'Alice'); assert.equal(st.top_absent[0].name, 'Bilal'); assert.equal(st.weekdays.length, 7);
  assert.ok(st.top_overtime.some(e => e.name === 'Chand'));

  // permissions: viewers can run reports but not save; a scoped manager exports only their part
  await api('users', 'POST', { username: 'viewer1', password: 'password1', role: 'viewer' });
  await api('users', 'POST', { username: 'salesboss', password: 'password1', role: 'manager', departments: [sales] });
  const vt = await S.login('viewer1', 'password1'), mt = await S.login('salesboss', 'password1');
  assert.equal((await get(`reports/daily?${q}`, vt)).status, 200);
  assert.equal((await S.raw('reports/saved', 'POST', { name: 'x', type: 'late' }, vt)).status, 403);
  assert.equal((await get('reports/payroll?month=2026-07', vt)).status, 403, 'viewer role has no payroll access');
  const mcsv = await (await S.raw(`reports/daily/export?${q}&format=csv`, 'GET', undefined, mt)).text();
  assert.ok(mcsv.includes('Chand') && !mcsv.includes('Alice') && !mcsv.includes('Bilal'), 'a scoped login exports only its own rows');
  assert.equal((await get('stats?' + q, mt)).status, 200);
  assert.equal((await (await S.raw('stats?' + q, 'GET', undefined, mt)).json()).totals.employees, 1);
  console.log('e2e-reports passed: 15 report types, filters, CSV/Excel/PDF, saved reports, statistics, scope');
} catch (e) { console.error('E2E-REPORTS FAILED:', e.stack?.split('\n').slice(0, 3).join(' | ')); process.exitCode = 1; }
finally { S.stop(); }
