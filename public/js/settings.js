// Einstellungen im localStorage (rein lokal im Browser; kann in privaten Fenstern fehlen).
const KEY = 'lanvoice-settings';

const DEFAULTS = {
  name: '',
  mode: 'open', // 'open' = Mikrofon offen, 'ptt' = Push-to-Talk
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  micId: '',
  sinkId: '',
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* Speichern nicht möglich – Einstellungen gelten dann nur für diese Sitzung */
  }
}
