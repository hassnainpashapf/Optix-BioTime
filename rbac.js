import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from './db.js';

// ---------- roles: what each module allows (none < view < edit) ----------
export const MODULES = ['employees', 'organization', 'shifts', 'attendance', 'leave', 'overtime', 'payroll', 'devices', 'access', 'settings'];
const all = (lvl) => Object.fromEntries(MODULES.map(m => [m, lvl]));
const ROLE_DEFAULTS = {
  admin: all('edit'),
  hr: { ...all('edit'), payroll: 'view', devices: 'view', settings: 'none' },
  manager: { employees: 'view', organization: 'view', shifts: 'view', attendance: 'view', leave: 'edit', overtime: 'edit', payroll: 'none', devices: 'none', settings: 'none' },
  viewer: { ...all('view'), payroll: 'none', settings: 'none' },
};
for (const [name, perms] of Object.entries(ROLE_DEFAULTS))
  db.prepare('INSERT OR IGNORE INTO roles(name, perms, builtin) VALUES(?,?,?)').run(name, JSON.stringify(perms), name === 'admin' ? 1 : 0);
const RANK = { none: 0, view: 1, edit: 2 };
// a group can also hold "view+add", "view+change+delete" ...: Add = POST, Change = PUT/PATCH, Delete = DELETE (actions such as approve are POSTs and count as Add)
const PART = /^view(\+(add|change|delete))+$/, NEED = { POST: 'add', PUT: 'change', PATCH: 'change', DELETE: 'delete' };
export const levelAllows = (lv, method) => { lv = lv ?? 'none'; if (lv === 'edit') return true; if (lv === 'none') return false; if (method === 'GET' || method === 'HEAD') return true; return PART.test(lv) && lv.split('+').includes(NEED[method] ?? 'add'); };
export const permsOf = (role) => {
  if (role === 'admin') return all('edit');
  const r = db.prepare('SELECT perms FROM roles WHERE name=?').get(role);
  return { ...all('none'), ...(r ? JSON.parse(r.perms) : {}) };
};

// ---------- data scope: a user can be limited to some departments / branches / companies ----------
export const als = new AsyncLocalStorage();
const ids = (j) => { try { const a = JSON.parse(j); return Array.isArray(a) && a.length ? a.map(Number).filter(Number.isFinite) : null; } catch { return null; } };
export const userScope = (u) => ({ departments: ids(u.scope_departments), branches: ids(u.scope_branches), companies: ids(u.scope_companies) });
export const isScoped = (s = als.getStore()?.scope) => !!s && !!(s.departments || s.branches || s.companies);
// SQL fragment (starts with AND) restricting `alias` (an employees row) to the current request's scope.
export function scopeClause(alias = 'e') {
  const s = als.getStore()?.scope;
  if (!isScoped(s)) return { sql: '', args: [] };
  let sql = ''; const args = [];
  for (const [k, col] of [['departments', 'department_id'], ['branches', 'branch_id'], ['companies', 'company_id']])
    if (s[k]) { sql += ` AND ${alias}.${col} IN (${s[k].map(() => '?')})`; args.push(...s[k]); }
  return { sql, args };
}
export const inScope = (employeeId) => { const c = scopeClause('e'); return !c.sql || !!db.prepare(`SELECT 1 FROM employees e WHERE e.id=?${c.sql}`).get(employeeId, ...c.args); };
export const allowedCodes = () => { const c = scopeClause('e'); return c.sql ? new Set(db.prepare(`SELECT e.code FROM employees e WHERE 1=1${c.sql}`).all(...c.args).map(r => r.code)) : null; };

