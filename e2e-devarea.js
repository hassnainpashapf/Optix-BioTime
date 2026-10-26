import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
// people a device reports land in the device's Area, so area-based pickers and reports list them
{
  const S2 = await startServer(), api2 = S2.api;
  try {
    const area = (await api2('branches', 'POST', { name: 'Techub' })).id;
    await api2('devices', 'POST', { name: 'Gate', sn: 'AR-1', area_id: area });
    await fetch(`${S2.base}/iclock/cdata?SN=AR-1&table=OPERLOG&Stamp=1`, { method: 'POST', body: 'USER PIN=501\tName=Ali Raza\tPri=0\tPasswd=\tCard=\tGrp=1\n' });
    await fetch(`${S2.base}/iclock/cdata?SN=AR-1&table=ATTLOG&Stamp=1`, { method: 'POST', body: `502\t${new Date().toLocaleDateString('sv')} 09:00:00\t0\t1\t0\t0\n` });
    const pick = await api2(`zkrep/employees?areas=${area}`);
    assert.deepEqual(pick.map(e => e.code).sort(), ['501', '502'], 'employees reported by the device are listed for its area: ' + JSON.stringify(pick));
    // adding an employee in that Area also goes to a pull device of the Area (here the device is unreachable, so the failure is logged for the admin)
    const net = await import('node:net'); const c = net.createServer(); await new Promise(r => c.listen(0, '127.0.0.1', r)); const dead = c.address().port; await new Promise(r => c.close(r));
    const pd = await api2('devices', 'POST', { name: 'Pull gate', ip: '127.0.0.1', port: dead, area_id: area });
    await api2('employees', 'POST', { name: 'New Joiner', join_date: '2026-01-01', branch_id: area });
    await new Promise(r => setTimeout(r, 4500));
    const ev = await api2(`devices/${pd.id}/events`); assert.ok(ev.some(x => /Could not update the people on the device/.test(x.detail ?? '')), 'a pull device of the Area is written to: ' + JSON.stringify(ev.slice(0, 3)));
    console.log('e2e-devarea passed: device people appear in the area picker');
  } finally { S2.stop(); }
}
