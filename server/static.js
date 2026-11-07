'use strict';
// Liefert Dateien aus public/ aus. Kleiner Eigenbau statt Framework: nur GET/HEAD, kein Cache-Zauber.
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Strenge CSP: nur eigene Skripte/Styles (kein Inline-Code). blob: für die Audio-/Media-Streams.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self' blob: mediastream:; connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Cache-Control': 'no-cache',
};

/**
 * @param {object} o
 * @param {string} o.root   Verzeichnis mit den Dateien
 * @param {string} o.index  Datei, die für "/" geliefert wird
 * @param {Set<string>} [o.allow] Wenn gesetzt: nur diese URL-Pfade sind erreichbar
 */
function createStaticHandler({ root, index, allow = null }) {
  const base = path.resolve(root);
  const reply = (res, code, text) => {
    res.writeHead(code, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  };

  return function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Methode nicht erlaubt');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return reply(res, 400, 'Ungültige Anfrage');
    }
    if (pathname === '/') pathname = '/' + index;
    if (pathname.includes('\0') || (allow && !allow.has(pathname))) return reply(res, 404, 'Nicht gefunden');

    // Pfad-Traversal verhindern: aufgelöster Pfad muss unterhalb von root liegen.
    const file = path.resolve(base, '.' + pathname);
    if (!file.startsWith(base + path.sep)) return reply(res, 404, 'Nicht gefunden');

    fs.readFile(file, (err, data) => {
      if (err) return reply(res, 404, 'Nicht gefunden');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };
}

module.exports = { createStaticHandler };
