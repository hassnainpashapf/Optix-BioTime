import express from 'express';
import { db } from './db.js';
import { parseCsv } from './csv.js';
import { dateStr } from './dates.js';
import { emit } from './events.js';
import { scopeClause } from './rbac.js';
import { queueUser, queueCommand } from './devsync.js';

// ZKT-style Personnel pages: extra columns on the employee / department / area lists, bulk personnel transfer,
// resignation records, and the employee actions (probation, app access, device resync).
export const zkpRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
const DATE = /^\d{4}-\d\d-\d\d$/;
const txt = (v, n) => { const s = String(v ?? '').trim().slice(0, n); return s || null; };
const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some(r => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
addCol('employees', 'nationality', 'TEXT');
addCol('employees', 'emp_type', 'TEXT');
addCol('departments', 'manager_id', 'INTEGER');
addCol('branches', 'parent_id', 'INTEGER');
db.exec('CREATE TRIGGER IF NOT EXISTS zk_area_del AFTER DELETE ON branches BEGIN UPDATE branches SET parent_id=NULL WHERE parent_id=OLD.id; END');
db.exec('CREATE TABLE IF NOT EXISTS zk_resign(employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE, type TEXT, reason TEXT, date TEXT, att_disabled INTEGER DEFAULT 0)');
export const EMP_TYPES = ['Official', 'Temporary', 'Probation'];
export const RESIGN_TYPES = ['Resignation', 'Termination', 'Dismissal', 'Retirement', 'Contract end', 'Transfer out'];

const history = (id, kind, date, detail, user) => db.prepare('INSERT INTO emp_history(employee_id, kind, date, detail, by_user) VALUES(?,?,?,?,?)').run(id, kind, date, typeof detail === 'string' ? detail : JSON.stringify(detail), user);
const idList = (b, key = 'employee_ids') => [...new Set((Array.isArray(b?.[key]) ? b[key] : []).map(Number).filter(Number.isInteger))].slice(0, 2000);
const qty = (col) => `(SELECT COUNT(*) FROM employees e WHERE e.${col}=x.id AND e.active=1) AS employees, (SELECT COUNT(*) FROM employees e WHERE e.${col}=x.id AND e.active=0) AS resigned`;
const mine = (id) => { const c = scopeClause('e'); return db.prepare(`SELECT e.* FROM employees e WHERE e.id=?${c.sql}`).get(id, ...c.args); };

// ---------- employee list (ZKT columns) ----------
const EMP_SQL = `SELECT e.id, e.code, e.name, e.nationality, e.emp_type, e.join_date, e.active, e.status, e.card_no, e.photo IS NOT NULL AS has_photo,
  d.name AS dept, ds.name AS position, b.name AS area,
  CASE WHEN a.employee_id IS NOT NULL AND a.enabled=1 AND a.mobile_enabled=1 THEN 'Enable' ELSE 'Disable' END AS app_status
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN branches b ON b.id=e.branch_id
  LEFT JOIN employee_accounts a ON a.employee_id=e.id`;
zkpRouter.get('/zkp/employees', (req, res) => {
  const w = [], a = [], q = req.query, sc = scopeClause('e');
  if (q.q) { w.push('(e.code LIKE ? OR e.name LIKE ? OR e.phone LIKE ? OR e.email LIKE ?)'); const l = `%${q.q}%`; a.push(l, l, l, l); }
  for (const [p, col] of [['department_id', 'e.department_id'], ['designation_id', 'e.designation_id'], ['branch_id', 'e.branch_id']]) if (q[p]) { w.push(`${col}=?`); a.push(q[p]); }
  w.push(q.status === 'all' ? '1=1' : 'e.active=1');
  res.json(db.prepare(`${EMP_SQL} WHERE ${w.join(' AND ')}${sc.sql} ORDER BY CAST(e.code AS INTEGER), e.code LIMIT 5000`).all(...a, ...sc.args));
});
zkpRouter.get('/zkp/employees/extra-options', (_q, res) => res.json({ emp_types: EMP_TYPES, resign_types: RESIGN_TYPES }));
zkpRouter.get('/zkp/employees/:id/extra', (req, res) => { const e = mine(req.params.id); if (!e) return fail(res, 'No such employee', 404); res.json({ nationality: e.nationality, emp_type: e.emp_type }); });
zkpRouter.put('/zkp/employees/:id/extra', (req, res) => {
  const e = mine(req.params.id); if (!e) return fail(res, 'No such employee', 404);
  const b = req.body ?? {}, nat = 'nationality' in b ? txt(b.nationality, 60) : e.nationality, et = 'emp_type' in b ? txt(b.emp_type, 40) : e.emp_type;
  db.prepare('UPDATE employees SET nationality=?, emp_type=? WHERE id=?').run(nat, et, e.id); res.json({ ok: true });
});

// ---------- bulk personnel transfer (department / position / area) ----------
const KINDS = { department: ['departments', 'department_id'], position: ['designations', 'designation_id'], area: ['branches', 'branch_id'] };
function transferPeople(b, user) {
  const k = KINDS[b.kind]; if (!k) return { error: 'Choose department, position or area' };
  const ids = idList(b); if (!ids.length) return { error: 'Pick at least one employee' };
  const date = b.date || dateStr(new Date()); if (!DATE.test(date)) return { error: 'Date must be YYYY-MM-DD' };
  const dest = db.prepare(`SELECT id, name FROM ${k[0]} WHERE id=?`).get(Number(b.to_id)); if (!dest) return { error: `Choose the ${b.kind} to move people into` };
  let moved = 0; db.exec('BEGIN');
  try {
    for (const id of ids) {
      const e = mine(id); if (!e || e[k[1]] === dest.id) continue;
      const from = e[k[1]] ? db.prepare(`SELECT name FROM ${k[0]} WHERE id=?`).get(e[k[1]])?.name ?? null : null;
      db.prepare(`UPDATE employees SET ${k[1]}=? WHERE id=?`).run(dest.id, id);
      history(id, 'transfer', date, { [b.kind]: { from, to: dest.name }, note: txt(b.note, 200) ?? '' }, user); moved++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return { error: e.message }; }
  return { moved };
}
zkpRouter.post('/zkp/employees/transfer', (req, res) => { const r = transferPeople(req.body ?? {}, req.user); r.error ? fail(res, r.error) : res.json(r); });
// same for areas as a whole: everybody active in one area moves to another (the Area page's Personnel Transfer)
zkpRouter.post('/zkp/org/transfer-area', (req, res) => {
  const b = req.body ?? {}, from = b.from_area_id ? Number(b.from_area_id) : null, sc = scopeClause('e'); let ids = idList(b);
  if (!db.prepare('SELECT 1 FROM branches WHERE id=?').get(Number(b.to_area_id))) return fail(res, 'Choose the area to move people into');
  if (!ids.length) { if (!from) return fail(res, 'Choose the area to move people out of, or pick the people'); ids = db.prepare(`SELECT e.id FROM employees e WHERE e.branch_id=? AND e.active=1${sc.sql}`).all(from, ...sc.args).map(r => r.id); }
  const r = transferPeople({ kind: 'area', to_id: b.to_area_id, employee_ids: ids, date: b.date, note: b.note }, req.user); r.error ? fail(res, r.error) : res.json(r);
});

zkpRouter.post('/zkp/employees/pass-probation', (req, res) => {
  const ids = idList(req.body); if (!ids.length) return fail(res, 'Pick at least one employee');
  const date = req.body?.date || dateStr(new Date()); if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  let done = 0;
  for (const id of ids) { const e = mine(id); if (!e || !e.active) continue; db.prepare("UPDATE employees SET emp_type='Official' WHERE id=?").run(id); history(id, 'probation', date, { note: 'Passed probation' }, req.user); done++; }
  res.json({ done });
});

// ---------- mobile app access ----------
zkpRouter.post('/zkp/employees/app', (req, res) => {
  const ids = idList(req.body), on = req.body?.enabled ? 1 : 0; if (!ids.length) return fail(res, 'Pick at least one employee');
  let done = 0, skipped = 0;
  for (const id of ids) {
    if (!mine(id)) { skipped++; continue; }
    const r = db.prepare('UPDATE employee_accounts SET enabled=?, mobile_enabled=? WHERE employee_id=?').run(on, on, id);
    if (r.changes) done++; else skipped++;
  }
  res.json({ done, skipped, note: skipped ? 'People without a portal account were skipped. Create their accounts under Portal accounts first.' : '' });
});

// ---------- device sync actions ----------
const pushDevices = () => db.prepare('SELECT id FROM devices WHERE sn IS NOT NULL AND approved=1').all();
zkpRouter.post('/zkp/employees/device-sync', (req, res) => {
  const ids = idList(req.body), action = req.body?.action; if (!ids.length) return fail(res, 'Pick at least one employee');
  const emps = ids.map(mine).filter(Boolean); let n = 0;
  if (action === 'resync') { for (const e of emps) { if (e.active) queueUser(e.code, e.name, 'update'); n++; } }
  else if (action === 'reupload') { for (const d of pushDevices()) { queueCommand(d.id, 'DATA QUERY tablename=USERINFO,fielddesc=*,filter=*'); n++; } }
  else if (action === 'delete-bio') {
    for (const e of emps) {
      db.prepare('DELETE FROM biodata WHERE employee_id=?').run(e.id);
      for (const d of pushDevices()) { queueCommand(d.id, `DATA DELETE FINGERTMP PIN=${e.code}`); queueCommand(d.id, `DATA DELETE FACE PIN=${e.code}`); }
      n++;
    }
  } else return fail(res, 'Unknown action');
  res.json({ done: n, devices: pushDevices().length });
});
zkpRouter.get('/zkp/employees/usb-export', (req, res) => {
  const sc = scopeClause('e'), rows = db.prepare(`SELECT e.code, e.name, e.card_no FROM employees e WHERE e.active=1${sc.sql} ORDER BY CAST(e.code AS INTEGER), e.code`).all(...sc.args);
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.type('text/csv').set('Content-Disposition', 'attachment; filename="user.csv"').send(['PIN,Name,Card', ...rows.map(r => [r.code, r.name, r.card_no].map(cell).join(','))].join('\n'));
});
// A USB user file ("PIN,Name,Card" per line): new people are created, known ones get their card number
zkpRouter.post('/zkp/employees/usb-import', (req, res) => {
  let rows = parseCsv(String(req.body?.csv ?? '')); if (!rows.length) return fail(res, 'Paste or choose a user file (PIN, Name, Card)');
  if (/^(pin|id|code)$/i.test((rows[0][0] ?? '').trim())) rows = rows.slice(1);
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows.slice(0, 5000)) {
    const pin = txt(r[0], 20), name = txt(r[1], 80) ?? `User ${pin}`, card = String(r[2] ?? '').replace(/\D/g, '') || null; if (!pin) { skipped++; continue; }
    const e = db.prepare('SELECT id FROM employees WHERE code=?').get(pin);
    try {
      if (!e) { db.prepare('INSERT INTO employees(code, name, card_no) VALUES(?,?,?)').run(pin, name, card); added++; }
      else if (card) { db.prepare('UPDATE employees SET card_no=? WHERE id=?').run(card, e.id); updated++; } else skipped++;
    } catch { skipped++; }
  }
  res.json({ added, updated, skipped });
});

// ---------- resignations ----------
function exitEmp(e, type, date, reason, user) {
  const status = type === 'Resignation' ? 'resigned' : 'terminated';
  db.prepare('UPDATE employees SET active=0, status=?, exit_date=? WHERE id=?').run(status, date, e.id);
  db.prepare('INSERT INTO zk_resign(employee_id, type, reason, date) VALUES(?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET type=excluded.type, reason=excluded.reason, date=excluded.date, att_disabled=0').run(e.id, type, reason, date);
  history(e.id, type === 'Resignation' ? 'resignation' : 'termination', date, { reason: reason ?? '', type }, user);
  queueUser(e.code, e.name, 'delete');
  emit('employee.status_changed', { code: e.code, status, date });
}
const RESIGN_SQL = `SELECT e.id, e.code, e.name, e.status, e.exit_date, d.name AS dept, ds.name AS position, z.type, z.reason, z.date, COALESCE(z.att_disabled, 0) AS att_disabled,
  (SELECT detail FROM emp_history h WHERE h.employee_id=e.id AND h.kind IN ('resignation','termination') ORDER BY h.id DESC LIMIT 1) AS hist
  FROM employees e LEFT JOIN departments d ON d.id=e.department_id LEFT JOIN designations ds ON ds.id=e.designation_id LEFT JOIN zk_resign z ON z.employee_id=e.id`;
zkpRouter.get('/zkp/resign', (_req, res) => {
  const sc = scopeClause('e');
  res.json(db.prepare(`${RESIGN_SQL} WHERE e.active=0${sc.sql} ORDER BY COALESCE(z.date, e.exit_date) DESC, e.id DESC LIMIT 5000`).all(...sc.args).map(r => {
    let h = {}; try { h = JSON.parse(r.hist ?? '{}'); } catch {}
    return { id: r.id, code: r.code, name: r.name, dept: r.dept, position: r.position, type: r.type ?? (r.status === 'terminated' ? 'Termination' : 'Resignation'), date: r.date ?? r.exit_date, reason: r.reason ?? h.reason ?? '', att_disabled: r.att_disabled };
  }));
});
zkpRouter.post('/zkp/resign', (req, res) => {
  const b = req.body ?? {}, type = RESIGN_TYPES.includes(b.type) ? b.type : 'Resignation', date = b.date || dateStr(new Date());
  if (!DATE.test(date)) return fail(res, 'Date must be YYYY-MM-DD');
  const ids = idList(b); if (!ids.length) return fail(res, 'Choose at least one employee');
  let done = 0; const errors = [];
  for (const id of ids) { const e = mine(id); if (!e) { errors.push('No such employee'); continue; } if (!e.active) { errors.push(`${e.name} is already inactive`); continue; } exitEmp(e, type, date, txt(b.reason, 300), req.user); done++; }
  if (!done) return fail(res, errors[0] ?? 'Nothing done');
  res.json({ done, errors });
});
zkpRouter.post('/zkp/resign/import', (req, res) => { // code,type,date,reason
  let rows = parseCsv(String(req.body?.csv ?? '')); if (!rows.length) return fail(res, 'Paste a CSV: employee id, type, date, reason');
  if (/^employee/i.test((rows[0][0] ?? '').trim()) || /^(code|id)$/i.test((rows[0][0] ?? '').trim())) rows = rows.slice(1);
  let added = 0, skipped = 0; const errors = [];
  rows.slice(0, 2000).forEach((r, i) => {
    const e = db.prepare('SELECT * FROM employees WHERE code=?').get(String(r[0] ?? '').trim()), type = RESIGN_TYPES.find(t => t.toLowerCase() === String(r[1] ?? '').trim().toLowerCase()) ?? 'Resignation', date = String(r[2] ?? '').trim() || dateStr(new Date());
    if (!e || !e.active) { skipped++; return; } if (!DATE.test(date)) { errors.push({ line: i + 1, error: 'Bad date' }); return; }
    exitEmp(e, type, date, txt(r[3], 300), req.user); added++;
  });
  res.json({ added, skipped, errors });
});
zkpRouter.post('/zkp/resign/reinstate', (req, res) => {
  const ids = idList(req.body, 'employee_ids'); if (!ids.length) return fail(res, 'Pick at least one employee');
  const date = req.body?.date || dateStr(new Date()); let done = 0;
  for (const id of ids) {
    const e = mine(id); if (!e || e.active) continue;
    db.prepare("UPDATE employees SET active=1, status='active', exit_date=NULL WHERE id=?").run(id);
    db.prepare('DELETE FROM zk_resign WHERE employee_id=?').run(id);
    history(id, 'rejoin', date, { note: 'Reinstated' }, req.user); queueUser(e.code, e.name, 'update'); emit('employee.status_changed', { code: e.code, status: 'active', date }); done++;
  }
  res.json({ done });
});
zkpRouter.post('/zkp/resign/attendance', (req, res) => {
  const ids = idList(req.body); if (!ids.length) return fail(res, 'Pick at least one employee');
  let done = 0; for (const id of ids) { if (!mine(id)) continue; db.prepare('UPDATE zk_resign SET att_disabled=? WHERE employee_id=?').run(req.body?.disabled === false ? 0 : 1, id); done++; }
  res.json({ done });
});
zkpRouter.delete('/zkp/resign/:id', (req, res) => {
  const e = mine(req.params.id); if (!e) return fail(res, 'No such employee', 404); if (e.active) return fail(res, 'This employee has not resigned');
  try { db.prepare('DELETE FROM employees WHERE id=?').run(e.id); res.json({ ok: true }); } catch { fail(res, `${e.name} has leave or roster records, so the record cannot be deleted. Reinstate the employee instead.`); }
});

// ---------- departments: manager ----------
zkpRouter.get('/zkp/org/departments', (_q, res) => res.json(db.prepare(`SELECT x.id, x.code, x.name, x.parent_id, x.shift_id, x.manager_id, p.name AS superior, s.name AS shift, m.name AS manager, ${qty('department_id')}
  FROM departments x LEFT JOIN departments p ON p.id=x.parent_id LEFT JOIN shifts s ON s.id=x.shift_id LEFT JOIN employees m ON m.id=x.manager_id ORDER BY COALESCE(x.code,''), x.name`).all()));
zkpRouter.put('/zkp/org/departments/:id/manager', (req, res) => {
  if (!db.prepare('SELECT 1 FROM departments WHERE id=?').get(req.params.id)) return fail(res, 'No such department', 404);
  const m = req.body?.manager_id ? Number(req.body.manager_id) : null;
  if (m && !db.prepare('SELECT 1 FROM employees WHERE id=?').get(m)) return fail(res, 'Unknown employee');
  db.prepare('UPDATE departments SET manager_id=? WHERE id=?').run(m, req.params.id); res.json({ ok: true });
});

// ---------- areas: superior, device qty ----------
zkpRouter.get('/zkp/org/areas', (_q, res) => res.json(db.prepare(`SELECT x.id, x.code, x.name, x.address, x.company_id, x.parent_id, p.name AS superior, c.name AS company,
  (SELECT COUNT(*) FROM devices d JOIN device_groups g ON g.id=d.group_id WHERE g.branch_id=x.id) AS devices, ${qty('branch_id')}
  FROM branches x LEFT JOIN branches p ON p.id=x.parent_id LEFT JOIN companies c ON c.id=x.company_id ORDER BY COALESCE(x.code,''), x.name`).all()));
zkpRouter.put('/zkp/org/areas/:id/parent', (req, res) => {
  const id = Number(req.params.id); if (!db.prepare('SELECT 1 FROM branches WHERE id=?').get(id)) return fail(res, 'No such area', 404);
  const p = req.body?.parent_id ? Number(req.body.parent_id) : null;
  if (p) {
    if (!db.prepare('SELECT 1 FROM branches WHERE id=?').get(p)) return fail(res, 'Unknown superior area');
    for (let q = p, n = 0; q && n < 50; n++) { if (q === id) return fail(res, 'An area cannot sit under itself or one of its own sub-areas'); q = db.prepare('SELECT parent_id FROM branches WHERE id=?').get(q)?.parent_id; }
  }
  db.prepare('UPDATE branches SET parent_id=? WHERE id=?').run(p, id); res.json({ ok: true });
});
