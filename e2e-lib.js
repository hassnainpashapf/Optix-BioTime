// Shared helper: start a real server with a throwaway database and talk to it as admin.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startServer(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'att-e2e-'));
  const PORT = 18000 + Math.floor(Math.random() * 1000), base = `http://localhost:${PORT}`;
  const env = { ...process.env, PORT, DB_FILE: join(dir, 'e2e.db'), BACKUP_DIR: join(dir, 'bk'), LOG_DIR: join(dir, 'logs'), UPLOAD_DIR: join(dir, 'up'), ADMIN_PASSWORD: 'e2e-pass', ...extraEnv };
  const launch = async () => {
    const p = spawn('node', ['server.js'], { env, stdio: 'pipe' });
    p.exited = new Promise(r => p.once('exit', r));
    for (let i = 0; i < 80; i++) { try { await fetch(base + '/iclock/ping'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    return p;
  };
  let srv = await launch();
  const S = { base, dir, env, token: '', stop() { srv.kill(); rmSync(dir, { recursive: true, force: true }); },
    // wait for the server to stop by itself (a restore does this), then start it again on the same files
    async restart() { await Promise.race([srv.exited, new Promise((_, no) => setTimeout(() => no(new Error('server did not stop')), 8000))]); srv = await launch(); S.token = await S.login(); } };
  S.raw = (path, method = 'GET', body, token = S.token) => fetch(base + '/api/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : JSON.stringify(body) });
  S.api = async (path, method = 'GET', body) => {
    const r = await S.raw(path, method, body); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`); return j;
  };
  S.login = async (username = 'admin', password = 'e2e-pass') => {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return (await r.json()).token;
  };
  S.token = await S.login();
  return S;
}
