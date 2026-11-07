'use strict';
// Ende-zu-Ende: echte Chromium-Instanzen mit Fake-Mikrofon (piept), echtes WebRTC über das LAN-Interface.
// Läuft bewusst nicht in "npm test" (braucht Playwright-Browser): npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Browser liegen in node_modules (so installiert: PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium)
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
const { chromium } = require('playwright');
const { createApp } = require('../server/app');

let app, browser, certDir;
const contexts = [];

test.before(async () => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvoice-e2e-'));
  app = await createApp({ port: 0, maxPeers: 6, graceMs: 2000, certDir });
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', // Mikrofon-Dialog automatisch bestätigen
      '--use-fake-device-for-media-stream', // Fake-Mikrofon (periodischer Piepton)
    ],
  });
});
// Nach jedem Test alles schließen und warten, bis der Server den Raum leer meldet (Reconnect-Frist läuft ab),
// damit gehaltene Plätze nicht in den nächsten Test hineinragen.
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
  const deadline = Date.now() + 10_000;
  while (app.room.peers.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
});
test.after(async () => {
  await browser.close();
  app.close();
  fs.rmSync(certDir, { recursive: true, force: true });
});

async function open(name, { join = true } = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] Seitenfehler:`, e.message));
  await page.goto(`https://localhost:${app.port}/?debug=1`);
  await page.fill('#name', name);
  if (join) {
    await page.click('#join-btn');
    await page.waitForFunction(() => window.__lv && window.__lv.inRoom, null, { timeout: 15_000 });
  }
  return page;
}

// Wartet, bis die Seite n Gegenstellen sieht und alle "connected" sind.
const connected = (page, n) =>
  page.waitForFunction(
    (count) => {
      const peers = window.__lv.peers();
      return peers.length === count && peers.every((p) => p.conn === 'connected');
    },
    n,
    { timeout: 30_000, polling: 200 },
  );

// Höchster gemessener Pegel einer Gegenstelle innerhalb von ms (der Fake-Ton piept nur zeitweise).
const maxLevel = (page, peerId, ms) =>
  page.evaluate(
    ([id, duration]) =>
      new Promise((resolve) => {
        let max = 0;
        const t0 = performance.now();
        const timer = setInterval(() => {
          const p = window.__lv.peers().find((x) => x.id === id);
          if (p) max = Math.max(max, p.level);
          if (performance.now() - t0 > duration) {
            clearInterval(timer);
            resolve(max);
          }
        }, 50);
      }),
    [peerId, ms],
  );

const hasSound = async (page, peerId, ms = 4000) => (await maxLevel(page, peerId, ms)) > 0.01;

test('Zwei Personen: Verbindung steht und Audio kommt an (beide Richtungen)', async () => {
  const a = await open('Anna');
  const b = await open('Ben');
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const idA = await a.evaluate(() => window.__lv.selfId);
  const idB = await b.evaluate(() => window.__lv.selfId);
  assert.ok(await hasSound(b, idA, 6000), 'Ben hört Anna nicht');
  assert.ok(await hasSound(a, idB, 6000), 'Anna hört Ben nicht');
  // Sprechanzeige: Zeile von Anna wird bei Ben hervorgehoben
  await b.waitForSelector(`.peer[data-id="${idA}"].speaking`, { timeout: 8000 });
  assert.equal(await b.locator('#peer-list li').count(), 2); // Ben selbst + Anna
  await a.close();
  await b.close();
});

test('Mute, Push-to-Talk (Leertaste + Zeigerbutton), Lautstärkeregler', async () => {
  const a = await open('Anna');
  const b = await open('Ben');
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const idA = await a.evaluate(() => window.__lv.selfId);
  assert.ok(await hasSound(b, idA, 6000));

  // Mute: Pegel bei Ben fällt auf Stille, Status "stumm" erscheint, Aufheben bringt Ton zurück
  await a.click('#mute-btn');
  await b.waitForFunction((id) => window.__lv.peers().find((p) => p.id === id).muted, idA);
  await b.waitForTimeout(1000); // ausschwingen lassen
  assert.ok((await maxLevel(b, idA, 3000)) < 0.002, 'trotz Mute noch Ton');
  await a.click('#mute-btn');
  assert.ok(await hasSound(b, idA, 6000), 'nach Unmute kein Ton');

  // Push-to-Talk: Spur ist aus, bis die Leertaste gehalten wird
  await a.click('#mode-ptt');
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), false);
  await a.keyboard.down('Space');
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), true);
  await a.keyboard.up('Space');
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), false);

  // Leertaste im Chatfeld darf NICHT senden
  await a.focus('#chat-input');
  await a.keyboard.down('Space');
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), false);
  await a.keyboard.up('Space');

  // Zeigerbutton (Touch/Maus): gedrückt halten = senden, loslassen = aus
  const box = await a.locator('#ptt-btn').boundingBox();
  await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await a.mouse.down();
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), true);
  await a.mouse.up();
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), false);
  // Fenster verliert Fokus während gehalten: loslassen erzwingen
  await a.keyboard.down('Space');
  await a.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal(await a.evaluate(() => window.__lv.trackEnabled()), false);
  await a.keyboard.up('Space');

  // Lautstärke: Regler setzt den Gain nur lokal beim Hörer
  await b.evaluate((id) => {
    const slider = document.querySelector(`.peer[data-id="${id}"] input[type=range]`);
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, idA);
  assert.ok(Math.abs((await b.evaluate((id) => window.__lv.gainOf(id), idA)) - 0.4) < 1e-6); // Float32
  const idB = await b.evaluate(() => window.__lv.selfId);
  assert.equal(await a.evaluate((id) => window.__lv.gainOf(id), idB), 1);
  await a.close();
  await b.close();
});

