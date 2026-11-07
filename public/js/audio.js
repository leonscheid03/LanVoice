// Wiedergabe und Pegel über Web Audio.
//
// Warum nicht einfach <audio>.volume? iOS-Safari ignoriert die Lautstärke von Audio-Elementen.
// Ein GainNode funktioniert überall und erlaubt auch Werte über 100 %.
//
// Chrome-Eigenheit: Ein Remote-WebRTC-Stream, der nur in createMediaStreamSource hängt, liefert
// Stille, solange er nicht auch an einem Media-Element hängt. Deshalb bekommt jeder Stream ein
// stummgeschaltetes <audio>-Element (nur als "Anker"); gehört wird der Web-Audio-Pfad.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.remotes = new Map(); // id -> { el, src, gain, analyser, buf }
    this.volumes = new Map(); // id -> 0..2 (bleibt bei Reconnects erhalten)
    this.local = null; // { src, analyser, buf } – nur zur Pegelanzeige, nicht zur Wiedergabe
    this.onStateChange = null;
    this._timer = 0;
  }

  // Muss aus einer Nutzergeste (Klick/Tipp) aufgerufen werden: Autoplay-Regeln der Browser.
  // Auch nach einer Unterbrechung (iOS "interrupted", Hintergrund) erneut aufrufbar.
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.ctx.onstatechange = () => this.onStateChange && this.onStateChange(this.ctx.state);
    }
    try {
      await this.ctx.resume();
    } catch {
      /* bleibt suspended – Banner "Ton aktivieren" erscheint */
    }
    for (const r of this.remotes.values()) r.el.play().catch(() => {});
    if (this.onStateChange) this.onStateChange(this.ctx.state);
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  addStream(id, stream) {
    this.removeStream(id);
    const ctx = this.ctx;
    const el = document.createElement('audio');
    el.srcObject = stream;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.play().catch(() => {});

    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = this.volumes.has(id) ? this.volumes.get(id) : 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser); // Pegel vor dem Regler: Sprechanzeige unabhängig von der eigenen Lautstärke
    src.connect(gain);
    gain.connect(ctx.destination);
    this.remotes.set(id, { el, src, gain, analyser, buf: new Float32Array(analyser.fftSize) });
  }

  removeStream(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.src.disconnect();
    r.gain.disconnect();
    r.el.srcObject = null;
    this.remotes.delete(id);
  }

  setVolume(id, value) {
    this.volumes.set(id, value);
    const r = this.remotes.get(id);
    if (r) r.gain.gain.value = value;
  }

  // Eigener Pegel (für die Sprechanzeige bei dir selbst).
  setLocal(stream) {
    if (this.local) this.local.src.disconnect();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    const src = this.ctx.createMediaStreamSource(stream);
    src.connect(analyser); // bewusst NICHT mit destination verbunden (kein Selbsthören)
    this.local = { src, analyser, buf: new Float32Array(analyser.fftSize) };
  }

  // Ausgabegerät: nur wo AudioContext.setSinkId existiert (Chromium). Sonst false.
  get canSelectOutput() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  async setSink(deviceId) {
    if (this.ctx && this.canSelectOutput) await this.ctx.setSinkId(deviceId || '');
  }

  static rms(node) {
    node.analyser.getFloatTimeDomainData(node.buf);
    let sum = 0;
    for (let i = 0; i < node.buf.length; i++) sum += node.buf[i] * node.buf[i];
    return Math.sqrt(sum / node.buf.length);
  }

  levelOf(id) {
    const r = this.remotes.get(id);
    return r ? AudioEngine.rms(r) : 0;
  }

  localLevel() {
    return this.local ? AudioEngine.rms(this.local) : 0;
  }

  // Ein gemeinsamer Takt für alle Pegelanzeigen (statt eines Loops pro Person).
  startMeters(callback) {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      const levels = new Map();
      for (const id of this.remotes.keys()) levels.set(id, this.levelOf(id));
      callback(levels, this.localLevel());
    }, 80);
  }

  stopMeters() {
    clearInterval(this._timer);
  }
}
