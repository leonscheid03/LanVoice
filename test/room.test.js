'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, clean } = require('../server/room');

// Fake-Verbindung: sammelt gesendete Nachrichten.
function conn() {
  return {
    sent: [],
    closed: null,
    send(m) { this.sent.push(m); },
    close(code) { this.closed = code; },
    of(type) { return this.sent.filter((m) => m.type === type); },
  };
}
const tok = (n) => `token-${n}`.padEnd(20, 'x');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Beitritt: eigene ID, Liste der anderen, Broadcast an bestehende', () => {
  const room = new Room();
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'Anna', conn: a });
  const rb = room.join({ token: tok(2), name: 'Ben', conn: b });
  assert.ok(ra.ok && rb.ok);
  assert.equal(ra.peers.length, 0);
  assert.deepEqual(rb.peers.map((p) => p.name), ['Anna']);
  assert.equal(a.of('peer-joined').length, 1);
  assert.equal(a.of('peer-joined')[0].id, rb.id);
  assert.equal(b.of('peer-joined').length, 0); // Beitretender bekommt sich nicht selbst gemeldet
});

test('Obergrenze: weiterer Beitritt wird mit room-full abgelehnt', () => {
  const room = new Room({ maxPeers: 2 });
  room.join({ token: tok(1), name: 'A', conn: conn() });
  room.join({ token: tok(2), name: 'B', conn: conn() });
  const r = room.join({ token: tok(3), name: 'C', conn: conn() });
  assert.deepEqual(r, { ok: false, code: 'room-full', maxPeers: 2 });
});

test('Doppelte Namen bekommen Suffix, Länge bleibt <= 32', () => {
  const room = new Room();
  const n1 = room.join({ token: tok(1), name: 'Anna', conn: conn() }).name;
  const n2 = room.join({ token: tok(2), name: 'anna', conn: conn() }).name;
  assert.equal(n1, 'Anna');
  assert.equal(n2, 'anna (2)');
  const long = 'x'.repeat(100);
  const l1 = room.join({ token: tok(3), name: long, conn: conn() }).name;
  const l2 = room.join({ token: tok(4), name: long, conn: conn() }).name;
  assert.equal(Array.from(l1).length, 32);
  assert.equal(Array.from(l2).length, 32);
  assert.notEqual(l1, l2);
});

test('clean(): Steuer-/Bidi-Zeichen raus, Whitespace normalisiert', () => {
  assert.equal(clean('  A‮B\u0000\n\tC  ', 32), 'AB C');
  assert.equal(clean(42, 10), '');
  assert.equal(room_name(''), 'Gast');
  function room_name(n) { return new Room().join({ token: tok(9), name: n, conn: conn() }).name; }
});

test('Reconnect innerhalb der Frist: gleiche ID, kein peer-left', async () => {
  const room = new Room({ graceMs: 80 });
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'Anna', conn: a });
  room.join({ token: tok(2), name: 'Ben', conn: b });
  room.detach(ra.id, a);
  await sleep(20);
  const a2 = conn();
  const again = room.join({ token: tok(1), name: 'Egal', conn: a2, resume: true });
  assert.ok(again.ok && again.resumed);
  assert.equal(again.id, ra.id);
  assert.equal(again.name, 'Anna');
  await sleep(120); // über die Frist hinaus: Timer muss abgebrochen sein
  assert.equal(b.of('peer-left').length, 0);
  assert.ok(room.peers.has(ra.id));
});

test('Reconnect-Frist läuft ab: peer-left wird gesendet', async () => {
  const room = new Room({ graceMs: 30 });
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'Anna', conn: a });
  room.join({ token: tok(2), name: 'Ben', conn: b });
  room.detach(ra.id, a);
  await sleep(80);
  assert.equal(b.of('peer-left').length, 1);
  assert.equal(b.of('peer-left')[0].id, ra.id);
  assert.equal(room.peers.size, 1);
});

test('Wiederaufnahme verdrängt alte Verbindung; deren spätes detach wird ignoriert', async () => {
  const room = new Room({ graceMs: 30 });
  const a = conn();
  const ra = room.join({ token: tok(1), name: 'Anna', conn: a });
  const a2 = conn();
  room.join({ token: tok(1), name: 'Anna', conn: a2, resume: true });
  assert.equal(a.closed, 4002);
  room.detach(ra.id, a); // spätes close-Ereignis der alten Verbindung
  await sleep(60);
  assert.ok(room.peers.has(ra.id), 'Platz darf nicht verloren gehen');
});