test('Chat: Nachricht kommt bei allen an, HTML wird nicht ausgeführt', async () => {
  const a = await open('Anna');
  const b = await open('Ben');
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const evil = '<img src=x onerror="window.__xss=1"><b>fett</b>';
  await a.fill('#chat-input', evil);
  await a.press('#chat-input', 'Enter');
  await b.waitForSelector('#chat-log li');
  assert.equal(await b.locator('#chat-log .text').first().textContent(), evil);
  assert.equal(await b.locator('#chat-log .who').first().textContent(), 'Anna');
  assert.equal(await b.locator('#chat-log img, #chat-log b').count(), 0);
  assert.equal(await b.evaluate(() => window.__xss), undefined);
  assert.equal(await a.locator('#chat-log li.mine').count(), 1);
  await a.close();
  await b.close();
});

test('Reconnect: nach Verbindungsabbruch gleiche Identität, Audioverbindung bleibt', async () => {
  const a = await open('Anna');
  const b = await open('Ben');
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const idA = await a.evaluate(() => window.__lv.selfId);
  await a.evaluate(() => window.__lv.dropSocket());
  await a.waitForFunction(() => document.getElementById('conn-status').textContent === 'verbunden' && window.__lv.inRoom, null, { timeout: 15_000 });
  await a.waitForTimeout(500);
  assert.equal(await a.evaluate(() => window.__lv.selfId), idA);
  assert.equal(await b.locator('#peer-list li').count(), 2); // Anna nie entfernt
  await Promise.all([connected(a, 1), connected(b, 1)]);
  assert.ok(await hasSound(b, idA, 6000), 'nach Reconnect kein Ton');
  await a.close();
  await b.close();
});

test('Seite neu laden (gleiches Token, kein resume): andere verhandeln neu, Ton in beide Richtungen', async () => {
  const a = await open('Anna');
  const b = await open('Ben');
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const idBefore = await a.evaluate(() => window.__lv.selfId);
  await a.reload();
  await a.click('#join-btn'); // Name steht aus localStorage im Feld
  await a.waitForFunction(() => window.__lv && window.__lv.inRoom, null, { timeout: 15_000 });
  await Promise.all([connected(a, 1), connected(b, 1)]);
  const idAfter = await a.evaluate(() => window.__lv.selfId);
  const idB = await b.evaluate(() => window.__lv.selfId);
  assert.notEqual(idAfter, idBefore); // frische Identität, kein Geisterplatz
  assert.equal(await b.locator('#peer-list li').count(), 2); // genau eine Gegenstelle bei Ben
  assert.ok(await hasSound(b, idAfter, 6000), 'Ben hört die neu geladene Seite nicht');
  assert.ok(await hasSound(a, idB, 6000), 'neu geladene Seite hört Ben nicht');
});

test('Android-Brücke: Seite meldet Betreten/Verlassen, "Server wechseln" nur in der App sichtbar', async () => {
  // Im normalen Browser (ohne window.LanVoiceNative) bleibt der Knopf versteckt.
  const plain = await open('Browser', { join: false });
  assert.equal(await plain.locator('#native-server').isVisible(), false);

  // Attrappe der App-Brücke; das Protokoll liegt im sessionStorage, weil "Verlassen" die Seite neu lädt.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  contexts.push(context);
  await context.addInitScript(() => {
    const log = (entry) => {
      const list = JSON.parse(sessionStorage.getItem('native-log') || '[]');
      list.push(entry);
      sessionStorage.setItem('native-log', JSON.stringify(list));
    };
    window.LanVoiceNative = {
      setActive: (active, room) => log(['setActive', active, room]),
      changeServer: () => log(['changeServer']),
    };
  });
  const page = await context.newPage();
  await page.goto(`https://localhost:${app.port}/?debug=1`);
  assert.equal(await page.locator('#native-server').isVisible(), true);
  await page.click('#native-server');
  await page.fill('#name', 'Anna');
  await page.click('#join-btn');
  await page.waitForFunction(() => window.__lv && window.__lv.inRoom, null, { timeout: 15_000 });
  await page.click('#leave-btn');
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('native-log') || '[]').length === 3, null, { timeout: 10_000 });
  const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem('native-log')));
  assert.deepEqual(log, [['changeServer'], ['setActive', true, 'Voicechat'], ['setActive', false, '']]);
});

test('Mesh mit 6 Personen: alle verbinden sich, die 7. Person bekommt eine klare Meldung', async () => {
  const pages = [];
  for (let i = 1; i <= 6; i++) pages.push(await open(`Gast${i}`));
  await Promise.all(pages.map((p) => connected(p, 5)));
  // Jede Seite hört jede andere
  const ids = await Promise.all(pages.map((p) => p.evaluate(() => window.__lv.selfId)));
  for (const [i, page] of pages.entries()) {
    const sounds = await Promise.all(ids.filter((_, j) => j !== i).map((id) => hasSound(page, id, 8000)));
    assert.ok(sounds.every(Boolean), `Gast${i + 1} hört nicht alle`);
  }
  const seventh = await open('Gast7', { join: false });
  await seventh.click('#join-btn');
  await seventh.waitForSelector('#join-error:not([hidden])');
  assert.match(await seventh.locator('#join-error').textContent(), /Raum ist voll \(maximal 6 Teilnehmer\)/);
  assert.equal(await seventh.evaluate(() => window.__lv.inRoom), false);
  for (const p of pages) await p.close();
  await seventh.close();
});
