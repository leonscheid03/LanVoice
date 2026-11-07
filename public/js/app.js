// Oberfläche und Ablauf: Beitreten, Teilnehmerliste, Mikrofonsteuerung, Einstellungen.
import { loadSettings, saveSettings } from './settings.js';
import { Mic, listDevices } from './mic.js';
import { AudioEngine } from './audio.js';
import { Signaling } from './signaling.js';
import { Mesh } from './peers.js';
import { createChat } from './chat.js';
import { setupPushToTalk } from './ptt.js';

const $ = (id) => document.getElementById(id);
const SPEAKING_LEVEL = 0.015; // RMS-Schwelle für die Sprechanzeige
const SPEAKING_HOLD_MS = 300; // Anzeige kurz halten, damit sie nicht flackert

const settings = loadSettings();
const audio = new AudioEngine();
const mic = new Mic();

const state = {
  selfId: null,
  mode: settings.mode === 'ptt' ? 'ptt' : 'open',
  muted: false,
  inRoom: false,
  rows: new Map(), // id -> { li, status, slider, name, muted, conn, lastSpoke }
  selfRow: null,
  sentMuted: null,
};
let signaling = null;
let mesh = null;
let chat = null;
let wakeLock = null;

// ---------- kleine Helfer ----------

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- Teilnehmerliste ----------

const CONN_TEXT = { new: 'verbindet …', connecting: 'verbindet …', disconnected: 'Verbindung gestört', failed: 'Verbindung fehlgeschlagen' };

function renderStatus(row) {
  const parts = [];
  if (row.muted) parts.push('stumm');
  if (row.conn && CONN_TEXT[row.conn]) parts.push(CONN_TEXT[row.conn]);
  row.status.textContent = parts.join(' · ');
  row.li.classList.toggle('problem', row.conn === 'failed' || row.conn === 'disconnected');
}

function addRow(id, name, isSelf) {
  const li = el('li', 'peer');
  li.dataset.id = id;
  const dot = el('span', 'dot');
  dot.setAttribute('aria-hidden', 'true');
  const nameEl = el('span', 'name', isSelf ? `${name} (Du)` : name);
  const status = el('span', 'status');
  li.append(dot, nameEl, status);

  let slider = null;
  if (!isSelf) {
    slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '200';
    slider.step = '5';
    slider.value = String(Math.round((audio.volumes.get(id) ?? 1) * 100));
    slider.setAttribute('aria-label', `Lautstärke von ${name}`);
    slider.addEventListener('input', () => audio.setVolume(id, Number(slider.value) / 100));
    li.append(slider);
  }
  const row = { li, status, slider, name, muted: false, conn: '', lastSpoke: 0, speaking: false };
  $('peer-list').append(li);
  return row;
}

function addPeer({ id, name, muted }) {
  if (state.rows.has(id)) return;
  const row = addRow(id, name, false);
  row.muted = !!muted;
  renderStatus(row);
  state.rows.set(id, row);
}

function removePeer(id) {
  const row = state.rows.get(id);
  if (row) row.li.remove();
  state.rows.delete(id);
  mesh.remove(id);
  audio.volumes.delete(id);
}

function resetRoom() {
  mesh.closeAll();
  for (const row of state.rows.values()) row.li.remove();
  state.rows.clear();
  audio.volumes.clear();
}

function updateSpeaking(levels, selfLevel) {
  const now = performance.now();
  const apply = (row, level) => {
    if (level > SPEAKING_LEVEL) row.lastSpoke = now;
    const speaking = now - row.lastSpoke < SPEAKING_HOLD_MS;
    if (speaking !== row.speaking) {
      row.speaking = speaking;
      row.li.classList.toggle('speaking', speaking);
    }
  };
  if (state.selfRow) apply(state.selfRow, selfLevel);
  for (const [id, level] of levels) {
    const row = state.rows.get(id);
    if (row) apply(row, level);
  }
}

// ---------- Mikrofon: stumm / Push-to-Talk ----------

const transmitting = () => (state.mode === 'open' ? !state.muted : ptt.held);

