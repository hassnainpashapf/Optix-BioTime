// Workflow roles and builder rules, certification types, custom attribute switches, employee ID settings.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api;
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
try {
  await api('leave_types', 'POST', { name: 'Errand', paid: 1, quota: 0, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 });
  const dep = (await api('departments', 'POST', { name: 'Sales' })).id, dep2 = (await api('departments', 'POST', { name: 'Ops' })).id;
  const mk = (name, extra = {}) => api('employees', 'POST', { name, join_date: '2025-01-01', ...extra });
  const A = await mk('Amna Sales', { department_id: dep }), B = await mk('Bilal Ops', { department_id: dep2 }), H = await mk('Hina Approver');

  // ---- workflow roles
  await assert.rejects(api('workflow/roles', 'POST', { code: '', name: 'x' }), /required/);
  const role = (await api('workflow/roles', 'POST', { code: 'HR1', name: 'HR Approvers', description: 'first line' })).id;
  await assert.rejects(api('workflow/roles', 'POST', { code: 'HR1', name: 'dup' }), /already used/);
  assert.equal((await api(`workflow/roles/${role}/members`, 'POST', { employee_ids: [H.id] })).added, 1); assert.equal((await api(`workflow/roles/${role}/members`, 'POST', { employee_ids: [H.id] })).added, 0);
  await assert.rejects(api(`workflow/roles/${role}/members`, 'POST', { employee_ids: [] }), /at least one/);
  assert.equal((await api('workflow/roles')).find(r => r.id === role).employees, 1);
  const member = (await api(`workflow/roles/${role}/members`))[0];
  assert.equal(member.name, 'Hina Approver');
  assert.ok(Object.hasOwn(member, 'last_name') && Object.hasOwn(member, 'position'));

  // ---- builder rules
  const rule = { code: 'R1', name: 'Sales leave', scope: 'department', target_id: dep, kind: 'leave', steps: [{ who: 'wrole:HR1' }, { who: 'admin' }], start_date: day(-5), end_date: day(60) };
  await assert.rejects(api('workflow/rules', 'POST', { ...rule, scope: 'x' }), /department, position or employee/); await assert.rejects(api('workflow/rules', 'POST', { ...rule, kind: 'zzz' }), /content type/);
  await assert.rejects(api('workflow/rules', 'POST', { ...rule, steps: [{ who: 'wrole:NOPE' }] }), /Unknown approver/); await assert.rejects(api('workflow/rules', 'POST', { ...rule, end_date: day(-9) }), /end date/);
  const rid = (await api('workflow/rules', 'POST', rule)).id; const rr = (await api('workflow/rules')).find(r => r.id === rid); assert.equal(rr.target, 'Sales'); assert.match(rr.workflow, /HR Approvers group > an admin/);
  await assert.rejects(api(`workflow/roles/${role}`, 'DELETE'), /still uses this role/);
  // the rule applies to Sales only: Amna's leave waits for the HR group, Bilal's has no workflow
  await api('leaves', 'POST', { employee_id: A.id, type: 'Errand', from_date: day(3), to_date: day(3) }); await api('leaves', 'POST', { employee_id: B.id, type: 'Errand', from_date: day(4), to_date: day(4) });
  const inbox = await api('workflow/inbox'); assert.equal(inbox.length, 1); assert.match(inbox[0].waiting_for, /HR Approvers group/); assert.equal(inbox[0].employee, 'Amna Sales');
  await api(`workflow/rules/${rid}`, 'PUT', { ...rule, enabled: false }); await api('workflow/rules/' + rid, 'DELETE'); assert.equal((await api('workflow/rules')).length, 0);
  await api(`workflow/roles/${role}/members/${H.id}`, 'DELETE'); assert.equal((await api(`workflow/roles/${role}/members`)).length, 0); await api('workflow/roles/' + role, 'DELETE');

  // ---- documents (certification types)
  const c1 = (await api('org/certifications', 'POST', { code: 'DL', name: 'Driving licence' })).id; await assert.rejects(api('org/certifications', 'POST', { code: 'DL', name: 'x' }), /already used/);
  assert.deepEqual(await api('org/certifications/import', 'POST', { csv: 'code,name\nPP,Passport\nDL,Again\n' }), { added: 1, skipped: 1 }); await api('org/certifications/' + c1, 'PUT', { code: 'DL', name: 'Driving license' });
  assert.equal((await api('org/certifications')).length, 2); await api('org/certifications/' + c1, 'DELETE'); assert.equal((await api('org/certifications')).length, 1);

  // ---- custom attributes: unique and enable
  const cf = (await api('custom_fields', 'POST', { label: 'Badge', type: 'text' })).id; await api('org/custom-attributes/' + cf, 'PUT', { uniq: true });
  const E1 = await mk('Cf One', { custom: { [cf]: 'X1' } }); await assert.rejects(mk('Cf Two', { custom: { [cf]: 'X1' } }), /already used/); await api('employees/' + E1.id, 'PUT', { custom: { [cf]: 'X1' } });
  await api('org/custom-attributes/' + cf, 'PUT', { enabled: false }); await mk('Cf Three', { custom: { [cf]: 'X1' } }); assert.equal((await api('custom_fields')).find(f => f.id === cf).enabled, 0);

  // ---- employee ID setting
  await api('settings', 'PUT', { emp_id_numeric: 1 }); await assert.rejects(api('employees', 'POST', { name: 'Letters', code: 'AB12', join_date: '2025-01-01' }), /must be numbers/); await mk('Num', { code: '9001' });
  await api('settings', 'PUT', { emp_id_ordered: 1 }); await assert.rejects(api('employees', 'POST', { name: 'Skip', code: '9500', join_date: '2025-01-01' }), /next employee ID must be 9002/); await mk('Seq', { code: '9002' }); await mk('Auto');
  console.log('e2e-wfrole passed: workflow roles, builder rules overriding the general workflow, documents, custom attribute switches, employee ID settings');
} finally { await S.stop(); }
