'use strict';
// Raumlogik ohne Netzwerkcode: Teilnehmer, Limit, Reconnect-Fenster, Relay, Chat.
// "conn" ist ein beliebiges Objekt mit send(obj) und close(code) – so ist alles ohne
// echte WebSockets testbar.
const crypto = require('node:crypto');

const NAME_MAX = 32;
const CHAT_MAX = 500;

// Whitespace zu einem Leerzeichen, danach alle Steuer-/Formatzeichen entfernen
// (inkl. Bidi-Overrides, Zero-Width-Zeichen) – so kann niemand Namen "fälschen".
function clean(str, max) {
  if (typeof str !== 'string') return '';
  const s = str.replace(/\s+/gu, ' ').replace(/\p{C}/gu, '').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

class Room {
  constructor({ name = 'Voicechat', maxPeers = 6, graceMs = 15_000, chatBurst = 5, chatWindowMs = 5_000, now = Date.now } = {}) {
    this.name = name;
    this.maxPeers = maxPeers;
    this.graceMs = graceMs;
    this.chatBurst = chatBurst;
    this.chatWindowMs = chatWindowMs;
    this.now = now;
    this.peers = new Map(); // id -> peer
    this.byToken = new Map(); // Reconnect-Token -> peer
  }

  // Eindeutiger Anzeigename: "Anna", "Anna (2)", ...
  _uniqueName(wanted) {
    const base = clean(wanted, NAME_MAX) || 'Gast';
    const taken = new Set([...this.peers.values()].map((p) => p.name.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = Array.from(base).slice(0, NAME_MAX - suffix.length).join('') + suffix;
    }
    return name;
  }

  _others(exceptId) {
    return [...this.peers.values()]
      .filter((p) => p.id !== exceptId)
      .map((p) => ({ id: p.id, name: p.name, muted: p.muted }));
  }

  _broadcast(msg, exceptId) {
    for (const p of this.peers.values()) if (p.conn && p.id !== exceptId) p.conn.send(msg);
  }

  // Beitritt ODER Wiederaufnahme: Dasselbe Token bedeutet "gleiche Person, neue Verbindung".
  // Die Peer-ID bleibt dann gleich, deshalb überleben die WebRTC-Verbindungen der anderen.
  //
  // Wiederaufnahme gilt nur, wenn der Client "resume" meldet, also dieselbe Seite nach einem
  // Verbindungsabbruch. Dasselbe Token OHNE resume (Seite neu geladen, Tab dupliziert) heißt:
  // Die alte Seite samt ihren PeerConnections ist weg. Dann muss der Platz wirklich geräumt werden
  // (peer-left), damit die anderen beim neuen peer-joined frisch anbieten – sonst blieben sie
  // an einer toten Verbindung hängen.
  join({ token, name, conn, resume = false }) {
    let existing = this.byToken.get(token);
    if (existing && !resume) {
      if (existing.conn) existing.conn.close(4002);
      this._remove(existing.id);
      existing = null;
    }
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = null;
      const old = existing.conn;
      existing.conn = conn;
      if (old && old !== conn) old.close(4002); // alte Verbindung (z. B. zweiter Tab) verdrängen
      return { ok: true, id: existing.id, name: existing.name, resumed: true, peers: this._others(existing.id) };
    }
    // Gehaltene (kurz getrennte) Plätze zählen mit – sonst könnte jemand "dazwischenschlüpfen".
    if (this.peers.size >= this.maxPeers) return { ok: false, code: 'room-full', maxPeers: this.maxPeers };

    const peer = {
      id: crypto.randomBytes(6).toString('hex'),
      name: this._uniqueName(name),
      token,
      conn,
      timer: null,
      muted: false,
      chatTimes: [],
    };
    this.peers.set(peer.id, peer);
    this.byToken.set(token, peer);
    this._broadcast({ type: 'peer-joined', id: peer.id, name: peer.name, muted: false }, peer.id);
    return { ok: true, id: peer.id, name: peer.name, resumed: false, peers: this._others(peer.id) };
  }

  // Verbindung abgerissen: Platz für graceMs halten, ohne den anderen "left" zu melden.
  detach(id, conn) {
    const peer = this.peers.get(id);
    if (!peer || peer.conn !== conn) return; // wurde bereits durch neue Verbindung ersetzt
    peer.conn = null;
    peer.timer = setTimeout(() => this._remove(id), this.graceMs);
    peer.timer.unref?.();
  }

  leave(id) {
    this._remove(id);
  }

  _remove(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timer);
    this.peers.delete(id);
    this.byToken.delete(peer.token);
    this._broadcast({ type: 'peer-left', id });
  }

  // Leitet Offer/Answer/ICE an genau einen Teilnehmer desselben Raums weiter.
  // "from" setzt der Server – Clients können keine fremde Absenderkennung vortäuschen.
  relay(fromId, toId, data) {
    const to = this.peers.get(toId);
    if (!this.peers.has(fromId) || !to || !to.conn || fromId === toId) return false;
    to.conn.send({ type: 'signal', from: fromId, data });
    return true;
  }

  setMuted(id, muted) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.muted = Boolean(muted);
    this._broadcast({ type: 'peer-state', id, muted: peer.muted }, id);
  }

  chat(id, text) {
    const peer = this.peers.get(id);
    const msg = clean(text, CHAT_MAX);
    if (!peer || !msg) return { ok: true };
    const t = this.now();
    peer.chatTimes = peer.chatTimes.filter((x) => t - x < this.chatWindowMs);
    if (peer.chatTimes.length >= this.chatBurst) return { ok: false, code: 'rate-limit' };
    peer.chatTimes.push(t);
    // Wird nur weitergereicht, nirgends gespeichert oder geloggt.
    this._broadcast({ type: 'chat', from: id, name: peer.name, text: msg, ts: t });
    return { ok: true };
  }
}

module.exports = { Room, clean, NAME_MAX, CHAT_MAX };
