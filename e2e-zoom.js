// "Online Meeting" makes a real Zoom meeting (here a fake Zoom answers), and cancelling the meeting removes it.
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './e2e-lib.js';
const seen = [];
const fake = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { seen.push(`${req.method} ${req.url.split('?')[0]}`); res.setHeader('Content-Type', 'application/json');
  if (req.url.startsWith('/oauth/token')) return res.end(JSON.stringify({ access_token: 'tok' }));
  if (req.method === 'POST' && req.url === '/v2/users/me/meetings') { seen.push('BODY ' + b); return res.end(JSON.stringify({ id: 987654321, join_url: 'https://zoom.example/j/987654321', start_url: 'https://zoom.example/s/987654321', host_email: 'host@acme.com' })); }
  if (req.method === 'DELETE') { res.statusCode = 204; return res.end(); } res.statusCode = 404; res.end('{}'); }); });
await new Promise(r => fake.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${fake.address().port}`;
const S = await startServer({ ZOOM_OAUTH_BASE: base, ZOOM_API_BASE: base }), api = S.api;
try {
  const host = (await api('employees', 'POST', { name: 'Host', join_date: '2026-01-01' })).id, day = new Date().toLocaleDateString('sv');
  const mk = (extra) => api('meetings', 'POST', { title: 'Zoom sync', organizer_id: host, start: `${day} 09:00`, end: `${day} 10:00`, ...extra });
  let r = await mk({ online: true }); assert.ok(r.warnings.some(w => /not set up/.test(w)), 'without Zoom set up the meeting is still saved, with a warning');
  await api('zk/settings/zoom', 'PUT', { account_id: 'acc', client_id: 'cid', client_secret: 'secret', zoom_enable: true });
  r = await mk({ online: true, start: `${day} 11:00`, end: `${day} 12:30`, waiting_room: true, mute_entry: true, auto_recording: 'cloud' });
  const m = (await api('meetings')).find(x => x.id === r.id); assert.equal(m.zoom_id, '987654321'); assert.equal(m.join_url, 'https://zoom.example/j/987654321'); assert.equal(m.start_url, 'https://zoom.example/s/987654321'); assert.equal(m.zoom_user, 'host@acme.com');
  const body = JSON.parse(seen.find(x => x.startsWith('BODY ')).slice(5)); assert.equal(body.topic, 'Zoom sync'); assert.equal(body.duration, 90); assert.equal(body.settings.waiting_room, true); assert.equal(body.settings.mute_upon_entry, true); assert.equal(body.settings.auto_recording, 'cloud'); assert.equal(body.settings.join_before_host, false, 'a waiting room and join-before-host do not go together');
  const plain = await mk({ start: `${day} 14:00`, end: `${day} 15:00` }); assert.equal((await api('meetings')).find(x => x.id === plain.id).zoom_id, null, 'a normal meeting makes no Zoom meeting');
  await api(`meetings/${r.id}/cancel`, 'POST', {}); await new Promise(rr => setTimeout(rr, 400)); assert.ok(seen.includes('DELETE /v2/meetings/987654321'), 'cancelling removes the Zoom meeting: ' + seen.join(' | '));
  console.log('e2e-zoom passed: online meeting creates a Zoom meeting with its switches and links; cancel removes it');
} finally { S.stop(); fake.close(); }
