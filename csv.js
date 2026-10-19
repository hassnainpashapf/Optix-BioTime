// Minimal RFC-4180 CSV parser/serializer (quotes, embedded commas/newlines, BOM).
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
// Cells starting with = + - @ are prefixed so a spreadsheet will not run them as formulas.
export const safeCell = (v) => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s; };
export const csvCell = (v) => `"${safeCell(v).replace(/"/g, '""')}"`;
export const toCsv = (keys, rows) => [keys.join(','), ...rows.map(r => keys.map(k => csvCell(r[k])).join(','))].join('\n');
// Same, but with human column labels in the header row (used by report exports).
export const toCsvCols = (columns, rows) => [columns.map(c => csvCell(c.label)).join(','), ...rows.map(r => columns.map(c => csvCell(r[c.key])).join(','))].join('\n');
