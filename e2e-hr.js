// HR core: organization, profile, photo, documents, custom fields, lifecycle, import/export, audit trail.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
try {
  // organization
  const co = (await api('companies', 'POST', { name: 'Asapp Studio' })).id;
  const hq = (await api('branches', 'POST', { name: 'Lahore HQ', company_id: co })).id;
  const kh = (await api('branches', 'POST', { name: 'Karachi', company_id: co })).id;
  const dept = (await api('departments', 'POST', { name: 'Engineering' })).id;
  const dept2 = (await api('departments', 'POST', { name: 'Sales' })).id;
  const des = (await api('designations', 'POST', { name: 'Developer' })).id;
  const grp = (await api('emp_groups', 'POST', { name: 'Staff' })).id;
  assert.equal((await api('branches')).find(b => b.id === hq).company, 'Asapp Studio');

    // registration, auto ID, validation
  const a = await api('employees', 'POST', { name: 'Ali Raza', department_id: dept, branch_id: hq, designation_id: des, group_id: grp, company_id: co, salary: 50000, join_date: '2026-01-10', email: 'ali@x.com', phone: '0300111', gender: 'male' });
  assert.equal(a.code, '1', 'first auto ID');
  const b = await api('employees', 'POST', { name: 'Sara Khan', department_id: dept2, branch_id: kh, join_date: '2026-02-01' });
  assert.equal(b.code, '2', 'IDs count up');
  assert.equal((await api('employees/next-code')).code, '3');
  await assert.rejects(api('employees', 'POST', { name: 'X', code: '1' }), /already exists/);
  await assert.rejects(api('employees', 'POST', { name: 'X', email: 'nope' }), /email/i);
  await assert.rejects(api('employees', 'POST', { name: 'X', join_date: '10/01/2026' }), /YYYY-MM-DD/);
  await assert.rejects(api('employees', 'POST', { name: 'X', code: 'a b' }), /Code/);
  await assert.rejects(api('employees', 'POST', { name: 'X', branch_id: 999 }), /Unknown/);
  await assert.rejects(api('employees', 'POST', { name: '' }), /Name/);

  await assert.rejects(api('branches/' + hq, 'DELETE'), /In use/); await assert.rejects(api('designations/' + des, 'DELETE'), /In use/); await assert.rejects(api('companies/' + co, 'DELETE'), /In use/);
  const spare = (await api('branches', 'POST', { name: 'Spare' })).id; await api('branches/' + spare, 'DELETE');

  // search and filters
  assert.equal((await api('employees?q=ali')).length, 1);
  assert.equal((await api('employees?q=0300111')).length, 1);
  assert.deepEqual((await api('employees?branch_id=' + kh)).map(e => e.name), ['Sara Khan']);
  assert.equal((await api('employees?department_id=' + dept)).length, 1);
  assert.equal((await api('employees?status=active')).length, 2);
  const full = await api('employees/' + a.id);
  assert.equal(full.designation, 'Developer'); assert.equal(full.branch, 'Lahore HQ'); assert.equal(full.company, 'Asapp Studio');

  // custom fields
  const cf = (await api('custom_fields', 'POST', { label: 'Blood group', type: 'select', options: 'A+,B+,O+' })).id;
  const cn = (await api('custom_fields', 'POST', { label: 'Cars', type: 'number' })).id;
  await api('employees/' + a.id, 'PUT', { custom: { [cf]: 'O+', [cn]: '2' } });
  assert.deepEqual((await api('employees/' + a.id)).custom, { [cf]: 'O+', [cn]: '2' });
  await assert.rejects(api('employees/' + a.id, 'PUT', { custom: { [cf]: 'Z+' } }), /options/);
  await assert.rejects(api('employees/' + a.id, 'PUT', { custom: { [cn]: 'many' } }), /number/);

  // profile edit
  await api('employees/' + a.id, 'PUT', { phone: '0322999', salary: 55000 });
  assert.equal((await api('employees/' + a.id)).phone, '0322999');
  assert.equal((await api('employees?q=0300111')).length, 0);

  // transfer keeps a history entry
  await api(`employees/${a.id}/transfer`, 'POST', { branch_id: kh, department_id: dept2, date: '2026-06-01', note: 'Opening Karachi desk' });
  const moved = await api('employees/' + a.id); assert.equal(moved.branch, 'Karachi'); assert.equal(moved.dept, 'Sales');
  const hist = await api(`employees/${a.id}/history`);
  assert.equal(hist[0].kind, 'transfer'); assert.match(hist[0].detail, /Lahore HQ/); assert.match(hist[0].detail, /Karachi/);
  await assert.rejects(api(`employees/${a.id}/transfer`, 'POST', { branch_id: kh }), /Nothing to change/);

  // photo
  await api(`employees/${a.id}/photo`, 'POST', { data: PNG });
  const ph = await S.raw(`employees/${a.id}/photo`); assert.equal(ph.status, 200); assert.equal(ph.headers.get('content-type'), 'image/png');
  await assert.rejects(api(`employees/${a.id}/photo`, 'POST', { data: 'data:image/svg+xml;base64,PHN2Zz4=' }), /JPEG or PNG/);
  await api(`employees/${a.id}/photo`, 'DELETE'); assert.equal((await S.raw(`employees/${a.id}/photo`)).status, 404);

  // documents
  const txt = 'Offer letter for Ali';
  const doc = await api(`employees/${a.id}/documents`, 'POST', { name: 'Offer', filename: '../../etc/offer.txt', data: Buffer.from(txt).toString('base64') });
  const list = await api(`employees/${a.id}/documents`); assert.equal(list[0].filename, 'offer.txt', 'path stripped from the file name');
  const dl = await S.raw(`documents/${doc.id}/download`); assert.equal(await dl.text(), txt);
  await assert.rejects(api(`employees/${a.id}/documents`, 'POST', { filename: 'virus.exe', data: 'QQ==' }), /Allowed/);
  await api(`documents/${doc.id}`, 'DELETE'); assert.equal((await api(`employees/${a.id}/documents`)).length, 0);

  // resignation / termination / rejoining
  await api(`employees/${b.id}/resign`, 'POST', { date: '2026-07-31', reason: 'Better offer' });
  let sara = await api('employees/' + b.id); assert.equal(sara.status, 'resigned'); assert.equal(sara.active, 0); assert.equal(sara.exit_date, '2026-07-31');
  await assert.rejects(api(`employees/${b.id}/resign`, 'POST', {}), /already inactive/);
  assert.equal((await api('employees?status=resigned')).length, 1);
  assert.equal((await api('employees?status=inactive')).length, 1);
  await api(`employees/${b.id}/rejoin`, 'POST', { date: '2026-09-01' });
  sara = await api('employees/' + b.id); assert.equal(sara.status, 'active'); assert.equal(sara.active, 1);
  await api(`employees/${b.id}/terminate`, 'POST', { date: '2026-09-30', reason: 'Policy breach' });
  assert.equal((await api('employees/' + b.id)).status, 'terminated');
  assert.deepEqual((await api(`employees/${b.id}/history`)).map(h => h.kind), ['termination', 'rejoin', 'resignation', 'registered']);

  // bulk import / export (+ spreadsheet formula safety)
  const csv = 'code,name,department,branch,designation,group,shift,salary,join_date,email,phone\n' +
    '50,"Khan, Bilal",Operations,Lahore HQ,Clerk,Staff,,30000,2026-02-01,b@x.com,0301\n' +
    ',=HYPERLINK("http://evil"),Operations,,,,,25000,2026-02-02,,\n' +
    '1,Ali Raza,,,,,,60000,,,\n' +
    '51,,Operations,,,,,1,,,\n' +
    '52,Bad Date,,,,,,1,2026/02/01,,\n';
  const imp = await api('employees/import', 'POST', { csv });
  assert.equal(imp.created, 2); assert.equal(imp.updated, 1); assert.equal(imp.errors.length, 2); assert.deepEqual(imp.errors.map(e => e.line), [5, 6]);
  assert.equal((await api('employees/' + a.id)).salary, 60000, 'import updates by code');
  assert.equal((await api('departments')).some(d => d.name === 'Operations'), true, 'import creates missing departments');
  const exp = await (await S.raw('employees/export.csv')).text();
  assert.match(exp, /"Khan, Bilal"/); assert.match(exp, /"'=HYPERLINK/); assert.doesNotMatch(exp, /,"=HYPERLINK/);
  assert.match(await (await S.raw('employees/template.csv')).text(), /^code,name,department/);

  // everything above reached the device as commands for approved push devices (none here), audit trail recorded
  const audit = await api('audit');
  assert.ok(audit.some(r => r.method === 'POST' && r.path === '/api/employees'));
  assert.ok(audit.every(r => !/e2e-pass|newpass/.test(r.summary)));
  assert.ok(!audit.some(r => /base64|iVBOR/.test(r.summary)), 'uploaded file bytes are not copied into the log');
  await api('users', 'POST', { username: 'viewer1', password: 'viewonly1', role: 'viewer' });
  const vt = await S.login('viewer1', 'viewonly1');
  assert.equal((await S.raw('audit', 'GET', undefined, vt)).status, 403);
  assert.equal((await S.raw('employees', 'GET', undefined, vt)).status, 200);
  assert.equal((await S.raw('employees', 'POST', { name: 'Nope' }, vt)).status, 403);
  console.log('e2e-hr passed: org, profile, photo, documents, custom fields, lifecycle, import/export, audit');
} catch (e) { console.error('E2E-HR FAILED:', e.message); process.exitCode = 1; }
finally { S.stop(); }
