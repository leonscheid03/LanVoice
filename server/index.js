#!/usr/bin/env node
'use strict';
// Kommandozeilen-Einstieg: npm start [-- --port 8443 --room "Mein Raum" --max 6]
const { parseArgs } = require('node:util');
const qrcode = require('qrcode-terminal');
const { createApp } = require('./app');

const HELP = `LanVoice – lokaler Voicechat

Aufruf: npm start [-- Optionen]

  -p, --port <n>     Port (Standard 8443, oder Umgebungsvariable LANVOICE_PORT)
  -r, --room <name>  Raumname (Standard "Voicechat", oder LANVOICE_ROOM)
  -m, --max <n>      Maximale Teilnehmer, 2-20 (Standard 6, oder LANVOICE_MAX)
  -h, --help         Diese Hilfe
`;

function intOption(value, fallback, min, max, label) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`Ungültiger Wert für ${label}: "${value}" (erlaubt: ${min}-${max})`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      room: { type: 'string', short: 'r' },
      max: { type: 'string', short: 'm' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return console.log(HELP);

  const port = intOption(values.port ?? process.env.LANVOICE_PORT, 8443, 1, 65535, 'Port');
  const maxPeers = intOption(values.max ?? process.env.LANVOICE_MAX, 6, 2, 20, 'Teilnehmer-Maximum');
  const roomName = (values.room ?? process.env.LANVOICE_ROOM ?? 'Voicechat').trim() || 'Voicechat';

  let app;
  try {
    app = await createApp({ port, roomName, maxPeers });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} ist schon belegt. Anderen Port wählen: npm start -- --port 9443`);
    } else {
      console.error('Start fehlgeschlagen:', err.message);
    }
    process.exit(1);
  }

  const best = app.addresses[0];
  console.log(`\nLanVoice läuft – Raum "${roomName}", max. ${maxPeers} Teilnehmer`);
  if (app.certCreated) console.log('(Neues selbstsigniertes Zertifikat erzeugt – siehe Ordner certs/)');

  console.log('\nDu selbst (ohne Zertifikatswarnung):');
  console.log(`  http://localhost:${app.port}`);

  if (app.addresses.length === 0) {
    console.log('\nKeine Netzwerkadresse gefunden – bist du mit WLAN/LAN verbunden?');
  } else {
    console.log('\nGäste im selben WLAN/LAN öffnen:');
    for (const a of app.addresses) {
      console.log(`  http://${a.address}:${app.port}${a === best ? '   <- QR-Code' : ''}${a.virtual ? `   (${a.name}, evtl. virtuell)` : ''}`);
    }
    console.log('\n(Die Seite führt Gäste durch die Zertifikatswarnung und leitet auf https:// weiter.)\n');
    qrcode.generate(`http://${best.address}:${app.port}`, { small: true });
  }

  console.log(`
Zertifikat-Fingerabdruck (SHA-256, für die Android-App):
  ${app.certFingerprint}

Kommen Geräte nicht an?
  - Firewall: Windows fragt beim ersten Start; "Private Netzwerke" erlauben. Sonst:
      Windows : Einstellungen > Firewall > App zulassen > node.exe (Privat). WLAN-Profil auf "Privat" stellen.
      macOS   : Systemeinstellungen > Netzwerk > Firewall > node erlauben.
      Linux   : z. B. sudo ufw allow ${port}/tcp
  - Router: "Client-/AP-Isolation" (Gäste-WLAN) verhindert, dass sich Geräte untereinander sehen.
  - Kein Port-Forwarding einrichten: Die App ist nur fürs lokale Netz gedacht.

Beenden mit Strg+C.`);

  process.on('SIGINT', () => {
    app.close();
    process.exit(0);
  });
}

main();
