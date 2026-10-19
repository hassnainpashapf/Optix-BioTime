import assert from 'node:assert/strict';
process.env.DB_FILE = ':memory:';
const { db, setSettings, DEFAULTS } = await import('./db.js');
const { attendanceReport, summarize } = await import('./report.js');
const { payroll } = await import('./payroll.js');
const { saveLogs } = await import('./zk.js');

const shift = (name, s, e, wd) => Number(db.prepare('INSERT INTO shifts(name,start,end,grace_min,workdays) VALUES(?,?,?,10,?)').run(name, s, e, wd).lastInsertRowid);
const emp = (code, shiftId, extra = {}) => Number(db.prepare('INSERT INTO employees(code,name,shift_id,salary,join_date) VALUES(?,?,?,?,?)').run(code, 'Emp ' + code, shiftId, extra.salary ?? 0, extra.join ?? null).lastInsertRowid);
const punch = (code, date, ...times) => saveLogs(times.map(t => ({ code, ts: `${date} ${t}:00` })));
const row = (rows, code, date) => rows.find(r => r.code === code && r.date === date);

const day = shift('Day', '09:00', '18:00', '1,2,3,4,5');
const night = shift('Night', '22:00', '06:00', '0,1,2,3,4,5,6');

// --- September 2026 payroll scenario: 22 weekdays, salary 22000 -> 1000 per day
const A = emp('A', day, { salary: 22000, join: '2026-09-01' });
setSettings({ half_day_min: 270 });
for (let d = 1; d <= 30; d++) {
  const date = `2026-09-${String(d).padStart(2, '0')}`;
  if (![2, 3, 7, 8, 9].includes(d)) punch('A', date, '09:00', '18:00');
}
punch('A', '2026-09-03', '09:00', '12:00');   // half day
punch('A', '2026-09-07', '09:00', '20:10');   // 130 min after shift -> 120 paid overtime
db.prepare("INSERT INTO leaves(employee_id,from_date,to_date,type) VALUES(?,?,?,?)").run(A, '2026-09-08', '2026-09-08', 'Unpaid');
db.prepare("INSERT INTO leaves(employee_id,from_date,to_date,type) VALUES(?,?,?,?)").run(A, '2026-09-09', '2026-09-09', 'Casual');
// 09-01 is Tue; weekend punches from the loop above on Sat/Sun are "worked on weekly off" -> remove them for a clean month
db.exec("DELETE FROM logs WHERE emp_code='A' AND strftime('%w', substr(ts,1,10)) IN ('0','6')");

let rows = attendanceReport('2026-09-01', '2026-09-30');
assert.equal(row(rows, 'A', '2026-09-02').status, 'Absent');
assert.equal(row(rows, 'A', '2026-09-03').status, 'Half Day');
assert.equal(row(rows, 'A', '2026-09-07').overtime_min, 120);
assert.equal(row(rows, 'A', '2026-09-08').status, 'Unpaid Leave');
assert.equal(row(rows, 'A', '2026-09-09').status, 'Leave');
assert.equal(row(rows, 'A', '2026-09-05').status, 'Weekly Off');
const p = payroll('2026-09').find(x => x.code === 'A');
assert.equal(p.working_days, 22);
assert.equal(p.deduction_days, 2.5);           // 1 absent + 0.5 half + 1 unpaid
assert.equal(p.deduction, 2500);
assert.equal(p.overtime_pay, 333.33);          // 2h * (1000/9h) * 1.5
assert.equal(p.net, 19833.33);
// monthly adjustments: +1000 allowance, -500 advance
db.prepare("INSERT INTO payroll_items(employee_id,month,kind,amount) VALUES(?,?,?,?)").run(A, '2026-09', 'allowance', 1000);
db.prepare("INSERT INTO payroll_items(employee_id,month,kind,amount) VALUES(?,?,?,?)").run(A, '2026-09', 'advance', 500);
const p2 = payroll('2026-09').find(x => x.code === 'A');
assert.equal(p2.allowances, 1000); assert.equal(p2.advances, 500); assert.equal(p2.net, 20333.33);
setSettings({ half_day_min: 0 });

