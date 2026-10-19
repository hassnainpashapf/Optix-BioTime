import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DB_FILE } from './db.js';

// Biometric templates are personal data. When they are stored at all they are encrypted (AES-256-GCM) with a key that lives
// OUTSIDE the database (BIO_KEY, or a key file next to it), so a copied database or backup alone does not expose them.
let memKey = null;
function key() {
  if (/^[0-9a-f]{64}$/i.test(process.env.BIO_KEY ?? '')) return Buffer.from(process.env.BIO_KEY, 'hex');
  if (DB_FILE === ':memory:') return (memKey ??= randomBytes(32));
  const f = DB_FILE + '.biokey';
  if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(readFileSync(f, 'utf8').trim(), 'hex');
}
export function encrypt(text) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv), ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function decrypt(buf) {
  const b = Buffer.from(buf), d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
