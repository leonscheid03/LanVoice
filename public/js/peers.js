// WebRTC-Mesh: pro Gegenstelle eine RTCPeerConnection, Aushandlung nach dem
// "Perfect Negotiation"-Muster (https://w3c.github.io/webrtc-pc/#perfect-negotiation-example).
//
// Problem: Beide Seiten können gleichzeitig ein Offer senden ("Glare"). Lösung: Eine Seite ist
// "polite" und gibt nach (rollt ihr eigenes Offer zurück), die andere "impolite" ignoriert das
// kollidierende Offer. Wer polite ist, entscheiden wir über den Vergleich der Server-IDs –
// beide Seiten kommen so ohne Absprache zum selben Ergebnis.
//
// Nur Host-Kandidaten: iceServers ist leer, es gibt weder STUN noch TURN. Damit der Browser echte
// LAN-IPs statt "xyz.local"-mDNS-Namen in die Kandidaten schreibt, muss die Mikrofonfreigabe
// VOR dem Erzeugen der ersten Verbindung vorliegen (steht in app.js).
const DISCONNECT_RESTART_MS = 4000;

function connectionState(pc) {
  if (pc.connectionState) return pc.connectionState;
  const i = pc.iceConnectionState; // ältere Browser
  return i === 'completed' ? 'connected' : i === 'checking' ? 'connecting' : i;
}

export class Mesh {
  constructor({ send, getTrack, getStream, onStream, onState, onGone }) {
    this.send = send; // (toId, data) => void
    this.getTrack = getTrack;
    this.getStream = getStream;
    this.onStream = onStream;
    this.onState = onState;
    this.onGone = onGone;
    this.selfId = null;
    this.peers = new Map();
  }

  setSelf(id) {
    this.selfId = id;
  }

  has(id) {
    return this.peers.has(id);
  }

  /**
   * @param {boolean} initiator  true = wir waren zuerst im Raum und senden das erste Offer.
   *   Der Neuankömmling wartet, damit nicht beide Seiten gleichzeitig anbieten.
   *   (Perfect Negotiation löst Kollisionen trotzdem sauber, falls es doch passiert.)
   */
  ensure(id, initiator) {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: [] });
    const p = {
      id,
      pc,
      initiator,
      polite: this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
      disconnectTimer: 0,
      sender: null,
    };
    this.peers.set(id, p);

    const track = this.getTrack();
    if (track) p.sender = pc.addTrack(track, this.getStream());

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(id, { candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track: t, streams }) => this.onStream(id, streams[0] || new MediaStream([t]));

    pc.onnegotiationneeded = async () => {
      if (!p.initiator && !pc.remoteDescription) return; // Erstes Offer kommt von der Gegenseite
      try {
        p.makingOffer = true;
        await pc.setLocalDescription(); // erzeugt je nach Zustand automatisch das passende Offer
        this.send(id, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
      } catch (err) {
        console.warn('Offer fehlgeschlagen', err);
      } finally {
        p.makingOffer = false;
      }
    };

    const onChange = () => this._stateChanged(p);
    pc.addEventListener('connectionstatechange', onChange);
    pc.addEventListener('iceconnectionstatechange', onChange);
    return p;
  }

  _stateChanged(p) {
    const state = connectionState(p.pc);
    this.onState(p.id, state);
    clearTimeout(p.disconnectTimer);
    // Bei "failed" sofort, bei anhaltendem "disconnected" nach kurzer Wartezeit neu verhandeln
    // (z. B. nach WLAN-Wechsel oder Standby). restartIce löst negotiationneeded aus.
    if (state === 'failed') p.pc.restartIce();
    else if (state === 'disconnected') p.disconnectTimer = setTimeout(() => p.pc.restartIce(), DISCONNECT_RESTART_MS);
  }

  async handleSignal(from, data) {
    const p = this.ensure(from, false);
    const pc = p.pc;
    try {
      if (data.description) {
        const { type, sdp } = data.description;
        // Kollision: Offer kommt an, während wir selbst anbieten oder nicht "stable" sind.
        const collision = type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        // Als "polite" setzt setRemoteDescription bei Kollision implizit unser Offer zurück.
        await pc.setRemoteDescription({ type, sdp });
        if (type === 'offer') {
          await pc.setLocalDescription();
          this.send(from, { description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!p.ignoreOffer) throw err; // Kandidaten zu einem ignorierten Offer dürfen fehlschlagen
        }
      }
    } catch (err) {
      console.warn('Signal konnte nicht verarbeitet werden', err);
    }
  }

  // Nach einem Signaling-Abbruch: Angebote, die während der Pause gesendet wurden, sind verloren.
  // Bei allen nicht verbundenen Gegenstellen deshalb neu verhandeln (bei laufenden nicht nötig).
  restartUnhealthy() {
    for (const p of this.peers.values()) if (connectionState(p.pc) !== 'connected') p.pc.restartIce();
  }

  // Neue Mikrofonspur bei allen Gegenstellen einsetzen, ohne neu zu verhandeln.
  async replaceTrack(track) {
    await Promise.all([...this.peers.values()].map((p) => p.sender && p.sender.replaceTrack(track)));
  }

  remove(id) {
    const p = this.peers.get(id);
    if (!p) return;
    clearTimeout(p.disconnectTimer);
    p.pc.close();
    this.peers.delete(id);
    this.onGone(id);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.remove(id);
  }
}
