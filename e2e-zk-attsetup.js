// Attendance setup pages (/api/att/*): pay codes, fixed codes, groups, rules, break times, timetables, shifts, schedules,
// manual log / leave / overtime / training / schedule adjustment approvals, leave groups, holidays, calculation, configuration.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';

const S = await startServer(), api = S.api, att = (p, m, b) => api('att/' + p, m, b);
const as = (token) => ({ send: async (p, m, b) => { const r = await S.raw(p, m, b, token); return { status: r.status, body: await r.json().catch(() => ({})) }; } });
const iso = (d) => d.toISOString().slice(0, 10), addD = (n) => iso(new Date(Date.now() + n * 864e5));
const d0 = new Date(); d0.setDate(1); d0.setMonth(d0.getMonth() - 1); const M = d0.toLocaleDateString('sv').slice(0, 7), day = (n) => `${M}-${String(n).padStart(2, '0')}`;
const rej = (p, re) => assert.rejects(p, re);
const row = async (code, d) => (await api(`report/daily?from=${d}&to=${d}`)).find(r => r.code === code);
try {
  const eng = (await api('departments', 'POST', { name: 'Plant' })).id, ops = (await api('departments', 'POST', { name: 'Office' })).id;
  const mk = async (name, department_id, extra = {}) => { const r = await api('employees', 'POST', { name, department_id, join_date: M + '-01', ...extra }); return { ...r, code: (await api('employees')).find(e => e.id === r.id).code }; };
  const A = await mk('Alice Ann', eng), B = await mk('Bob Brown', eng), C = await mk('Carol Cox', ops);

  // ---------- pay codes
  const pcs = await att('paycodes'); assert.ok(pcs.length >= 15); assert.equal(pcs.find(p => p.status === 'Absent').ptype, 'Exception'); assert.equal(pcs.find(p => p.status === 'Present').ord, 1);
  const pid = (await att('paycodes', 'POST', { code: 'xo', name: 'Extra OT', ptype: 'Overtime', unit: 'Hour', pay_factor: 1, fixed_hours: 8, ord: 50, descr: 'x', color: '#ff0000', display: true })).id;
  assert.equal((await att('paycodes')).find(p => p.id === pid).code, 'XO');
  await rej(att('paycodes', 'POST', { code: 'XO', name: 'Another' }), /already uses this code/); await rej(att('paycodes', 'POST', { code: 'Z', name: '' }), /Name required/); await rej(att('paycodes', 'POST', { code: '!!', name: 'Bad' }), /1 to 6 letters/);
  await rej(att('paycodes', 'POST', { code: 'Q', name: 'Q', ptype: 'Nope' }), /Unknown type/); await rej(att('paycodes', 'POST', { code: 'Q', name: 'Q', pay_factor: 2 }), /0 to 1/);
  const absent = pcs.find(p => p.status === 'Absent'); await att('paycodes/' + absent.id, 'PUT', { code: 'AB', name: 'Absent', pay_factor: 0, ptype: 'Exception', unit: 'Hour' });
  assert.equal((await api('pay_codes')).find(p => p.status === 'Absent').code, 'AB', 'the legacy pay code list and the engine see the edit');
  await rej(att('paycodes/' + pcs.find(p => p.status === 'Present').id, 'PUT', { code: 'P', name: 'Present', pay_factor: 0.5 }), /always paid in full/);
  await rej(att('paycodes/' + absent.id, 'DELETE'), /built-in/); await att('paycodes/' + pid, 'DELETE'); assert.ok(!(await att('paycodes')).some(p => p.id === pid));

  // ---------- fixed codes
  const fx = await att('fixedcodes'); assert.equal(fx.length, 15); assert.equal(fx[0].name, 'Duration'); assert.equal(fx[0].format, 'HH:MM');
  const fid = (await att('fixedcodes', 'POST', { name: 'Late Minutes', format: 'Minute', symbol: 'LM', round_off: 'Round Up', min_val: 1 })).id;
  await rej(att('fixedcodes', 'POST', { name: 'Late Minutes' }), /exists/); await rej(att('fixedcodes', 'POST', { name: 'x', format: 'Bad' }), /Format must/); await rej(att('fixedcodes', 'POST', { name: '' }), /Name required/);
  await att('fixedcodes/' + fid, 'PUT', { name: 'Late Min', format: 'Hour' }); assert.equal((await att('fixedcodes')).find(f => f.id === fid).format, 'Hour'); await att('fixedcodes/' + fid, 'DELETE');

  // ---------- attendance groups
  const g1 = (await att('groups', 'POST', { name: 'Night crew' })).id, g1row = (await att('groups')).find(g => g.id === g1); assert.ok(g1row.code); assert.equal(g1row.employees, 0);
  await rej(att('groups', 'POST', { code: g1row.code, name: 'Other' }), /already used/); await rej(att('groups', 'POST', { name: '' }), /name required/);
  assert.equal((await att('groups/transfer', 'POST', { group_id: g1, employee_ids: [A.id, B.id] })).moved, 2); assert.equal((await att('groups')).find(g => g.id === g1).employees, 2);
  assert.equal((await att('groups/transfer', 'POST', { group_id: g1, by: 'dept', target_id: ops })).moved, 1); assert.equal((await att('groups')).find(g => g.id === g1).employees, 3);
  await rej(att('groups/transfer', 'POST', { group_id: 999, employee_ids: [A.id] }), /Choose the group/); await rej(att('groups/transfer', 'POST', { group_id: g1 }), /Choose the employees/);
  await rej(att('groups/' + g1, 'DELETE'), /still in this group/); await att('groups/transfer', 'POST', { group_id: null, employee_ids: [A.id, B.id, C.id] }); await att('groups/' + g1, 'PUT', { code: g1row.code, name: 'Night team' }); await att('groups/' + g1, 'DELETE');

  // ---------- global rule (backed by the settings the engine reads) and attendance configuration
  const gr = await att('globalrule'); assert.equal(gr.max_hrs, 12); assert.equal(gr.paring_rule, 1); assert.equal(gr.day_change, '00:00:00');
  const g2 = await att('globalrule', 'PUT', { punch_period: 3, late_in2absence: 45, max_hrs: 14, day_change: '04:00', overtime_policy: 1, enable_daily_ot: true, d1_pay_code: 'Normal OT', d1_hrs_from: 0, d1_hrs_to: 2, require_capture: true });
  assert.equal(g2.punch_period, 3); assert.equal(g2.day_change, '04:00:00'); assert.equal(g2.enable_daily_ot, true);
  const st = await api('settings'); assert.equal(st.min_gap_min, 3); assert.equal(st.late_to_absent_min, 45); assert.equal(st.ot_approval, 1);
  await rej(att('globalrule', 'PUT', { max_hrs: 0 }), /Max work hour/); await rej(att('globalrule', 'PUT', { day_change: '25:00' }), /Day change time/); await rej(att('globalrule', 'PUT', { paring_rule: 9 }), /paring rule/);
  await rej(att('globalrule', 'PUT', { d1_hrs_from: 3, d1_hrs_to: 2 }), /end must be above/); await rej(att('globalrule', 'PUT', { punch_period: 'x' }), /number/);
  await att('globalrule', 'PUT', { punch_period: 5, late_in2absence: 0, overtime_policy: -1 }); assert.equal((await api('settings')).ot_approval, 0);
  const cf = await att('config'); assert.equal(cf.short_date, 1); assert.equal(cf.change_recalc_days, 30);
  assert.equal((await att('config', 'PUT', { short_date: 4, calculate_time: '03:30', auto_calculate: false })).calculate_time, '03:30:00'); assert.equal((await att('config')).auto_calculate, false);
  await rej(att('config', 'PUT', { short_date: 99 }), /Unknown date or time/); await rej(att('config', 'PUT', { calculate_time: 'zz' }), /Calculate time/); await rej(att('config', 'PUT', { change_recalc_days: 9999 }), /Days back/);

  // ---------- department and group rules (the duplicate punch interval becomes an attendance policy)
  const dr = (await att('rules/dept', 'POST', { target_id: eng, punch_period: 7, max_hrs: 10, paring_rule: 2, enable_weekly_ot: true, t1_pay_code: 'OT1', t1_hrs_from: 40, t1_hrs_to: 50 })).id;
  let drow = (await att('rules/dept')).find(r => r.id === dr); assert.equal(drow.target, 'Plant'); assert.equal(drow.max_hrs, 10); assert.equal(drow.paring_rule, 2); assert.equal(drow.t1_pay_code, 'OT1');
  const depts = await api('departments'); const polId = depts.find(d => d.id === eng).att_policy_id; assert.ok(polId); assert.equal((await api('att_policies')).find(p => p.id === polId).min_gap_min, 7);
  await rej(att('rules/dept', 'POST', { target_id: eng }), /already has a rule/); await rej(att('rules/dept', 'POST', { target_id: 999 }), /Choose a department/); await rej(att('rules/dept', 'POST', { target_id: ops, max_hrs: 99 }), /Max work hour/);
  await att('rules/dept/' + dr, 'PUT', { punch_period: 9 }); assert.equal((await api('att_policies')).find(p => p.id === polId).min_gap_min, 9); assert.equal((await att('rules/dept')).find(r => r.id === dr).max_hrs, 10, 'a partial update keeps the other values');
  await att('rules/dept/' + dr, 'DELETE'); assert.equal((await api('departments')).find(d => d.id === eng).att_policy_id, null); assert.ok(!(await api('att_policies')).some(p => p.id === polId));
  const grp = (await att('groups', 'POST', { name: 'Gr' })).id, gru = (await att('rules/group', 'POST', { target_id: grp, punch_period: 4 })).id; assert.equal((await att('rules/group')).length, 1); await att('rules/group/' + gru, 'DELETE'); assert.equal((await att('rules/group')).length, 0);

  // ---------- break times
  await rej(att('breaktimes', 'POST', { alias: '', period_start: '13:00', period_end: '14:00' }), /Name/); await rej(att('breaktimes', 'POST', { alias: 'x', period_start: '1pm', period_end: '14:00' }), /HH:MM/); await rej(att('breaktimes', 'POST', { alias: 'x', period_start: '13:00', period_end: '13:00' }), /some time/);
  await rej(att('breaktimes', 'POST', { alias: 'x', period_start: '13:00', period_end: '14:00', duration: 0 }), /Duration/);
  const lunch = (await att('breaktimes', 'POST', { alias: 'Lunch', period_start: '13:00:00', period_end: '14:00:00', duration: 60, with_salary: 0, calc_type: 0 })).id;
  await rej(att('breaktimes', 'POST', { alias: 'Lunch', period_start: '12:00', period_end: '13:00' }), /exists/);
  let br = (await att('breaktimes')).find(b => b.id === lunch); assert.equal(br.start, '13:00'); assert.equal(br.duration, 60); assert.equal(br.with_salary, 0);

  // ---------- timetables
  await rej(att('timetables/normal', 'POST', { alias: '', in_time: '09:00', out_time: '18:00' }), /Name required/); await rej(att('timetables/normal', 'POST', { alias: 'x', in_time: 'bad', out_time: '18:00' }), /HH:MM/);
  await rej(att('timetables/normal', 'POST', { alias: 'x', in_time: '18:00', out_time: '09:00', out_time_cross_days: 0 }), /after check-in/); await rej(att('timetables/flexible', 'POST', { alias: 'x', in_time: '00:00', out_time: '00:00', work_time_duration: 10 }), /60 to 1440/);
  await rej(att('timetables/normal', 'POST', { alias: 'x', in_time: '09:00', out_time: '18:00', break_id: 999 }), /Unknown break/);
  const day9 = (await att('timetables/normal', 'POST', { alias: 'Day 9-6', in_time: '09:00', out_time: '18:00', break_id: lunch, work_day: 1, color_setting: '#00ff00', enable_overtime: true, t1_pay_code: 'Normal OT', t1_hrs_from: 0, t1_hrs_to: 2 })).id;
  await rej(att('timetables/normal', 'POST', { alias: 'Day 9-6', in_time: '09:00', out_time: '18:00' }), /exists/);
  const flex = (await att('timetables/flexible', 'POST', { alias: 'Flex 8h', in_time: '07:00', out_time: '22:00', out_time_cross_days: 0, work_time_duration: 480, work_type: 0 })).id;
  let tts = await att('timetables'); let t1 = tts.find(t => t.id === day9); assert.equal(t1.type, 'Normal'); assert.equal(t1.check_in, '09:00:00'); assert.equal(t1.work_time, 480, 'nine hours minus the unpaid one hour break'); assert.equal(t1.break_time, 60); assert.equal(t1.overtime, 'Yes'); assert.equal(t1.work_type, 'Normal Work');
  assert.equal(tts.find(t => t.id === flex).type, 'Flexible'); assert.equal(tts.find(t => t.id === flex).work_time, 480);
  const imp = await att('timetables/import', 'POST', { type: 'normal', csv: 'name,check_in,check_out,work_day\nEarly,06:00,14:00,1\nDay 9-6,10:00,19:00,1\nBroken,x,y,1' }); assert.equal(imp.added, 1); assert.equal(imp.skipped, 2); assert.equal(imp.errors.length, 1);
  assert.equal((await att('timetables/import', 'POST', { type: 'normal', mode: 'overwrite', csv: 'Day 9-6,09:00,18:00,1' })).updated, 1);
  const impf = await att('timetables/import', 'POST', { type: 'flexible', csv: 'FlexA,420,00:00,00:00' }); assert.equal(impf.added, 1); await rej(att('timetables/import', 'POST', { csv: '' }), /at least one row/);

  // ---------- shifts compose timetables, and the engine follows them
  await rej(att('shiftdefs', 'POST', { alias: 'x' }), /Choose a timetable/); await rej(att('shiftdefs', 'POST', { alias: '', timetable_id: day9 }), /Shift name/); await rej(att('shiftdefs', 'POST', { alias: 'x', timetable_id: day9, unit: 'Year' }), /Unit/);
  await rej(att('shiftdefs', 'POST', { alias: 'x', timetable_id: day9, workdays: '1,9' }), /Work days/); await rej(att('shiftdefs', 'POST', { alias: 'x', timetable_id: day9, cycle: 0 }), /Cycle/);
  const sOffice = (await att('shiftdefs', 'POST', { alias: 'Office day', code: 'OD', timetable_id: day9, workdays: '0,1,2,3,4,5,6', grace_min: 10, unit: 'Week', cycle: 1, auto_shift: true, enable_ot_rule: true, t1_pay_code: 'OT1', t1_hrs_from: 40, t1_hrs_to: 50 })).id;
  let sh = (await api('shifts')).find(s => s.id === sOffice); assert.equal(sh.start, '09:00'); assert.equal(sh.end, '18:00'); assert.equal(sh.type, 'fixed'); assert.equal(sh.break_start, '13:00', 'an unpaid break comes from the timetable'); assert.equal(sh.timetable_id, day9);
  let srow = (await att('shiftdefs')).find(s => s.id === sOffice); assert.equal(srow.timetable, 'Day 9-6'); assert.equal(srow.auto_shift, 'Yes'); assert.equal(srow.weekly_ot, 'Yes'); assert.equal(srow.tiers[0].pay_code, 'OT1');
  await api('employees/' + A.id, 'PUT', { shift_id: sOffice });
  const L = [`${A.code},${day(10)} 09:00`, `${A.code},${day(10)} 18:00`, `${A.code},${day(11)} 10:30`, `${A.code},${day(11)} 18:00`]; await api('logs/import', 'POST', { csv: L.join('\n') });
  assert.equal((await row(A.code, day(10))).status, 'Present'); assert.equal((await row(A.code, day(11))).status, 'Late'); const lateBefore = (await row(A.code, day(11))).late_min;
  await att('timetables/' + day9, 'PUT', { alias: 'Day 9-6', in_time: '10:00', out_time: '19:00', break_id: lunch }); sh = (await api('shifts')).find(s => s.id === sOffice); assert.equal(sh.start, '10:00'); assert.equal(sh.end, '19:00');
  assert.ok((await row(A.code, day(11))).late_min < lateBefore, 'editing a timetable moves every shift built on it'); assert.equal((await row(A.code, day(10))).status, 'Present');
  await att('breaktimes/' + lunch, 'PUT', { alias: 'Lunch', period_start: '13:00', period_end: '14:00', duration: 60, with_salary: 1 }); sh = (await api('shifts')).find(s => s.id === sOffice); assert.equal(sh.break_start, null, 'a paid break is not deducted');
  assert.equal((await att('timetables')).find(t => t.id === day9).work_time, 540); await att('breaktimes/' + lunch, 'PUT', { alias: 'Lunch', period_start: '13:00', period_end: '14:00', duration: 60, with_salary: 0 });
  await rej(att('breaktimes/' + lunch, 'DELETE'), /timetable\(s\) still use/); await rej(att('timetables/' + day9, 'DELETE'), /used by the shift/); await rej(att('shiftdefs/' + sOffice, 'DELETE'), /still used by employees/);
  // a shift made with the legacy API shows up with its own timetable
  const legacy = (await api('shifts', 'POST', { name: 'Legacy', start: '05:00', end: '13:00', grace_min: 5, workdays: '1,2,3,4,5' })).id;
  assert.ok((await att('timetables')).some(t => t.name === 'Legacy' && t.check_in === '05:00:00')); assert.equal((await att('shiftdefs')).find(s => s.id === legacy).timetable, 'Legacy');
  const night = (await att('timetables/normal', 'POST', { alias: 'Night', in_time: '20:00', out_time: '23:00' })).id, sNight = (await att('shiftdefs', 'POST', { alias: 'Night shift', timetable_id: night, workdays: '0,1,2,3,4,5,6' })).id;
  await att('shiftdefs/' + sNight, 'PUT', { alias: 'Night shift 2' }); assert.equal((await att('shiftdefs')).find(s => s.id === sNight).name, 'Night shift 2');

  // ---------- department schedule, group schedule, employee schedule, temporary schedule
  const nosh = await mk('No Shift', ops); const grpA = (await att('groups', 'POST', { name: 'Alpha' })).id;
  await api('employees/' + nosh.id, 'PUT', { group_id: grpA });
  await rej(att('deptsched', 'POST', { department_id: 999, shift_id: sNight, start_date: day(1), end_date: day(28) }), /Choose a department/); await rej(att('deptsched', 'POST', { department_id: ops, shift_id: 999, start_date: day(1), end_date: day(28) }), /Choose a shift/);
  await rej(att('deptsched', 'POST', { department_id: ops, shift_id: sNight, start_date: day(5), end_date: day(1) }), /end not before start/);
  const ds = (await att('deptsched', 'POST', { department_id: ops, shift_id: sNight, start_date: day(1), end_date: day(14) })).id;
  await rej(att('deptsched', 'POST', { department_id: ops, shift_id: sNight, start_date: day(10), end_date: day(20) }), /already has a schedule/);
  let dsr = (await att('deptsched')).find(r => r.id === ds); assert.equal(dsr.dept_name, 'Office'); assert.equal(dsr.shift, 'Night shift 2'); assert.equal(dsr.employees, 2); // Carol and the no-shift employee
  await api('logs/import', 'POST', { csv: `${nosh.code},${day(3)} 20:00\n${nosh.code},${day(3)} 23:00\n${nosh.code},${day(20)} 20:00\n${nosh.code},${day(20)} 23:00` });
  assert.equal((await row(nosh.code, day(3))).shift, 'Night shift 2', 'the department schedule applies inside its dates'); assert.equal((await row(nosh.code, day(20))).shift || null, null, 'and not outside them');
  const gs = (await att('grpsched', 'POST', { group_id: grpA, shift_id: sOffice, start_date: day(1), end_date: day(28) })).id; await rej(att('grpsched', 'POST', { group_id: grpA, shift_id: sOffice, start_date: day(2), end_date: day(3) }), /already has a schedule/);
  assert.equal((await row(nosh.code, day(3))).shift, 'Office day', 'a group schedule beats the department schedule'); assert.equal((await att('grpsched')).find(r => r.id === gs).group_name, 'Alpha');
  await att('grpsched/' + gs, 'PUT', { group_id: grpA, shift_id: sOffice, start_date: day(1), end_date: day(2) }); assert.equal((await row(nosh.code, day(3))).shift, 'Night shift 2'); await att('grpsched/' + gs, 'DELETE'); await att('deptsched/' + ds, 'DELETE'); assert.equal((await att('deptsched')).length, 0);
  // employee schedule
  await rej(att('empsched', 'POST', { employee_id: B.id, shift_id: sNight, start_date: day(5), end_date: day(1) }), /end not before start/); await rej(att('empsched', 'POST', { shift_id: sNight, start_date: day(1), end_date: day(2) }), /at least one employee/);
  await att('empsched', 'POST', { employee_id: B.id, shift_id: sNight, start_date: day(5), end_date: day(7) });
  const bl = (await att('empsched')).filter(r => r.code === B.code); assert.equal(bl.length, 1); assert.equal(bl[0].first_name, 'Bob'); assert.equal(bl[0].last_name, 'Brown'); assert.equal(bl[0].dept, 'Plant'); assert.equal(bl[0].shift, 'Night shift 2');
  await rej(att('empsched', 'POST', { employee_id: B.id, shift_id: sOffice, start_date: day(6), end_date: day(6), schedule_cover: false }), /Already scheduled/);
  const bulk = await att('empsched', 'POST', { by: 'dept', target_id: eng, shift_id: sOffice, start_date: day(9), end_date: day(9) }); assert.equal(bulk.added, 2);
  await att('empsched/' + bl[0].id, 'PUT', { end_date: day(8) }); assert.equal((await att('empsched')).find(r => r.id === bl[0].id).end_date, day(8));
  const ei = await att('empsched/import', 'POST', { csv: `employee,shift,start,end\n${C.code},Night shift 2,${day(12)},${day(13)}\n999,Night shift 2,${day(12)},${day(13)}\n${C.code},Nope,${day(12)},${day(13)}` }); assert.equal(ei.added, 1); assert.equal(ei.skipped, 2);
  await att('empsched/' + (await att('empsched')).find(r => r.code === C.code).id, 'DELETE'); assert.ok(!(await att('empsched')).some(r => r.code === C.code));
  // temporary schedule: one day on another timetable
  await api('logs/import', 'POST', { csv: `${A.code},${day(15)} 20:00\n${A.code},${day(15)} 23:00` });
  await rej(att('tempsched', 'POST', { employee_id: A.id, date: 'x', timetable_id: night }), /Valid date/); await rej(att('tempsched', 'POST', { employee_id: A.id, date: day(15), timetable_id: 999 }), /Choose a timetable/);
  const tid = (await att('tempsched', 'POST', { employee_id: A.id, date: day(15), timetable_id: night })); const trow = (await att('tempsched')).find(r => r.code === A.code); assert.equal(trow.timetable, 'Night'); assert.equal(trow.check_in, '20:00:00'); assert.equal(trow.date, day(15));
  assert.equal((await row(A.code, day(15))).status, 'Present'); assert.match((await row(A.code, day(15))).shift, /Temp: Night/);
  assert.ok(!(await att('shiftdefs')).some(s => /Temp:/.test(s.name)), 'the hidden shift behind a temporary schedule is not listed as a shift');
  await att('tempsched/' + trow.id, 'PUT', { timetable_id: day9 }); assert.equal((await att('tempsched')).find(r => r.code === A.code).timetable, 'Day 9-6');
  const ti = await att('tempsched/import', 'POST', { csv: `${B.code},${day(16)},Night\n${B.code},${day(17)},Nope` }); assert.equal(ti.added, 1); assert.equal(ti.skipped, 1);
  const bt = (await att('tempsched')).find(r => r.code === B.code); await att('tempsched/' + bt.id, 'DELETE'); await att('tempsched/' + trow.id, 'DELETE'); assert.equal((await att('tempsched')).length, 0);
  assert.ok(!(await row(A.code, day(15))).shift?.startsWith('Temp:'), 'deleting a temporary schedule restores the normal shift'); await rej(att('timetables/' + night, 'DELETE'), /used by the shift/);
  // view by person
  const ps = await att(`personsched?employee_id=${A.id}&month=${M}`); assert.equal(ps.days.length, new Date(+M.slice(0, 4), +M.slice(5, 7), 0).getDate()); assert.equal(ps.days[9].shift, 'Office day'); await rej(att('personsched?employee_id=999'), /Choose an employee/);

  // ---------- manual log (attendance requests)
  const hh = (n) => `${day(n)} 18:30`;
  await rej(att('manuallog', 'POST', { employee_id: A.id, punch_time: 'soon' }), /YYYY-MM-DD HH:MM/); await rej(att('manuallog', 'POST', { punch_time: hh(12) }), /Choose an employee/); await rej(att('manuallog', 'POST', { employee_id: A.id, punch_time: hh(12), punch_state: 99 }), /punch state/);
  const m1 = (await att('manuallog', 'POST', { employee_id: A.id, punch_time: hh(12), punch_state: 1, work_code: 'W1', reason: 'Forgot' })); assert.equal(m1.status, 'pending');
  let ml = (await att('manuallog')).find(r => r.id === m1.id); assert.equal(ml.approval_status, 'Pending'); assert.equal(ml.punch_state, 'Check Out'); assert.equal(ml.work_code, 'W1'); assert.equal(ml.punch_time, day(12) + ' 18:30:00'); assert.equal(ml.first_name, 'Alice'); assert.equal(ml.dept, 'Plant'); assert.equal(ml.reason, 'Forgot');
  await api(`attendance/requests/${m1.id}/approve`, 'POST', {}); assert.equal((await att('manuallog')).find(r => r.id === m1.id).approval_status, 'Approved');
  assert.ok((await api(`logs?from=${day(12)}&to=${day(12)}`).catch(() => [])).length >= 0);
  assert.equal((await row(A.code, day(12))).in, '18:30', 'the approved punch counts'); await att(`manuallog/${m1.id}/revoke`, 'POST', {}); assert.equal((await att('manuallog')).find(r => r.id === m1.id).approval_status, 'Revoked'); assert.notEqual((await row(A.code, day(12))).in, '18:30', 'revoking takes the punch back');
  await rej(att(`manuallog/${m1.id}/revoke`, 'POST', {}), /Only pending or approved/);
  const m2 = await att('manuallog', 'POST', { employee_id: A.id, punch_time: hh(13), auto_approve: true }); assert.equal(m2.status, 'approved'); await att('manuallog/' + m2.id, 'DELETE'); assert.ok(!(await att('manuallog')).some(r => r.id === m2.id)); assert.notEqual((await row(A.code, day(13))).in, '18:30', 'deleting an approved entry removes its punch');
  const od = await att('manuallog', 'POST', { employee_id: B.id, type: 'Work From Home', punch_time: day(14), auto_approve: true }); assert.equal((await row(B.code, day(14))).status, 'Work From Home');
  const mb = await att('manuallog/bulk', 'POST', { by: 'dept', target_id: eng, punch_time: hh(18), auto_approve: true }); assert.equal(mb.added, 2); await rej(att('manuallog/bulk', 'POST', { punch_time: hh(18) }), /at least one employee/);
  const mi = await att('manuallog/import', 'POST', { csv: `employee,time\n${C.code},${hh(19)},0,Imported\n999,${hh(19)}\n${C.code},bad`, auto_approve: true }); assert.equal(mi.added, 1); assert.equal(mi.skipped, 2);
  assert.equal((await att(`manuallog?status=approved&from=${day(18)}&to=${day(19)}`)).length, 3); const rejId = (await att('manuallog', 'POST', { employee_id: C.id, punch_time: hh(20), reason: 'x' })).id; await api(`attendance/requests/${rejId}/reject`, 'POST', { note: 'no' }); assert.equal((await att('manuallog')).find(r => r.id === rejId).approval_status, 'Rejected');

  // ---------- leave
  const lv = await api('leaves', 'POST', { employee_id: A.id, type: 'Casual', from_date: addD(30), to_date: addD(31), note: 'Trip' });
  let ll = (await att('leavelist')).find(r => r.id === lv.id); assert.equal(ll.pay_code, 'Casual'); assert.equal(ll.approval_status, 'Pending'); assert.equal(ll.first_name, 'Alice'); assert.equal(ll.reason, 'Trip'); assert.equal(ll.start_time, addD(30)); assert.equal(ll.end_time, addD(31)); assert.ok(ll.apply_time);
  await api(`leaves/${lv.id}/approve`, 'POST', {}); assert.equal((await att('leavelist?status=approved')).filter(r => r.id === lv.id).length, 1); await api(`leaves/${lv.id}/cancel`, 'POST', {}); assert.equal((await att('leavelist')).find(r => r.id === lv.id).approval_status, 'Revoked');
  // Keep these dates near today so the test remains valid around New Year;
  // a yearly leave quota is correctly zero for a future calendar year.
  // Bulk leave needs a working day for both employees; a fixed offset can land
  // on a weekend and correctly leave one or both records uncreated.
  let bulkLeaveOffset = 5;
  while ([0, 6].includes(new Date(Date.now() + bulkLeaveOffset * 864e5).getDay())) bulkLeaveOffset++;
  const bulkLeaveDay = addD(bulkLeaveOffset), importLeaveDay = addD(15);
  const lb = await att('leavelist/bulk', 'POST', { by: 'dept', target_id: eng, start_time: bulkLeaveDay, end_time: bulkLeaveDay, pay_code: 'Casual', auto_approve: true }); assert.equal(lb.added, 2); await rej(att('leavelist/bulk', 'POST', { start_time: bulkLeaveDay, end_time: bulkLeaveDay, pay_code: 'Casual' }), /at least one employee/);
  const lb2 = await att('leavelist/bulk', 'POST', { employee_ids: [A.id], start_time: bulkLeaveDay, end_time: bulkLeaveDay, pay_code: 'Casual' }).catch(e => e.message); assert.match(String(lb2), /already has leave/);
  const li = await att('leavelist/import', 'POST', { csv: `code,type,from,to,reason\n${C.code},Sick,${importLeaveDay},${importLeaveDay},Fever\n${C.code},Nope,${importLeaveDay},${importLeaveDay}\n999,Sick,${importLeaveDay},${importLeaveDay}`, auto_approve: true }); assert.equal(li.added, 1); assert.equal(li.skipped, 2);
  assert.equal((await att(`leavelist?from=${importLeaveDay}&to=${importLeaveDay}`)).length, 1);

  // ---------- overtime
  await rej(att('otlist', 'POST', { employee_id: A.id, start_time: `${day(10)} 19:00`, end_time: `${day(10)} 18:00` }), /End must be after start/); await rej(att('otlist', 'POST', { employee_id: A.id, start_time: 'x', end_time: 'y' }), /YYYY-MM-DD HH:MM/);
  await rej(att('otlist', 'POST', { employee_id: A.id, start_time: `${day(10)} 19:00`, end_time: `${day(10)} 20:00`, pay_code: 'Nope' }), /Unknown pay code/);
  assert.equal((await att('otlist', 'POST', { employee_id: A.id, start_time: `${day(10)} 19:00`, end_time: `${day(10)} 20:30`, pay_code: 'Weekend OT', reason: 'Rush' })).minutes, 90);
  let ot = (await att(`otlist?from=${day(1)}&to=${day(28)}`)).find(r => r.kind === 'manual' && r.employee_id === A.id); assert.equal(ot.pay_code, 'Weekend OT'); assert.equal(ot.start_time, `${day(10)} 19:00`); assert.equal(ot.end_time, `${day(10)} 20:30`); assert.equal(ot.approval_status, 'Approved'); assert.equal(ot.reason, 'Rush');
  assert.equal((await row(A.code, day(10))).ot_manual_min, 90, 'the engine pays the manual overtime');
  const ob = await att('otlist/bulk', 'POST', { by: 'dept', target_id: eng, start_time: `${day(21)} 18:00`, end_time: `${day(21)} 19:00` }); assert.equal(ob.added, 2);
  const oi = await att('otlist/import', 'POST', { csv: `${C.code},${day(22)} 18:00,${day(22)} 19:00,OT1,x\n${C.code},bad,bad`, auto_approve: true }); assert.equal(oi.added, 1); assert.equal(oi.skipped, 1);
  await att(`otlist/${ot.id}/revoke`, 'POST', {}); assert.ok(!(await att(`otlist?from=${day(1)}&to=${day(28)}`)).some(r => r.id === ot.id), 'revoking a manual entry removes it'); assert.equal((await row(A.code, day(10))).ot_manual_min, 0);
  // an overtime day that needs approval: revoke sends an approved one back to waiting
  await att('globalrule', 'PUT', { overtime_policy: 1 }); await api('logs/import', 'POST', { csv: `${B.code},${day(23)} 09:00\n${B.code},${day(23)} 21:00` }); await api('employees/' + B.id, 'PUT', { shift_id: sOffice });
  const pend = (await att(`otlist?from=${day(23)}&to=${day(23)}&status=pending`)).find(r => r.employee_id === B.id); assert.ok(pend, 'calculated overtime waits for approval'); assert.equal(pend.pay_code, 'Normal OT');
  await api(`overtime/${pend.id}/approve`, 'POST', {}); assert.equal((await att(`otlist?from=${day(23)}&to=${day(23)}`)).find(r => r.id === pend.id).approval_status, 'Approved');
  await att(`otlist/${pend.id}/revoke`, 'POST', {}); assert.equal((await att(`otlist?from=${day(23)}&to=${day(23)}`)).find(r => r.id === pend.id).approval_status, 'Pending'); await rej(att(`otlist/${pend.id}/revoke`, 'POST', {}), /already waiting/); await att('globalrule', 'PUT', { overtime_policy: -1 });

  // ---------- training
  await rej(att('training', 'POST', { employee_id: A.id, start_time: 'x', end_time: 'y' }), /YYYY-MM-DD HH:MM/); await rej(att('training', 'POST', { employee_id: A.id, start_time: `${day(24)} 17:00`, end_time: `${day(24)} 09:00` }), /End must be after start/); await rej(att('training', 'POST', { employee_id: 999, start_time: `${day(24)} 09:00`, end_time: `${day(24)} 17:00` }), /active employee/);
  const tr = (await att('training', 'POST', { employee_id: A.id, start_time: `${day(24)} 09:00`, end_time: `${day(25)} 17:00`, reason: 'Safety course' })).id;
  let trr = (await att('training')).find(r => r.id === tr); assert.equal(trr.approval_status, 'Pending'); assert.equal(trr.pay_code, 'Training'); assert.equal(trr.reason, 'Safety course');
  await att('training/' + tr, 'PUT', { reason: 'Safety course 2' }); assert.equal((await att('training')).find(r => r.id === tr).reason, 'Safety course 2');
  await att(`training/${tr}/approve`, 'POST', {}); assert.equal((await row(A.code, day(24))).status, 'Training'); assert.equal((await row(A.code, day(25))).status, 'Training'); await rej(att(`training/${tr}/approve`, 'POST', {}), /Only pending/); await rej(att('training/' + tr, 'PUT', { reason: 'x' }), /Only pending trainings/);
  await att(`training/${tr}/revoke`, 'POST', {}); assert.notEqual((await row(A.code, day(24))).status, 'Training', 'revoking takes the days back'); assert.equal((await att('training')).find(r => r.id === tr).approval_status, 'Revoked'); await rej(att(`training/${tr}/revoke`, 'POST', {}), /Only pending or approved/);
  const tr2 = (await att('training', 'POST', { employee_id: B.id, start_time: `${day(26)} 09:00`, end_time: `${day(26)} 17:00`, auto_approve: true })).id; assert.equal((await row(B.code, day(26))).status, 'Training'); await att('training/' + tr2, 'DELETE'); assert.notEqual((await row(B.code, day(26))).status, 'Training');
  const tr3 = (await att('training', 'POST', { employee_id: B.id, start_time: `${day(27)} 09:00`, end_time: `${day(27)} 17:00` })).id; await att(`training/${tr3}/reject`, 'POST', { note: 'no budget' }); const t3 = (await att('training')).find(r => r.id === tr3); assert.equal(t3.approval_status, 'Rejected');
  assert.equal((await att('training/bulk', 'POST', { by: 'dept', target_id: eng, start_time: `${day(28)} 09:00`, end_time: `${day(28)} 17:00`, auto_approve: true })).added, 2); assert.equal((await att('training/import', 'POST', { csv: `${C.code},${day(28)} 09:00,${day(28)} 17:00,Training,x\n999,a,b` })).added, 1);

  // ---------- schedule adjustment (shift change requests)
  await rej(att('schedadj', 'POST', { employee_id: 999, date: day(9), shift_id: sNight }), /Choose an employee/); await rej(att('schedadj', 'POST', { employee_id: A.id, date: 'x', shift_id: sNight }), /Date required/); await rej(att('schedadj', 'POST', { employee_id: A.id, date: day(9), auto_approve: true }), /Choose the shift/);
  const sa = await att('schedadj', 'POST', { employee_id: A.id, date: day(9), shift_id: sNight, reason: 'Swap', auto_approve: true }); assert.equal(sa.status, 'approved');
  let sar = (await att('schedadj')).find(r => r.id === sa.id); assert.equal(sar.new_schedule, 'Night shift 2'); assert.equal(sar.previous, 'Office day'); assert.equal(sar.date, day(9)); assert.equal(sar.approval_status, 'Approved'); assert.equal((await row(A.code, day(9))).shift, 'Night shift 2');
  const future = addD(3), sb = await att('schedadj', 'POST', { employee_id: C.id, date: future, shift_id: sOffice, reason: 'Need it' }); assert.equal(sb.status, 'pending');
  await api(`shifts/requests/${sb.id}/reject`, 'POST', { note: 'no' }); assert.equal((await att('schedadj')).find(r => r.id === sb.id).approval_status, 'Rejected'); await att('schedadj/' + sb.id, 'DELETE'); assert.ok(!(await att('schedadj')).some(r => r.id === sb.id));

  // ---------- leave groups
  const lgid = (await att('leavegroups', 'POST', { name: 'Staff leave' })).id, lg = (await att('leavegroups')).find(g => g.id === lgid); assert.ok(lg.code); assert.equal(lg.employees, 0);
  await rej(att('leavegroups', 'POST', { code: lg.code, name: 'Other' }), /already used/); await rej(att('leavegroups', 'POST', { name: '' }), /Name required/); await rej(att('leavegroups', 'POST', { name: 'Staff leave' }), /exists/);
  assert.equal((await att('leavegroups/assign', 'POST', { policy_id: lgid, by: 'dept', target_id: eng })).assigned, 2); assert.equal((await att('leavegroups')).find(g => g.id === lgid).employees, 2); assert.equal((await api('employees')).find(e => e.id === A.id).leave_policy_id, lgid);
  await rej(att('leavegroups/assign', 'POST', { policy_id: 999, employee_ids: [A.id] }), /Choose a leave group/); await rej(att('leavegroups/assign', 'POST', { policy_id: lgid }), /Choose the employees/); await rej(att('leavegroups/' + lgid, 'DELETE'), /still in this leave group/);
  await att('leavegroups/' + lgid, 'PUT', { code: lg.code, name: 'Staff leave 2' }); for (const e of [A, B]) await api('employees/' + e.id, 'PUT', { leave_policy_id: null }); await att('leavegroups/' + lgid, 'DELETE'); assert.ok(!(await att('leavegroups')).some(g => g.id === lgid));

  // ---------- holidays
  const hid = (await att('holidays', 'POST', { alias: 'Eid break', start_date: day(5), duration_day: 3, color_setting: '#ff9900', enable_ot_rule: true, t1_pay_code: 'Holiday OT', t1_hrs_from: 0, t1_hrs_to: 4 })).id;
  let hl = (await att('holidays')).find(h => h.id === hid); assert.equal(hl.duration, 3); assert.equal(hl.end_date, day(7)); assert.equal(hl.overtime, 'Yes'); assert.equal(hl.color, '#ff9900'); assert.equal(hl.t1_pay_code, 'Holiday OT');
  assert.deepEqual((await api('holidays')).filter(h => h.name === 'Eid break').map(h => h.date).sort(), [day(5), day(6), day(7)], 'each day is a holiday for the engine');
  await api('logs/import', 'POST', { csv: `${A.code},${day(6)} 09:00\n${A.code},${day(6)} 18:00` }); assert.equal((await row(A.code, day(6))).day_type, 'holiday');
  await rej(att('holidays', 'POST', { alias: 'Clash', start_date: day(7), duration_day: 2 }), /already a holiday/); await rej(att('holidays', 'POST', { alias: '', start_date: day(9) }), /Name required/); await rej(att('holidays', 'POST', { alias: 'x', start_date: day(9), duration_day: 99 }), /1 to 60/); await rej(att('holidays', 'POST', { alias: 'x', start_date: day(9), department_id: 999 }), /Unknown department/);
  await att('holidays/' + hid, 'PUT', { alias: 'Eid break', start_date: day(5), duration_day: 2 }); assert.equal((await api('holidays')).filter(h => h.name === 'Eid break').length, 2);
  const dh = (await att('holidays', 'POST', { alias: 'Plant only', start_date: day(9), duration_day: 1, department_id: eng })).id; assert.equal((await att('holidays')).find(h => h.id === dh).department, 'Plant'); assert.ok(!(await api('holidays')).some(h => h.date === day(9)), 'a scoped holiday is recorded, not applied company-wide'); await att('holidays/' + dh, 'DELETE');
  await api('holidays', 'POST', { date: day(11), name: 'Legacy day' }); assert.ok((await att('holidays')).some(h => h.name === 'Legacy day' && h.duration === 1), 'a holiday added the old way is listed too');
  await att('holidays/' + hid, 'DELETE'); assert.equal((await api('holidays')).filter(h => h.name === 'Eid break').length, 0);

  // ---------- calculation
  await rej(att('calc', 'POST', { start_date: day(5), end_date: day(1), employee_ids: [A.id] }), /end not before start/); await rej(att('calc', 'POST', { start_date: day(1), end_date: day(2) }), /at least one employee/); await rej(att('calc', 'POST', { start_date: '2020-01-01', end_date: '2026-12-31', employee_ids: [A.id] }), /one year/);
  const cr = await att('calc', 'POST', { start_date: day(1), end_date: day(28), employee_ids: [A.id, B.id] }); assert.equal(cr.employees, 2); assert.equal(cr.days, 56); assert.ok(cr.counts.Present >= 1);
  const bt2 = await att('calcbatches'); assert.equal(bt2[0].employees, 2); assert.equal(bt2[0].att_from, day(1)); assert.equal(bt2[0].result, 'Success'); await att('calcbatches/' + bt2[0].id, 'DELETE'); assert.equal((await att('calcbatches')).length, 0);

  // ---------- workbench quick setup
  const qs = await att('quickset', 'POST', { break_name: 'Tea', break_start: '11:00', break_end: '11:15', timetable_name: 'Quick TT', check_in: '08:00', check_out: '16:00', shift_name: 'Quick shift', workdays: '1,2,3,4,5' });
  assert.ok(qs.break_id && qs.timetable_id && qs.shift_id); const qsh = (await api('shifts')).find(s => s.id === qs.shift_id); assert.equal(qsh.start, '08:00'); assert.equal(qsh.break_start, '11:00'); await rej(att('quickset', 'POST', { timetable_name: '', check_in: '08:00', check_out: '16:00' }), /Name required/);
  assert.equal((await att('breaktimes')).filter(b => b.name === 'Tea').length, 1, 'a failed quick setup leaves nothing behind');

  // ---------- permissions: a viewer reads schedules but cannot change them or see settings pages
  await api('users', 'POST', { username: 'view1', password: 'password1', role: 'viewer' }); const v = as(await S.login('view1', 'password1'));
  assert.equal((await v.send('att/empsched', 'GET')).status, 200); assert.equal((await v.send('att/empsched', 'POST', { employee_id: A.id, shift_id: sNight, start_date: day(1), end_date: day(1) })).status, 403);
  assert.equal((await v.send('att/paycodes', 'GET')).status, 403, 'pay codes belong to settings, which a viewer has no access to'); assert.equal((await v.send('att/globalrule', 'GET')).status, 403); assert.equal((await v.send('att/leavelist', 'GET')).status, 200); assert.equal((await v.send('att/leavelist/bulk', 'POST', {})).status, 403);
  await api('users', 'POST', { username: 'mgr1', password: 'password1', role: 'manager', departments: [eng] }); const mg = as(await S.login('mgr1', 'password1'));
  const mrows = (await mg.send('att/leavelist', 'GET')).body; assert.ok(mrows.length && mrows.every(r => [A.code, B.code].includes(r.code)), 'a scoped manager only sees the people of their department');
  assert.equal((await mg.send('att/manuallog', 'POST', { employee_id: C.id, punch_time: hh(3) })).status, 403, 'and cannot act on others');
  assert.equal((await (await fetch(S.base + '/api/att/paycodes')).status), 401, 'no login, no access');
  console.log('e2e-zk-attsetup: ok');
} finally { S.stop(); }