// ---------- which module a request belongs to ----------
const ADMIN_ONLY = /^\/(users|audit|backup|restore|roles|restart|api-keys|webhooks)(\/|$)/; // /api/portal/* is not here: it is served before staff login and has its own auth
const PUBLIC = /^\/(me|notifications|alerts|mobile|password|dashboard|bookmarks|workflow\/inbox)(\/|$)/;
const RULES = [
  [/^\/zkp\/org(\/|$)/, 'organization'],
  [/^\/zkp(\/|$)/, 'employees'],
  [/^\/zkd\/(geo|ann)(\/|$)/, 'organization'],
  [/^\/zkd\/app(\/|$)/, 'employees'],
  [/^\/zkd(\/|$)/, 'devices'],
  [/^\/att\/(leavelist|leavegroups)(\/|$)/, 'leave'],
  [/^\/att\/otlist(\/|$)/, 'overtime'],
  [/^\/att\/(manuallog|training|calc|calcbatches)(\/|$)/, 'attendance'],
  [/^\/att\/groups(\/|$)/, 'organization'],
  [/^\/att\/(paycodes|fixedcodes|globalrule|rules|config)(\/|$)/, 'settings'],
  [/^\/att(\/|$)/, 'shifts'],
  [/^\/(employees|documents|custom_fields|portal-accounts|contracts|promotions|directory)(\/|$)/, 'employees'],
  [/^\/(companies|branches|departments|designations|emp_groups|geo_sites|announcements|org)(\/|$)/, 'organization'],
  [/^\/(shifts|schedules|holidays|rotations|breaks)(\/|$)/, 'shifts'],
  [/^\/pay_codes(\/|$)/, 'settings'],
  [/^\/ac(\/|$)/, 'access'],
  [/^\/workflow(\/|$)/, 'settings'],
  [/^\/(leaves|leave|leave_types|leave_policies|report\/leave)(\/|$)/, 'leave'],
  [/^\/(overtime|ot_policies|report\/overtime)(\/|$)/, 'overtime'],
  [/^\/(payroll|report\/payroll)(\/|$)/, 'payroll'],
  [/^\/(devices|device-events|device-commands|device-messages|device_groups)(\/|$)/, 'devices'],
  [/^\/settings(\/|$)/, 'settings'],
  [/^\/zkrep\/(dailyLeaveReport|employeeLeaveReport|leaveBalanceSummaryReport)(\/|$)/, 'leave'],
  [/^\/zkrep\/(dailyOvertimeReport|weeklyOvertimeReport|monthlyOvertimeReport|employeeOvertimeReport|departmentOvertimeReport|groupOvertimeReport)(\/|$)/, 'overtime'],
  [/^\/(logs|attendance|report|stats|reports|monitor|punch-photo|visitors|zkrep|mtd|webauthn|fingerprint)(\/|$)/, 'attendance'],
  [/^\/(rooms|meetings)(\/|$)/, 'organization'],
  [/^\/notification-rules(\/|$)/, 'settings'],
  [/^\/att_policies(\/|$)/, 'settings'],
  [/^\/automations(\/|$)/, 'settings'],
];
// ---------- single pages inside a module ----------
// A UserGroup can also hold a level for one page ("Payroll.Formula": "view+add"): when that key is present it decides for the requests of that page, otherwise the module level does.
const SUBS = [
  ['Personnel.Resign', /^\/zkp\/resign(\/|$)/], ['Personnel.Document', /^\/documents(\/|$)/],
  ['Personnel.Department', /^\/(departments|zkp\/org\/departments|org\/departments)(\/|$)/], ['Personnel.Position', /^\/(designations|org\/positions)(\/|$)/], ['Personnel.Area', /^\/(branches|zkp\/org\/areas|org\/areas)(\/|$)/],
  ['Device.Device', /^\/(devices|device_groups)(\/|$)/], ['Device.Device Command', /^\/(device-commands|zkd\/commands)(\/|$)/], ['Device.Device Parameter', /^\/zkd\/(params|config)(\/|$)/], ['Device.Message', /^\/(device-messages|zkd\/messages)(\/|$)/],
  ['Device.Data', /^\/zkd\/(devemp|biotemplates|biophotos)(\/|$)/], ['Device.Log', /^\/(device-events|zkd\/transactions)(\/|$)/], ['Device.Mobile App', /^\/zkd\/app(\/|$)/], ['Device.Geo-fence', /^\/zkd\/geo(\/|$)/],
  ['Attendance.Pay Code', /^\/(pay_codes|att\/(paycodes|fixedcodes))(\/|$)/], ['Attendance.Rule', /^\/att\/(globalrule|rules|config)(\/|$)/], ['Attendance.Break Time', /^\/att\/breaktimes(\/|$)/], ['Attendance.Timetable', /^\/att\/timetables(\/|$)/],
  ['Attendance.Shift', /^\/(shifts|att\/shiftdefs)(\/|$)/], ['Attendance.Schedule Assignment', /^\/(schedules|att\/(empsched|deptsched|grpsched|personsched|tempsched|schedadj|quickset))(\/|$)/],
  ['Attendance.Manual Log', /^\/att\/manuallog(\/|$)/], ['Attendance.Training', /^\/att\/training(\/|$)/],
  ['Payroll.Formula', /^\/payroll\/(formulas|formula-vars)(\/|$)/], ['Payroll.Extra Funds', /^\/payroll\/(extra|extras)(\/|$)/], ['Payroll.Structure', /^\/payroll\/(structure|salary|salary-bulk)(\/|$)/],
  ['Payroll.Profile', /^\/payroll\/(profiles|employee|employee-history)(\/|$)/], ['Payroll.Special Payment', /^\/payroll\/special(\/|$)/], ['Payroll.Exemption', /^\/payroll\/exemptions(\/|$)/], ['Payroll.Payslip', /^\/payroll\/(history|bank-file)(\/|$)/],
  ['Access.Holiday', /^\/ac\/holidays(\/|$)/], ['Access.Groups', /^\/ac\/levels(\/|$)/], ['Access.Combination', /^\/ac\/combos(\/|$)/], ['Access.Privilege', /^\/ac\/privileges(\/|$)/],
  ['Visitor.Visitor', /^\/visitors(\/blocklist)?\/?$/], ['Visitor.Reason', /^\/visitors\/reasons(\/|$)/], ['Visitor.Transaction', /^\/visitors\/transactions(\/|$)/],
  ['Meeting.Room', /^\/rooms(\/|$)/], ['Meeting.Meeting', /^\/meetings(\/|$)/],
  ['MTD.Daily Report', /^\/mtd\/daily(\/|$)/], ['MTD.Department Summary', /^\/mtd\/deptsummary(\/|$)/], ['MTD.Abnormal', /^\/mtd\/abnormal(\/|$)/],
];
export const SUBKEYS = SUBS.map(x => x[0]);
export const subFor = (path) => SUBS.find(([, re]) => re.test(path))?.[0] ?? null;
const REPORT_MODULE = { leave: 'leave', overtime: 'overtime', payroll: 'payroll' };
export function moduleFor(path) {
  if (PUBLIC.test(path)) return 'public';
  if (ADMIN_ONLY.test(path)) return 'admin';
  const m = path.match(/^\/reports\/([a-z_]+)/);
  if (m && REPORT_MODULE[m[1]]) return REPORT_MODULE[m[1]];
  for (const [re, mod] of RULES) if (re.test(path)) return mod;
  return 'admin'; // anything unmapped is admin-only, so a new endpoint can never be open by accident
}

