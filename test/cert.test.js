'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureCert, certIsUsable } = require('../server/cert');

const DAY = 24 * 3600 * 1000;
// DER-Kodierung der OID sha256WithRSAEncryption (1.2.840.113549.1.1.11)
const SHA256_RSA_OID = Buffer.from('2a864886f70d01010b', 'hex');

test('Zertifikat erfüllt die iOS-Regeln und wird wiederverwendet bzw. bei neuer IP erneuert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvoice-cert-'));
  try {
    const ips = ['192.168.1.5', '10.0.0.2'];
    const first = await ensureCert({ certDir: dir, addresses: ips, hostname: 'testhost' });
    assert.equal(first.created, true);

    const x = new crypto.X509Certificate(first.cert);
    for (const ip of ips) assert.match(x.subjectAltName, new RegExp(`IP Address:${ip.replace(/\./g, '\\.')}`));
    assert.match(x.subjectAltName, /DNS:localhost/);
    assert.match(x.subjectAltName, /DNS:testhost/);
    assert.match(x.subjectAltName, /IP Address:127\.0\.0\.1/);

    const days = (new Date(x.validTo) - new Date(x.validFrom)) / DAY;
    assert.ok(days > 300 && days <= 825, `Laufzeit ${days} Tage`);
    assert.ok(x.publicKey.asymmetricKeyDetails.modulusLength >= 2048);
    assert.ok(x.raw.includes(SHA256_RSA_OID), 'Signatur muss SHA-256/RSA sein');
    assert.equal(x.ca, false);
    assert.deepEqual(x.keyUsage, ['1.3.6.1.5.5.7.3.1']); // nur serverAuth

    // Schlüssel passt zum Zertifikat
    assert.ok(x.checkPrivateKey(crypto.createPrivateKey(first.key)));

    const second = await ensureCert({ certDir: dir, addresses: ips, hostname: 'testhost' });
    assert.equal(second.created, false);
    assert.equal(second.cert, first.cert);

    const third = await ensureCert({ certDir: dir, addresses: [...ips, '172.16.0.9'], hostname: 'testhost' });
    assert.equal(third.created, true);
    assert.match(new crypto.X509Certificate(third.cert).subjectAltName, /IP Address:172\.16\.0\.9/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('certIsUsable: IP-Vergleich ist exakt (…2.12 passt nicht auf …2.126)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvoice-cert-'));
  try {
    const { cert } = await ensureCert({ certDir: dir, addresses: ['192.168.2.126'], hostname: 'h' });
    assert.equal(certIsUsable(cert, ['192.168.2.126']), true);
    assert.equal(certIsUsable(cert, ['192.168.2.12']), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('certIsUsable: kaputtes oder bald ablaufendes Zertifikat wird verworfen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvoice-cert-'));
  try {
    const { cert } = await ensureCert({ certDir: dir, addresses: ['192.168.1.5'], hostname: 'h' });
    assert.equal(certIsUsable(cert, ['192.168.1.5']), true);
    assert.equal(certIsUsable(cert, ['192.168.1.5'], Date.now() + 340 * DAY), false); // < 30 Tage Rest
    assert.equal(certIsUsable('kein zertifikat', ['192.168.1.5']), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
