'use strict';
// Integrationstest: echter Server auf Port 0 (HTTP+HTTPS-Sniffing, Static, WebSocket-Signaling).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const WebSocket = require('ws');
const { createApp } = require('../server/app');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvoice-it-'));
const publicDir = path.join(tmp, 'public');
fs.mkdirSync(path.join(publicDir, 'js'), { recursive: true });
fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>APP</h1>');
fs.writeFileSync(path.join(publicDir, 'hilfe.html'), '<h1>HILFE</h1>');
fs.writeFileSync(path.join(publicDir, 'style.css'), 'body{}');
fs.writeFileSync(path.join(publicDir, 'js', 'hilfe.js'), '//');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'GEHEIM');

let app;
test.before(async () => {
  app = await createApp({ port: 0, maxPeers: 2, graceMs: 400, certDir: path.join(tmp, 'certs'), publicDir });
});
test.after(() => {
  app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function get(scheme, p, { host = '127.0.0.1' } = {}) {
  const lib = scheme === 'https' ? https : http;
  return new Promise((resolve, reject) => {
    lib.get({ host, port: app.port, path: p, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

// WebSocket-Client, der Nachrichten puffert.
function client(url = `wss://127.0.0.1:${app.port}/ws`, opts = {}) {
  const ws = new WebSocket(url, { rejectUnauthorized: false, ...opts });
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  });
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  return {
    ws,
    closed,
    open: new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    next(type, ms = 2000) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timeout auf "${type}"`)), ms);
        waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    has: (type) => queue.some((m) => m.type === type),
  };
}
// Sauber verlassen: sonst hält der Server den Platz noch graceMs lang (gewolltes Verhalten)
// und die Folgetests laufen gegen einen vollen Raum.
const bye = (c) => {
  c.send({ type: 'leave' });
  return c.closed;
};
const token = (n) => `t-${n}-`.padEnd(24, 'z');

async function joined(name, n) {
  const c = client();
  await c.open;
  c.send({ type: 'join', name, token: token(n) });
  c.welcome = await c.next('welcome');
  return c;
}

test('Zertifikat-Fingerabdruck liegt als SHA-256 vor (für die Android-App)', () => {
  assert.match(app.certFingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test('HTTPS und Klartext-HTTP laufen auf demselben Port', async () => {
  const s = await get('https', '/');
  assert.equal(s.status, 200);
  assert.equal(s.body, '<h1>APP</h1>');
  assert.match(s.headers['content-security-policy'], /default-src 'self'/);
  const h = await get('http', '/'); // Loopback: komplette App (localhost ist ein sicherer Kontext)
  assert.equal(h.body, '<h1>APP</h1>');
});

test('Gäste (nicht Loopback) bekommen per HTTP nur die Hilfeseite', async (t) => {
  const lan = app.addresses[0];
  if (!lan) return t.skip('keine LAN-Adresse vorhanden');
  const root = await get('http', '/', { host: lan.address });
  assert.equal(root.body, '<h1>HILFE</h1>');
  assert.equal((await get('http', '/style.css', { host: lan.address })).status, 200);
  assert.equal((await get('http', '/index.html', { host: lan.address })).status, 404);
  // HTTPS über die LAN-Adresse liefert die App
  assert.equal((await get('https', '/', { host: lan.address })).body, '<h1>APP</h1>');
});

test('Pfad-Traversal liefert nie Dateien außerhalb von public/', async () => {
  for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/../secret.txt', '/%00']) {
    const r = await get('https', p);
    assert.notEqual(r.body, 'GEHEIM', p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('Signaling: Welcome, Beitritt wird gemeldet, Relay setzt "from" selbst', async () => {
  const a = await joined('Anna', 1);
  const b = await joined('Ben', 2);
  assert.equal(b.welcome.peers[0].name, 'Anna');
  assert.equal(b.welcome.maxPeers, 2);
  const pj = await a.next('peer-joined');
  assert.equal(pj.id, b.welcome.id);

  a.send({ type: 'signal', to: b.welcome.id, from: 'gefälscht', data: { description: { type: 'offer', sdp: 'v=0' }, evil: 1 } });
  const sig = await b.next('signal');
  assert.equal(sig.from, a.welcome.id);
  assert.deepEqual(sig.data, { description: { type: 'offer', sdp: 'v=0' } }); // unbekanntes Feld entfernt

  a.send({ type: 'signal', to: b.welcome.id, data: { description: { type: 'evil', sdp: 'x' } } }); // ungültig: still verworfen
  a.send({ type: 'chat', text: 'hallo' });
  const chat = await b.next('chat');
  assert.equal(chat.text, 'hallo');
  assert.equal(b.has('signal'), false);

  a.send({ type: 'leave' });
  await b.next('peer-left');
  await bye(b);
});

test('Raum voll: verständlicher Fehler und Verbindung wird geschlossen', async () => {
  const a = await joined('A', 11);
  const b = await joined('B', 12);
  const c = client();
  await c.open;
  c.send({ type: 'join', name: 'C', token: token(13) });
  const err = await c.next('error');
  assert.deepEqual([err.code, err.maxPeers], ['room-full', 2]);
  assert.equal(await c.closed, 4001);
  await bye(a);
  await bye(b);
});

test('Reconnect: gleiche ID, andere sehen kein peer-left', async () => {
  const a = await joined('Anna', 21);
  const b = await joined('Ben', 22);
  await a.next('peer-joined');
  a.ws.terminate();
  await new Promise((r) => setTimeout(r, 100));
  const a2 = client();
  await a2.open;
  a2.send({ type: 'join', name: 'Anna', token: token(21), resume: true });
  const w = await a2.next('welcome');
  assert.equal(w.resumed, true);
  assert.equal(w.id, a.welcome.id);
  await new Promise((r) => setTimeout(r, 500)); // länger als graceMs
  assert.equal(b.has('peer-left'), false);
  await bye(a2);
  await bye(b);
});

test('Fremder Origin, ungültige/übergroße Nachrichten werden abgewiesen', async () => {
  const evil = client(undefined, { headers: { Origin: 'https://evil.example' } });
  const status = await new Promise((res) => {
    evil.ws.on('unexpected-response', (_q, r) => res(r.statusCode));
    evil.ws.on('error', () => {});
  });
  assert.equal(status, 403);

  const noJoin = client();
  await noJoin.open;
  noJoin.ws.send('kein json');
  assert.equal(await noJoin.closed, 1007);

  const badToken = client();
  await badToken.open;
  badToken.send({ type: 'join', name: 'x', token: 'kurz' });
  assert.equal(await badToken.closed, 1008);

  const big = client();
  await big.open;
  big.ws.send(JSON.stringify({ type: 'join', name: 'x'.repeat(100_000), token: token(31) }));
  assert.equal(await big.closed, 1009);
});

test('WebSocket auch über Loopback-HTTP (ws://) erreichbar', async () => {
  const c = client(`ws://127.0.0.1:${app.port}/ws`);
  await c.open;
  c.send({ type: 'join', name: 'Lokal', token: token(41) });
  assert.equal((await c.next('welcome')).name, 'Lokal');
  await bye(c);
});

test('Ping wird mit Pong beantwortet (Lebenszeichen-Test des Clients)', async () => {
  const c = await joined('Pinger', 51);
  c.send({ type: 'ping' });
  assert.equal((await c.next('pong')).type, 'pong');
  await bye(c);
});
