// A shift grid that mixes timetables: each day resolves to its own timetable, empty cells are days off
import { startServer } from './e2e-lib.js';
const S = await startServer({}), api = S.api;
process.env.DB_FILE = S.dir + '/e2e.db'; const { db } = await import('./db.js');
const a = (await api('att/timetables/normal', 'POST', { name: 'Early', check_in: '06:00', check_out: '14:00' })).id, b = (await api('att/timetables/normal', 'POST', { name: 'Late', check_in: '14:00', check_out: '22:00' })).id;
const sid = (await api('att/shiftdefs', 'POST', { alias: 'Mixed', unit: 'Week', cycle: 1, pattern: [[null, a, a, b, b, null, null]] })).id;
const list = await api('att/shiftdefs'); if (list.length !== 1 || list[0].workdays !== '1,2,3,4') throw new Error('workdays ' + JSON.stringify(list));
const emp = (await api('employees', 'POST', { code: 'G1', name: 'Grid', shift_id: sid })).id;
const { shiftResolver } = await import('./shifts.js');
const R = shiftResolver('2026-10-18', '2026-10-24'), e = { id: emp, shift_id: sid };
const day = (d) => R(e, d); // 2026-10-18 is a Sunday
const exp = { '2026-10-18': 'off', '2026-10-19': '06:00', '2026-10-20': '06:00', '2026-10-21': '14:00', '2026-10-22': '14:00', '2026-10-23': 'off', '2026-10-24': 'off' };
for (const [d, w] of Object.entries(exp)) { const r = day(d), got = r.off ? 'off' : r.sh.start; if (got !== w) throw new Error(`${d}: ${got} != ${w}`); }
await api('att/shiftdefs/' + sid, 'PUT', { alias: 'Mixed', unit: 'Week', cycle: 1, pattern: [[null, a, a, a, a, null, null]] });
const n = db.prepare('SELECT COUNT(*) n FROM shifts WHERE child_of=?').get(sid).n; if (n) throw new Error('children kept ' + n);
S.stop(); console.log('e2e-gridshift passed: mixed timetables per day, day off cells, back to a single timetable');
