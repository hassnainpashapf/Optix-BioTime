// Payroll: salary structure and revisions, income tax slabs, EOBI / social security, approval, history, bank file.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b}`);
try {
  const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - 1); const M = d0.toLocaleDateString('sv').slice(0, 7), first = M + '-01', days = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate();
  const cur = new Date().toLocaleDateString('sv').slice(0, 7);
  await api('shifts', 'POST', { name: 'Office', code: 'O', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' }); const sh = (await api('shifts')).at(-1).id;
  const mk = async (name, salary) => { const r = await api('employees', 'POST', { name, salary, shift_id: sh, join_date: first }); return { ...r, code: (await api('employees')).find(e => e.id === r.id).code }; };
  const A = await mk('Aslam', 100000), B = await mk('Bilqis', 300000), C = await mk('Chand', 1000000), D = await mk('Dania', 100000), E = await mk('Eman', 50000);
  const L = []; for (let i = 1; i <= days; i++) for (const x of [A, B, C, D, E]) { const day = `${M}-${String(i).padStart(2, '0')}`; L.push(`${x.code},${day} 09:00`, `${x.code},${day} 18:00`); }
  await api('logs/import', 'POST', { csv: L.join('\n') });
  const row = async (c, m = M) => (await api('report/payroll?month=' + m)).rows.find(r => r.code === c);
  let r = await row(A.code); near(r.net, 100000); assert.equal(r.tax, 0, 'tax is off by default'); assert.equal(r.gross, 100000); assert.equal(r.basic, 100000, 'without a structure basic = salary');

  // ---- salary structure
  await assert.rejects(api('payroll/salary/' + D.id, 'POST', { effective_from: first, basic: 0 }), /Basic salary/); await assert.rejects(api('payroll/salary/' + D.id, 'POST', { effective_from: first, basic: 50000, components: [{ name: 'HRA', amount: -1 }] }), /0 or more/);
  await assert.rejects(api('payroll/salary/' + D.id, 'POST', { basic: 50000 }), /month the new salary starts/);
  const rev = await api('payroll/salary/' + D.id, 'POST', { effective_from: first, basic: 60000, components: [{ name: 'House rent', amount: 25000, taxable: true }, { name: 'Conveyance', amount: 15000, taxable: false }], note: 'Joining' });
  assert.equal(rev.gross, 100000); let s = await api('payroll/salary/' + D.id); assert.equal(s.current.gross, 100000); assert.equal(s.current.components.length, 2); assert.equal((await api('employees')).find(e => e.id === D.id).salary, 100000, 'employees.salary follows the structure');
  r = await row(D.code); assert.equal(r.basic, 60000); assert.equal(r.gross, 100000); near(r.net, 100000);
  // a later revision, history and percentage change
  await api('payroll/salary/' + D.id, 'POST', { effective_from: cur + '-15', basic: 66000, components: [{ name: 'House rent', amount: 27500, taxable: true }, { name: 'Conveyance', amount: 16500, taxable: false }] });
  s = await api('payroll/salary/' + D.id); assert.equal(s.history.length, 2); assert.equal(s.history[0].effective_from, cur + '-01', 'a revision starts on the 1st of its month'); assert.equal(s.history[0].change_pct, 10); assert.equal((await row(D.code)).gross, 100000, 'last month still uses the old salary');
  assert.equal((await api('employees')).find(e => e.id === D.id).salary, 110000, 'the current month already uses the new one');
  await api('payroll/salary/revision/' + s.history[0].id, 'DELETE'); assert.equal((await api('employees')).find(e => e.id === D.id).salary, 100000);
  // typing a new gross on the employee form keeps the structure in proportion
  await api('employees/' + D.id, 'PUT', { salary: 120000 }); s = await api('payroll/salary/' + D.id); assert.equal(s.current.gross, 120000); near(s.current.basic, 72000); near(s.current.components[1].amount, 18000);
  await api('payroll/salary/' + D.id, 'POST', { effective_from: first, basic: 60000, components: [{ name: 'House rent', amount: 25000, taxable: true }, { name: 'Conveyance', amount: 15000, taxable: false }] }); // back to the plain structure for last month
  await api('payroll/salary/' + D.id, 'POST', { effective_from: cur, basic: 60000, components: [{ name: 'House rent', amount: 25000, taxable: true }, { name: 'Conveyance', amount: 15000, taxable: false }] });

  // ---- income tax slabs
  const rates = await api('payroll/rates'); assert.equal(rates.slabs.length, 6); assert.equal(rates.settings.tax_enabled, 0);
  assert.deepEqual(await api('payroll/tax-calc?monthly=100000'), { annual_income: 1200000, annual_tax: 6000, monthly_tax: 500 }); near((await api('payroll/tax-calc?annual=12000000')).annual_tax, 3685290);
  await api('payroll/rates', 'PUT', { settings: { tax_enabled: 1 } });
  r = await row(A.code); near(r.tax, 500); near(r.net, 99500); near(r.taxable_income, 100000);
  near((await row(B.code)).tax, 38833.33); near((await row(C.code)).tax, 307107.5, 0.02);
  r = await row(D.code); near(r.taxable_income, 85000, 0.01); near(r.tax, 350); // conveyance (15,000) is not taxable: 1,020,000 a year = 1% of 420,000 = 4,200, so 350 a month
  await api('payroll/employee/' + A.id, 'PUT', { tax_exempt: true }); r = await row(A.code); assert.equal(r.tax, 0); near(r.net, 100000);
  // editing the slabs
  const bad = (sl, re) => assert.rejects(api('payroll/rates', 'PUT', { slabs: sl }), re);
  await bad([{ lower: 100, upper: null, fixed: 0, rate: 0 }], /start at 0/); await bad([{ lower: 0, upper: 100, rate: 0 }], /no upper limit/); await bad([{ lower: 0, upper: 100, rate: 0 }, { lower: 150, upper: null, rate: 5 }], /start where slab 1 ends/);
  await bad([{ lower: 0, upper: null, rate: 0 }, { lower: 100, upper: null, rate: 5 }], /Only the last/); await bad([{ lower: 0, upper: null, rate: 150 }], /look wrong/);
  await api('payroll/rates', 'PUT', { tax_year: 'test', slabs: [{ lower: 0, upper: 1000000, fixed: 0, rate: 0 }, { lower: 1000000, upper: null, fixed: 0, rate: 10 }] });
  assert.deepEqual(await api('payroll/tax-calc?annual=2000000'), { annual_income: 2000000, annual_tax: 100000, monthly_tax: 8333.33 }); assert.equal((await api('payroll/rates')).tax_year, 'test');
  await api('payroll/rates', 'PUT', { slabs: [{ lower: 0, upper: 600000, fixed: 0, rate: 0 }, { lower: 600000, upper: 1200000, fixed: 0, rate: 1 }, { lower: 1200000, upper: 2200000, fixed: 6000, rate: 11 }, { lower: 2200000, upper: 3200000, fixed: 116000, rate: 23 }, { lower: 3200000, upper: 4100000, fixed: 346000, rate: 30 }, { lower: 4100000, upper: null, fixed: 616000, rate: 35 }] });

  // ---- EOBI and social security
  await api('payroll/employee/' + E.id, 'PUT', { eobi: true, social_scheme: 'SESSI', eobi_no: 'E-1', cnic: '35202-1234567-1' }); await assert.rejects(api('payroll/employee/' + E.id, 'PUT', { social_scheme: 'XYZ' }), /SESSI, PESSI/); await assert.rejects(api('payroll/employee/' + E.id, 'PUT', { cnic: '123' }), /CNIC/);
  r = await row(E.code); assert.equal(r.eobi_employee, 400); assert.equal(r.eobi_employer, 2000); assert.equal(r.social_employer, 2400, '6% of 40,000: the ceiling applies below the salary'); near(r.net, 50000 - 400 - r.tax);
  await api('payroll/rates', 'PUT', { settings: { eobi_wage: 37000 } }); assert.equal((await row(E.code)).eobi_employee, 370);
  await api('payroll/employee/' + E.id, 'PUT', { social_scheme: 'PESSI' }); assert.equal((await row(E.code)).social_employer, 2400);
  await api('payroll/employee/' + E.id, 'PUT', { eobi: false, social_scheme: null }); r = await row(E.code); assert.equal(r.eobi_employee, 0); assert.equal(r.social_employer, 0);

  // ---- approval: submit, an admin approves, finalize; numbers that change after approval need a new approval
  await api('payroll/rates', 'PUT', { settings: { payroll_approval: 1 } });
  await assert.rejects(api('payroll/finalize', 'POST', { month: M }), /submitted and approved/);
  await assert.rejects(api('payroll/approve', 'POST', { month: M }), /Nothing is waiting/);
  await api('payroll/submit', 'POST', { month: M, note: 'please check' }); assert.equal((await api('report/payroll?month=' + M)).approval.status, 'submitted');
  await assert.rejects(api('payroll/finalize', 'POST', { month: M }), /submitted and approved/);
  await api('users', 'POST', { username: 'payclerk', password: 'password1', role: 'hr' }); const clerk = await S.login('payclerk', 'password1');
  assert.equal((await S.raw('payroll/approve', 'POST', { month: M }, clerk)).status, 403, 'only an admin approves');
  await api('payroll/approve', 'POST', { month: M }); assert.equal((await api('report/payroll?month=' + M)).approval.status, 'approved');
  await api('payroll/items', 'POST', { employee_id: B.id, month: M, kind: 'bonus', amount: 5000 }); assert.equal((await api('report/payroll?month=' + M)).approval.status, 'stale', 'the numbers moved after approval');
  await assert.rejects(api('payroll/finalize', 'POST', { month: M }), /numbers changed/);
  await api('payroll/reject', 'POST', { month: M, note: 'no' }); assert.equal((await api('report/payroll?month=' + M)).approval.status, 'rejected');
  await api('payroll/submit', 'POST', { month: M }); await api('payroll/approve', 'POST', { month: M }); await api('payroll/finalize', 'POST', { month: M });
  assert.equal((await api('report/payroll?month=' + M)).status, 'finalized'); await assert.rejects(api('payroll/submit', 'POST', { month: M }), /already finalized/);
  await assert.rejects(api('payroll/salary/' + A.id, 'POST', { effective_from: first, basic: 1000 }), /finalized/); await assert.rejects(api('payroll/salary-bulk', 'POST', { percent: 5, effective_from: first }), /finalized/);

  // ---- history and bank file
  const hist = await api('payroll/history'); assert.equal(hist[0].month, M); assert.equal(hist[0].employees, 5); near(hist[0].net, (await api('report/payroll?month=' + M)).rows.reduce((a, x) => a + x.net, 0)); assert.ok(hist[0].tax > 300000); assert.equal(hist[0].approval, 'admin');
  const eh = await api('payroll/employee-history/' + B.id); assert.equal(eh.months.length, 1); assert.equal(eh.months[0].bonus, 5000);
  await api('payroll/employee/' + B.id, 'PUT', { bank_name: 'HBL', bank_account: 'PK36SCBL0000001123456702', bank_title: 'Bilqis Bano' }); await api('payroll/employee/' + A.id, 'PUT', { bank_name: 'MCB', bank_account: '1234567890123' });
  await assert.rejects(api('payroll/employee/' + A.id, 'PUT', { bank_account: '12' }), /looks wrong/);
  const bf = await api('payroll/bank-file?month=' + M); assert.equal(bf.count, 2); assert.equal(bf.skipped.length, 3); assert.ok(bf.skipped.every(x => /No bank account/.test(x.reason))); assert.match(bf.csv, /"Bilqis Bano","HBL","PK36SCBL0000001123456702",/); assert.match(bf.csv, /Salary \d{4}-\d\d/);
  const bnet = (await api('report/payroll?month=' + M)).rows.find(x => x.code === B.code).net; assert.ok(bf.csv.includes(bnet.toFixed(2))); near(bf.total, bnet + (await row(A.code)).net);
  assert.ok(bf.csv.startsWith('code,title,bank,account,amount,narration')); assert.ok((await api('payroll/bank-file?month=' + M + '&format=ibft')).csv.startsWith('title,bank,account,amount,narration'));
  await assert.rejects(api('payroll/bank-file?month=' + cur), /Finalize the month first/); assert.ok((await api('payroll/bank-file?month=' + cur + '&draft=1')).status === 'draft');

  // ---- annual increment for everyone
  await api('payroll/rates', 'PUT', { settings: { payroll_approval: 0 } });
  const dry = await api('payroll/salary-bulk', 'POST', { percent: 10, effective_from: cur, dry_run: true }); assert.equal(dry.total, 5); assert.equal(dry.changed, 0); assert.equal(dry.preview.find(x => x.code === A.code).to, 110000);
  const did = await api('payroll/salary-bulk', 'POST', { percent: 10, effective_from: cur }); assert.equal(did.changed, 5);
  const sal = (await api('payroll/salary')).find(x => x.id === D.id); assert.equal(sal.gross, 110000); assert.equal(sal.structured, true); assert.equal((await api('payroll/salary')).find(x => x.id === A.id).gross, 110000);
  await assert.rejects(api('payroll/salary-bulk', 'POST', { percent: 5, amount: 100, effective_from: cur }), /either a percentage or an amount/);
  // permissions
  await api('users', 'POST', { username: 'viewer3', password: 'password1', role: 'viewer' }); const vt = await S.login('viewer3', 'password1');
  assert.equal((await S.raw('payroll/salary/' + A.id, 'POST', { effective_from: cur, basic: 5 }, vt)).status, 403); assert.equal((await S.raw('payroll/history', 'GET', undefined, vt)).status, 403, 'the viewer role has no payroll access');
  console.log('e2e-payroll passed: salary structure + revisions, FBR-style tax slabs, EOBI, SESSI/PESSI, approval, history, bank file, increments, permissions');
} catch (e) { console.error('E2E-PAYROLL FAILED:', (e.stack || '').split('\n').filter(l => /e2e-payroll.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); }
