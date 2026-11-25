// BioTime-style attendance report pages: one report per group with seeded punches / leave / overtime, column titles,
// filters, exports, the Custom Report CRUD, and permission scoping.
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const get = async (p, token = S.token) => { const r = await S.raw(p, 'GET', undefined, token); return { status: r.status, j: r.headers.get('content-type')?.includes('json') ? await r.json() : null, r }; };
try {
  const eng = (await api('departments', 'POST', { name: 'Engineering' })).id, sales = (await api('departments', 'POST', { name: 'Sales' })).id;
  const grp = (await api('emp_groups', 'POST', { name: 'Night crew' })).id;
  const shift = (await api('shifts', 'POST', { name: 'Office', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5' })).id;
  const mk = (name, department_id, extra = {}) => api('employees', 'POST', { name, department_id, shift_id: shift, join_date: '2026-07-01', ...extra });
  const A = await mk('Alice', eng), B = await mk('Bilal', eng), C = await mk('Chand', sales, { group_id: grp }), D = await mk('Dina', sales, { gender: 'female' });
  await api('holidays', 'POST', { date: '2026-07-10', name: 'Test holiday' });
  const L = [], p = (e, d, ...t) => t.forEach(x => L.push(`${e.code},2026-07-${d} ${x}`));
  p(A, '06', '09:00', '18:00'); p(A, '07', '09:30', '18:00'); p(A, '08', '09:00');   // Alice: on time / 30 late / no punch-out
  p(B, '06', '09:00', '17:00'); p(B, '08', '09:00', '18:00');                         // Bilal: left 60 early / absent Tue
  for (const d of ['06', '07', '08']) p(C, d, '09:00', '18:30');                      // Chand: 30 min overtime a day
  p(C, '11', '10:00', '14:00');                                                       // Chand: Saturday (weekly off) 4 h
  p(D, '06', '09:00', '12:00', '13:00', '18:00');                                     // Dina: lunch break out and back
  await api('logs/import', 'POST', { csv: L.join('\n') });
  await api('leaves', 'POST', { employee_id: C.id, type: 'Casual', from_date: '2026-07-09', to_date: '2026-07-09', auto_approve: true });
  const q = 'start_date=2026-07-06&end_date=2026-07-12&departments=-1&areas=-1&groups=-1&employees=-1';
  const run = async (n, extra = '') => { const r = await get(`zkrep/${n}?${q}&page_size=500${extra}`); assert.equal(r.status, 200, n + ' ' + JSON.stringify(r.j)); return r.j; };
  const row = (r, code, date) => r.rows.find(x => x['Employee ID'] === code && (!date || x.Date === `2026-07-${date}`));
  const EMP9 = ['Employee ID', 'First Name', 'Last Name', 'Nick Name', 'Gender', 'Department Code', 'Department', 'Position Code', 'Position'];

  // catalogue: every report answers, titles in the reference order
  const meta = (await api('zkrep/meta')).reports; assert.equal(meta.length, 31);
  for (const m of meta) { const r = await run(m.name); assert.ok(r.columns.length >= 3 && Array.isArray(r.rows), m.name); }
  const tx = await run('transactionReport');
  assert.deepEqual(tx.columns.map(c => c.label), [...EMP9, 'Date', 'Time', 'Punch State', 'Verification Type', 'Work Code', 'Data Sources', 'Device Name']);
  assert.deepEqual(tx.columns.filter(c => c.hide).map(c => c.label), ['Last Name', 'Nick Name', 'Gender', 'Department Code', 'Position Code', 'Position', 'Verification Type']);
  assert.equal(tx.count, 21, 'every punch is one row');
  await assert.rejects(api('zkrep/nope?' + q), /Unknown report/);

  // Transaction group
  assert.equal(tx.rows.filter(r => r['Employee ID'] === D.code).length, 4);
  assert.deepEqual(tx.rows.filter(r => r['Employee ID'] === A.code && r.Date === '2026-07-06').map(r => `${r.Time}|${r['Punch State']}`), ['09:00:00|Check In', '18:00:00|Check Out']);
  assert.equal(tx.rows[0]['Data Sources'], 'Device');
  const tc = await run('timeCardReport'); assert.deepEqual([row(tc, A.code, '06').Times, row(tc, A.code, '06').Time], [2, '09:00  18:00']);
  const fl = await run('firstLastReport'), a7 = row(fl, A.code, '07'); assert.deepEqual([a7['First Punch'], a7['Last Punch'], a7['Total Time'], a7.Weekday], ['09:30', '18:00', '08:30', 'Tuesday']);
  assert.equal(row(fl, A.code, '08')['Last Punch'], '', 'one punch only');
  const filo = await run('firstInLastOutReport'); assert.deepEqual(filo.columns.slice(9).map(c => c.label), ['Date', 'Weekday', 'Check In', 'Check Out', 'Total Time']); assert.equal(row(filo, B.code, '06')['Check Out'], '17:00');

  // Daily group
  const tt = await run('totalTimeCardReportV2'); assert.equal(tt.columns.length, 58 + 0, 'every Total Time Card column');
  assert.ok(!tt.columns.find(c => c.label === 'Attendance').hide, 'attendance status is visible by default');
  assert.equal(row(tt, A.code, '06').Attendance, 'Present', 'calculated attendance reaches the report');
  assert.deepEqual(tt.columns.slice(9, 14).map(c => c.label), ['Date', 'Weekday', 'Timetable', 'Check In', 'Check Out']);
  const al7 = row(tt, A.code, '07'); assert.deepEqual([al7['Late In(M)'], al7['Clock In'], al7['Timetable'], al7['Check In'], al7['Duty Duration'], al7.Exception], [30, '09:30', 'Office', '09:00', 9, 'Late In 30M']);
  assert.equal(row(tt, B.code, '06')['Early Out(M)'], 60); assert.equal(row(tt, B.code, '07')['Absence(H)'], 9);
  const c6 = row(tt, C.code, '06'); assert.deepEqual([c6['Normal OT(H)'], c6['OT1(H)'], c6['Total OT'], c6['Regular(H)']], [0.5, 0.5, 0.5, 9]);
  assert.equal(row(tt, C.code, '09')['Casual Leave(H)'], 9, 'approved leave day');
  assert.equal(row(tt, C.code, '11')['Weekend OT(H)'], 4);
  assert.deepEqual((await run('dailyLateInReport')).rows.map(r => `${r['First Name']} ${r.Date} ${r['Late In(M)']}`), ['Alice 2026-07-07 30']);
  assert.deepEqual((await run('dailyEarlyOutReport')).rows.map(r => `${r['First Name']} ${r['Early Out(M)']}`), ['Bilal 60']);
  const ab = await run('dailyAbsentReport'); assert.ok(ab.rows.some(r => r['First Name'] === 'Bilal' && r.Date === '2026-07-07') && !ab.rows.some(r => r.Date === '2026-07-10'), 'a holiday is not an absence');
  const lv = await run('dailyLeaveReport'); assert.deepEqual(lv.rows.map(r => `${r['First Name']} ${r.Date} ${r['Casual Leave(H)']}`), ['Chand 2026-07-09 9']);
  const ex = (await run('dailyExceptionReport')).rows.map(r => `${r['First Name']} ${r.Date} ${r.Description}`); assert.ok(ex.includes('Alice 2026-07-07 Late In 30M') && ex.includes('Alice 2026-07-08 Missing Check Out'));
  assert.equal((await run('dailyOvertimeReport')).rows.filter(r => r['First Name'] === 'Chand').length, 4);
  assert.deepEqual((await run('dailyActivityReport')).columns.slice(-3).map(c => c.label), ['Compensatory Leave(H)', 'Unpaid Leave(H)', 'Paternity Leave(H)'], 'leave types without a fixed column follow the fixed ones');
  const sp = await run('scheduledPunchReport'); assert.deepEqual(sp.rows.filter(r => r['Employee ID'] === A.code && r.Date === '2026-07-06').map(r => r['Correct State']), ['Check In', 'Check Out']);
  const pr = await run('punchParingReport'); assert.deepEqual(pr.rows.filter(r => r['Employee ID'] === D.code).map(r => `${r.In}-${r.Out}:${r['Total Hrs']}`), ['09:00-12:00:3', '13:00-18:00:5']);
  const mu = (await run('dailyMultiplePunchParingReport')).rows.filter(r => r['Employee ID'] === D.code);
  assert.equal(mu[0]['Total Time'], '08:00'); assert.equal(mu[0]._p, 1); assert.deepEqual(mu.slice(1).map(r => `${r['Check In']}-${r['Check Out']}:${r['Total Time#2']}`), ['09:00-12:00:03:00', '13:00-18:00:05:00']);
  const br = (await run('dailyMultipleBreakParingReport')).rows; assert.equal(br.length, 2); assert.equal(br[0]['Summary Time'], '01:00'); assert.deepEqual([br[1]['Clock In'], br[1]['Clock Out'], br[1]['Total Time']], ['13:00', '12:00', '01:00']);

  // Weekly group
  const wk = await run('weeklyWorkedHoursReport'), cw = wk.rows.find(r => r['Employee ID'] === C.code);
  assert.deepEqual([cw['Week Start Date'], cw['Week End Date'], cw['Normal OT(H)'], cw['Weekend OT(H)'], cw['Casual Leave(H)']], ['2026-07-06', '2026-07-12', 1.5, 4, 9]);
  assert.equal((await run('weeklyOvertimeReport')).rows.find(r => r['Employee ID'] === C.code)['Normal OT(H)'], 1.5);

  // Monthly group: one column per day of the range
  const ms = await run('monthlyStatusReport'); assert.equal(ms.columns.length, 9 + 7); assert.equal(ms.columns[9].label, '6'); assert.match(ms.legend, /P:Regular/);
  const sa = ms.rows.find(r => r['Employee ID'] === A.code), sb = ms.rows.find(r => r['Employee ID'] === B.code);
  assert.deepEqual([sa.d0706, sa.d0707, sb.d0706, sb.d0707], ['P', 'L', 'E', 'A']);
  assert.equal((await run('monthlyPunchReport')).rows.find(r => r['Employee ID'] === A.code).d0707, '09:30-18:00');
  assert.equal((await run('monthlyWorkHoursReport')).rows.find(r => r['Employee ID'] === A.code).d0706, 9);
  assert.equal((await run('monthlyOvertimeReport')).rows.find(r => r['Employee ID'] === C.code).d0706, 0.5);
  const mab = (await run('monthlyAbsenceReport')).rows.find(r => r['Employee ID'] === B.code);
  assert.deepEqual([mab['Need Present Days'], mab['Present Days'], mab['Absence Days'], mab['Holiday Days'], mab['Absence Percentage']], [4, 2, 2, 1, '50%']);

  // Summary group
  const es = (await run('empSummaryReport')).rows.find(r => r['Employee ID'] === C.code); assert.deepEqual([es['Normal OT(H)'], es['Weekend OT(H)'], es['Casual Leave(H)']], [1.5, 4, 9]);
  assert.equal((await run('empSummaryReport')).rows.find(r => r['Employee ID'] === A.code)['Late In(M)'], 30);
  assert.equal((await run('employeeOvertimeReport')).rows.find(r => r['Employee ID'] === C.code)['Normal OT(H)'], 1.5);
  assert.equal((await run('employeeLeaveReport')).rows.find(r => r['Employee ID'] === C.code)['Casual Leave(H)'], 9);
  const ds = (await run('departmentSummaryReport')).rows.find(r => r.Department === 'Engineering'); assert.deepEqual([ds['Employee Qty.'], ds['Late(Times)'], ds['Early Leave(Times)']], [2, 1, 1]);
  assert.equal((await run('departmentOvertimeReport')).rows.find(r => r.Department === 'Sales')['Normal OT(H)'], 1.5);
  const gs = (await run('groupSummaryReport')).rows; assert.equal(gs.length, 1); assert.deepEqual([gs[0]['Group Name'], gs[0]['Employee Qty.']], ['Night crew', 1]);
  assert.equal((await run('groupOvertimeReport')).rows[0]['Normal OT(H)'], 1.5);
  const lb = await get(`zkrep/leaveBalanceSummaryReport?start_date=2026&end_date=2026&year=2026&page_size=500&employees=${C.id}`), cas = lb.j.columns.filter(c => c.group === 'Casual Leave(Days)');
  assert.deepEqual(cas.map(c => c.label), ['Total', 'Used', 'Remaining', 'Advance']); assert.equal(lb.j.rows.length, 1);
  assert.deepEqual(cas.map(c => lb.j.rows[0][c.key]), [5, 1, 4, 0], 'joined in July: 5 of 10 days earned, 1 used');
  const filt = await run('empSummaryReport', `&departments=${eng}`); assert.deepEqual(filt.rows.map(r => r['First Name']).sort(), ['Alice', 'Bilal'], 'department filter');
  assert.deepEqual((await run('empSummaryReport', `&employees=${D.id}`)).rows.map(r => r['First Name']), ['Dina'], 'employee filter');
  assert.equal((await get(`zkrep/empSummaryReport?${q}&page=2&page_size=2`)).j.rows.length, 2, 'paging'); assert.equal((await get(`zkrep/empSummaryReport?${q}&page=2&page_size=2`)).j.count, 4);

  // exports
  const csv = await (await S.raw(`zkrep/transactionReport/export?${q}&format=csv`)).text();
  assert.equal(csv.split('\n')[0], '"Employee ID","First Name","Department","Date","Time","Punch State","Work Code","Data Sources","Device Name"', 'hidden columns are not exported');
  const csv2 = await (await S.raw(`zkrep/transactionReport/export?${q}&format=csv&cols=0,2,10`)).text(); assert.equal(csv2.split('\n')[0], '"Employee ID","Last Name","Time"');
  const xr = await S.raw(`zkrep/empSummaryReport/export?${q}&format=xlsx`); assert.match(xr.headers.get('content-type'), /spreadsheetml/);
  assert.ok(strFromU8(unzipSync(new Uint8Array(await xr.arrayBuffer()))['xl/worksheets/sheet1.xml']).includes('>Regular(H)</t>'));
  const pdf = Buffer.from(await (await S.raw(`zkrep/dailyAbsentReport/export?${q}&format=pdf`)).arrayBuffer()).toString('latin1'); assert.ok(pdf.startsWith('%PDF-1.4') && pdf.includes('(Absent Report)'));
  const cardPdf = Buffer.from(await (await S.raw(`zkrep/totalTimeCardReportV2/export?${q}&format=pdf`)).arrayBuffer()).toString('latin1');
  assert.ok(cardPdf.includes('(Attendance)') && cardPdf.includes('(Present)') && cardPdf.includes('(Alice)'), 'wide PDF keeps names and attendance statuses');
  assert.match(cardPdf, /Columns 2 of \d+/, 'wide PDF continues onto another readable column page');
  assert.equal((await S.raw(`zkrep/empSummaryReport/export?${q}&format=docx`)).status, 400);
  const lbx = await (await S.raw(`zkrep/leaveBalanceSummaryReport/export?start_date=2026&end_date=2026&format=csv`)).text(); assert.ok(lbx.includes('Annual Leave(Days) Total'));

  // Custom Report: validation, CRUD, data, export
  await assert.rejects(api('zkrep/custom', 'POST', { name: '', date_range: 'today', fields: ['emp_code'] }), /Report Name/);
  await assert.rejects(api('zkrep/custom', 'POST', { name: 'x', date_range: 'someday', fields: ['emp_code'] }), /Time Period/);
  await assert.rejects(api('zkrep/custom', 'POST', { name: 'x', date_range: 'today', fields: ['bogus'] }), /valid field/);
  const cid = (await api('zkrep/custom', 'POST', { name: 'Late list', date_range: 'last_year', description: 'd', fields: ['emp_code', 'first_name', 'att_date', 'clock_in', 'paycode_2'] })).id;
  await assert.rejects(api('zkrep/custom', 'POST', { name: 'Late list', date_range: 'today', fields: ['emp_code'] }), /already exists/);
  const list = await api('zkrep/custom'); assert.equal(list.reports.length, 1); assert.ok(list.fields.some(f => f.id === 'paycode_2' && f.label === 'Late In(M)'));
  const cd = await api(`zkrep/custom/${cid}/data`); assert.deepEqual(cd.columns.map(c => c.label), ['Employee ID', 'First Name', 'Date', 'Clock In', 'Late In(M)']);
  const cx = await (await S.raw(`zkrep/custom/${cid}/export?format=csv&dateRange=custom&startDate=2026-07-06&endDate=2026-07-08&selectionMethod=department&ids=${eng}`)).text();
  assert.ok(cx.includes('"Alice"') && cx.includes('"09:30"') && !cx.includes('"Chand"'), 'export honours range and department');
  assert.match(await (await S.raw(`zkrep/custom/${cid}/export?format=txt&dateRange=custom&startDate=2026-07-06&endDate=2026-07-06`)).text(), /^Employee ID\tFirst Name/);
  assert.equal((await S.raw(`zkrep/custom/${cid}/export?format=xls&dateRange=this_month`)).headers.get('content-type').includes('spreadsheetml'), true);
  await api('zkrep/custom/' + cid, 'PUT', { name: 'Late list 2', date_range: 'this_month', fields: ['emp_code'] }); assert.equal((await api('zkrep/custom')).reports[0].name, 'Late list 2');
  assert.equal((await S.raw('zkrep/custom/999', 'DELETE')).status, 404);

  // permissions
  await api('roles', 'POST', { name: 'reporter', perms: { attendance: 'view' } });
  await api('users', 'POST', { username: 'rep1', password: 'password1', role: 'reporter' });
  await api('users', 'POST', { username: 'viewer1', password: 'password1', role: 'viewer' });
  await api('users', 'POST', { username: 'salesboss', password: 'password1', role: 'manager', departments: [sales] });
  const rt = await S.login('rep1', 'password1'), vt = await S.login('viewer1', 'password1'), mt = await S.login('salesboss', 'password1');
  assert.equal((await get(`zkrep/transactionReport?${q}`, rt)).status, 200);
  assert.equal((await get(`zkrep/dailyOvertimeReport?${q}`, rt)).status, 403, 'overtime reports need the overtime module');
  assert.equal((await get(`zkrep/employeeLeaveReport?${q}`, rt)).status, 403, 'leave reports need the leave module');
  assert.equal((await get(`zkrep/leaveBalanceSummaryReport?start_date=2026`, rt)).status, 403);
  assert.equal((await get(`zkrep/dailyOvertimeReport/export?${q}&format=csv`, rt)).status, 403, 'export is checked too');
  assert.equal((await get(`zkrep/dailyOvertimeReport?${q}`, vt)).status, 200);
  assert.equal((await S.raw('zkrep/custom', 'POST', { name: 'v', date_range: 'today', fields: ['emp_code'] }, vt)).status, 403, 'a read-only login cannot save custom reports');
  const mtx = (await get(`zkrep/transactionReport?${q}&page_size=500`, mt)).j; assert.ok(mtx.rows.length > 0 && mtx.rows.every(r => r.Department === 'Sales'), 'a scoped login sees its own department only');
  const mes = (await get(`zkrep/empSummaryReport?${q}&departments=${eng}`, mt)).j; assert.equal(mes.rows.length, 0, 'asking for another department yields nothing');
  const mcsv = await (await S.raw(`zkrep/empSummaryReport/export?${q}&format=csv`, 'GET', undefined, mt)).text(); assert.ok(mcsv.includes('Chand') && !mcsv.includes('Alice'));
  assert.deepEqual((await get('zkrep/tree/dept', mt)).j.map(d => d.name), ['Sales'], 'trees are scoped');
  assert.ok((await get('zkrep/employees', mt)).j.every(e => e.dept === 'Sales'));
  assert.equal((await get(`zkrep/leaveBalanceSummaryReport?start_date=2026&page_size=500`, mt)).j.rows.every(r => r.Department === 'Sales'), true);
  assert.equal((await api('zkrep/custom/' + cid, 'DELETE')).ok, true);
  console.log('e2e-zk-reports passed: 31 report pages, filters, paging, CSV/Excel/PDF/TXT, custom reports, permissions and scope');
} catch (e) { console.error('E2E-ZK-REPORTS FAILED:', e.stack?.split('\n').slice(0, 14).join(' | ')); process.exitCode = 1; }
finally { S.stop(); }