// --- overnight shift: 21:55 -> 06:30 next day belongs to the day the shift started
emp('N', night, { join: '2026-09-14' });
punch('N', '2026-09-14', '21:55'); punch('N', '2026-09-15', '06:30');
rows = attendanceReport('2026-09-14', '2026-09-15');
const n14 = row(rows, 'N', '2026-09-14');
assert.equal(n14.status, 'Present'); assert.equal(n14.out, '06:30 +1'); assert.equal(n14.worked_min, 515);
assert.equal(n14.overtime_min, 30);
assert.equal(row(rows, 'N', '2026-09-15').status, 'Absent'); // that 06:30 punch must not make the 15th "present"

// --- holiday / weekly-off work, late-to-absent, double tap, unknown employee, join date
db.prepare("INSERT INTO holidays(date,name) VALUES('2026-08-17','Test Day')").run();
emp('H', day, { join: '2026-08-10' }); emp('H2', day, { join: '2026-08-10' });
punch('H', '2026-08-17', '10:00', '14:00');     // holiday worked: 240 min overtime
punch('H', '2026-08-16', '10:00', '13:00');     // Sunday worked
punch('H2', '2026-08-10', '09:00', '18:00');
rows = attendanceReport('2026-08-10', '2026-08-18');
assert.equal(row(rows, 'H', '2026-08-17').status, 'Present');
assert.equal(row(rows, 'H', '2026-08-17').overtime_min, 240);
assert.equal(row(rows, 'H', '2026-08-16').overtime_min, 180);
assert.equal(row(rows, 'H2', '2026-08-17').status, 'Holiday');
assert.equal(row(rows, 'H2', '2026-08-16').status, 'Weekly Off');

setSettings({ late_to_absent_min: 120 });
emp('L', day, { join: '2026-08-10' }); punch('L', '2026-08-11', '11:30', '18:00');
assert.equal(row(attendanceReport('2026-08-11', '2026-08-11'), 'L', '2026-08-11').status, 'Absent');
setSettings({ late_to_absent_min: 0 });
assert.equal(row(attendanceReport('2026-08-11', '2026-08-11'), 'L', '2026-08-11').status, 'Late');

emp('D', day, { join: '2026-08-10' }); punch('D', '2026-08-12', '09:00', '09:01'); // double tap = one punch
assert.equal(row(attendanceReport('2026-08-12', '2026-08-12'), 'D', '2026-08-12').status, 'Missing Out');

punch('999', '2026-08-12', '09:00', '18:00');   // never registered: employee is created, not lost
assert.equal(db.prepare("SELECT name FROM employees WHERE code='999'").get().name, 'User 999');

emp('J', day);                                  // no join date, no punches: no past days counted absent
assert.equal(attendanceReport('2026-01-01', '2026-01-31').filter(r => r.code === 'J').length, 0);

// --- roster: a date-range shift overrides the employee's own shift (day employee moved to nights for 2 days)
const R = emp('R', day, { join: '2026-08-10' });
db.prepare('INSERT INTO schedules(employee_id,shift_id,from_date,to_date) VALUES(?,?,?,?)').run(R, night, '2026-08-19', '2026-08-20');
punch('R', '2026-08-18', '09:00', '18:00');                         // normal day shift
punch('R', '2026-08-19', '21:58'); punch('R', '2026-08-20', '06:05'); // rostered night shift
rows = attendanceReport('2026-08-18', '2026-08-20');
assert.equal(row(rows, 'R', '2026-08-18').status, 'Present');
assert.equal(row(rows, 'R', '2026-08-19').status, 'Present');
assert.equal(row(rows, 'R', '2026-08-19').out, '06:05 +1');

