import { createHmac, randomUUID } from 'node:crypto';
import { db } from './db.js';

// Business events (a punch, a leave request, an employee leaving, a device going offline...) are offered to every active webhook
// that asked for them. Delivery happens in the background with retries, so a slow or broken receiver never slows the app down.
export const EVENTS = ['punch.created', 'employee.created', 'employee.updated', 'employee.status_changed', 'leave.requested', 'leave.decided', 'attendance_request.created', 'attendance_request.decided',
  'device.offline', 'device.online', 'payroll.finalized', 'visitor.checked_in', 'visitor.checked_out', 'notification.sent'];
const now = () => new Date().toLocaleString('sv');

// In-process listeners (alerts, automation rules). They run after the current action has finished, and a failing listener never breaks it.
const listeners = [];
export const onEvent = (fn) => listeners.push(fn);
export function emit(event, data = {}) {
  for (const fn of listeners) setImmediate(() => { Promise.resolve().then(() => fn(event, data)).catch(() => {}); });
  try {
    const hooks = db.prepare('SELECT id, events FROM webhooks WHERE active=1').all();
    if (!hooks.length) return;
    const payload = JSON.stringify({ id: randomUUID(), event, created: now(), data });
    for (const h of hooks) if (h.events === '*' || h.events.split(',').includes(event))
      db.prepare('INSERT INTO webhook_deliveries(webhook_id, event, payload, next_try) VALUES(?,?,?,?)').run(h.id, event, payload, now());
  } catch { /* an integration problem must never break the action that caused the event */ }
}

// Blocked always: cloud metadata addresses and anything that is not http(s). Private/LAN addresses are allowed on purpose (an in-house ERP is usually on the LAN).
export function checkUrl(u) {
  let x; try { x = new URL(u); } catch { return 'That is not a valid URL'; }
  if (!['http:', 'https:'].includes(x.protocol)) return 'Only http:// and https:// addresses are allowed';
  if (/^(169\.254\.|metadata\.google|fd00:ec2)/i.test(x.hostname)) return 'That address is not allowed';
  return null;
}
export const sign = (secret, body) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
const BACKOFF_MIN = [1, 5, 30, 120, 720]; // retry after 1 min, 5 min, 30 min, 2 h, 12 h, then give up

// Deliver everything that is due. `force` ignores the retry delay (used by "retry now" in the screen and by tests).
export async function deliverDue({ force = false, limit = 25 } = {}) {
  const due = db.prepare(`SELECT d.*, h.url, h.secret FROM webhook_deliveries d JOIN webhooks h ON h.id=d.webhook_id WHERE d.status='pending' AND h.active=1 ${force ? '' : 'AND d.next_try<=?'} ORDER BY d.id LIMIT ${limit}`).all(...(force ? [] : [now()]));
  let ok = 0, bad = 0;
  for (const d of due) {
    let code = null, error = null;
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(d.url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'User-Agent': 'attendance-webhook/1', 'X-Webhook-Event': d.event, 'X-Webhook-Delivery': String(d.id), 'X-Signature': sign(d.secret, d.payload) }, body: d.payload });
      clearTimeout(t); code = r.status; if (!r.ok) error = `The receiver answered ${r.status}`;
    } catch (e) { error = e.name === 'AbortError' ? 'No answer within 8 seconds' : String(e.cause?.code || e.message).slice(0, 120); }
    const attempts = d.attempts + 1;
    if (!error) { db.prepare("UPDATE webhook_deliveries SET status='done', attempts=?, code=?, error=NULL WHERE id=?").run(attempts, code, d.id); db.prepare("UPDATE webhooks SET last_status='ok', failures=0 WHERE id=?").run(d.webhook_id); ok++; }
    else {
      const give = attempts >= BACKOFF_MIN.length + 1;
      db.prepare('UPDATE webhook_deliveries SET status=?, attempts=?, code=?, error=?, next_try=? WHERE id=?').run(give ? 'failed' : 'pending', attempts, code, error, new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000).toLocaleString('sv'), d.id);
      db.prepare('UPDATE webhooks SET last_status=?, failures=failures+1 WHERE id=?').run(error, d.webhook_id); bad++;
    }
  }
  // old finished deliveries are not kept forever
  db.prepare("DELETE FROM webhook_deliveries WHERE status IN ('done','failed') AND created < ?").run(new Date(Date.now() - 30 * 86400000).toLocaleString('sv'));
  return { delivered: ok, failed: bad };
}
export function startWebhookWorker() { setInterval(() => deliverDue().catch(() => {}), 10000).unref(); }
