// SMS and WhatsApp through any HTTP gateway you have an account with. Nothing is built in: the address and format come from the environment,
// so the keys stay out of the database.
//   SMS_URL       e.g. https://api.provider.example/send?key=SECRET&to={to}&text={text}      (WA_URL for WhatsApp)
//   SMS_METHOD    GET (default) or POST
//   SMS_BODY      for POST: a JSON template such as {"to":"{to}","message":"{text}"}
//   SMS_HEADERS   optional JSON of headers, e.g. {"Authorization":"Bearer SECRET"}
//   ADMIN_PHONE   comma-separated numbers that "the admins" means
//   PHONE_COUNTRY country code used for numbers starting with 0 (default 92)
import { waLog, kvGet } from './zk-log.js';
const P = { sms: 'SMS', whatsapp: 'WA' };
const env = (ch, k) => process.env[`${P[ch]}_${k}`];
// SMS can also go through the Twilio account saved on System > Configuration > Twilio Setting (used when no SMS_URL is set)
const twilio = () => { const c = kvGet('twilio', null); return c?.twilio_enable && c.mobile && c.account_sid && c.auth_token ? c : null; };
export const configured = (ch) => !!env(ch, 'URL') || (ch === 'sms' && !!twilio());
export const adminPhones = () => String(process.env.ADMIN_PHONE ?? '').split(',').map(x => x.trim()).filter(Boolean);

export function normalizePhone(raw) {
  let n = String(raw ?? '').replace(/[^\d+]/g, ''); if (!n) return null;
  if (n.startsWith('00')) n = '+' + n.slice(2); else if (n.startsWith('0')) n = '+' + (process.env.PHONE_COUNTRY || '92') + n.slice(1); else if (!n.startsWith('+')) n = '+' + n;
  return /^\+\d{8,15}$/.test(n) ? n : null;
}
const fill = (v, vars, enc) => typeof v === 'string' ? v.replace(/\{(to|text)\}/g, (_m, k) => enc ? encodeURIComponent(vars[k]) : vars[k]) : Array.isArray(v) ? v.map(x => fill(x, vars, enc)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars, enc)])) : v;

export async function sendMessage(ch, to, text) {
  try { const n = await sendRaw(ch, to, text); if (ch === 'whatsapp') waLog({ phone: n, text, status: 'Success' }); return n; }
  catch (e) { if (ch === 'whatsapp') waLog({ phone: normalizePhone(to) ?? String(to ?? ''), text, status: 'Failed', reason: e.message }); throw e; }
}
async function sendRaw(ch, to, text) {
  if (!configured(ch)) throw new Error(`${ch === 'sms' ? 'SMS' : 'WhatsApp'} gateway is not set up`);
  const number = normalizePhone(to); if (!number) throw new Error(`"${to}" is not a phone number`);
  if (ch === 'sms' && !env(ch, 'URL')) { // Twilio
    const c = twilio(), body = new URLSearchParams({ To: number, From: c.mobile, Body: String(text).slice(0, 600) });
    try { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.account_sid}:${c.auth_token}`).toString('base64') }, body, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`Twilio answered ${r.status}`); return number; }
    catch (e) { throw new Error(e.name === 'TimeoutError' ? 'Twilio did not answer in 10 seconds' : e.message); }
  }
  const vars = { to: number, text: String(text).slice(0, 600) }, method = String(env(ch, 'METHOD') || 'GET').toUpperCase();
  let headers = {}; try { headers = JSON.parse(env(ch, 'HEADERS') || '{}'); } catch { throw new Error('The gateway headers are not valid JSON'); }
  const opt = { method, headers: { 'User-Agent': 'attendance-gateway/1', ...headers } };
  if (method === 'POST') { let tpl; try { tpl = JSON.parse(env(ch, 'BODY') || '{"to":"{to}","message":"{text}"}'); } catch { throw new Error('The gateway body is not valid JSON'); } opt.body = JSON.stringify(fill(tpl, vars, false)); opt.headers['Content-Type'] ??= 'application/json'; }
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000); opt.signal = ctl.signal;
  try { const r = await fetch(fill(env(ch, 'URL'), vars, true), opt); if (!r.ok) throw new Error(`The gateway answered ${r.status}`); return number; }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'The gateway did not answer in 10 seconds' : e.message); } finally { clearTimeout(t); }
}
