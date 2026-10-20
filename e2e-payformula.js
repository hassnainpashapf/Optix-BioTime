// Payroll > Formula (calculator engine, pages) and Extra Funds (increase / deduction for many people at once).
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api, near = (a, b, t = 0.02) => assert.ok(Math.abs(a - b) <= t, `${a} is not ${b}`);
try {
  const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - 1); const M = d0.toLocaleDateString('sv').slice(0, 7), first = M + '-01';
  await api('shifts', 'POST', { name: 'Office', code: 'O', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' }); const sh = (await api('shifts')).at(-1).id;
  const mk = async (name, salary) => { const r = await api('employees', 'POST', { name, salary, shift_id: sh, join_date: first }); return { id: r.id, code: (await api('employees')).find(e => e.id === r.id).code }; };
  const A = await mk('Aslam', 30000), B = await mk('Bilqis', 30000);
  await api('logs/import', 'POST', { csv: [`${A.code},${M}-03 09:00`, `${A.code},${M}-03 20:00`, `${B.code},${M}-03 09:00`, `${B.code},${M}-03 18:00`].join('\n') });
  const row = async (c) => (await api('report/payroll?month=' + M)).rows.find(r => r.code === c);
  const before = await row(A.code);
  // the calculator
  assert.ok((await api('payroll/formula-vars')).includes('Basic Salary'));
  assert.equal((await api('payroll/formulas/check', 'POST', { formula: '(Basic Salary + 100) * 2' })).sample, 202);
  for (const [f, re] of [['Basic Salary +', /ends too early/], ['Nonsense * 2', /Unknown name/], ['(Basic Salary', /bracket/]]) assert.match((await api('payroll/formulas/check', 'POST', { formula: f })).error, re);
  assert.equal((await api('payroll/formulas/check', 'POST', { formula: 'Late In / Absence' })).ok, true, 'division by zero is fine, it gives 0');
  // an overtime formula replaces the default overtime pay
  const id = (await api('payroll/formulas', 'POST', { kind: 'overtime', name: 'Double time', pay_code: 'NOT', formula: 'Basic Salary / Schedule Period / 9 * Normal OT * 2', remarks: 'x2' })).id;
  await assert.rejects(api('payroll/formulas', 'POST', { kind: 'overtime', name: 'Double time', pay_code: 'NOT', formula: '1' }), /already exists/); await assert.rejects(api('payroll/formulas', 'POST', { kind: 'overtime', name: 'Bad', pay_code: 'ZZZ', formula: '1' }), /pay code/);
  // formulas apply to the people whose salary structure chooses them
  const days = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate(); assert.equal((await row(A.code)).overtime_pay, before.overtime_pay, 'a formula nobody uses changes nothing');
  await assert.rejects(api('payroll/structure', 'POST', { employee_ids: [A.id], basic: 30000, effective_date: first, f_overtime: 99999 }), /Unknown overtime/); await assert.rejects(api('payroll/structure', 'POST', { employee_ids: [], basic: 30000, effective_date: first }), /at least one/);
  await api('payroll/structure', 'POST', { employee_ids: [A.id], basic: 30000, effective_date: first, f_overtime: id, remarks: 'with formula' });
  const srow = (await api('payroll/structure')).find(x => x.employee_id === A.id); assert.equal(srow.overtime_formula, 'Double time'); assert.equal(srow.remarks, 'with formula'); assert.equal(srow.basic, 30000);
  const after = await row(A.code);
  near(after.overtime_pay, 30000 / days / 9 * 2 * 2, 0.5); assert.ok(Math.abs(after.overtime_pay - before.overtime_pay) > 0.5 || before.overtime_pay === 0);
  assert.equal((await row(B.code)).overtime_pay, 0, 'someone without overtime gets none');
  // an exception formula takes money off
  const exc = (await api('payroll/formulas', 'POST', { kind: 'exception', name: 'Late fine', pay_code: 'L', formula: '100 + Late In' })).id; await api(`payroll/structure/${srow.id}`, 'PUT', { f_exception: exc });
  assert.equal((await api('payroll/structure')).find(x => x.employee_id === A.id).exception_formula, 'Late fine');
  near((await row(A.code)).other_deductions, 100); // 100 plus 0 late minutes
  await api(`payroll/formulas/${id}`, 'PUT', { name: 'Double time', pay_code: 'NOT', formula: 'Normal OT * 0' }); near((await row(A.code)).overtime_pay, 0);
  await api('payroll/formulas/delete', 'POST', { ids: [id] }); assert.equal((await api('payroll/formulas?kind=overtime')).length, 0);
  const incF = await api('payroll/formulas', 'POST', { kind: 'increment', name: 'Attendance bonus', formula: 'Full Attendance * 1000' }); assert.ok(incF.id, 'an increment formula needs no pay code'); await api('payroll/formulas/delete', 'POST', { ids: [incF.id] });
  // a Leave formula takes its amount off the salary of the people whose structure chooses it
  const lf = (await api('payroll/formulas', 'POST', { kind: 'leave', name: 'Leave cut', pay_code: 'AL', formula: '75 + Annual Leave * 10' })).id, dBefore = (await row(A.code)).other_deductions;
  await api(`payroll/structure/${srow.id}`, 'PUT', { f_leave: lf }); near((await row(A.code)).other_deductions, dBefore + 75); await api(`payroll/structure/${srow.id}`, 'PUT', { f_leave: null }); near((await row(A.code)).other_deductions, dBefore);
  // Extra Funds: one amount for several people
  const net0 = (await row(B.code)).net;
  const r1 = await api('payroll/extra', 'POST', { kind: 'increase', employee_ids: [A.id, B.id], amount: 1500, issue_date: `${M}-15`, remarks: 'Eid bonus' }); assert.equal(r1.added, 2);
  near((await row(B.code)).net, net0 + 1500);
  await api('payroll/extra', 'POST', { kind: 'deduction', employee_ids: [B.id], amount: 500, issue_date: `${M}-20` }); near((await row(B.code)).net, net0 + 1000);
  const inc = await api('payroll/extra?kind=increase'), ded = await api('payroll/extra?kind=deduction');
  assert.equal(inc.length, 2); assert.equal(ded.length, 1); assert.equal(inc[0].issue_date, `${M}-15`); assert.equal(ded[0].remarks, null);
  await assert.rejects(api('payroll/extra', 'POST', { kind: 'increase', employee_ids: [], amount: 5, issue_date: `${M}-15` }), /at least one/); await assert.rejects(api('payroll/extra', 'POST', { kind: 'increase', employee_ids: [A.id], amount: 0, issue_date: `${M}-15` }), /amount/);
  await api('payroll/extra/delete', 'POST', { ids: inc.map(x => x.id) }); assert.equal((await api('payroll/extra?kind=increase')).length, 0);
  // Employee Profile and the structure that keeps its formulas through a later revision
  await api(`zkp/employees/${B.id}/extra`, 'PUT', { pay_period: 'Weekly', pay_type: 'Bank Transfer', agent_id: 'AG1', agent_account: 'AC77' }); await api(`employees/${B.id}`, 'PUT', { bank_name: 'HBL', bank_account: 'PK36HBL0000001' });
  const pf = (await api('payroll/profiles')).find(x => x.id === B.id); assert.deepEqual([pf.pay_period, pf.pay_type, pf.bank_name, pf.agent_id, pf.agent_account], ['Weekly', 'Bank Transfer', 'HBL', 'AG1', 'AC77']);
  const keep = await api('payroll/formulas', 'POST', { kind: 'deduction', name: 'Fixed fine', formula: '50' }); await api('payroll/structure', 'POST', { employee_ids: [B.id], basic: 30000, effective_date: first, f_deduction: keep.id });
  await api(`payroll/salary/${B.id}`, 'POST', { effective_from: `${M}-20`, basic: 31000, components: [] }); const rev = (await api('payroll/structure')).filter(x => x.employee_id === B.id).sort((a, b) => b.id - a.id)[0]; assert.equal(rev.basic, 31000); assert.equal(rev.deduction_formula, 'Fixed fine', 'a new salary revision keeps the formulas');
  // Special Payment and Expense Exemption (a yearly amount off the taxed income)
  assert.ok((await api('payroll/special', 'POST', { name: 'Eid bonus', remarks: 'yearly' })).id); await assert.rejects(api('payroll/special', 'POST', { name: 'Eid bonus' }), /already exists/);
  await api('payroll/rates', 'PUT', { settings: { tax_enabled: 1 } }); await api(`payroll/structure`, 'POST', { employee_ids: [A.id], basic: 3000000, effective_date: first });
  const taxBefore = (await row(A.code)).tax; assert.ok(taxBefore > 0, 'a high salary pays tax: ' + taxBefore);
  assert.equal((await api('payroll/exemptions', 'POST', { employee_ids: [A.id], kind: 'Medical', amount: 600000, year: d0.getFullYear(), issued: `${M}-05`, remarks: 'receipts' })).added, 1);
  const taxAfter = (await row(A.code)).tax; assert.ok(taxAfter < taxBefore, `the exemption lowers the tax: ${taxBefore} -> ${taxAfter}`);
  await assert.rejects(api('payroll/exemptions', 'POST', { employee_ids: [A.id], kind: 'X', amount: 0, year: 2026 }), /amount/); const ex = await api('payroll/exemptions'); assert.equal(ex[0].kind, 'Medical');
  await api('payroll/exemptions/delete', 'POST', { ids: [ex[0].id] }); near((await row(A.code)).tax, taxBefore, 0.5);
  console.log('e2e-payformula passed: calculator engine, overtime/exception formulas in payroll, extra increase and deduction');
} finally { S.stop(); }
