'use strict';
// Ermittelt die IPv4-Adressen dieses Rechners, unter denen Gäste ihn erreichen können.
const os = require('node:os');

// Adapter, die fast nie das "echte" WLAN/LAN sind (WSL, Hyper-V, Docker, VPNs ...).
// Sie werden nicht ausgeschlossen (Zertifikat deckt sie ab), aber ans Ende sortiert,
// damit der QR-Code auf die wahrscheinlich richtige Adresse zeigt.
const VIRTUAL_NAME = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|docker|veth|virbr|br-|tailscale|zerotier|hamachi|\btun|\btap|loopback|bluetooth/i;

function privateRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
  return 3;
}

function listLanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      // Node 18.0-18.3 liefert family als Zahl 4, später als 'IPv4'.
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL_NAME.test(name) });
    }
  }
  // Array.prototype.sort ist stabil: gleiche Ränge behalten ihre Reihenfolge.
  return out.sort((a, b) => (a.virtual - b.virtual) || (privateRank(a.address) - privateRank(b.address)));
}

module.exports = { listLanAddresses };
