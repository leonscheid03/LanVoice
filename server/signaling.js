'use strict';
// WebSocket-Schicht: parst und validiert Nachrichten, ruft die Raumlogik auf.
// Es wird nichts geloggt (weder Chat noch SDP).
const { WebSocketServer } = require('ws');

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SDP_MAX = 30_000; // SDP eines Audio-Offers hat wenige KB
const CANDIDATE_MAX = 1_000;

function str(v, max) {
  return typeof v === 'string' && v.length <= max;
}

// Baut die weiterzuleitende Nachricht aus bekannten Feldern neu auf (nichts Unbekanntes wird durchgereicht).
function sanitizeSignal(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.description) {
    const { type, sdp } = d.description;
    if (!['offer', 'answer', 'rollback'].includes(type) || !str(sdp ?? '', SDP_MAX)) return null;
    return { description: { type, sdp: sdp ?? '' } };
  }
  if (d.candidate && typeof d.candidate === 'object') {
    const { candidate, sdpMid = null, sdpMLineIndex = null, usernameFragment = null } = d.candidate;
    if (!str(candidate, CANDIDATE_MAX)) return null;
    if (sdpMid !== null && !str(sdpMid, 64)) return null;
    if (sdpMLineIndex !== null && !Number.isInteger(sdpMLineIndex)) return null;
    if (usernameFragment !== null && !str(usernameFragment, 64)) return null;
    return { candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  // Leeres Kandidaten-Ende ("end of candidates") bewusst nicht weiterleiten.
  return null;
}

function createSignaling(room, { pingMs = 15_000, joinTimeoutMs = 10_000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Stirbt eine Verbindung leise (Handy im Standby, WLAN weg), merkt man das nur durch Ping/Pong.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, pingMs);
  pinger.unref?.();

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => {});

    const conn = {
      send: (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj)),
      close: (code) => ws.close(code),
    };
    let peerId = null;
    const joinTimer = setTimeout(() => ws.close(4003), joinTimeoutMs);

    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (peerId) room.detach(peerId, conn);
    });

    ws.on('message', (raw, isBinary) => {
      let msg;
      try {
        if (isBinary) throw new Error('binary');
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(1007);
      }
      if (!msg || typeof msg !== 'object') return ws.close(1007);

      if (!peerId) {
        if (msg.type !== 'join' || !TOKEN_RE.test(msg.token)) return ws.close(1008);
        const res = room.join({ token: msg.token, name: msg.name, conn, resume: msg.resume === true });
        if (!res.ok) {
          conn.send({ type: 'error', code: res.code, maxPeers: res.maxPeers });
          return ws.close(4001);
        }
        clearTimeout(joinTimer);
        peerId = res.id;
        return conn.send({
          type: 'welcome',
          id: res.id,
          name: res.name,
          room: room.name,
          maxPeers: room.maxPeers,
          resumed: res.resumed,
          peers: res.peers,
        });
      }

      switch (msg.type) {
        case 'signal': {
          const data = sanitizeSignal(msg.data);
          if (typeof msg.to === 'string' && data) room.relay(peerId, msg.to, data);
          break;
        }
        case 'chat': {
          const r = room.chat(peerId, msg.text);
          if (!r.ok) conn.send({ type: 'error', code: r.code });
          break;
        }
        case 'ping': // Lebenszeichen-Test des Clients (erkennt tote Verbindungen nach Standby/WLAN-Wechsel)
          conn.send({ type: 'pong' });
          break;
        case 'state':
          room.setMuted(peerId, msg.muted === true);
          break;
        case 'leave':
          room.leave(peerId);
          peerId = null;
          ws.close(1000);
          break;
        default:
          break; // Unbekanntes ignorieren
      }
    });
  });

  // Same-Origin-Prüfung: Eine fremde Webseite im Browser eines Gasts darf sich nicht verbinden.
  // Fehlender Origin (Nicht-Browser-Clients) ist im LAN-Kontext unkritisch.
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function handleUpgrade(req, socket, head) {
    const path = new URL(req.url, 'http://x').pathname;
    if (path !== '/ws' || !originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  function close() {
    clearInterval(pinger);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { handleUpgrade, close };
}

module.exports = { createSignaling, sanitizeSignal };
