// Zoom: an "Online Meeting" in Optix creates a real Zoom meeting (Server-to-Server OAuth app set up in System > Zoom Setting) and keeps its join and host links.
import { getConf } from './zk-system.js';
const OAUTH = () => process.env.ZOOM_OAUTH_BASE || 'https://zoom.us', API = () => process.env.ZOOM_API_BASE || 'https://api.zoom.us';
export const zoomOn = () => { const c = getConf('zoom'); return !!(c.zoom_enable && c.account_id && c.client_id && c.client_secret); };
async function token() {
  const c = getConf('zoom');
  const r = await fetch(`${OAUTH()}/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.account_id)}`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64') }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Zoom refused the credentials (${r.status})`);
  return (await r.json()).access_token;
}
const rec = { none: 'none', local: 'local', cloud: 'cloud' };
// m: a meetings row. Returns { id, join_url, start_url, host }.
export async function createZoomMeeting(m) {
  const t = await token(), start = m.start_ts.replace(' ', 'T') + ':00', mins = Math.max(1, Math.round((Date.parse(m.end_ts.replace(' ', 'T')) - Date.parse(m.start_ts.replace(' ', 'T'))) / 60000));
  const r = await fetch(`${API()}/v2/users/me/meetings`, { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ topic: m.title, agenda: m.topic || m.purpose || '', type: 2, start_time: start, duration: mins, timezone: m.timezone || 'Asia/Karachi',
      settings: { waiting_room: !!m.waiting_room, join_before_host: !!m.join_before_host && !m.waiting_room, mute_upon_entry: !!m.mute_entry, host_video: !!m.host_video, participant_video: !!m.participant_video, auto_recording: rec[m.auto_recording] ?? 'none' } }) });
  if (!r.ok) throw new Error(`Zoom could not create the meeting (${r.status})`);
  const j = await r.json(); return { id: String(j.id), join_url: j.join_url ?? null, start_url: j.start_url ?? null, host: j.host_email ?? null };
}
export async function deleteZoomMeeting(id) {
  try { const t = await token(); await fetch(`${API()}/v2/meetings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(12000) }); } catch {}
}
