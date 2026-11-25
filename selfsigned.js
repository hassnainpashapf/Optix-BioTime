// A self-signed TLS certificate made with nothing but Node (no openssl needed, so it also works inside the Windows installer).
import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';

const len = (n) => n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p))); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p);
const oid = (s) => { const a = s.split('.').map(Number), out = [a[0] * 40 + a[1]]; for (const n of a.slice(2)) { const b = [n & 127]; let v = n >> 7; while (v) { b.unshift((v & 127) | 128); v >>= 7; } out.push(...b); } return tlv(0x06, Buffer.from(out)); };
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8')), int = (buf) => tlv(0x02, buf[0] & 128 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b])), octets = (b) => tlv(0x04, b);
const utc = (d) => tlv(0x17, d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'), gen = (d) => tlv(0x18, d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z');
const when = (d) => d.getUTCFullYear() < 2050 ? utc(d) : gen(d);
const name = (cn) => seq(set(seq(oid('2.5.4.10'), utf8('Optix'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const ip4 = (s) => Buffer.from(s.split('.').map(Number));

// hosts: DNS names and IPv4 addresses the certificate should be valid for
export function makeSelfSigned({ hosts = ['localhost'], days = 3650, cn } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const names = [...new Set(['localhost', '127.0.0.1', ...hosts].filter(Boolean))], common = cn || hosts.find(h => h && !/^\d+\.\d+\.\d+\.\d+$/.test(h)) || hosts.find(Boolean) || 'localhost';
  const san = seq(...names.map(h => /^\d+\.\d+\.\d+\.\d+$/.test(h) ? tlv(0x87, ip4(h)) : tlv(0x82, h)));
  const sigAlg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([5, 0]));
  const nb = new Date(Date.now() - 86400000), na = new Date(Date.now() + days * 86400000);
  const exts = tlv(0xa3, seq(
    seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), octets(seq())),              // basicConstraints (critical)... CA false
    seq(oid('2.5.29.15'), tlv(0x01, Buffer.from([0xff])), octets(bits(Buffer.from([0xa0])))),   // keyUsage: digitalSignature, keyEncipherment
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))),                           // extKeyUsage: serverAuth
    seq(oid('2.5.29.17'), octets(san))));                                                    // subjectAltName
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])), sigAlg, name(common), seq(when(nb), when(na)), name(common), Buffer.from(publicKey.export({ type: 'spki', format: 'der' })), exts);
  const sig = createSign('sha256').update(tbs).sign(privateKey);
  const der = seq(tbs, sigAlg, bits(sig)), b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return { cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), names };
}
