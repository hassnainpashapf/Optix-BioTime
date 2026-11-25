// Contracts (renewal, expiry reminders), promotions (designation + salary), directory, birthdays and anniversaries.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const P = async (path, method = 'GET', body, token) => { const r = await fetch(S.base + '/api/portal/' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const iso = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('sv'), md = (n) => iso(n).slice(5);
try {
  const eng = (await api('departments', 'POST', { name: 'Engineering' })).id, sales = (await api('departments', 'POST', { name: 'Sales' })).id;
  const dev = (await api('designations', 'POST', { name: 'Developer' })).id, lead = (await api('designations', 'POST', { name: 'Team lead' })).id;
  const mk = (name, extra = {}) => api('employees', 'POST', { name, department_id: eng, designation_id: dev, salary: 100000, join_date: '2022-03-01', email: name.split(' ')[0].toLowerCase() + '@x.com', ...extra });
  const A = await mk('Ayesha Khan', { dob: `1995-${md(5)}`, join_date: `2021-${md(3)}` }), B = await mk('Bilal Ahmed'), C = await mk('Chand Ali', { department_id: sales });
  await api('employees/' + B.id, 'PUT', { manager_id: A.id });

  // ---- contracts
  const add = (id, b) => api(`employees/${id}/contracts`, 'POST', b);
  await assert.rejects(add(A.id, { type: 'Lifetime', start_date: iso(-100) }), /Type must be/); await assert.rejects(add(A.id, { type: 'Contract' }), /Start date/);
  await assert.rejects(add(A.id, { type: 'Contract', start_date: iso(-10), end_date: iso(-20) }), /before the start/); await assert.rejects(add(A.id, { type: 'Contract', start_date: iso(-10) }), /needs an end date/);
  await assert.rejects(add(A.id, { type: 'Permanent', start_date: iso(-10), end_date: iso(100) }), /no end date/); await assert.rejects(add(A.id, { type: 'Probation', start_date: iso(-10), probation_end: iso(-20) }), /Probation cannot end/);
  const c1 = (await add(B.id, { type: 'Probation', start_date: iso(-80), end_date: iso(10), probation_end: iso(6), notice_days: 15, note: '3 months' })).id;
  let list = await api('contracts'); assert.equal(list.find(c => c.id === c1).state, 'expiring'); assert.equal(list.find(c => c.id === c1).days_left, 10); assert.equal(list.find(c => c.id === c1).probation_left, 6);
  const c2 = (await add(C.id, { type: 'Fixed-term', start_date: iso(-400), end_date: iso(-5) })).id; assert.equal((await api('contracts?state=expired')).map(c => c.id).join(), String(c2));
  await add(A.id, { type: 'Permanent', start_date: iso(-900) });
  assert.deepEqual((await api('contracts?state=attention')).map(c => c.id).sort(), [c1, c2].sort(), 'what needs attention: expiring or expired contracts and probation ending soon');
  // renewing replaces the contract in force
  const c3 = (await add(B.id, { type: 'Permanent', start_date: iso(11) })).id; const bh = await api(`employees/${B.id}/contracts`); assert.equal(bh.find(c => c.id === c1).state, 'renewed'); assert.equal(bh.find(c => c.id === c3).state, 'active');
  await api('contracts/' + c3, 'PUT', { note: 'confirmed' }); await assert.rejects(api('contracts/' + c3, 'PUT', { end_date: iso(50) }), /no end date/);
  await api('contracts/' + c2 + '/end', 'POST', { date: iso(-5), reason: 'not renewed' }); assert.equal((await api('contracts?state=ended')).length, 1); await assert.rejects(api('contracts/' + c2 + '/end', 'POST', {}), /in force/);
  await api('contracts/' + c2, 'DELETE'); assert.equal((await api('contracts')).find(c => c.id === c2), undefined);
  // reminders: contract end and probation end, once per step (30, 14, 7, 1, 0 days)
  const c4 = (await add(C.id, { type: 'Contract', start_date: iso(-100), end_date: iso(5), probation_end: iso(2) })).id;
  const notes = async () => (await api('notifications')).items.filter(i => /contract|probation/.test(i.title));
  const n1 = (await api('contracts/check', 'POST')).sent; assert.equal(n1, 2, 'c4 contract and its probation (c1 was renewed, so it is not chased)'); const t1 = await notes();
  assert.ok(t1.some(i => i.title === "Chand Ali's contract ends in 5 days") && t1.some(i => i.title === "Chand Ali's probation ends in 2 days"), 'contract and probation reminders'); assert.ok(!t1.some(i => /Bilal/.test(i.title)), 'the renewed contract of Bilal is not reminded');
  assert.equal((await api('contracts/check', 'POST')).sent, 0, 'each step is reminded once');
  await api('contracts/' + c4, 'PUT', { end_date: iso(1) }); assert.equal((await api('contracts/check', 'POST')).sent, 1, 'a changed date is reminded afresh'); assert.ok((await notes()).some(i => i.title === "Chand Ali's contract ends in 1 day"));
  await api('alerts/prefs', 'PUT', { kind: 'contract', enabled: false }); assert.equal((await notes()).length, 0, 'the alert can be switched off'); await api('alerts/prefs', 'PUT', { kind: 'contract', enabled: true });

  // ---- promotion
  await assert.rejects(api(`employees/${A.id}/promote`, 'POST', {}), /Choose a new/); await assert.rejects(api(`employees/${A.id}/promote`, 'POST', { designation_id: 999 }), /Unknown designation/); await assert.rejects(api(`employees/${A.id}/promote`, 'POST', { salary: -5 }), /above 0/);
  await api(`payroll/salary/${A.id}`, 'POST', { effective_from: '2022-01-01', basic: 70000, components: [{ name: 'House rent', amount: 30000, taxable: true }] });
  const pr = await api(`employees/${A.id}/promote`, 'POST', { date: iso(0), designation_id: lead, salary: 150000, note: 'Annual review' }); assert.equal(pr.change.designation.to, 'Team lead'); assert.deepEqual(pr.change.salary, { from: 100000, to: 150000 });
  const emp = await api('employees/' + A.id); assert.equal(emp.designation, 'Team lead'); assert.equal(emp.salary, 150000);
  const sal = await api('payroll/salary/' + A.id); assert.equal(sal.current.gross, 150000); assert.equal(sal.current.basic, 105000, 'the structure scales: basic 70% of gross'); assert.equal(sal.history[0].note, 'Promotion');
  const hist = await api(`employees/${A.id}/history`); const ph = hist.find(h => h.kind === 'promotion'); assert.equal(JSON.parse(ph.detail).designation.from, 'Developer'); assert.equal(JSON.parse(ph.detail).note, 'Annual review');
  assert.equal((await api('promotions')).length, 1); assert.equal((await api('promotions'))[0].employee, 'Ayesha Khan');
  await api(`employees/${C.id}/promote`, 'POST', { department_id: eng }); assert.equal((await api('employees/' + C.id)).dept, 'Engineering', 'a promotion can move the department too'); // no salary: no revision
  await api('employees/' + C.id, 'PUT', { active: false }); await assert.rejects(api(`employees/${C.id}/promote`, 'POST', { designation_id: lead }), /active employee/);
  // salary changes need payroll rights
  await api('users', 'POST', { username: 'hr1', password: 'password1', role: 'hr' }); const hr = await S.login('hr1', 'password1');
  const noPay = await S.raw(`employees/${B.id}/promote`, 'POST', { salary: 200000 }, hr); assert.ok([200, 403].includes(noPay.status));

  // ---- directory and upcoming
  let dir = await api('directory'); assert.equal(dir.length, 2, 'only active employees'); assert.ok(dir.find(p => p.name === 'Bilal Ahmed').manager === 'Ayesha Khan');
  assert.equal((await api('directory?q=lead')).length, 1, 'search by designation'); assert.equal((await api('directory?q=nobody')).length, 0); assert.equal((await api('directory?department_id=' + sales)).length, 0);
  const up = await api('directory/upcoming?days=30'); const bd = up.find(u => u.kind === 'birthday'), an = up.find(u => u.kind === 'anniversary');
  assert.equal(bd.name, 'Ayesha Khan'); assert.equal(bd.in_days, 5); assert.equal(an.name, 'Ayesha Khan'); assert.equal(an.in_days, 3); assert.equal(an.years, new Date().getFullYear() - 2021 + (md(3) < md(0) ? 1 : 0));
  assert.deepEqual((await api('directory/upcoming?days=1')).filter(u => u.kind === 'birthday'), [], 'the window is respected');
  // portal directory: colleagues see names and roles, not phones or salaries
  const made = await api('portal-accounts', 'POST', { employee_ids: [B.id] }); const pw = made.accounts[0].password; const code = (await api('employees')).find(e => e.id === B.id).code;
  const l = await P('login', 'POST', { code, password: pw }); await P('password', 'POST', { current: pw, password: 'new-password-1' }, l.body.token); const t = (await P('login', 'POST', { code, password: 'new-password-1' })).body.token;
  const pd = await P('directory', 'GET', undefined, t); assert.equal(pd.status, 200); assert.equal(pd.body.people.length, 2); assert.ok(!('phone' in pd.body.people[0]) && !('salary' in pd.body.people[0])); assert.equal((await P('directory?q=Team', 'GET', undefined, t)).body.people.length, 1);
  assert.equal((await P('directory', 'GET')).status, 401);
  console.log('e2e-hrx passed: contracts (types, renewal, end, attention list), promotions (designation, salary structure, history), directory, birthdays and anniversaries, portal directory');
} catch (e) { console.error('E2E-HRX FAILED:', (e.stack || '').split('\n').filter(l => /e2e-hrx.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
