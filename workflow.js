import express from 'express';
import { db } from './db.js';
import { notify, notifyManager } from './notify.js';
import { scopeClause } from './rbac.js';

// Approval workflows: a request type can need several approvers in turn (manager, then HR, then an admin...).
// Steps: { who: 'manager' | 'admin' | 'role:<role>' | 'user:<username>', min_days? (leave only: the step applies from this many days) }
export const KINDS = {
  leave: { label: 'Leave requests', table: 'leaves', notice: 'leave_request', done: 'leave_decision', title: (q) => `${q.type} leave, ${q.from_date} to ${q.to_date}` },
  attendance: { label: 'Attendance requests', table: 'attendance_requests', notice: 'attendance_request', done: 'request_decision', title: (q) => `${q.kind === 'add_punch' ? 'Add punch ' + (q.time ?? '') : q.status_text} on ${q.date}` },
  shift: { label: 'Shift change and swap requests', table: 'shift_requests', notice: 'shift_request', done: 'shift_decision', title: (q) => `Shift ${q.kind}, ${q.from_date}` },
  overtime: { label: 'Overtime', table: 'overtime_requests', notice: 'approval', done: 'overtime_decision', title: (q) => `Overtime on ${q.date} (${q.calc_minutes} min)` },
};
const stamp = () => new Date().toLocaleString('sv');
const whoLabel = (st) => st.label || (st.who.startsWith('wrole:') ? `the ${db.prepare('SELECT name FROM wf_roles WHERE code=?').get(st.who.slice(6))?.name ?? st.who.slice(6)} group` : st.who === 'manager' ? 'the manager' : st.who === 'admin' ? 'an admin' : st.who.startsWith('role:') ? `the ${st.who.slice(5)} role` : st.who.startsWith('user:') ? st.who.slice(5) : st.who);
let advance = null; // what the last approval did, for the screen to show
export const takeAdvance = () => { const a = advance; advance = null; return a ?? {}; };

const emp = (id) => db.prepare('SELECT id, code, name, manager_id FROM employees WHERE id=?').get(id);
// Can this actor decide at this step? Admins can decide any step (so a request never gets stuck); automation rules are explicit overrides.
export function eligible(actor, step, employeeId) {
  if (String(actor).startsWith('automation:')) return true;
  if (String(actor).startsWith('emp:')) { const me = db.prepare('SELECT id FROM employees WHERE code=?').get(String(actor).slice(4)); if (step.who.startsWith('wrole:')) return !!me && !!db.prepare('SELECT 1 FROM wf_role_members m JOIN wf_roles r ON r.id=m.role_id WHERE r.code=? AND m.employee_id=?').get(step.who.slice(6), me.id); return step.who === 'manager' && !!me && emp(employeeId)?.manager_id === me.id; }
  const u = db.prepare('SELECT username, role FROM users WHERE username=?').get(actor); if (!u) return false;
  if (u.role === 'admin') return true;
  return step.who.startsWith('wrole:') ? false : step.who === 'manager' ? u.role === 'manager' : step.who === 'admin' ? false : step.who.startsWith('role:') ? u.role === step.who.slice(5) : step.who.startsWith('user:') ? u.username === step.who.slice(5) : false;
}
const applies = (kind, st, q, employeeId) => {
  if (st.who === 'manager' && !emp(employeeId)?.manager_id) return false; // nobody to ask: the step is skipped
  if (kind === 'leave' && st.min_days && !(Number(q.days) >= st.min_days)) return false;
  return true;
};
// A builder rule beats the general workflow: the person's own rule, then their position's, then their department's (for the request's date).
function ruleFor(kind, q) {
  const e = db.prepare('SELECT id, department_id, designation_id FROM employees WHERE id=?').get(q.employee_id); if (!e) return null;
  const day = String(q.date ?? q.from_date ?? new Date().toLocaleDateString('sv')).slice(0, 10);
  for (const [scope, id] of [['employee', e.id], ['position', e.designation_id], ['department', e.department_id]]) {
    if (!id) continue;
    const r = db.prepare("SELECT * FROM wf_rules WHERE kind=? AND scope=? AND target_id=? AND enabled=1 AND (start_date IS NULL OR start_date<=?) AND (end_date IS NULL OR end_date>=?) ORDER BY id DESC").get(kind, scope, id, day, day); if (r) return r;
  }
  return null;
}
const load = (kind, id) => { const r = db.prepare('SELECT * FROM wf_progress WHERE kind=? AND ref_id=?').get(kind, id); return r ? { ...r, steps: JSON.parse(r.steps), history: JSON.parse(r.history) } : null; };
function start(kind, q) { // the steps that apply to this request are fixed now, so editing the workflow later does not disturb requests in flight
  const wf = ruleFor(kind, q) ?? db.prepare('SELECT * FROM workflows WHERE kind=? AND enabled=1').get(kind); if (!wf) return null;
  const steps = JSON.parse(wf.steps).filter(st => applies(kind, st, q, q.employee_id));
  db.prepare('INSERT OR IGNORE INTO wf_progress(kind, ref_id, idx, steps) VALUES(?,?,?,?)').run(kind, q.id, steps.length ? 0 : null, JSON.stringify(steps)); return load(kind, q.id);
}
const save = (kind, id, idx, history) => db.prepare('UPDATE wf_progress SET idx=?, history=? WHERE kind=? AND ref_id=?').run(idx, JSON.stringify(history), kind, id);
export const progressOf = (kind, q) => { const p = load(kind, q.id) ?? (q.status === 'pending' ? start(kind, q) : null); return p; };