// --- employment window: resigned staff stay in the report up to their last day; rejoining counts again from that date
const X = emp('X', day, { join: '2026-08-10' });
db.prepare("UPDATE employees SET active=0, status='resigned' WHERE id=?").run(X);
db.prepare("INSERT INTO emp_history(employee_id,kind,date) VALUES(?,?,?)").run(X, 'resignation', '2026-08-14');
let xr = attendanceReport('2026-08-10', '2026-08-20').filter(r => r.code === 'X').map(r => r.date);
assert.equal(xr[0], '2026-08-10'); assert.equal(xr.at(-1), '2026-08-14', 'no rows after the last working day');
db.prepare("UPDATE employees SET active=1, status='active' WHERE id=?").run(X);
db.prepare("INSERT INTO emp_history(employee_id,kind,date) VALUES(?,?,?)").run(X, 'rejoin', '2026-08-18');
xr = attendanceReport('2026-08-10', '2026-08-20').filter(r => r.code === 'X').map(r => r.date);
assert.deepEqual(xr, ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-18', '2026-08-19', '2026-08-20'], 'gap between exit and rejoin is not counted');
const Y = emp('Y', day, { join: '2026-08-10' }); db.prepare('UPDATE employees SET active=0 WHERE id=?').run(Y);
assert.equal(attendanceReport('2026-08-10', '2026-08-20').some(r => r.code === 'Y'), false, 'plain inactive staff are left out');
assert.equal(attendanceReport('2026-08-10', '2026-08-20', { employeeId: X }).every(r => r.code === 'X'), true);

// --- leave balances: accrual, proration, carry forward, holidays, half days, policy override
const { balanceFor, empInfo, leaveDaysByYear } = await import('./leave.js');
const type = (n) => db.prepare('SELECT * FROM leave_types WHERE name=?').get(n);
const L = emp('L1', day, { join: '2025-03-10' });                       // Mon-Fri shift, joined March 2025
const lv = (from, to, t, status = 'approved', half = 0) => db.prepare('INSERT INTO leaves(employee_id,from_date,to_date,type,status,half) VALUES(?,?,?,?,?,?)').run(L, from, to, t, status, half);
assert.equal(balanceFor(empInfo(L), type('Casual'), 2025, '2026-03-15').accrued, 8.5, 'yearly quota prorated from join month (10 x 10/12 -> nearest half)');
assert.equal(balanceFor(empInfo(L), type('Casual'), 2026, '2026-03-15').accrued, 10);
const L2 = emp('L2', day, { join: '2025-01-01' }); const lv2 = (a, b, t, st = 'approved') => db.prepare('INSERT INTO leaves(employee_id,from_date,to_date,type,status) VALUES(?,?,?,?,?)').run(L2, a, b, t, st);
lv2('2025-06-02', '2025-06-06', 'Annual');                                // 5 days in 2025
let ann = balanceFor(empInfo(L2), type('Annual'), 2025, '2026-03-15'); assert.equal(ann.accrued, 14); assert.equal(ann.used, 5); assert.equal(ann.available, 9);
ann = balanceFor(empInfo(L2), type('Annual'), 2026, '2026-03-15');
assert.equal(ann.accrued, 3.5, 'monthly accrual: 14/12 x 3 months'); assert.equal(ann.carry_forward, 7, 'carry forward capped at 7 although 9 were unused'); assert.equal(ann.available, 10.5);
lv2('2026-03-02', '2026-03-03', 'Annual', 'pending');
assert.equal(balanceFor(empInfo(L2), type('Annual'), 2026, '2026-03-15').available, 8.5, 'pending leave is reserved');
lv2('2026-03-09', '2026-03-09', 'Annual', 'rejected'); lv2('2026-03-10', '2026-03-10', 'Annual', 'cancelled');
assert.equal(balanceFor(empInfo(L2), type('Annual'), 2026, '2026-03-15').available, 8.5, 'rejected and cancelled leave cost nothing');
db.prepare("INSERT INTO holidays(date,name) VALUES('2026-03-04','H')").run();
assert.equal([...leaveDaysByYear(empInfo(L2), '2026-03-02', '2026-03-08', 0).values()][0], 4, 'holiday and weekend are not counted (Mon,Tue,Thu,Fri)');
assert.equal([...leaveDaysByYear(empInfo(L2), '2026-03-02', '2026-03-02', 1).values()][0], 0.5, 'half day');
assert.equal([...leaveDaysByYear(empInfo(L2), '2025-12-29', '2026-01-02', 0).entries()].map(e => e.join(':')).join(), '2025:3,2026:2', 'a leave across new year splits by year');
assert.equal(balanceFor(empInfo(L2), type('Unpaid'), 2026, '2026-03-15').tracked, false, 'quota 0 = not tracked');
const pol = Number(db.prepare("INSERT INTO leave_policies(name) VALUES('Senior')").run().lastInsertRowid);
db.prepare('INSERT INTO leave_policy_items(policy_id,type_id,quota,accrual,carry_max) VALUES(?,?,?,?,?)').run(pol, type('Casual').id, 20, 'yearly', 0);
db.prepare('UPDATE employees SET leave_policy_id=? WHERE id=?').run(pol, L2);
assert.equal(balanceFor(empInfo(L2), type('Casual'), 2026, '2026-03-15').accrued, 20, 'policy overrides the leave type default');
// only approved leave changes attendance
rows = attendanceReport('2026-03-02', '2026-03-03', { employeeId: L2 });
assert.deepEqual(rows.map(r => r.status), ['Absent', 'Absent'], 'pending leave does not excuse absence');
db.prepare("UPDATE leaves SET status='approved' WHERE employee_id=? AND from_date='2026-03-02'").run(L2);
assert.deepEqual(attendanceReport('2026-03-02', '2026-03-03', { employeeId: L2 }).map(r => r.status), ['Leave', 'Leave']);

// --- overtime policy: pre-shift, rounding, daily and monthly caps, approval, manual entries, per-policy multiplier
const otPol = (name, f = {}) => Number(db.prepare('INSERT INTO ot_policies(name, post, pre, min_minutes, round_minutes, mult_work, daily_max, monthly_max, approval) VALUES(?,?,?,?,?,?,?,?,?)')
  .run(name, f.post ?? 1, f.pre ?? 0, 30, 15, f.mult ?? 1.5, f.daily ?? 0, f.monthly ?? 0, f.approval ?? 0).lastInsertRowid);
const withPol = (code, p) => { const id = emp(code, day, { join: '2026-07-01', salary: 23000 }); db.prepare('UPDATE employees SET ot_policy_id=? WHERE id=?').run(p, id); return id; };
const capped = otPol('Capped', { pre: 1, daily: 120, monthly: 300 }); withPol('OT1', capped);
punch('OT1', '2026-07-06', '08:10', '19:00');   // pre 50->45, post 60  = 105
punch('OT1', '2026-07-07', '08:00', '20:30');   // pre 60 + post 150 = 210 -> daily cap 120
punch('OT1', '2026-07-08', '09:00', '19:40');   // post 100 -> 90; month total would be 315 -> capped to 75
punch('OT1', '2026-07-09', '09:00', '19:00');   // 60 but the monthly 300 is used up -> 0
const ot = (rs, d) => rs.find(r => r.code === 'OT1' && r.date === d);
rows = attendanceReport('2026-07-06', '2026-07-09', { employeeId: db.prepare("SELECT id FROM employees WHERE code='OT1'").get().id });
assert.deepEqual(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09'].map(d => ot(rows, d).ot_calc_min), [105, 120, 75, 0]);
assert.equal(ot(rows, '2026-07-06').ot_pre_min, 45, 'early arrival counts and is rounded down');
assert.match(ot(rows, '2026-07-07').note, /Daily overtime limit/); assert.match(ot(rows, '2026-07-09').note, /Monthly overtime limit/);
rows = attendanceReport('2026-07-08', '2026-07-09'); // the range starts mid-month: the cap still counts the earlier days
assert.deepEqual([ot(rows, '2026-07-08').ot_calc_min, ot(rows, '2026-07-09').ot_calc_min], [75, 0], 'monthly cap is not reset by the report range');

const needApproval = otPol('Approval', { approval: 1 }); const O2 = withPol('OT2', needApproval);
punch('OT2', '2026-07-06', '09:00', '19:00');
const reqRow = () => attendanceReport('2026-07-06', '2026-07-06', { employeeId: O2 })[0];
assert.equal(reqRow().ot_calc_min, 60); assert.equal(reqRow().ot_status, 'pending'); assert.equal(reqRow().ot_approved_min, 0, 'unapproved overtime is not payable');
db.prepare("INSERT INTO overtime_requests(employee_id,date,kind,calc_minutes,minutes,status) VALUES(?,?,'auto',60,45,'approved')").run(O2, '2026-07-06');
assert.equal(reqRow().ot_approved_min, 45, 'only the approved minutes are payable'); assert.equal(reqRow().ot_status, 'approved');
db.prepare("UPDATE overtime_requests SET status='rejected' WHERE employee_id=?").run(O2);
assert.equal(reqRow().ot_approved_min, 0);
db.prepare("INSERT INTO overtime_requests(employee_id,date,kind,calc_minutes,minutes,status) VALUES(?,?,'manual',90,90,'approved')").run(O2, '2026-07-11');
const sat = attendanceReport('2026-07-11', '2026-07-11', { employeeId: O2 })[0];
assert.equal(sat.ot_manual_min, 90); assert.equal(sat.ot_approved_min, 90); assert.equal(sat.overtime_min, 90);

const dbl = otPol('Double', { mult: 2 }); const O3 = withPol('OT3', dbl); punch('OT3', '2026-07-06', '09:00', '19:00');
const p3 = payroll('2026-07').find(x => x.code === 'OT3');
assert.equal(p3.overtime_hours, 1); assert.equal(p3.overtime_pay, 222.22, '1 h x (1000/9) x policy multiplier 2');
// day overrides (approved on-duty) count as present
const O4 = emp('OT4', day, { join: '2026-07-01' }); punch('OT4', '2026-07-03', '09:00', '18:00');
db.prepare("INSERT INTO day_overrides(employee_id,date,status,note) VALUES(?,?,'On Duty','Client visit')").run(O4, '2026-07-06');
const od = attendanceReport('2026-07-06', '2026-07-06', { employeeId: O4 })[0]; assert.equal(od.status, 'On Duty'); assert.equal(od.note, 'Client visit');
assert.equal(summarize([od])[0].present, 1);

// --- shift types: flexible, split, break, shift-level rules, alternate offs, rotation, department shift, alternates, roster carving
const { setRoster, shiftCalendar, validAltOff, shiftPaidHours } = await import('./shifts.js');
const mkShift = (o) => { const c = Object.keys(o); return Number(db.prepare(`INSERT INTO shifts(${c}) VALUES(${c.map(() => '?')})`).run(...c.map(k => o[k])).lastInsertRowid); };
const em = (code, shiftId, extra = {}) => { const id = emp(code, shiftId, { join: '2026-06-01', ...extra }); return id; };
const one = (code, date) => attendanceReport(date, date).find(r => r.code === code);

const flex = mkShift({ name: 'Flexi', type: 'flexible', start: '07:00', end: '22:00', grace_min: 0, workdays: '1,2,3,4,5', required_min: 480 });
em('FX1', flex);
punch('FX1', '2026-07-06', '10:15', '18:30');                       // 8h15: fine, no lateness however late they start
punch('FX1', '2026-07-07', '11:00', '17:00');                       // 6h: short by 2h
punch('FX1', '2026-07-08', '08:00', '17:30');                       // 9h30: 90 min over
assert.equal(one('FX1', '2026-07-06').status, 'Present'); assert.equal(one('FX1', '2026-07-06').late_min, 0);
assert.equal(one('FX1', '2026-07-07').status, 'Short Hours'); assert.equal(one('FX1', '2026-07-07').early_min, 120);
assert.equal(one('FX1', '2026-07-08').overtime_min, 90);
assert.equal(shiftPaidHours({ start: '07:00', end: '22:00', type: 'flexible', required_min: 480 }), 8);

const brk = mkShift({ name: 'With break', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5', break_start: '13:00', break_end: '14:00' });
em('BR1', brk); punch('BR1', '2026-07-06', '09:00', '18:00'); punch('BR1', '2026-07-07', '09:00', '12:30');
assert.equal(one('BR1', '2026-07-06').worked_min, 480, 'the unpaid lunch hour is not work'); assert.equal(one('BR1', '2026-07-07').worked_min, 210, 'left before the break: nothing to subtract');
assert.equal(shiftPaidHours({ start: '09:00', end: '18:00', break_start: '13:00', break_end: '14:00' }), 8);

const spl = mkShift({ name: 'Split', type: 'split', start: '09:00', end: '13:00', seg2_start: '17:00', seg2_end: '21:00', grace_min: 10, workdays: '1,2,3,4,5' });
em('SP1', spl); em('SP2', spl);
punch('SP1', '2026-07-06', '09:00', '13:00', '17:00', '21:30');   // four punches: real gap is subtracted
punch('SP2', '2026-07-06', '09:20', '21:00');                       // two punches: the scheduled gap is subtracted
assert.equal(one('SP1', '2026-07-06').worked_min, 510); assert.equal(one('SP1', '2026-07-06').overtime_min, 30); assert.equal(one('SP1', '2026-07-06').status, 'Present');
assert.equal(one('SP2', '2026-07-06').worked_min, 460); assert.equal(one('SP2', '2026-07-06').late_min, 20); assert.equal(one('SP2', '2026-07-06').status, 'Late');
assert.equal(shiftPaidHours({ start: '09:00', end: '13:00', seg2_start: '17:00', seg2_end: '21:00', type: 'split' }), 8);

const strict = mkShift({ name: 'Strict', start: '09:00', end: '18:00', grace_min: 5, workdays: '1,2,3,4,5', late_to_absent_min: 60, half_day_min: 300 });
em('ST1', strict); em('ST2', strict); punch('ST1', '2026-07-06', '10:30', '18:00'); punch('ST2', '2026-07-06', '09:00', '13:00');
assert.equal(one('ST1', '2026-07-06').status, 'Absent', 'this shift counts 90 minutes late as absent even though Settings says off'); assert.equal(one('ST2', '2026-07-06').status, 'Half Day');
assert.equal(one('BR1', '2026-07-06').status, 'Present');            // other shifts keep the global rules

const alt = mkShift({ name: 'Alt Sat', start: '09:00', end: '18:00', grace_min: 10, workdays: '1,2,3,4,5,6', alt_off: '6:2,4' });
em('AL1', alt);
assert.equal(one('AL1', '2026-07-04').day_type, 'work', '1st Saturday works'); assert.equal(one('AL1', '2026-07-11').day_type, 'weekend', '2nd Saturday is off');
assert.equal(one('AL1', '2026-07-25').day_type, 'weekend', '4th Saturday is off'); assert.equal(one('AL1', '2026-07-18').day_type, 'work');
assert.ok(validAltOff('6:2,4;0:*') && validAltOff('') && !validAltOff('9:1') && !validAltOff('6:7') && !validAltOff('x'));

const mor = mkShift({ name: 'Morning', code: 'M', start: '06:00', end: '14:00', grace_min: 10, workdays: '1,2,3,4,5' });
const eve = mkShift({ name: 'Evening', code: 'E', start: '14:00', end: '22:00', grace_min: 10, workdays: '1,2,3,4,5' });
const rot = Number(db.prepare("INSERT INTO rotations(name) VALUES('2 on morning, off, 2 on evening')").run().lastInsertRowid);
[[mor, 2], [null, 1], [eve, 2]].forEach(([s, d], i) => db.prepare('INSERT INTO rotation_steps(rotation_id, seq, shift_id, days) VALUES(?,?,?,?)').run(rot, i, s, d));
const RO = em('RO1', null); db.prepare("UPDATE employees SET rotation_id=?, rotation_anchor='2026-07-06' WHERE id=?").run(rot, RO);
const expect = { '2026-07-06': 'Morning', '2026-07-07': 'Morning', '2026-07-08': '', '2026-07-09': 'Evening', '2026-07-10': 'Evening', '2026-07-11': 'Morning', '2026-07-12': 'Morning', '2026-07-13': '' };
punch('RO1', '2026-07-12', '06:00', '14:00');                       // a Sunday, but rotation days ignore the calendar week
punch('RO1', '2026-07-09', '14:05', '22:00');
const ro = attendanceReport('2026-07-06', '2026-07-13', { employeeId: RO });
assert.deepEqual(ro.map(r => r.shift), Object.values(expect), 'rotation cycle repeats from the anchor date');
assert.equal(ro.find(r => r.date === '2026-07-08').status, 'Weekly Off'); assert.equal(ro.find(r => r.date === '2026-07-12').status, 'Present'); assert.equal(ro.find(r => r.date === '2026-07-12').day_type, 'work');
assert.equal(ro.find(r => r.date === '2026-07-09').status, 'Present');
setRoster(RO, '2026-07-06', '2026-07-06', eve);                       // roster entry beats the rotation
assert.equal(attendanceReport('2026-07-06', '2026-07-06', { employeeId: RO })[0].shift, 'Evening');

const dsh = mkShift({ name: 'Dept shift', start: '08:00', end: '16:00', grace_min: 10, workdays: '1,2,3,4,5' });
const dep = Number(db.prepare("INSERT INTO departments(name, shift_id) VALUES('Plant', ?)").run(dsh).lastInsertRowid);
const D1 = em('DP1', null), D2 = em('DP2', mor); db.prepare('UPDATE employees SET department_id=? WHERE id IN (?,?)').run(dep, D1, D2);
assert.equal(one('DP1', '2026-07-07').shift, 'Dept shift', 'no own shift: the department shift applies'); assert.equal(one('DP2', '2026-07-07').shift, 'Morning', 'own shift beats the department shift');

const MS = em('MS1', mor); db.prepare('INSERT INTO employee_shifts(employee_id, shift_id) VALUES(?,?)').run(MS, eve);
punch('MS1', '2026-07-07', '05:55', '14:00'); punch('MS1', '2026-07-08', '13:50', '22:00');
assert.equal(one('MS1', '2026-07-07').shift, 'Morning'); assert.equal(one('MS1', '2026-07-08').shift, 'Evening', 'several allowed shifts: the one nearest the arrival time');
assert.equal(one('MS1', '2026-07-08').late_min, 0);

const triple = Number(db.prepare("INSERT INTO ot_policies(name, mult_work, min_minutes, round_minutes) VALUES('Shift triple', 3, 30, 15)").run().lastInsertRowid);
const otShift = mkShift({ name: 'OT shift', start: '09:00', end: '17:00', grace_min: 10, workdays: '1,2,3,4,5', ot_policy_id: triple });
em('OS1', otShift); punch('OS1', '2026-07-06', '09:00', '18:00');
assert.equal(one('OS1', '2026-07-06').ot_mult, 3, 'the shift brings its own overtime policy'); assert.equal(one('OS1', '2026-07-06').overtime_min, 60);

// roster carving: a new entry cuts older overlapping ones instead of leaving ambiguous overlaps
const RC = em('RC1', mor);
setRoster(RC, '2026-07-01', '2026-07-10', mor); setRoster(RC, '2026-07-04', '2026-07-05', eve);
assert.deepEqual(db.prepare('SELECT shift_id, from_date, to_date FROM schedules WHERE employee_id=? ORDER BY from_date').all(RC).map(r => `${r.shift_id === mor ? 'M' : 'E'} ${r.from_date}..${r.to_date}`),
  ['M 2026-07-01..2026-07-03', 'E 2026-07-04..2026-07-05', 'M 2026-07-06..2026-07-10']);
const cal = shiftCalendar({ month: '2026-07' }); const roRow = cal.rows.find(r => r.code === 'RO1');
assert.equal(cal.days.length, 31); assert.equal(roRow.cells[7].c, 'OFF'); assert.equal(roRow.cells[8].c, 'E'); assert.equal(cal.rows.find(r => r.code === 'AL1').cells[10].c, 'OFF');

// --- scheduled notifications: e-mail, once-a-day scheduling, and the device IP allow-list
process.env.SMTP_URL = 'json:';
const { runRule, tickRules, mailbox } = await import('./rules.js');
const { ipAllowed } = await import('./devsync.js');
const alld = mkShift({ name: 'Every day', start: '09:00', end: '18:00', grace_min: 10, workdays: '0,1,2,3,4,5,6' });
const yday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA'); })();
const MP = emp('MP1', alld, { join: '2020-01-01' }); db.prepare("UPDATE employees SET email='mp1@example.com' WHERE id=?").run(MP); punch('MP1', yday, '09:00');   // punched in yesterday, never out
const rule = (k) => db.prepare('SELECT * FROM notification_rules WHERE kind=?').get(k);
db.prepare("UPDATE notification_rules SET email=1 WHERE kind='missing_punch'").run();
let r0 = await runRule(rule('missing_punch'));
assert.equal(r0.sent, 1); assert.equal(r0.emails, 1); assert.equal(mailbox.length, 1); assert.equal(mailbox[0].to[0].address, 'mp1@example.com'); assert.match(mailbox[0].subject, /forgot to punch out yesterday/); assert.match(mailbox[0].text, /punched in at 09:00/);
assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE audience='employee' AND title LIKE '%forgot to punch out%'").get().n, 1, 'also shown inside the app');
db.prepare("UPDATE notification_rules SET email=0 WHERE kind='missing_punch'").run(); r0 = await runRule(rule('missing_punch')); assert.equal(r0.emails, 0, 'no e-mail unless the rule asks for it');
// scheduling: a rule runs once a day, at or after its time, and only when enabled
db.prepare("UPDATE notification_rules SET enabled=1, at='09:00', last_run=NULL WHERE kind='missing_punch'").run(); const before = db.prepare("SELECT COUNT(*) n FROM notifications").get().n;
await tickRules(new Date(new Date().setHours(8, 59, 0, 0))); assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications").get().n, before, 'before its time nothing happens');
await tickRules(new Date(new Date().setHours(9, 1, 0, 0))); const after = db.prepare("SELECT COUNT(*) n FROM notifications").get().n; assert.equal(after, before + 1); assert.equal(rule('missing_punch').last_run, new Date().toLocaleDateString('en-CA'));
await tickRules(new Date(new Date().setHours(9, 30, 0, 0))); assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications").get().n, after, 'it does not run twice in one day');
db.prepare("UPDATE notification_rules SET enabled=0 WHERE kind='missing_punch'").run();
assert.ok(ipAllowed('1.2.3.4', '') && ipAllowed('::ffff:10.0.0.5', '10.0.0.5') && !ipAllowed('10.0.0.6', '10.0.0.5') && ipAllowed('192.168.7.9', '10.0.0.5, 192.168.0.0/16') && !ipAllowed('192.169.0.1', '192.168.0.0/16') && ipAllowed('::1', '::1') && ipAllowed('8.8.8.8', '0.0.0.0/0') && ipAllowed('10.0.0.255', '10.0.0.0/24') && !ipAllowed('10.0.1.1', '10.0.0.0/24'), 'allow-list matching');

const sum = summarize(attendanceReport('2026-09-01', '2026-09-30')).find(s => s.code === 'A');
assert.equal(sum.absent, 1); assert.equal(sum.unpaid_leave, 1); assert.equal(sum.leave, 1); assert.equal(sum.half_day, 0); // half-day rule is off again
assert.deepEqual(Object.keys(DEFAULTS).length > 5, true);
console.log('all tests passed');
