// A push device uploads the picture it took at a punch; the dashboard's Real-Time Monitor gets it with that punch. Also the monitor's refresh time lives on the server.
import assert from 'node:assert/strict';
import { startServer } from './e2e-lib.js';
const S = await startServer(), api = S.api;
try {
  const e = await api('employees', 'POST', { name: 'Photo Person', join_date: '2025-01-01' }), code = (await api('employees')).find(x => x.id === e.id).code;
  await api('devices', 'POST', { name: 'Face reader', sn: 'PHOTO-001', approved: 1 });
  const now = new Date(), p = (n) => String(n).padStart(2, '0'), day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`, hm = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  // the punch, as a device uploads it
  const cd = await fetch(`${S.base}/iclock/cdata?SN=PHOTO-001&table=ATTLOG&Stamp=1`, { method: 'POST', body: `${code}\t${day} ${hm}\t0\t1\t0\t0\n` });
  assert.equal(cd.status, 200);
  await fetch(`${S.base}/iclock/cdata?SN=PHOTO-001&table=ATTLOG&Stamp=2`, { method: 'POST', body: `${code}\t${day} 00:00:05\t1\t1\t0\t0\n${code}\t${day} 00:00:09\t\t1\t0\t0\n` });
  // the photo, both wrappers: text lines before the JPEG, and a bare JPEG named in the query
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7), Buffer.from([0xff, 0xd9])]);
  const stamp = day.replace(/-/g, '') + hm.replace(/:/g, '');
  const up = await fetch(`${S.base}/iclock/fdata?SN=PHOTO-001&table=ATTPHOTO&Stamp=1`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.concat([Buffer.from(`PIN=${stamp}-${code}.jpg\nSN=PHOTO-001\nSIZE=${jpeg.length}\nCMD=uploadphoto\n`), jpeg]) });
  assert.equal(await up.text(), 'OK');
  const m = await api('monitor?limit=10');
  const row = m.feed.find(r => r.code === code && r.ts.endsWith(hm)); assert.ok(row, 'the punch shows in the monitor'); assert.ok(row.photo_id, 'the punch carries its photo');
  const states = Object.fromEntries(m.feed.filter(r => r.code === code).map(r => [r.ts.slice(11), r.state]));
  assert.equal(states['00:00:05'], 'Check Out', 'the device punch code is shown: ' + JSON.stringify(states));
  assert.equal(states[hm], 'Check In', 'a punch with code 0 is Check In');
  assert.equal(states['00:00:09'], 'Check Out', 'with no code the punches alternate: this is the second of the day');
  const img = await S.raw('punch-photo/' + row.photo_id); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await img.arrayBuffer()).length, jpeg.length, 'the same picture comes back');
  assert.equal((await S.raw('punch-photo/99999')).status, 404);
  const noAuth = await fetch(`${S.base}/api/punch-photo/${row.photo_id}`); assert.equal(noAuth.status, 401, 'a photo needs a login');
  const nonJpeg = await fetch(`${S.base}/iclock/fdata?SN=PHOTO-001&table=ATTPHOTO`, { method: 'POST', body: 'not a picture' }); assert.equal(await nonJpeg.text(), 'OK');
  // refresh time is kept on the server
  assert.equal(m.refresh_sec, 10);
  await api('zkd/config', 'PUT', { monitor_refresh_sec: 5 }); assert.equal((await api('monitor')).refresh_sec, 5);
  await assert.rejects(api('zkd/config', 'PUT', { monitor_refresh_sec: 1 }), /Monitor refresh/);
  console.log('e2e-punchphoto passed: punch photo upload, shown with the punch, refresh time on the server');
} finally { S.stop(); }
