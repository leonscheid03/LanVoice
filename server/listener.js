'use strict';
// Ein TCP-Port für HTTP *und* HTTPS.
//
// Warum? Die Zertifikatswarnung erscheint, bevor irgendeine Seite geladen ist – die App kann
// sie also nicht selbst erklären. Tippt ein Gast "192.168.0.5:8443" ohne https://, landet er
// per Klartext-HTTP auf einer Hilfeseite mit Anleitung. Der QR-Code zeigt auf diese Adresse.
//
// Erkennung: Ein TLS-Handshake beginnt immer mit dem Byte 0x16 (ClientHello). Alles andere
// (z. B. "GET ...") ist Klartext. Wir lesen das erste Byte, legen es zurück in den Stream
// und übergeben den Socket an den passenden Server.
//
// Ausnahme: Verbindungen von diesem Rechner selbst (Loopback) bekommen über Klartext-HTTP die
// komplette App. http://localhost gilt als "sicherer Kontext", das Mikrofon funktioniert dort
// ohne Zertifikatswarnung – praktisch für den Host.
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FIRST_BYTE_TIMEOUT_MS = 10_000;

function createListener({ tls, appHandler, helpHandler, onUpgrade }) {
  const isLoopback = (req) => LOOPBACK.has(req.socket.remoteAddress);

  const httpsServer = https.createServer(tls, appHandler);
  httpsServer.on('upgrade', onUpgrade);
  httpsServer.on('tlsClientError', () => {}); // Gäste, die das Zertifikat ablehnen: kein Lärm im Terminal

  const httpServer = http.createServer((req, res) => (isLoopback(req) ? appHandler : helpHandler)(req, res));
  httpServer.on('upgrade', (req, socket, head) => {
    if (isLoopback(req)) onUpgrade(req, socket, head);
    else socket.destroy();
  });

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => socket.destroy()); // Verbindung ohne Daten
    socket.once('data', (first) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });

  server.closeAll = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };
  return server;
}

module.exports = { createListener };