function applyTransmit() {
  if (mic.track) mic.track.enabled = transmitting();
  const openMode = state.mode === 'open';
  $('mode-open').setAttribute('aria-pressed', String(openMode));
  $('mode-ptt').setAttribute('aria-pressed', String(!openMode));
  $('mute-btn').hidden = !openMode;
  $('ptt-btn').hidden = openMode;
  $('mute-btn').setAttribute('aria-pressed', String(state.muted));
  $('mute-btn').textContent = state.muted ? 'Stummschaltung aufheben' : 'Stumm schalten';
  $('mute-btn').classList.toggle('on', state.muted);

  // Andere sehen "stumm" nur im Modus "Mikrofon offen". Bei Push-to-Talk wäre das ein Geflacker.
  const shownMuted = openMode && state.muted;
  if (state.selfRow) {
    state.selfRow.muted = shownMuted;
    renderStatus(state.selfRow);
  }
  if (shownMuted !== state.sentMuted) {
    state.sentMuted = shownMuted;
    signaling.send({ type: 'state', muted: shownMuted });
  }
}

const ptt = setupPushToTalk({
  button: $('ptt-btn'),
  isActive: () => state.inRoom && state.mode === 'ptt' && !$('settings-dialog').open,
  onChange: () => applyTransmit(),
});

function setMode(mode) {
  state.mode = mode;
  settings.mode = mode;
  saveSettings(settings);
  ptt.release();
  applyTransmit();
}

// ---------- Nachrichten vom Server ----------

const ERRORS = {
  'room-full': (m) => `Der Raum ist voll (maximal ${m.maxPeers} Teilnehmer).`,
  'rate-limit': () => 'Du schreibst zu schnell – bitte kurz warten.',
};

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome': return onWelcome(msg);
    case 'peer-joined':
      addPeer(msg);
      mesh.ensure(msg.id, true); // wir waren zuerst da, also bieten wir an
      break;
    case 'peer-left': removePeer(msg.id); break;
    case 'peer-state': {
      const row = state.rows.get(msg.id);
      if (row) {
        row.muted = !!msg.muted;
        renderStatus(row);
      }
      break;
    }
    case 'signal': if (state.selfId) mesh.handleSignal(msg.from, msg.data); break;
    case 'chat': chat.add(msg); break;
    case 'error': {
      const text = (ERRORS[msg.code] || (() => 'Unbekannter Fehler.'))(msg);
      if (state.inRoom) toast(text);
      else joinFailed(text);
      break;
    }
  }
}

function onWelcome(msg) {
  const fresh = state.selfId !== msg.id; // false = Wiederaufnahme nach kurzem Abbruch, PeerConnections leben weiter
  if (fresh) {
    resetRoom();
    state.selfId = msg.id;
    mesh.setSelf(msg.id);
    if (state.selfRow) state.selfRow.li.remove();
    state.selfRow = addRow(msg.id, msg.name, true);
    $('peer-list').prepend(state.selfRow.li);
  }
  $('room-name').textContent = msg.room;

  // Abgleich mit der Teilnehmerliste des Servers (nach einem Abbruch kann sich etwas geändert haben).
  const listed = new Set(msg.peers.map((p) => p.id));
  for (const id of [...state.rows.keys()]) if (!listed.has(id)) removePeer(id);
  for (const p of msg.peers) {
    const isNew = !state.rows.has(p.id);
    addPeer(p);
    const row = state.rows.get(p.id);
    row.muted = !!p.muted;
    renderStatus(row);
    // Frisch beigetreten: die Bestehenden bieten an. Nach Wiederaufnahme sind Neue jünger als wir: wir bieten an.
    if (!mesh.has(p.id)) mesh.ensure(p.id, !fresh && isNew);
  }

  if (!fresh) mesh.restartUnhealthy(); // Angebote aus der Offline-Zeit sind verloren gegangen
  state.sentMuted = null; // Zustand dem Server nach (Wieder-)Beitritt erneut melden
  if (!state.inRoom) enterRoom();
  applyTransmit();
}

function onStatus(status) {
  const badge = $('conn-status');
  badge.textContent = status === 'online' ? 'verbunden' : status === 'closed' ? 'getrennt' : 'verbinde neu …';
  badge.className = `badge ${status}`;
  if (status === 'closed' && state.inRoom) {
    toast('Verbindung zum Server beendet.');
  }
}

function onSocketClosed(info) {
  // 4002: Dieselbe Sitzung wurde in einem anderen Tab/Fenster geöffnet.
  if (info && info.code === 4002) leaveRoom('Der Raum wurde in einem anderen Tab oder Fenster geöffnet.');
}

// ---------- Beitreten / Verlassen ----------

