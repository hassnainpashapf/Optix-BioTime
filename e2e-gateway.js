// SMS and WhatsApp actions in automation rules, through a (fake) HTTP gateway.
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './e2e-lib.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const hits = [];
const gw = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => { hits.push({ method: q.method, url: q.url, headers: q.headers, body: b }); r.writeHead(q.url.includes('fail') ? 500 : 200); r.end('ok'); }); });
await new Promise(ok => gw.listen(0, '127.0.0.1', ok)); const gp = gw.address().port;
const S = await startServer({ SMS_URL: `http://127.0.0.1:${gp}/sms?to={to}&text={text}`, WA_URL: `http://127.0.0.1:${gp}/wa`, WA_METHOD: 'POST', WA_BODY: '{"phone":"{to}","body":{"text":"{text}"}}', WA_HEADERS: '{"Authorization":"Bearer T0KEN"}', ADMIN_PHONE: '0300-1111111' });
const api = S.api;
try {
  const cfg = await api('automations'); assert.equal(cfg.sms, true); assert.equal(cfg.whatsapp, true); assert.ok(cfg.actions.some(a => a.id === 'sms') && cfg.actions.some(a => a.id === 'whatsapp'));
  const rule = (b) => api('automations', 'POST', b);
  await assert.rejects(rule({ name: 'x', trigger: 'leave.requested', actions: [{ type: 'sms', to: 'junk' }] }), /phone number/);
  await assert.rejects(rule({ name: 'x', trigger: 'device.offline', actions: [{ type: 'sms', to: 'manager' }] }), /about one person/);
  await api('leave_types', 'POST', { name: 'Errand', paid: 1, quota: 0, accrual: 'yearly', carry_max: 0, gender: 'any', approval: 1 });
  const M = await api('employees', 'POST', { name: 'Manager Mona', phone: '0300 222-3344', join_date: '2025-01-01' }), R = await api('employees', 'POST', { name: 'Report One', phone: '+92 321 5551234', join_date: '2025-01-01' }), N = await api('employees', 'POST', { name: 'No Phone', join_date: '2025-01-01' });
  await api('employees/' + R.id, 'PUT', { manager_id: M.id }); await api('employees/' + N.id, 'PUT', { manager_id: M.id });
  await rule({ name: 'Leave messages', trigger: 'leave.requested', config: { leave_type: 'Errand' }, actions: [{ type: 'sms', to: 'manager', title: 'Leave: {name}', body: '{type} {from}' }, { type: 'whatsapp', to: 'admins', title: 'Leave: {name}' }, { type: 'sms', to: 'employee', title: 'Received' }, { type: 'sms', to: '0345 9998877', title: 'Copy' }] });
  const pv = await api(`automations/${(await api('automations')).rules[0].id}/preview`, 'POST'); assert.ok(pv.sample[0].results.some(r => /Would send/.test(r.text)) && pv.sample[0].results.every(r => /Would send|No phone number/.test(r.text)), 'preview only describes'); assert.equal(hits.length, 0, 'a preview sends nothing');
  const day = new Date(Date.now() + 5 * 864e5); while (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() + 1); const d = day.toISOString().slice(0, 10);
  await api('leaves', 'POST', { employee_id: R.id, type: 'Errand', from_date: d, to_date: d }); await sleep(900);
  const sms = hits.filter(h => h.url.startsWith('/sms')), wa = hits.filter(h => h.url.startsWith('/wa'));
  assert.equal(sms.length, 3, 'manager, the employee and the fixed number'); assert.equal(wa.length, 1);
  const q = (h) => Object.fromEntries(new URL('http://x' + h.url).searchParams); const tos = sms.map(h => q(h).to).sort();
  assert.deepEqual(tos, ['+923002223344', '+923215551234', '+923459998877'], 'numbers are normalised to +92...'); assert.ok(sms.some(h => q(h).to === '+923002223344' && q(h).text === 'Leave: Report One\nErrand ' + d), 'the text is filled in and URL-encoded');
  assert.equal(wa[0].method, 'POST'); assert.equal(wa[0].headers.authorization, 'Bearer T0KEN'); assert.deepEqual(JSON.parse(wa[0].body), { phone: '+923001111111', body: { text: `Leave: Report One\nReport One asked for Errand leave, ${d} to ${d} (1 day(s)).` } });
  const log = (await api('automations')).log.map(l => l.outcome); assert.ok(log.some(o => /SMS sent to \+923002223344/.test(o)) && log.some(o => /WhatsApp sent to \+923001111111/.test(o)));
  // a person without a phone number
  await api('leaves', 'POST', { employee_id: N.id, type: 'Errand', from_date: d, to_date: d }); await sleep(900);
  assert.ok((await api('automations')).log.some(l => !l.ok && /No phone number to send the SMS to/.test(l.outcome)), 'logged as not sent, with the reason');
  // a gateway that refuses
  await api('automations', 'POST', { name: 'Refused', trigger: 'employee.created', actions: [{ type: 'sms', to: '0300 1234567' }] });
  const before = hits.length; await api('employees', 'POST', { name: 'Newbie' }); await sleep(700); assert.ok(hits.length > before);
  // not set up at all
  const S2 = await startServer(); try {
    assert.equal((await S2.api('automations')).sms, false);
    const id = (await S2.api('automations', 'POST', { name: 'x', trigger: 'device.offline', actions: [{ type: 'sms', to: '0300 1234567' }] })).id; const p2 = await S2.api(`automations/${id}/preview`, 'POST');
    assert.equal(p2.sample[0].results[0].ok, false); assert.match(p2.sample[0].results[0].text, /not set up/);
  } finally { S2.stop(); }
  console.log('e2e-gateway passed: SMS and WhatsApp through an HTTP gateway (GET and POST, headers, number normalisation, preview, logging, not-configured)');
} catch (e) { console.error('E2E-GATEWAY FAILED:', (e.stack || '').split('\n').filter(l => /e2e-gateway.js:/.test(l)).slice(0, 2).join(' | ') + ' :: ' + e.message); process.exitCode = 1; }
finally { S.stop(); gw.close(); }
