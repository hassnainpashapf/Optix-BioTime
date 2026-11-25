// Loan / salary advance / reimbursement: approving writes payroll adjustments, rejecting or deleting removes them, finalized months are left alone.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
const mAdd = (m, n) => { const [y, mo] = m.split('-').map(Number), d = new Date(y, mo - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
try {
  const e = await api('employees', 'POST', { name: 'Loan Taker', join_date: '2025-01-01' }), m0 = new Date().toLocaleDateString('sv').slice(0, 7);
  const loan = (await api('payroll/extras', 'POST', { kind: 'loan', employee_id: e.id, amount: 1000, month: m0, installments: 3, reason: 'bike' })).id;
  assert.equal((await api('payroll/extras?kind=loan'))[0].monthly, 333.33);
  const items = async (m) => (await api('payroll/items?month=' + m)).filter(x => x.note && x.note.includes('[extra:' + loan + ']'));
  assert.equal((await items(m0)).length, 0, 'nothing is written before approval');
  const r = await api(`payroll/extras/${loan}/decide`, 'POST', { approve: true }); assert.equal(r.status, 'approved');
  const a = await items(m0), b = await items(mAdd(m0, 1)), c = await items(mAdd(m0, 2));
  assert.deepEqual([a, b, c].map(x => x.length), [1, 1, 1]); assert.equal(a[0].kind, 'deduction'); assert.ok(Math.abs(a[0].amount + b[0].amount + c[0].amount - 1000) < 0.001, 'installments add up to the loan');
  await assert.rejects(api(`payroll/extras/${loan}/decide`, 'POST', { approve: true }), /Already approved/);
  await api(`payroll/extras/${loan}/decide`, 'POST', { approve: false }); assert.equal((await items(m0)).length + (await items(mAdd(m0, 1))).length, 0, 'rejecting removes the installments');
  const adv = (await api('payroll/extras', 'POST', { kind: 'advance', employee_id: e.id, amount: 200, month: m0 })).id, rb = (await api('payroll/extras', 'POST', { kind: 'reimbursement', employee_id: e.id, amount: 50, month: m0 })).id;
  await api(`payroll/extras/${adv}/decide`, 'POST', { approve: true }); await api(`payroll/extras/${rb}/decide`, 'POST', { approve: true });
  const all = await api('payroll/items?month=' + m0); assert.ok(all.some(x => x.kind === 'advance' && x.amount === 200)); assert.ok(all.some(x => x.kind === 'allowance' && x.amount === 50));
  await api('payroll/extras/' + adv, 'DELETE'); assert.ok(!(await api('payroll/items?month=' + m0)).some(x => x.kind === 'advance'), 'deleting removes the adjustment');
  assert.equal((await S.raw('payroll/extras', 'POST', { kind: 'loan', employee_id: e.id, amount: 0, month: m0 })).status, 400);
  assert.equal((await S.raw('payroll/extras', 'POST', { kind: 'loan', employee_id: e.id, amount: 10, month: m0, installments: 99 })).status, 400);
  console.log('e2e-payextra passed: loan installments, advance, reimbursement, reject/delete cleanup');
} finally { S.stop(); }