// Called before a request is approved or rejected. { proceed } = decide for real now; { advanced } = this step is done, the request moves on; { error } = not allowed.
export function gate(kind, q, action, actor, note) {
  const p = progressOf(kind, q); if (!p || p.idx === null) return { proceed: true };
  const step = p.steps[p.idx], n = p.steps.length;
  if (!eligible(actor, step, q.employee_id)) return { error: `This request is waiting for ${whoLabel(step)} (step ${p.idx + 1} of ${n}). It is not yours to decide.` };
  const hist = [...p.history, { step: p.idx + 1, who: whoLabel(step), by: actor, at: stamp(), action, note: note ?? null }];
  if (action === 'reject' || String(actor).startsWith('automation:')) { save(kind, q.id, null, hist); return { proceed: true }; }
  if (p.idx + 1 >= n) { save(kind, q.id, null, hist); return { proceed: true }; }
  const next = p.steps[p.idx + 1]; save(kind, q.id, p.idx + 1, hist);
  const k = KINDS[kind], e = emp(q.employee_id), what = `${e?.name}: ${k.title(q)}`;
  if (next.who.startsWith('wrole:')) for (const m of db.prepare('SELECT m.employee_id FROM wf_role_members m JOIN wf_roles r ON r.id=m.role_id WHERE r.code=?').all(next.who.slice(6))) notify({ audience: 'employee', employee_id: m.employee_id, title: `Your approval is needed: ${e?.name}`, body: what, kind: 'approval' });
  if (next.who === 'manager') notifyManager(q.employee_id, `Your approval is needed: ${e?.name}`, what, 'Team', 'approval'); else notify({ title: `Waiting for ${whoLabel(next)}: ${e?.name}`, body: what, link: 'Approvals', kind: 'approval', employee_id: q.employee_id });
  notify({ audience: 'employee', employee_id: q.employee_id, title: `Your request passed step ${p.idx + 1} of ${n}`, body: `${k.title(q)}. Now waiting for ${whoLabel(next)}.`, kind: k.done });
  advance = { advanced: true, step: p.idx + 2, of: n, waiting_for: whoLabel(next) };
  return { advanced: true };
}
// Is this request, right now, waiting for the employee's reporting manager? (the portal only shows the manager what is theirs to decide)
export function waitingOnManager(kind, q) {
  const p = progressOf(kind, q); if (!p || p.idx === null) return true;
  return p.steps[p.idx].who === 'manager';
}

