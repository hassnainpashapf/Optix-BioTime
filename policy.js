import express from 'express';
import { db } from './db.js';

// Attendance policy for an employee: their own, else their group's, department's or branch's (in that order), else the global Settings.
// A policy field left empty means "use the global value".
export const POLICY_FIELDS = ['min_gap_min', 'late_to_absent_min', 'half_day_min', 'lates_per_deduction', 'grace_extra_min', 'missing_out_as'];
export function policyResolver(S) {
  const rows = db.prepare('SELECT * FROM att_policies').all(); if (!rows.length) return () => S;
  const pols = new Map(rows.map(p => [p.id, p]));
  const by = (t) => new Map(db.prepare(`SELECT id, att_policy_id FROM ${t} WHERE att_policy_id IS NOT NULL`).all().map(r => [r.id, r.att_policy_id]));
  const dep = by('departments'), grp = by('emp_groups'), br = by('branches'), cache = new Map();
  return (e) => {
    const pid = e.att_policy_id ?? grp.get(e.group_id) ?? dep.get(e.department_id) ?? br.get(e.branch_id), p = pid ? pols.get(pid) : null;
    if (!p) return S;
    if (!cache.has(p.id)) { const o = { ...S, _policy: p.name }; for (const f of POLICY_FIELDS) if (p[f] !== null && p[f] !== undefined) o[f] = p[f]; cache.set(p.id, o); }
    return cache.get(p.id);
  };
}

export const policyRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const TARGETS = { department: 'departments', group: 'emp_groups', branch: 'branches', employee: 'employees' };
function clean(b) {
  const o = { name: String(b.name ?? '').trim().slice(0, 60) }; if (!o.name) return { error: 'Name required' };
  for (const f of ['min_gap_min', 'late_to_absent_min', 'half_day_min', 'lates_per_deduction', 'grace_extra_min']) {
    if (b[f] === undefined || b[f] === null || b[f] === '') { o[f] = null; continue; }
    const v = Number(b[f]); if (!(v >= 0 && v <= 1440)) return { error: `${f.replace(/_/g, ' ')} must be a number from 0 to 1440` }; o[f] = v;
  }
  o.missing_out_as = b.missing_out_as || null; if (o.missing_out_as && !['Missing Out', 'Half Day', 'Absent'].includes(o.missing_out_as)) return { error: 'A missing punch-out can count as Missing Out, Half Day or Absent' };
  return { o };
}
policyRouter.get('/att_policies', (_q, res) => {
  const pols = db.prepare('SELECT * FROM att_policies ORDER BY name').all(), use = (t, col = 'att_policy_id') => db.prepare(`SELECT id, name, ${col} AS pid FROM ${t} WHERE ${col} IS NOT NULL`).all();
  const assigned = [...use('departments').map(r => ({ ...r, type: 'department' })), ...use('emp_groups').map(r => ({ ...r, type: 'group' })), ...use('branches').map(r => ({ ...r, type: 'branch' })), ...use('employees').map(r => ({ ...r, type: 'employee' }))];
  res.json(pols.map(p => ({ ...p, assigned: assigned.filter(a => a.pid === p.id).map(({ type, id, name }) => ({ type, id, name })) })));
});
policyRouter.post('/att_policies', (req, res) => {
  const { o, error } = clean(req.body ?? {}); if (error) return fail(res, error);
  try { const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO att_policies(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); } catch { fail(res, 'A policy with this name exists'); }
});
policyRouter.put('/att_policies/:id', (req, res) => {
  if (!db.prepare('SELECT 1 FROM att_policies WHERE id=?').get(req.params.id)) return fail(res, 'No such policy', 404);
  const { o, error } = clean(req.body ?? {}); if (error) return fail(res, error);
  try { const c = Object.keys(o); db.prepare(`UPDATE att_policies SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true }); } catch { fail(res, 'A policy with this name exists'); }
});
policyRouter.delete('/att_policies/:id', (req, res) => {
  for (const t of Object.values(TARGETS)) db.prepare(`UPDATE ${t} SET att_policy_id=NULL WHERE att_policy_id=?`).run(req.params.id);
  db.prepare('DELETE FROM att_policies WHERE id=?').run(req.params.id); res.json({ ok: true });
});
// Attach a policy to a department/group/branch/employee (policy_id null removes it).
policyRouter.post('/att_policies/assign', (req, res) => {
  const { type, target_id, policy_id } = req.body ?? {}, t = TARGETS[type]; if (!t) return fail(res, 'Choose department, group, branch or employee');
  if (!db.prepare(`SELECT 1 FROM ${t} WHERE id=?`).get(target_id)) return fail(res, 'Unknown target');
  if (policy_id && !db.prepare('SELECT 1 FROM att_policies WHERE id=?').get(policy_id)) return fail(res, 'Unknown policy');
  db.prepare(`UPDATE ${t} SET att_policy_id=? WHERE id=?`).run(policy_id || null, target_id); res.json({ ok: true });
});
// What rules apply to one employee, and why.
policyRouter.get('/att_policies/for/:empId', (req, res) => {
  const e = db.prepare('SELECT id, att_policy_id, group_id, department_id, branch_id FROM employees WHERE id=?').get(req.params.empId); if (!e) return fail(res, 'No such employee', 404);
  const get = (t, id, col = 'att_policy_id') => id ? db.prepare(`SELECT ${col} AS p FROM ${t} WHERE id=?`).get(id)?.p : null;
  const via = e.att_policy_id ? 'the employee' : get('emp_groups', e.group_id) ? 'the group' : get('departments', e.department_id) ? 'the department' : get('branches', e.branch_id) ? 'the branch' : null;
  const pid = e.att_policy_id ?? get('emp_groups', e.group_id) ?? get('departments', e.department_id) ?? get('branches', e.branch_id);
  res.json({ policy: pid ? db.prepare('SELECT * FROM att_policies WHERE id=?').get(pid) : null, via });
});
