// Runs the server and starts it again whenever it exits (a restore or "Restart Now" in Server Setting stops it on purpose).
// Used by the Windows installer (scheduled task) and the Linux service; plain `node server.js` still works for development.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const data = process.env.OPTIX_DATA || (process.platform === 'win32' ? join(process.env.ProgramData || 'C:\\ProgramData', 'OKT') : '/var/lib/optix');
mkdirSync(data, { recursive: true });
let savedBackup = '';
try { savedBackup = readFileSync(join(data, 'backup-path.txt'), 'utf8').trim(); } catch {}
const env = { ...process.env, DB_FILE: process.env.DB_FILE || join(data, 'okt.db'), BACKUP_DIR: process.env.BACKUP_DIR || savedBackup || join(data, 'backups'), LOG_DIR: process.env.LOG_DIR || join(data, 'logs'), UPLOAD_DIR: process.env.UPLOAD_DIR || join(data, 'uploads'), CERT_DIR: process.env.CERT_DIR || join(data, 'certs'), SERVER_CONFIG: process.env.SERVER_CONFIG || join(data, 'server.json') };
let quick = 0, child, stopping = false;
const run = () => {
  const t0 = Date.now();
  child = spawn(process.execPath, [join(here, 'server.js')], { env, stdio: 'inherit', cwd: here });
  child.on('exit', (code) => {
    if (stopping) return process.exit(0);
    quick = Date.now() - t0 < 5000 ? quick + 1 : 0;
    console.log(`server exited (${code}); starting again${quick >= 5 ? ' in 15 seconds' : ''}`);
    setTimeout(run, quick >= 5 ? 15000 : 800);
  });
};
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; child?.kill(); setTimeout(() => process.exit(0), 3000).unref(); });
run();
