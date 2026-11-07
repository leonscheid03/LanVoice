'use strict';
// Setzt alle Server-Teile zusammen. Getrennt vom CLI (index.js), damit Tests den Server starten können.
const os = require('node:os');
const path = require('node:path');
const { listLanAddresses } = require('./netinfo');
const { ensureCert } = require('./cert');
const { Room } = require('./room');
const { createSignaling } = require('./signaling');
const { createStaticHandler } = require('./static');
const { createListener } = require('./listener');

// Was Gäste über Klartext-HTTP sehen dürfen: nur die Hilfeseite und ihre Dateien.
const HELP_FILES = new Set(['/hilfe.html', '/style.css', '/js/hilfe.js']);

async function createApp({
  port = 8443,
  host = '0.0.0.0',
  roomName = 'Voicechat',
  maxPeers = 6,
  graceMs,
  certDir = path.join(__dirname, '..', 'certs'),
  publicDir = path.join(__dirname, '..', 'public'),
} = {}) {
  const addresses = listLanAddresses();
  const { key, cert, created } = await ensureCert({
    certDir,
    addresses: addresses.map((a) => a.address),
    hostname: os.hostname(),
  });

  const room = new Room({ name: roomName, maxPeers, graceMs });
  const signaling = createSignaling(room);
  const listener = createListener({
    tls: { key, cert },
    appHandler: createStaticHandler({ root: publicDir, index: 'index.html' }),
    helpHandler: createStaticHandler({ root: publicDir, index: 'hilfe.html', allow: HELP_FILES }),
    onUpgrade: signaling.handleUpgrade,
  });

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, host, resolve);
  });

  return {
    room,
    addresses,
    certCreated: created,
    port: listener.address().port,
    close() {
      signaling.close();
      listener.closeAll();
    },
  };
}

module.exports = { createApp };