// Which employee does this request touch? (checked against the user's scope)
const OWNERS = [
  [/^\/employees\/(\d+)/, 'SELECT id AS emp FROM employees WHERE id=?'],
  [/^\/documents\/(\d+)/, 'SELECT employee_id AS emp FROM emp_documents WHERE id=?'],
  [/^\/contracts\/(\d+)/, 'SELECT employee_id AS emp FROM emp_contracts WHERE id=?'],
  [/^\/leaves\/(\d+)/, 'SELECT employee_id AS emp FROM leaves WHERE id=?'],
  [/^\/overtime\/(\d+)/, 'SELECT employee_id AS emp FROM overtime_requests WHERE id=?'],
  [/^\/attendance\/requests\/(\d+)/, 'SELECT employee_id AS emp FROM attendance_requests WHERE id=?'],
  [/^\/attendance\/overrides\/(\d+)/, 'SELECT employee_id AS emp FROM day_overrides WHERE id=?'],
  [/^\/schedules\/(\d+)/, 'SELECT employee_id AS emp FROM schedules WHERE id=?'],
  [/^\/shifts\/requests\/(\d+)/, 'SELECT employee_id AS emp FROM shift_requests WHERE id=?'],
  [/^\/logs\/(\d+)/, "SELECT e.id AS emp FROM logs l JOIN employees e ON e.code=l.emp_code WHERE l.id=?"],
];
function touchedEmployees(req) {
  const out = [];
  for (const [re, sql] of OWNERS) { const m = req.path.match(re); if (m) { const r = db.prepare(sql).get(m[1]); if (r) out.push(r.emp); } }
  for (const v of [req.body?.employee_id, req.query?.employee_id, req.body?.other_employee_id]) if (v) out.push(Number(v));
  if (Array.isArray(req.body?.employee_ids)) out.push(...req.body.employee_ids.slice(0, 2000).map(Number));
  if (req.body?.emp_code) { const r = db.prepare('SELECT id FROM employees WHERE code=?').get(String(req.body.emp_code)); if (r) out.push(r.id); }
  if (req.path === '/overtime/bulk' && Array.isArray(req.body?.ids))
    for (const id of req.body.ids.slice(0, 500)) { const r = db.prepare('SELECT employee_id AS emp FROM overtime_requests WHERE id=?').get(id); if (r) out.push(r.emp); }
  return out;
}

