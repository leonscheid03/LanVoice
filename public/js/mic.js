// Mikrofon: Zugriff, Gerätewechsel, Geräteliste.
export class Mic {
  constructor() {
    this.stream = null;
  }

  get track() {
    return this.stream ? this.stream.getAudioTracks()[0] || null : null;
  }

  // Öffnet ein (neues) Mikrofon und gibt den bisherigen Stream zurück. Der Aufrufer stoppt ihn,
  // nachdem die neue Spur bei allen Verbindungen eingesetzt wurde (replaceTrack, kein Neuaushandeln).
  // Schlägt das Öffnen fehl, bleibt der bisherige Stream unverändert.
  async open({ micId, echoCancellation, noiseSuppression, autoGainControl }) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Kein Mikrofonzugriff ohne sichere Verbindung');
      err.name = 'InsecureContext';
      throw err;
    }
    const audio = { echoCancellation, noiseSuppression, autoGainControl, channelCount: 1 };
    if (micId) audio.deviceId = { ideal: micId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    const old = this.stream;
    this.stream = stream;
    return old;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
  };
}
