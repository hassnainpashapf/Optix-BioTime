import express from 'express';
import { db } from './db.js';
import { parseCsv } from './csv.js';
import { dateStr } from './dates.js';
import { scopeClause } from './rbac.js';

// Organization structure with codes, a department tree, quantities and bulk personnel transfer.
db.exec('SELECT 1');
for (const [t, c, d] of [['departments', 'code', 'TEXT'], ['departments', 'parent_id', 'INTEGER'], ['designations', 'code', 'TEXT'], ['designations', 'parent_id', 'INTEGER'], ['branches', 'code', 'TEXT']])
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);

export const orgRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const qty = (col) => `(SELECT COUNT(*) FROM employees e WHERE e.${col}=x.id AND e.active=1) AS employees, (SELECT COUNT(*) FROM employees e WHERE e.${col}=x.id AND e.active=0) AS resigned`;

// ---------- departments ----------
const deptRows = () => db.prepare(`SELECT x.id, x.code, x.name, x.parent_id, x.shift_id, p.name AS superior, s.name AS shift, ${qty('department_id')} FROM departments x LEFT JOIN departments p ON p.id=x.parent_id LEFT JOIN shifts s ON s.id=x.shift_id ORDER BY COALESCE(x.code, ''), x.name`).all();
orgRouter.get('/org/departments', (_q, res) => res.json(deptRows()));
function cleanDept(b, id) {
  const o = {}; if ('name' in b) { o.name = txt(b.name, 80); if (!o.name) return { error: 'Name required' }; }
  if ('code' in b) { o.code = txt(b.code, 20); if (o.code && db.prepare('SELECT 1 FROM departments WHERE code=? AND id IS NOT ?').get(o.code, id ?? null)) return { error: `The code ${o.code} is already used by another department` }; }
  if ('shift_id' in b) { o.shift_id = b.shift_id ? Number(b.shift_id) : null; if (o.shift_id && !db.prepare('SELECT 1 FROM shifts WHERE id=?').get(o.shift_id)) return { error: 'Unknown shift' }; }
  if ('parent_id' in b) {
    o.parent_id = b.parent_id ? Number(b.parent_id) : null;
    if (o.parent_id) {
      if (!db.prepare('SELECT 1 FROM departments WHERE id=?').get(o.parent_id)) return { error: 'Unknown superior department' };
      for (let p = o.parent_id, n = 0; p && n < 50; n++) { if (p === id) return { error: 'A department cannot sit under itself or one of its own sub-departments' }; p = db.prepare('SELECT parent_id FROM departments WHERE id=?').get(p)?.parent_id; }
    }
  }
  return { o };
}
orgRouter.post('/org/departments', (req, res) => {
  const { o, error } = cleanDept({ name: '', ...req.body }, null); if (error) return fail(res, error);
  try { const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO departments(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); } catch { fail(res, 'A department with this name exists'); }
});
orgRouter.put('/org/departments/:id', (req, res) => {
  const id = Number(req.params.id); if (!db.prepare('SELECT 1 FROM departments WHERE id=?').get(id)) return fail(res, 'No such department', 404);
  const { o, error } = cleanDept(req.body ?? {}, id); if (error) return fail(res, error); const c = Object.keys(o); if (!c.length) return res.json({ ok: true });
  try { db.prepare(`UPDATE departments SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), id); res.json({ ok: true }); } catch { fail(res, 'A department with this name exists'); }
});
orgRouter.delete('/org/departments/:id', (req, res) => {
  const id = Number(req.params.id), d = db.prepare('SELECT name FROM departments WHERE id=?').get(id); if (!d) return fail(res, 'No such department', 404);
  const n = db.prepare('SELECT COUNT(*) n FROM employees WHERE department_id=?').get(id).n; if (n) return fail(res, `${d.name} still has ${n} employee${n === 1 ? '' : 's'} (resigned ones count). Transfer them first.`);
  if (db.prepare('SELECT 1 FROM departments WHERE parent_id=?').get(id)) return fail(res, `${d.name} has sub-departments. Move or delete them first.`);
  db.prepare('DELETE FROM departments WHERE id=?').run(id); res.json({ ok: true });
});
// Nested view for the tree on the right.
orgRouter.get('/org/tree', (_q, res) => {
  const rows = deptRows(), by = new Map(rows.map(r => [r.id, { ...r, children: [] }])), roots = [];
  for (const r of by.values()) { const p = r.parent_id && by.get(r.parent_id); (p ? p.children : roots).push(r); }
  const total = (n) => n.employees + n.children.reduce((a, c) => a + total(c), 0);
  const fill = (n) => { n.children.forEach(fill); n.total = total(n); }; roots.forEach(fill);
  res.json(roots);
});
// code,name,superior_code  (header row optional; the superior may also be given by name)
orgRouter.post('/org/departments/import', (req, res) => {
  let rows = parseCsv(String(req.body?.csv ?? '')); if (!rows.length) return fail(res, 'Paste a CSV with code, name and (optionally) the superior\'s code');
  if (/^code$/i.test((rows[0][0] ?? '').trim()) || /^name$/i.test((rows[0][1] ?? '').trim())) rows = rows.slice(1);
  if (rows.length > 1000) return fail(res, 'At most 1000 departments at a time');
  let added = 0, skipped = 0; const errors = [], pending = [];
  rows.forEach((r, i) => {
    const code = txt(r[0], 20), name = txt(r[1], 80), sup = txt(r[2], 80), line = i + 1;
    if (!name) { errors.push({ line, error: 'Name required' }); return; }
    if (db.prepare('SELECT 1 FROM departments WHERE name=? OR (code IS NOT NULL AND code=?)').get(name, code)) { skipped++; return; }
    try { const id = Number(db.prepare('INSERT INTO departments(code, name) VALUES(?,?)').run(code, name).lastInsertRowid); added++; if (sup) pending.push({ id, sup, line }); } catch (e) { errors.push({ line, error: e.message }); }
  });
  for (const p of pending) { // superiors can be defined later in the same file, so link them after everything exists
    const parent = db.prepare('SELECT id FROM departments WHERE code=? OR name=?').get(p.sup, p.sup);
    if (!parent || parent.id === p.id) errors.push({ line: p.line, error: `Superior "${p.sup}" not found` }); else db.prepare('UPDATE departments SET parent_id=? WHERE id=?').run(parent.id, p.id);
  }
  res.json({ added, skipped, errors: errors.slice(0, 50) });
});
// Move people from one department to another (everyone active in the source, or only the chosen ones), with a history entry for each.
orgRouter.post('/org/transfer', (req, res) => {
  const b = req.body ?? {}, from = b.from_department_id ? Number(b.from_department_id) : null, to = Number(b.to_department_id), date = b.date || dateStr(new Date());
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  const dest = db.prepare('SELECT id, name FROM departments WHERE id=?').get(to); if (!dest) return fail(res, 'Choose the department to move people into');
  const sc = scopeClause('e'); let ids;
  if (Array.isArray(b.employee_ids) && b.employee_ids.length) ids = b.employee_ids.map(Number).slice(0, 2000);
  else if (from) ids = db.prepare(`SELECT e.id FROM employees e WHERE e.department_id=? AND e.active=1${sc.sql}`).all(from, ...sc.args).map(r => r.id);
  else return fail(res, 'Choose the department to move people out of, or pick the people');
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const e = db.prepare(`SELECT e.id, e.department_id, d.name AS dept FROM employees e LEFT JOIN departments d ON d.id=e.department_id WHERE e.id=?${sc.sql}`).get(id, ...sc.args); if (!e || e.department_id === to) continue;
      db.prepare('UPDATE employees SET department_id=? WHERE id=?').run(to, id);
      db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(id, 'transfer', date, JSON.stringify({ department: { from: e.dept, to: dest.name }, note: txt(b.note, 200) ?? '' }), req.user); moved++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return fail(res, e.message); }
  res.json({ moved });
});

// ---------- documents (certification types) and custom attribute switches ----------
orgRouter.get('/org/certifications', (_q, res) => res.json(db.prepare('SELECT * FROM cert_types ORDER BY code').all()));
orgRouter.post('/org/certifications', (req, res) => {
  const code = txt(req.body?.code, 20), name = txt(req.body?.name, 80); if (!code || !name) return fail(res, 'Code and name are required');
  try { res.json({ id: Number(db.prepare('INSERT INTO cert_types(code, name) VALUES(?,?)').run(code, name).lastInsertRowid) }); } catch { fail(res, 'This code is already used'); }
});
orgRouter.put('/org/certifications/:id', (req, res) => {
  const code = txt(req.body?.code, 20), name = txt(req.body?.name, 80); if (!code || !name) return fail(res, 'Code and name are required');
  try { const r = db.prepare('UPDATE cert_types SET code=?, name=? WHERE id=?').run(code, name, req.params.id); r.changes ? res.json({ ok: true }) : fail(res, 'Not found', 404); } catch { fail(res, 'This code is already used'); }
});
orgRouter.delete('/org/certifications/:id', (req, res) => { db.prepare('DELETE FROM cert_types WHERE id=?').run(req.params.id); res.json({ ok: true }); });
orgRouter.post('/org/certifications/import', (req, res) => {
  let rows = parseCsv(String(req.body?.csv ?? '')); if (!rows.length) return fail(res, 'Paste a CSV with code and name'); if (/^code$/i.test((rows[0][0] ?? '').trim())) rows = rows.slice(1); let added = 0, skipped = 0;
  for (const r of rows.slice(0, 1000)) { const code = txt(r[0], 20), name = txt(r[1], 80); if (!code || !name || db.prepare('SELECT 1 FROM cert_types WHERE code=?').get(code)) { skipped++; continue; } db.prepare('INSERT INTO cert_types(code, name) VALUES(?,?)').run(code, name); added++; }
  res.json({ added, skipped });
});
orgRouter.put('/org/custom-attributes/:id', (req, res) => {
  const b = req.body ?? {}; if (!db.prepare('SELECT 1 FROM custom_fields WHERE id=?').get(req.params.id)) return fail(res, 'Not found', 404);
  if ('uniq' in b) db.prepare('UPDATE custom_fields SET uniq=? WHERE id=?').run(b.uniq ? 1 : 0, req.params.id); if ('enabled' in b) db.prepare('UPDATE custom_fields SET enabled=? WHERE id=?').run(b.enabled ? 1 : 0, req.params.id); res.json({ ok: true });
});

// ---------- positions (designations) and areas (branches) ----------
orgRouter.get('/org/positions-tree', (_q, res) => {
  const rows = db.prepare("SELECT x.id, x.name, x.parent_id, (SELECT COUNT(*) FROM employees e WHERE e.designation_id=x.id AND e.active=1) AS own FROM designations x ORDER BY COALESCE(x.code,''), x.name").all(), by = new Map(rows.map(r => [r.id, { ...r, children: [] }]));
  const top = []; for (const n of by.values()) (n.parent_id && by.has(n.parent_id) ? by.get(n.parent_id).children : top).push(n);
  const sum = (n) => (n.total = n.own + n.children.reduce((a, c) => a + sum(c), 0)); top.forEach(sum); res.json(top);
});
// Move people from one position to another, with a history entry each.
orgRouter.post('/org/transfer-position', (req, res) => {
  const b = req.body ?? {}, from = b.from_position_id ? Number(b.from_position_id) : null, to = Number(b.to_position_id), date = b.date || dateStr(new Date());
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  const dest = db.prepare('SELECT id, name FROM designations WHERE id=?').get(to); if (!dest) return fail(res, 'Choose the position to move people into');
  const sc = scopeClause('e'); let ids;
  if (Array.isArray(b.employee_ids) && b.employee_ids.length) ids = b.employee_ids.map(Number).slice(0, 2000);
  else if (from) ids = db.prepare(`SELECT e.id FROM employees e WHERE e.designation_id=? AND e.active=1${sc.sql}`).all(from, ...sc.args).map(r => r.id);
  else return fail(res, 'Choose the position to move people out of, or pick the people');
  let moved = 0; db.exec('BEGIN');
  try {
    for (const id of ids) {
      const e = db.prepare(`SELECT e.id, e.designation_id, d.name AS pos FROM employees e LEFT JOIN designations d ON d.id=e.designation_id WHERE e.id=?${sc.sql}`).get(id, ...sc.args); if (!e || e.designation_id === to) continue;
      db.prepare('UPDATE employees SET designation_id=? WHERE id=?').run(to, id);
      db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(id, 'transfer', date, JSON.stringify({ position: { from: e.pos, to: dest.name }, note: txt(b.note, 200) ?? '' }), req.user); moved++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return fail(res, e.message); }
  res.json({ moved });
});
const simple = (path, table, extra = '', joins = '', qcol, extraCols = '') => {
  orgRouter.get(`/org/${path}`, (_q, res) => res.json(db.prepare(`SELECT x.id, x.code, x.name${extraCols}, ${qty(qcol)}${extra} FROM ${table} x ${joins} ORDER BY COALESCE(x.code, ''), x.name`).all()));
};
simple('positions', 'designations', ', (SELECT p.name FROM designations p WHERE p.id=x.parent_id) AS superior', '', 'designation_id', ', x.parent_id');
simple('areas', 'branches', ', (SELECT COUNT(*) FROM device_groups g WHERE g.branch_id=x.id) AS device_groups, (SELECT COUNT(*) FROM devices d JOIN device_groups g ON g.id=d.group_id WHERE g.branch_id=x.id) AS devices', 'LEFT JOIN companies c ON c.id=x.company_id', 'branch_id', ', x.address, x.company_id, c.name AS company');
const SIMPLE = { positions: ['designations', 'designation_id', ['code', 'name']], areas: ['branches', 'branch_id', ['code', 'name', 'address', 'company_id']] };
SIMPLE.positions[2].push('parent_id');
for (const [path, [table, col, fields]] of Object.entries(SIMPLE)) {
  const clean = (b, id) => {
    const o = {}; if ('name' in b) { o.name = txt(b.name, 80); if (!o.name) return { error: 'Name required' }; }
    if ('code' in b) { o.code = txt(b.code, 20); if (o.code && db.prepare(`SELECT 1 FROM ${table} WHERE code=? AND id IS NOT ?`).get(o.code, id ?? null)) return { error: `The code ${o.code} is already used` }; }
    if (fields.includes('parent_id') && 'parent_id' in b) { o.parent_id = b.parent_id ? Number(b.parent_id) : null; if (o.parent_id) { if (o.parent_id === id || !db.prepare('SELECT 1 FROM designations WHERE id=?').get(o.parent_id)) return { error: 'Unknown superior position' }; for (let q = o.parent_id, n = 0; q && n < 50; n++) { q = db.prepare('SELECT parent_id FROM designations WHERE id=?').get(q)?.parent_id; if (q === id) return { error: 'A position cannot sit under its own sub-position' }; } } }
    if (fields.includes('address') && 'address' in b) o.address = txt(b.address, 200);
    if (fields.includes('company_id') && 'company_id' in b) { o.company_id = b.company_id ? Number(b.company_id) : null; if (o.company_id && !db.prepare('SELECT 1 FROM companies WHERE id=?').get(o.company_id)) return { error: 'Unknown company' }; }
    return { o };
  };
  orgRouter.post(`/org/${path}`, (req, res) => { const { o, error } = clean({ name: '', ...req.body }, null); if (error) return fail(res, error); try { const c = Object.keys(o); res.json({ id: Number(db.prepare(`INSERT INTO ${table}(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid) }); } catch { fail(res, 'This name is already used'); } });
  orgRouter.put(`/org/${path}/:id`, (req, res) => { const id = Number(req.params.id); if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) return fail(res, 'Not found', 404); const { o, error } = clean(req.body ?? {}, id); if (error) return fail(res, error); const c = Object.keys(o); if (c.length) try { db.prepare(`UPDATE ${table} SET ${c.map(k => k + '=?')} WHERE id=?`).run(...c.map(k => o[k]), id); } catch { return fail(res, 'This name is already used'); } res.json({ ok: true }); });
  orgRouter.delete(`/org/${path}/:id`, (req, res) => {
    const id = Number(req.params.id), r = db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id); if (!r) return fail(res, 'Not found', 404);
    const n = db.prepare(`SELECT COUNT(*) n FROM employees WHERE ${col}=?`).get(id).n; if (n) return fail(res, `${r.name} is still used by ${n} employee${n === 1 ? '' : 's'}. Move them first.`);
    if (path === 'areas') { // the device group made for an area when a device is added to it is invisible in this menu, so empty ones go with the area
      const used = db.prepare('SELECT d.name FROM devices d JOIN device_groups g ON g.id=d.group_id WHERE g.branch_id=?').all(id);
      if (used.length) return fail(res, `${r.name} still has ${used.length === 1 ? 'a device' : used.length + ' devices'} (${used.slice(0, 3).map(x => x.name).join(', ')}). Change their Area or delete them first.`);
      db.prepare('DELETE FROM device_groups WHERE branch_id=?').run(id);
    }
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); res.json({ ok: true });
  });
  orgRouter.post(`/org/${path}/import`, (req, res) => { // code,name  (areas: code,name,address)
    let rows = parseCsv(String(req.body?.csv ?? '')); if (!rows.length) return fail(res, 'Paste a CSV with code and name'); if (/^code$/i.test((rows[0][0] ?? '').trim())) rows = rows.slice(1); if (rows.length > 1000) return fail(res, 'At most 1000 rows at a time');
    let added = 0, skipped = 0; const errors = [];
    rows.forEach((r, i) => { const code = txt(r[0], 20), name = txt(r[1], 80); if (!name) { errors.push({ line: i + 1, error: 'Name required' }); return; } if (db.prepare(`SELECT 1 FROM ${table} WHERE name=? OR (code IS NOT NULL AND code=?)`).get(name, code)) { skipped++; return; }
      try { if (path === 'areas') db.prepare('INSERT INTO branches(code, name, address) VALUES(?,?,?)').run(code, name, txt(r[2], 200)); else db.prepare(`INSERT INTO ${table}(code, name) VALUES(?,?)`).run(code, name); added++; } catch (e) { errors.push({ line: i + 1, error: e.message }); } });
    res.json({ added, skipped, errors: errors.slice(0, 50) });
  });
}
