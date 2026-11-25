const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[2], { readOnly: true });
  const ok = db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
  const users = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  db.close();
  if (!ok || !users) throw new Error('Database integrity check failed');
  console.log('Database connection and integrity: OK');
} catch (e) { console.error(e.message); process.exitCode = 1; }