// ---------- screens ----------
export const workflowRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
workflowRouter.get('/workflow', (_q, res) => {
  const rows = new Map(db.prepare('SELECT * FROM workflows').all().map(r => [r.kind, r]));
  res.json({ kinds: Object.entries(KINDS).map(([kind, k]) => ({ kind, label: k.label, enabled: !!rows.get(kind)?.enabled, steps: JSON.parse(rows.get(kind)?.steps ?? '[]') })), roles: db.prepare('SELECT name FROM roles ORDER BY name').all().map(r => r.name), users: db.prepare('SELECT username FROM users ORDER BY username').all().map(r => r.username) });
});
workflowRouter.put('/workflow/:kind', (req, res) => {
  const kind = req.params.kind; if (!KINDS[kind]) return fail(res, 'Unknown request type', 404);
  const b = req.body ?? {}, steps = [];
  if (!Array.isArray(b.steps) || b.steps.length > 6) return fail(res, 'Give 0 to 6 steps');
  for (const s of b.steps) {
    const who = String(s.who ?? ''); const ok = who === 'manager' || who === 'admin' || (who.startsWith('role:') && db.prepare('SELECT 1 FROM roles WHERE name=?').get(who.slice(5))) || (who.startsWith('user:') && db.prepare('SELECT 1 FROM users WHERE username=?').get(who.slice(5))) || (who.startsWith('wrole:') && db.prepare('SELECT 1 FROM wf_roles WHERE code=?').get(who.slice(6)));
    if (!ok) return fail(res, `Unknown approver "${who}"`);
    const st = { who }; if (s.label) st.label = String(s.label).slice(0, 40);
    if (kind === 'leave' && s.min_days !== undefined && s.min_days !== '' && s.min_days !== null) { const n = Number(s.min_days); if (!(n >= 0.5 && n <= 365)) return fail(res, 'Days must be a number from 0.5 to 365'); st.min_days = n; }
    steps.push(st);
  }
  if (b.enabled && !steps.length) return fail(res, 'Add at least one step before switching the workflow on');
  db.prepare('INSERT INTO workflows(kind, enabled, steps) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET enabled=excluded.enabled, steps=excluded.steps').run(kind, b.enabled ? 1 : 0, JSON.stringify(steps)); res.json({ ok: true });
});
// ---------- workflow roles ----------
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
workflowRouter.get('/workflow/roles', (_q, res) => res.json(db.prepare('SELECT r.*, (SELECT COUNT(*) FROM wf_role_members m WHERE m.role_id=r.id) AS employees FROM wf_roles r ORDER BY r.code').all()));
workflowRouter.post('/workflow/roles', (req, res) => {
  const code = txt(req.body?.code, 20), name = txt(req.body?.name, 60); if (!code || !name) return fail(res, 'Code and name are required');
  try { res.json({ id: Number(db.prepare('INSERT INTO wf_roles(code, name, description) VALUES(?,?,?)').run(code, name, txt(req.body?.description, 200)).lastInsertRowid) }); } catch { fail(res, 'This code is already used'); }
});
workflowRouter.put('/workflow/roles/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM wf_roles WHERE id=?').get(req.params.id); if (!r) return fail(res, 'No such role', 404); const b = req.body ?? {};
  const code = txt(b.code ?? r.code, 20), name = txt(b.name ?? r.name, 60); if (!code || !name) return fail(res, 'Code and name are required');
  if (code !== r.code && db.prepare("SELECT 1 FROM wf_rules WHERE steps LIKE ?").get(`%"wrole:${r.code}"%`)) return fail(res, 'Workflow steps use this code, so it cannot change');
  try { db.prepare('UPDATE wf_roles SET code=?, name=?, description=? WHERE id=?').run(code, name, 'description' in b ? txt(b.description, 200) : r.description, r.id); res.json({ ok: true }); } catch { fail(res, 'This code is already used'); }
});
const roleUsed = (code) => db.prepare("SELECT 1 FROM wf_rules WHERE steps LIKE ?").get(`%"wrole:${code}"%`) || db.prepare("SELECT 1 FROM workflows WHERE steps LIKE ?").get(`%"wrole:${code}"%`);
workflowRouter.delete('/workflow/roles/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM wf_roles WHERE id=?').get(req.params.id); if (!r) return fail(res, 'No such role', 404); if (roleUsed(r.code)) return fail(res, 'A workflow still uses this role. Change the workflow first.');
  db.prepare('DELETE FROM wf_roles WHERE id=?').run(r.id); res.json({ ok: true });
});
workflowRouter.get('/workflow/roles/:id/members', (req, res) => { const sc = scopeClause('e'); res.json(db.prepare(`SELECT e.id, e.code, e.name, e.last_name, d.name AS dept, p.name AS position FROM wf_role_members m JOIN employees e ON e.id=m.employee_id LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations p ON p.id=e.designation_id WHERE m.role_id=?${sc.sql} ORDER BY e.code`).all(req.params.id, ...sc.args)); });
workflowRouter.post('/workflow/roles/:id/members', (req, res) => {
  if (!db.prepare('SELECT 1 FROM wf_roles WHERE id=?').get(req.params.id)) return fail(res, 'No such role', 404); const ids = [...new Set((req.body?.employee_ids ?? []).map(Number))]; if (!ids.length) return fail(res, 'Choose at least one employee'); let added = 0;
  for (const id of ids.slice(0, 500)) if (db.prepare('SELECT 1 FROM employees WHERE id=?').get(id)) added += Number(db.prepare('INSERT OR IGNORE INTO wf_role_members(role_id, employee_id) VALUES(?,?)').run(req.params.id, id).changes);
  res.json({ added });
});
workflowRouter.delete('/workflow/roles/:id/members/:emp', (req, res) => { db.prepare('DELETE FROM wf_role_members WHERE role_id=? AND employee_id=?').run(req.params.id, req.params.emp); res.json({ ok: true }); });

