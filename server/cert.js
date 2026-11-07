'use strict';
// Selbstsigniertes Zertifikat: Browser verlangen HTTPS, sonst gibt es kein Mikrofon.
//
// Wichtig für iOS/macOS: Apple lehnt Server-Zertifikate ab (teils ohne "Trotzdem öffnen"),
// die diese Regeln verletzen: RSA >= 2048, SHA-256, Laufzeit <= 825 Tage, Hostname bzw. IP
// als SAN-Eintrag (der Common Name zählt nicht!) und extendedKeyUsage serverAuth.
// Deshalb setzen wir alles explizit und tragen ALLE LAN-IPs dieses Rechners in die SAN ein.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const selfsigned = require('selfsigned');

const VALID_DAYS = 365;
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;

function sanEntries(addresses, hostname) {
  const dns = new Set(['localhost']);
  if (hostname) {
    dns.add(hostname);
    dns.add(`${hostname}.local`);
  }
  const ips = new Set(['127.0.0.1', ...addresses]);
  return [
    ...[...dns].map((value) => ({ type: 2, value })),
    ...[...ips].map((ip) => ({ type: 7, ip })),
  ];
}

// Prüft, ob ein vorhandenes Zertifikat noch gültig ist und alle aktuellen IPs abdeckt.
function certIsUsable(certPem, addresses, now = Date.now()) {
  try {
    const x = new crypto.X509Certificate(certPem);
    if (new Date(x.validTo).getTime() - now < RENEW_BEFORE_MS) return false;
    if (new Date(x.validFrom).getTime() > now) return false;
    // Exakter Vergleich pro Eintrag ("IP Address:192.168.2.12" darf nicht auf "...2.126" passen).
    const entries = new Set((x.subjectAltName || '').split(', '));
    return addresses.every((ip) => entries.has(`IP Address:${ip}`));
  } catch {
    return false;
  }
}

async function ensureCert({ certDir, addresses, hostname }) {
  const keyFile = path.join(certDir, 'key.pem');
  const certFile = path.join(certDir, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    if (certIsUsable(cert, addresses)) return { key, cert, created: false };
  }
  const notBeforeDate = new Date(Date.now() - 24 * 3600 * 1000); // Uhren-Toleranz von Gästen
  const notAfterDate = new Date(notBeforeDate.getTime() + VALID_DAYS * 24 * 3600 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'LanVoice' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: sanEntries(addresses, hostname) },
    ],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert, created: true };
}

module.exports = { ensureCert, certIsUsable };
