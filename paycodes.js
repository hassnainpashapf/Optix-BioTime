import express from 'express';
import { db } from './db.js';

// Short codes shown in the monthly grids, and how much of a day is paid for each attendance status (1 = full day, 0 = nothing, 0.5 = half).
let cache = null; // read once, cleared when a code is edited
// the grids show the symbol (P, L, E, A like BioTime) when a code has one, else the code itself
const load = () => (cache ??= (() => { try { return db.prepare("SELECT status, COALESCE(NULLIF(symbol,''), code) AS code, pay_factor FROM pay_codes").all(); } catch { return db.prepare('SELECT status, code, pay_factor FROM pay_codes').all(); } })());
export const bustCodes = () => { cache = null; }; // called when another module edits pay_codes
export const codeMap = () => Object.fromEntries(load().map(r => [r.status, r.code]));
export const factorMap = () => Object.fromEntries(load().map(r => [r.status, r.pay_factor]));

export const payCodesRouter = express.Router();
const fail = (res, m, c = 400) => res.status(c).json({ error: m });
payCodesRouter.get('/pay_codes', (_q, res) => res.json(db.prepare('SELECT * FROM pay_codes ORDER BY CASE status WHEN \'Present\' THEN 0 ELSE 1 END, status').all()));
payCodesRouter.put('/pay_codes/:status', (req, res) => {
  const row = db.prepare('SELECT * FROM pay_codes WHERE status=?').get(req.params.status); if (!row) return fail(res, 'Unknown status', 404);
  const b = req.body ?? {}, code = 'code' in b ? String(b.code).trim().toUpperCase() : row.code, f = 'pay_factor' in b ? Number(b.pay_factor) : row.pay_factor;
  if (!/^[A-Z0-9+\-]{1,4}$/.test(code)) return fail(res, 'A code is 1 to 4 letters or digits');
  if (db.prepare('SELECT 1 FROM pay_codes WHERE code=? AND status!=?').get(code, row.status)) return fail(res, 'Another status already uses this code');
  if (!(f >= 0 && f <= 1)) return fail(res, 'Pay share is from 0 (nothing) to 1 (full day)');
  if (['Present', 'Weekly Off', 'Holiday'].includes(row.status) && f !== 1) return fail(res, `${row.status} is always paid in full`);
  cache = null; db.prepare('UPDATE pay_codes SET code=?, pay_factor=?, label=? WHERE status=?').run(code, f, 'label' in b ? (String(b.label ?? '').slice(0, 60) || null) : row.label, row.status);
  if ('code' in b) { try { db.prepare('UPDATE pay_codes SET symbol=? WHERE status=?').run(code, row.status); } catch {} } // an edited code is what the grids show
  res.json({ ok: true });
});