// Writes a scoped login may perform: they act on employees inside its scope, never on company-wide settings.
const SCOPED_WRITES = /^\/(bookmarks(\/\d+)?|alerts\/(prefs|options|test|watch(\/\d+)?)|mobile\/(pair-code|devices\/\d+)|contracts(\/\d+(\/[a-z]+)?)?|employees(\/\d+(\/[a-z]+)?)?|documents\/\d+|leaves(\/\d+(\/[a-z]+)?)?|overtime(\/(manual|bulk|\d+(\/[a-z]+)?))?|attendance\/(requests|overrides)(\/\d+(\/[a-z]+)?)?|shifts\/requests(\/\d+(\/[a-z]+)?)?|schedules|portal-accounts(\/\d+)?|logs\/manual|payroll\/items(\/\d+)?|notifications\/read|password)$/;
export function authorize(req, res, next) {
  const role = req.role, perms = permsOf(role);
  const target = moduleFor(req.path);
  if (target === 'admin') { if (role !== 'admin') return res.status(403).json({ error: 'Admin only' }); }
  else if (target !== 'public') {
    const sub = subFor(req.path), lv = sub && sub in perms ? perms[sub] : perms[target];
    if (!levelAllows(lv, req.method)) return res.status(403).json({ error: (lv ?? 'none') === 'none' ? `No access to ${sub ?? target}` : (lv === 'view' ? 'Read-only account' : `Your group may not ${NEED[req.method] ?? 'add'} here`) });
  }
  if (target === 'public' && req.method !== 'GET' && !(['/password', '/notifications/read', '/dashboard/prefs', '/alerts/prefs', '/alerts/options', '/alerts/watch', '/alerts/test', '/mobile/pair-code'].includes(req.path) || /^\/(alerts\/watch|mobile\/devices|bookmarks)\/\d+$/.test(req.path) || req.path === '/bookmarks')) return res.status(403).json({ error: 'Not allowed' });
  const scope = userScope(req.userRow);
  req.perms = perms;
  return als.run({ scope, user: req.user }, () => {
    if (isScoped(scope)) {
      if (req.method !== 'GET' && !SCOPED_WRITES.test(req.path)) return res.status(403).json({ error: 'Your account is limited to part of the company, so it cannot change company-wide settings' });
      for (const id of touchedEmployees(req)) if (!inScope(id)) return res.status(403).json({ error: 'That employee is outside your access' });
      if (req.method === 'POST' && req.path === '/employees') // a scoped user may only register people inside their own scope
        for (const [k, f] of [['departments', 'department_id'], ['branches', 'branch_id'], ['companies', 'company_id']])
          if (scope[k] && !scope[k].includes(Number(req.body?.[f]))) return res.status(403).json({ error: `Choose a ${f.replace('_id', '')} you have access to` });
    }
    next();
  });
}

// ---------- role management (admin only; see moduleFor) ----------
export const rolesRouter = express.Router();
const cleanPerms = (p) => { const o = {}; for (const m of MODULES) { const v = p?.[m] ?? 'none'; if (!(v in RANK) && !PART.test(v)) return null; o[m] = v; }
  for (const k of SUBKEYS) if (p && k in p) { const v = p[k]; if (!(v in RANK) && !PART.test(v)) return null; o[k] = v; } return o; };
rolesRouter.get('/roles', (_q, res) => {
  res.json(db.prepare('SELECT name, perms, builtin FROM roles ORDER BY builtin DESC, name').all().map(r => ({ name: r.name, builtin: !!r.builtin, perms: permsOf(r.name), users: db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(r.name).n })));
});
rolesRouter.post('/roles', (req, res) => {
  const name = String(req.body?.name ?? '').trim().toLowerCase(), perms = cleanPerms(req.body?.perms);
  if (!/^[a-z0-9_-]{2,30}$/.test(name)) return res.status(400).json({ error: 'Role name: 2-30 letters, digits, - or _' });
  if (!perms) return res.status(400).json({ error: 'Permissions must be none, view or edit' });
  if (db.prepare('SELECT 1 FROM roles WHERE name=?').get(name)) return res.status(400).json({ error: 'Role already exists' });
  db.prepare('INSERT INTO roles(name, perms) VALUES(?,?)').run(name, JSON.stringify(perms)); res.json({ ok: true });
});
rolesRouter.put('/roles/:name', (req, res) => {
  const r = db.prepare('SELECT * FROM roles WHERE name=?').get(req.params.name);
  if (!r) return res.status(404).json({ error: 'No such role' });
  if (r.builtin) return res.status(400).json({ error: 'The admin role cannot be changed' });
  const perms = cleanPerms({ ...JSON.parse(r.perms), ...req.body?.perms });
  if (!perms) return res.status(400).json({ error: 'Permissions must be none, view or edit' });
  db.prepare('UPDATE roles SET perms=? WHERE name=?').run(JSON.stringify(perms), r.name); res.json({ ok: true });
});
rolesRouter.delete('/roles/:name', (req, res) => {
  const r = db.prepare('SELECT * FROM roles WHERE name=?').get(req.params.name);
  if (!r) return res.json({ ok: true });
  if (r.builtin) return res.status(400).json({ error: 'The admin role cannot be deleted' });
  if (db.prepare('SELECT COUNT(*) n FROM users WHERE role=?').get(r.name).n) return res.status(400).json({ error: 'Users still have this role' });
  db.prepare('DELETE FROM roles WHERE name=?').run(r.name); res.json({ ok: true });
});