test('Gehaltene Plätze zählen zur Obergrenze', () => {
  const room = new Room({ maxPeers: 2, graceMs: 1000 });
  const a = conn();
  const ra = room.join({ token: tok(1), name: 'A', conn: a });
  room.join({ token: tok(2), name: 'B', conn: conn() });
  room.detach(ra.id, a);
  assert.equal(room.join({ token: tok(3), name: 'C', conn: conn() }).ok, false);
  room.leave(ra.id);
  assert.equal(room.join({ token: tok(3), name: 'C', conn: conn() }).ok, true);
});

test('Relay: Absender setzt der Server, nur an existierende, nicht an sich selbst/getrennte', () => {
  const room = new Room({ graceMs: 1000 });
  const a = conn(), b = conn(), c = conn();
  const ra = room.join({ token: tok(1), name: 'A', conn: a });
  const rb = room.join({ token: tok(2), name: 'B', conn: b });
  const rc = room.join({ token: tok(3), name: 'C', conn: c });
  assert.equal(room.relay(ra.id, rb.id, { description: { type: 'offer', sdp: 'x' } }), true);
  assert.equal(b.of('signal')[0].from, ra.id);
  assert.equal(c.of('signal').length, 0); // Dritte sehen nichts
  assert.equal(room.relay(ra.id, ra.id, {}), false);
  assert.equal(room.relay(ra.id, 'gibtsnicht', {}), false);
  assert.equal(room.relay('fremd', rb.id, {}), false);
  room.detach(rc.id, c);
  assert.equal(room.relay(ra.id, rc.id, {}), false);
});

test('Chat: Broadcast an alle inkl. Absender, bereinigt, begrenzt, Rate-Limit', () => {
  let t = 1000;
  const room = new Room({ now: () => t, chatBurst: 3, chatWindowMs: 1000 });
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'A', conn: a });
  room.join({ token: tok(2), name: 'B', conn: b });
  room.chat(ra.id, '<b>Hi</b>\u0000‮');
  assert.equal(a.of('chat')[0].text, '<b>Hi</b>'); // HTML bleibt Text, Steuerzeichen weg
  assert.equal(b.of('chat')[0].name, 'A');
  room.chat(ra.id, 'y'.repeat(900));
  assert.equal(b.of('chat')[1].text.length, 500);
  room.chat(ra.id, '   '); // leer: ignoriert
  assert.equal(b.of('chat').length, 2);
  room.chat(ra.id, 'drei');
  assert.deepEqual(room.chat(ra.id, 'vier'), { ok: false, code: 'rate-limit' });
  t += 1500;
  assert.equal(room.chat(ra.id, 'wieder').ok, true);
});

test('Mute-Status wird an andere gemeldet', () => {
  const room = new Room();
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'A', conn: a });
  room.join({ token: tok(2), name: 'B', conn: b });
  room.setMuted(ra.id, true);
  assert.deepEqual(b.of('peer-state')[0], { type: 'peer-state', id: ra.id, muted: true });
  assert.equal(a.of('peer-state').length, 0);
});

test('Gleiches Token OHNE resume (Seite neu geladen): Platz wird geräumt, andere sehen left + joined', () => {
  const room = new Room({ graceMs: 1000 });
  const a = conn(), b = conn();
  const ra = room.join({ token: tok(1), name: 'Anna', conn: a });
  room.join({ token: tok(2), name: 'Ben', conn: b });
  room.detach(ra.id, a); // alte Seite ist weg, Platz wird gehalten
  const a2 = conn();
  const again = room.join({ token: tok(1), name: 'Anna', conn: a2 }); // neu geladene Seite: kein resume
  assert.equal(again.resumed, false);
  assert.notEqual(again.id, ra.id);
  assert.equal(b.of('peer-left')[0].id, ra.id);
  assert.equal(b.of('peer-joined').at(-1).id, again.id);
  assert.equal(room.peers.size, 2);
});

test('Gleiches Token ohne resume bei noch offener alter Verbindung (dupliziertes Tab): alte wird geschlossen', () => {
  const room = new Room();
  const a = conn();
  room.join({ token: tok(1), name: 'Anna', conn: a });
  room.join({ token: tok(1), name: 'Anna', conn: conn() });
  assert.equal(a.closed, 4002);
  assert.equal(room.peers.size, 1);
});

test('resume mit abgelaufenem Platz: neuer Teilnehmer mit neuer ID', () => {
  const room = new Room();
  const r = room.join({ token: tok(5), name: 'X', conn: conn(), resume: true });
  assert.ok(r.ok);
  assert.equal(r.resumed, false);
});