function joinFailed(text) {
  mic.stop();
  signaling && signaling.leave();
  $('join-error').textContent = text;
  $('join-error').hidden = false;
  $('join-btn').disabled = false;
}

function micErrorText(err) {
  switch (err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Der Mikrofonzugriff wurde verweigert. Bitte erlaube das Mikrofon in den Browser- bzw. Seiteneinstellungen und versuche es erneut.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Es wurde kein Mikrofon gefunden.';
    case 'NotReadableError':
      return 'Das Mikrofon wird gerade von einer anderen Anwendung benutzt.';
    case 'InsecureContext':
      return 'Das Mikrofon geht nur über eine sichere Verbindung. Bitte die Adresse mit https:// öffnen.';
    default:
      return `Das Mikrofon konnte nicht geöffnet werden (${err.name}).`;
  }
}

async function join(name) {
  $('join-error').hidden = true;
  $('join-btn').disabled = true;
  settings.name = name;
  saveSettings(settings);

  // 1) AudioContext direkt im Klick erzeugen/starten (Autoplay-Regeln, besonders iOS).
  audio.onStateChange = () => updateAudioBanner();
  const unlocking = audio.unlock();

  // 2) Mikrofon VOR der ersten PeerConnection: Danach liefern Browser echte LAN-IPs statt mDNS-Namen.
  try {
    await mic.open(settings);
  } catch (err) {
    return joinFailed(micErrorText(err));
  }
  await unlocking;
  mic.track.enabled = transmitting(); // gespeicherter PTT-Modus: nie offen starten
  mic.track.addEventListener('ended', () => toast('Das Mikrofon wurde getrennt. Wähle in den Einstellungen ein anderes.'));
  audio.setLocal(mic.stream);

  mesh = new Mesh({
    send: (to, data) => signaling.send({ type: 'signal', to, data }),
    getTrack: () => mic.track,
    getStream: () => mic.stream,
    onStream: (id, stream) => audio.addStream(id, stream),
    onState: (id, conn) => {
      const row = state.rows.get(id);
      if (row) {
        row.conn = conn;
        renderStatus(row);
      }
    },
    onGone: (id) => audio.removeStream(id),
  });
  chat = createChat({ logEl: $('chat-log'), formEl: $('chat-form'), inputEl: $('chat-input'), send: (m) => signaling.send(m), getSelfId: () => state.selfId });

  signaling = new Signaling({
    name,
    onMessage,
    onStatus: (status, info) => {
      onStatus(status);
      if (status === 'closed') onSocketClosed(info);
    },
  });
  signaling.connect();
}

// In der Android-App gibt es window.LanVoiceNative: Sie startet einen Vordergrunddienst, damit
// Mikrofon und Verbindung auch im Hintergrund laufen. Im normalen Browser ist das undefined.
const nativeApp = window.LanVoiceNative;

function enterRoom() {
  state.inRoom = true;
  if (nativeApp) nativeApp.setActive(true, $('room-name').textContent);
  $('join-view').hidden = true;
  $('room-view').hidden = false;
  audio.startMeters(updateSpeaking);
  requestWakeLock();
  updateAudioBanner();
}

async function leaveRoom(reason) {
  state.inRoom = false;
  if (nativeApp) nativeApp.setActive(false, '');
  audio.stopMeters();
  ptt.release();
  if (signaling) await signaling.leave();
  mesh && mesh.closeAll();
  mic.stop();
  releaseWakeLock();
  if (reason) sessionStorage.setItem('lanvoice-notice', reason);
  location.reload(); // sauberster Weg zurück zum Startzustand
}

// ---------- Ton-Banner, Wake Lock ----------

function updateAudioBanner() {
  $('audio-banner').hidden = !state.inRoom || audio.running;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {
    /* nicht unterstützt oder abgelehnt (z. B. Energiesparmodus) – kein Problem, nur der Bildschirm kann ausgehen */
  }
}
function releaseWakeLock() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.inRoom) return;
  requestWakeLock(); // wird vom Browser beim Ausblenden automatisch freigegeben
  signaling.kick();
  audio.unlock(); // klappt ohne Geste nur, wenn der Browser es erlaubt; sonst bleibt das Banner
});

// Netz wieder da (z. B. WLAN nach Standby): nicht auf den nächsten Wiederholungsversuch warten.
window.addEventListener('online', () => {
  if (state.inRoom) signaling.kick();
});

