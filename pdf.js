// Minimal PDF table writer (configurable page and direction, Helvetica,
// repeating header row, page numbers). Text is WinAnsi: other characters print as "?".
const M = 28;
const enc = (s) => Buffer.from(String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[^\x00-\xff]/g, '?'), 'latin1');
const esc = (b) => b.toString('latin1').replace(/[\\()]/g, (c) => '\\' + c);
const f2 = (n) => (Math.round(n * 100) / 100).toString();

export function makePdf({ title, subtitle = '', columns, rows, pageSize = 'A4', orientation = 'landscape' }) {
  const sizes = { A4: [595, 842], Letter: [612, 792], Legal: [612, 1008] };
  const base = sizes[pageSize] || sizes.A4, portrait = orientation === 'portrait' || orientation === 'vertical' || (orientation === 'default' && columns.length <= 6);
  const [PW, PH] = portrait ? base : [base[1], base[0]];
  // font size shrinks until the columns fit the page width, then text is trimmed
  let fs = 8;
  const natural = (size) => columns.map(c => Math.min(34, Math.max(String(c.label).length, ...rows.slice(0, 400).map(r => String(r[c.key] ?? '').length))) * size * 0.52 + 8);
  let widths = natural(fs); const avail = PW - 2 * M;
  while (widths.reduce((a, b) => a + b, 0) > avail && fs > 5.5) { fs -= 0.5; widths = natural(fs); }
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > avail) widths = widths.map(w => (w * avail) / total);
  const charW = fs * 0.52, rowH = fs + 6, top = PH - M - 44, bottom = M + 18;
  const perPage = Math.max(1, Math.floor((top - bottom) / rowH) - 1);
  const pages = []; for (let i = 0; i < Math.max(rows.length, 1); i += perPage) pages.push(rows.slice(i, i + perPage));

  const fit = (v, w) => { const s = String(v ?? '').replace(/[\r\n\t]+/g, ' '); const max = Math.max(1, Math.floor((w - 6) / charW)); return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '.' : s; };
  const text = (x, y, s, bold = false) => `BT /${bold ? 'F2' : 'F1'} ${f2(fs)} Tf ${f2(x)} ${f2(y)} Td (${esc(enc(s))}) Tj ET\n`;
  const isNum = (v) => typeof v === 'number';

  const streams = pages.map((chunk, pi) => {
    let c = `BT /F2 14 Tf ${M} ${PH - M - 8} Td (${esc(enc(title))}) Tj ET\n`;
    if (subtitle) c += `BT /F1 8.5 Tf ${M} ${PH - M - 22} Td 0.4 0.4 0.4 rg (${esc(enc(subtitle))}) Tj ET 0 g\n`;
    let y = top;
    c += `0.91 0.93 0.96 rg ${M} ${f2(y - 4)} ${f2(widths.reduce((a, b) => a + b, 0))} ${f2(rowH)} re f 0 g\n`;
    let x = M; columns.forEach((col, i) => { c += text(x + 3, y + 2, fit(col.label, widths[i]), true); x += widths[i]; });
    chunk.forEach((r, n) => {
      y -= rowH;
      if (n % 2) c += `0.97 0.97 0.98 rg ${M} ${f2(y - 4)} ${f2(widths.reduce((a, b) => a + b, 0))} ${f2(rowH)} re f 0 g\n`;
      let cx = M;
      columns.forEach((col, i) => { const v = r[col.key]; const s = fit(v, widths[i]); c += text(isNum(v) ? cx + widths[i] - 3 - s.length * charW : cx + 3, y + 2, s); cx += widths[i]; });
    });
    c += `BT /F1 7.5 Tf ${M} ${M - 4} Td 0.4 0.4 0.4 rg (${esc(enc(`Page ${pi + 1} of ${pages.length}   -   ${rows.length} rows   -   generated ${new Date().toLocaleString('sv')}`))}) Tj ET 0 g\n`;
    return c;
  });

  // object layout: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then (page, content) pairs
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  streams.forEach((s, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = { stream: s };
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; const offsets = []; let pos = parts[0].length;
  for (let n = 1; n < objs.length; n++) {
    const o = objs[n];
    const body = typeof o === 'string' ? Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${Buffer.byteLength(o.stream, 'latin1')} >>\nstream\n`, 'latin1'), Buffer.from(o.stream, 'latin1'), Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    offsets[n] = pos; parts.push(body); pos += body.length;
  }
  const xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
