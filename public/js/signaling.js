// WebSocket zum Signaling-Server mit automatischem Wiederverbinden.
//
// Reconnect-Idee: Der Client hält ein zufälliges Token (sessionStorage = pro Tab). Mit demselben
// Token UND dem Flag "resume" bekommt er nach einem kurzen Abbruch dieselbe Peer-ID zurück, und die
// bestehenden WebRTC-Verbindungen laufen einfach weiter (die Audiodaten fließen ja nicht über den
// Server). "resume" sendet nur dieselbe Seite, die schon einmal beigetreten war. Eine neu geladene
// Seite hat keine PeerConnections mehr und tritt deshalb als Neuling bei (der Server räumt den
// alten Platz, die anderen verhandeln neu).
const GIVE_UP_CODES = new Set([1000, 4001, 4002, 4003]); // Verlassen / Raum voll / verdrängt / Timeout
const HEARTBEAT_MS = 10_000;
const PONG_TIMEOUT_MS = 4_000;
// Nach Standby ist das WLAN oft noch nicht wieder da: Ein Verbindungsversuch kann dann sehr lange
// hängen (TCP-Timeout, teils über eine Minute). Deshalb nach kurzer Zeit abbrechen und neu versuchen.
const CONNECT_TIMEOUT_MS = 5_000;
const STUCK_CONNECT_MS = 1_500; // beim Zurückkehren in den Vordergrund: so alte Versuche sind verdächtig

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function getToken() {
  try {
    let t = sessionStorage.getItem('lanvoice-token');
    if (!t) {
      t = makeToken();
      sessionStorage.setItem('lanvoice-token', t);
    }
    return t;
  } catch {
    return (getToken.fallback ||= makeToken());
  }
}

export class Signaling {
  /**
   * @param {{name:string, onMessage:(m:object)=>void, onStatus:(s:string, info?:object)=>void}} o
   * Status: 'connecting' | 'online' | 'reconnecting' | 'closed'
   */
  constructor({ name, onMessage, onStatus }) {
    this.name = name;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.token = getToken();
    this.ws = null;
    this.attempt = 0;
    this.stopped = false;
    this.welcomed = false; // schon einmal beigetreten (diese Seite) -> "resume"
    this.timer = 0;
    this.pongTimer = 0;
    this.heartbeat = 0;
    this.connectTimer = 0;
    this.connectStarted = 0;
  }

  connect() {
    this.stopped = false;
    this.onStatus(this.attempt === 0 && !this.welcomed ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    clearTimeout(this.pongTimer);
    this.pongTimer = 0;
    if (!this.heartbeat) this.heartbeat = setInterval(() => this._ping(PONG_TIMEOUT_MS), HEARTBEAT_MS);

    this.connectStarted = Date.now();
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) this._abandon(ws);
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      clearTimeout(this.connectTimer);
      ws.send(JSON.stringify({ type: 'join', name: this.name, token: this.token, resume: this.welcomed }));
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return; // veraltete Verbindung
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        clearTimeout(this.pongTimer);
        this.pongTimer = 0;
        return;
      }
      if (msg.type === 'welcome') {
        this.attempt = 0;
        this.welcomed = true;
        this.onStatus('online');
      }
      this.onMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      if (this.ws !== ws) return; // veraltete Verbindung
      clearTimeout(this.connectTimer);
      if (this.stopped || GIVE_UP_CODES.has(ev.code)) {
        this._stop();
        return this.onStatus('closed', { code: ev.code });
      }
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    this.onStatus('reconnecting');
    const delay = Math.min(500 * 2 ** this.attempt++, 5000);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  // Hängenden Verbindungsversuch aufgeben (sein späteres close-Ereignis wird ignoriert).
  _abandon(ws) {
    this.ws = null;
    try {
      ws.close();
    } catch {
      /* schon zu */
    }
    this._scheduleReconnect();
  }

  _stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.connectTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.heartbeat);
    this.pongTimer = 0;
    this.heartbeat = 0;
  }

  // Lebenszeichen prüfen: Nach Standby oder WLAN-Wechsel kann ein Socket "offen" aussehen, obwohl er tot
  // ist (der Server hat uns dann längst entfernt). Kommt kein Pong, wird sofort neu verbunden.
  _ping(timeoutMs) {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN || this.pongTimer) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    this.pongTimer = setTimeout(() => {
      this.pongTimer = 0;
      if (this.ws === ws) this._dropAndReconnect();
    }, timeoutMs);
  }

  _dropAndReconnect() {
    const ws = this.ws;
    this.ws = null; // spätere Ereignisse der toten Verbindung werden ignoriert
    try {
      ws.close(4000);
    } catch {
      /* schon zu */
    }
    this.attempt = 0;
    this.connect();
  }

  // Beim Zurückkehren in den Vordergrund (z. B. Handy aus dem Standby): nicht auf den Timeout warten.
  kick() {
    if (this.stopped) return;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) return this._ping(3000);
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      // Ein Versuch aus der Zeit vor dem Standby hängt womöglich: sofort frisch versuchen.
      if (Date.now() - this.connectStarted > STUCK_CONNECT_MS) this._dropAndReconnect();
      return;
    }
    clearTimeout(this.timer);
    this.attempt = 0;
    this.connect();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // Sauber verlassen; löst auf, sobald die Verbindung zu ist (oder nach kurzer Zeit).
  leave() {
    const ws = this.ws;
    this._stop();
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      ws.addEventListener('close', resolve, { once: true });
      setTimeout(resolve, 500);
      ws.send(JSON.stringify({ type: 'leave' }));
    });
  }
}