$('audio-banner').addEventListener('click', async () => {
  await audio.unlock();
  updateAudioBanner();
});

// ---------- Einstellungen ----------

async function fillDevices() {
  const { inputs, outputs } = await listDevices();
  const fill = (select, devices, current, fallbackLabel) => {
    select.replaceChildren(new Option('Standard', ''));
    devices.forEach((d, i) => select.append(new Option(d.label || `${fallbackLabel} ${i + 1}`, d.deviceId)));
    select.value = devices.some((d) => d.deviceId === current) ? current : '';
  };
  fill($('mic-select'), inputs, settings.micId, 'Mikrofon');
  fill($('sink-select'), outputs, settings.sinkId, 'Lautsprecher');
  $('sink-row').hidden = !audio.canSelectOutput;
  $('sink-note').hidden = audio.canSelectOutput;
}

async function reopenMic() {
  try {
    const old = await mic.open(settings);
    // Neue Spur sofort passend zum Stumm-/PTT-Zustand schalten: sonst sendet ein Stummer
    // beim Gerätewechsel kurz mit offenem Mikrofon.
    mic.track.enabled = transmitting();
    await mesh.replaceTrack(mic.track);
    audio.setLocal(mic.stream);
    if (old) old.getTracks().forEach((t) => t.stop());
    mic.track.addEventListener('ended', () => toast('Das Mikrofon wurde getrennt. Wähle in den Einstellungen ein anderes.'));
    applyTransmit();
  } catch (err) {
    toast(micErrorText(err));
  }
}

$('settings-btn').addEventListener('click', async () => {
  $('opt-ec').checked = settings.echoCancellation;
  $('opt-ns').checked = settings.noiseSuppression;
  $('opt-agc').checked = settings.autoGainControl;
  await fillDevices().catch(() => {});
  $('settings-dialog').showModal();
});

$('mic-select').addEventListener('change', () => {
  settings.micId = $('mic-select').value;
  saveSettings(settings);
  reopenMic();
});
$('sink-select').addEventListener('change', async () => {
  settings.sinkId = $('sink-select').value;
  saveSettings(settings);
  try {
    await audio.setSink(settings.sinkId);
  } catch {
    toast('Das Ausgabegerät konnte nicht gewechselt werden.');
  }
});
for (const [id, key] of [['opt-ec', 'echoCancellation'], ['opt-ns', 'noiseSuppression'], ['opt-agc', 'autoGainControl']]) {
  $(id).addEventListener('change', () => {
    settings[key] = $(id).checked;
    saveSettings(settings);
    reopenMic(); // geänderte Verarbeitung gilt nur für ein neu geöffnetes Mikrofon
  });
}

// ---------- Verdrahtung ----------

$('join-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('name').value.trim();
  if (name) join(name);
});
$('mode-open').addEventListener('click', () => setMode('open'));
$('mode-ptt').addEventListener('click', () => setMode('ptt'));
$('mute-btn').addEventListener('click', () => {
  state.muted = !state.muted;
  applyTransmit();
});
$('leave-btn').addEventListener('click', () => leaveRoom());
if (nativeApp) {
  $('native-server').hidden = false;
  $('native-server').addEventListener('click', () => nativeApp.changeServer());
}

$('name').value = settings.name;
try {
  const notice = sessionStorage.getItem('lanvoice-notice');
  if (notice) {
    sessionStorage.removeItem('lanvoice-notice');
    $('join-error').textContent = notice;
    $('join-error').hidden = false;
  }
} catch {
  /* sessionStorage nicht verfügbar */
}

// Test-/Diagnosehilfe, nur mit ?debug=1 in der Adresse.
if (new URLSearchParams(location.search).has('debug')) {
  window.__lv = {
    get selfId() { return state.selfId; },
    get inRoom() { return state.inRoom; },
    get audioState() { return audio.ctx && audio.ctx.state; },
    peers: () => [...state.rows].map(([id, r]) => ({ id, name: r.name, conn: r.conn, muted: r.muted, speaking: r.speaking, level: audio.levelOf(id) })),
    selfLevel: () => audio.localLevel(),
    trackEnabled: () => (mic.track ? mic.track.enabled : null),
    gainOf: (id) => (audio.remotes.has(id) ? audio.remotes.get(id).gain.gain.value : null),
    dropSocket: () => signaling.ws.close(4000), // simuliert einen Verbindungsabbruch (Client verbindet neu)
  };
}