// ---------- workflow builder: a workflow for a department, a position or one person ----------
const SCOPES = { department: 'departments', position: 'designations', employee: 'employees' };
const ruleRows = () => db.prepare('SELECT * FROM wf_rules ORDER BY id DESC').all().map(r => ({ ...r, steps: JSON.parse(r.steps), kind_label: KINDS[r.kind]?.label, target: db.prepare(`SELECT ${r.scope === 'employee' ? "code || ' - ' || name" : 'name'} AS n FROM ${SCOPES[r.scope]} WHERE id=?`).get(r.target_id)?.n ?? '(removed)', workflow: JSON.parse(r.steps).map(whoLabel).join(' > ') }));
workflowRouter.get('/workflow/rules', (_q, res) => res.json(ruleRows()));
function cleanRule(b) {
  const code = txt(b.code, 20), name = txt(b.name, 60); if (!code || !name) return { error: 'Code and name are required' };
  if (!SCOPES[b.scope]) return { error: 'Choose department, position or employee' }; const target = Number(b.target_id); if (!db.prepare(`SELECT 1 FROM ${SCOPES[b.scope]} WHERE id=?`).get(target)) return { error: 'Choose who the rule is for' };
  if (!KINDS[b.kind]) return { error: 'Choose the content type' }; const D = /^\d{4}-\d\d-\d\d$/; for (const k of ['start_date', 'end_date']) if (b[k] && !D.test(b[k])) return { error: 'Dates must be YYYY-MM-DD' };
  if (b.start_date && b.end_date && b.end_date < b.start_date) return { error: 'The end date is before the start date' };
  if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length > 6) return { error: 'Give 1 to 6 approval steps' };
  const steps = []; for (const s of b.steps) { const who = String(s.who ?? ''); const ok = who === 'manager' || who === 'admin' || (who.startsWith('role:') && db.prepare('SELECT 1 FROM roles WHERE name=?').get(who.slice(5))) || (who.startsWith('wrole:') && db.prepare('SELECT 1 FROM wf_roles WHERE code=?').get(who.slice(6))); if (!ok) return { error: `Unknown approver "${who}"` }; steps.push({ who }); }
  return { o: { code, name, scope: b.scope, target_id: target, start_date: b.start_date || null, end_date: b.end_date || null, kind: b.kind, steps: JSON.stringify(steps), enabled: b.enabled === false ? 0 : 1 } };
}
workflowRouter.post('/workflow/rules', (req, res) => { const { o, error } = cleanRule(req.body ?? {}); if (error) return fail(res, error); const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO wf_rules(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); });
workflowRouter.put('/workflow/rules/:id', (req, res) => { if (!db.prepare('SELECT 1 FROM wf_rules WHERE id=?').get(req.params.id)) return fail(res, 'No such rule', 404); const { o, error } = cleanRule(req.body ?? {}); if (error) return fail(res, error); const c = Object.keys(o); db.prepare(`UPDATE wf_rules SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), req.params.id); res.json({ ok: true }); });
workflowRouter.delete('/workflow/rules/:id', (req, res) => { db.prepare('DELETE FROM wf_rules WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// What is waiting for me: every pending request whose current step I may decide (admins see everything), with its history.
workflowRouter.get('/workflow/inbox', (req, res) => {
  const sc = scopeClause('e'), out = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const on = db.prepare('SELECT 1 FROM workflows WHERE kind=? AND enabled=1').get(kind) || db.prepare('SELECT 1 FROM wf_rules WHERE kind=? AND enabled=1').get(kind); if (!on) continue;
    const extra = kind === 'overtime' ? " AND q.kind='auto'" : '';
    for (const q of db.prepare(`SELECT q.* FROM ${k.table} q JOIN employees e ON e.id=q.employee_id WHERE q.status='pending'${extra}${sc.sql} ORDER BY q.id LIMIT 200`).all(...sc.args)) {
      const p = progressOf(kind, q); if (!p || p.idx === null) continue; const step = p.steps[p.idx];
      out.push({ kind, id: q.id, employee: emp(q.employee_id)?.name, what: k.title(q), step: p.idx + 1, of: p.steps.length, waiting_for: whoLabel(step), mine: eligible(req.user, step, q.employee_id), history: p.history });
    }
  }
  res.json(out);
});
