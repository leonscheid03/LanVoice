# LanVoice – lokaler Voicechat fürs eigene Netzwerk

Selbst gehostete Sprach-App für Personen im **selben WLAN/LAN**. Ein Rechner startet den Server mit einem Befehl, alle anderen öffnen eine Adresse im Browser (PC, Smartphone, Tablet) – ohne Installation, ohne Account, ohne Cloud, ohne externen STUN/TURN.

- Audio: WebRTC im Mesh (jeder mit jedem), direkt zwischen den Geräten. **Der Server verarbeitet oder leitet kein Audio weiter**, er ist nur Signaling-Server (WebSocket) und liefert die Webseite aus.
- Funktionen: Name + Raum betreten, Mikrofon offen/stumm **oder** Push-to-Talk (Leertaste / gedrückt gehaltener Button), Teilnehmerliste mit Sprechanzeige, Lautstärke pro Person (nur lokal beim Hörer), flüchtiger Text-Chat.
- Bis zu 6 Teilnehmer (Standard, einstellbar). Die Oberfläche ist Deutsch.

## Voraussetzungen

- **Node.js ab 18.3** auf dem Gastgeber-Rechner (Windows, macOS, Linux, Raspberry Pi). Getestet mit Node 26.
- Alle Geräte im selben WLAN/LAN.
- Aktueller Chrome, Edge, Firefox oder Safari (auch iOS).

## Herunterladen und starten

Auf dem Gastgeber-Rechner wird nur **Node.js** (LTS, von https://nodejs.org) gebraucht. Gäste brauchen nichts.

**Variante A – fertiges Paket (einfach):** `download/LanVoice.zip` herunterladen (auf GitHub die Datei öffnen → „Download raw file“), entpacken und starten. Die benötigten Pakete sind schon enthalten, `npm install` ist nicht nötig.
- Windows: Doppelklick auf `start.bat`
- sonst im entpackten Ordner: `node server/index.js`

**Variante B – aus dem Quellcode:** Repository klonen oder per „Code → Download ZIP“ laden, dann im Ordner:

```bash
npm install
npm start
```

Optionen (nach `--`) oder Umgebungsvariablen:

| Option | Umgebungsvariable | Standard |
|---|---|---|
| `--port 8443` / `-p` | `LANVOICE_PORT` | 8443 |
| `--room "Name"` / `-r` | `LANVOICE_ROOM` | Voicechat |
| `--max 6` / `-m` (2–20) | `LANVOICE_MAX` | 6 |

Beispiel: `npm start -- --port 9443 --room "Spieleabend" --max 4`

Beim Start zeigt das Terminal alle erreichbaren Adressen, einen **QR-Code** (für Gäste per Smartphone) und Hinweise zu Firewall und WLAN-Isolation. Du selbst öffnest `http://localhost:8443` (ohne Zertifikatswarnung).

## Gäste beitreten

1. QR-Code scannen oder `192.168.x.x:8443` (Adresse aus dem Terminal) in den Browser tippen. Ohne `https://` landet man auf einer **Hilfeseite** mit Anleitung für iOS, Android und Desktop.
2. Die Seite leitet per Button auf `https://…` weiter. Der Browser zeigt **einmalig eine Zertifikatswarnung**, weil LanVoice ein selbst erzeugtes Zertifikat nutzt (Anleitung dazu steht auf der Hilfeseite). Die Verbindung ist trotzdem verschlüsselt.
3. Namen eingeben, „Raum betreten“, Mikrofon erlauben.

Warum HTTPS? Browser erlauben Mikrofonzugriff nur in einem sicheren Kontext. Das Zertifikat entsteht beim ersten Start automatisch im Ordner `certs/` (nicht im Git). Ändert sich die IP-Adresse des Rechners, wird es neu erzeugt; Gäste müssen die Warnung dann erneut bestätigen.

Ein Port für alles: Auf demselben Port nimmt der Server HTTP (nur Hilfeseite für Gäste) und HTTPS (die App) entgegen.

## Android-App (läuft auch im Hintergrund)

Ein Browser darf das Mikrofon im Hintergrund nicht offen halten. Deshalb gibt es für Android eine kleine App (`download/LanVoice.apk`). Sie zeigt dieselbe Weboberfläche vom eigenen Server, startet aber im Raum einen Vordergrunddienst (dauerhafte Benachrichtigung „Mikrofon aktiv“), der Mikrofon und Verbindung am Leben hält.

1. APK aufs Handy laden und installieren (Android fragt einmalig nach „Installation aus unbekannten Quellen“).
2. App öffnen, Adresse des Servers eingeben (steht im Terminal, z. B. `192.168.2.126:8443`), „Verbinden“.
3. Beim ersten Mal zeigt die App den **Fingerabdruck** des Zertifikats. Mit der Zeile „Zertifikat-Fingerabdruck“ im Terminal des Servers vergleichen und „Vertrauen“ tippen. Danach gibt es keine Browser-Warnung mehr. Ändert sich das Zertifikat (z. B. neue IP), fragt die App erneut.
4. Mikrofon und Benachrichtigungen erlauben, die Akku-Optimierung für die App ausschalten (die App fragt einmal danach).
5. Wie im Browser beitreten. Zurück-Taste schiebt die App in den Hintergrund; „Verlassen“ in der Benachrichtigung oder in der App beendet.

Grenzen: Manche Hersteller (Xiaomi, Huawei, Samsung u. a.) beenden Hintergrund-Apps trotzdem; dann in den Energiespar-/Autostart-Einstellungen der App alles erlauben. Die APK ist eine Debug-Version (nur zum Weitergeben, nicht für den Play Store). Auf dem Handy bitte prüfen: Ton in beide Richtungen bei ausgeschaltetem Bildschirm, 10 Minuten oder länger.

Selbst bauen: Android-SDK (Plattform 35) und JDK 17+ nötig; im Ordner `android/` dann `gradlew assembleDebug` (Ergebnis: `app/build/outputs/apk/debug/app-debug.apk`). Die App besteht aus drei Kotlin-Dateien ohne Zusatzbibliotheken.

## Fehlerbehebung

**Seite lädt auf anderen Geräten nicht**
- **Firewall des Gastgebers:** Windows fragt beim ersten Start; „Private Netzwerke“ erlauben. Später: Einstellungen → Firewall → App zulassen → `node.exe` (Privat). Außerdem das WLAN-Profil auf **Privat** (nicht „Öffentlich“) stellen. macOS: Netzwerk → Firewall → `node` erlauben. Linux: z. B. `sudo ufw allow 8443/tcp`.
- **WLAN-/AP-/Client-Isolation:** Gäste-WLANs und manche Router verhindern, dass sich Geräte untereinander sehen. Dann hilft nur ein anderes WLAN oder die Isolation im Router auszuschalten.
- Mobilfunk statt WLAN aktiv? Geräte müssen im selben Netz sein.
- Mehrere Adressen im Terminal (VPN, WSL, Docker …)? Probiere die anderen; der QR-Code nimmt die wahrscheinlichste.

**Verbunden, aber kein Ton**
- Auf **iOS**: Lautlos-Schalter und Lautstärke prüfen; ggf. das Banner „Ton aktivieren“ antippen. Der Ton startet erst nach einer Berührung (Browser-Regel).
- Eigenes Mikrofon stumm (Modus „Mikrofon offen“ und „Stumm schalten“ aktiv) oder im Push-to-Talk-Modus nicht gehalten?
- Lautstärkeregler der Person auf 0?
- Eine Person zeigt „Verbindung gestört/fehlgeschlagen“: meist Firewall oder AP-Isolation zwischen genau diesen beiden Geräten.

**„Mikrofon verweigert“**: In den Seiteneinstellungen des Browsers das Mikrofon für die Adresse erlauben und neu laden.

## Bekannte Grenzen (ehrlich)

- **Hintergrund:** Browser drosseln oder beenden Mikrofon/Verbindungen im Hintergrund oder bei gesperrtem Bildschirm, besonders auf iOS und manchen Android-Geräten. Die App fordert einen Wake Lock an (Bildschirm bleibt an), aber der wird nicht überall unterstützt. Für zuverlässiges Sprechen: App im Vordergrund lassen.
- **Mesh:** Jedes Gerät sendet an jedes andere. Bis 6 Personen sinnvoll; mehr belastet schwache Handys und das WLAN.
- **Nur ein Raum**, kein Passwortschutz, keine Aufnahme, kein Video – wie vorgesehen. Wer im Netz die Adresse kennt, kann beitreten.
- **Kein Verlauf:** Chat existiert nur im Moment (nicht auf der Platte, nicht im Server-Speicher; wer später beitritt, sieht nichts Früheres).
- **Ausgabegerät wählen** geht nur in Chromium-Browsern.
- **Verbindungsabbruch:** Bei kurzem Abbruch (bis ca. 15 s) verbindet sich der Client automatisch neu und behält Platz und Audio-Verbindungen. Nach längerem Standby tritt die Seite dem Raum automatisch wieder bei; das WLAN des Handys braucht nach dem Aufwachen einen Moment, bis es wieder verbunden ist.
- **Seite neu laden oder Browser schließen:** Danach muss man dem Raum per Button erneut beitreten. Mikrofon und Ton dürfen Browser nur nach einer Berührung starten, ein automatischer Wiederbeitritt ist deshalb nicht möglich. Der Name bleibt vorausgefüllt.
- **Ein Tab pro Person:** Wer denselben Raum in einem zweiten Tab öffnet, verdrängt den ersten.
- Ohne Mikrofonfreigabe kein Beitritt (technisch nötig, damit Browser echte LAN-Adressen statt `.local`-Namen für den Verbindungsaufbau nutzen).

## Sicherheit

- Nur für das **lokale Netz** gedacht. **Kein Port-Forwarding einrichten, keine Freigabe ins Internet.** Es gibt keine Anmeldung.
- Der Server begrenzt Nachrichtengröße, Namenslänge (32), Chatlänge (500) und Chat-Rate, prüft den Origin des WebSockets, leitet Signaling nur innerhalb des Raums weiter und setzt die Absenderkennung selbst.
- Im Frontend landen Nutzerdaten nur per `textContent` im DOM. Strenge Content-Security-Policy, keine Inline-Skripte.
- Der Server loggt keine Chat-Inhalte und kein Signaling.
- Der private Schlüssel liegt in `certs/key.pem`; nicht weitergeben.

## Aufbau und Abhängigkeiten

```
server/   index.js (CLI) · app.js · cert.js · listener.js (HTTP+HTTPS auf einem Port)
          room.js (Raumlogik) · signaling.js (WebSocket) · static.js · netinfo.js
public/   index.html · hilfe.html · style.css · js/ (app, peers, audio, mic, ptt, chat, signaling, settings)
test/     room · netinfo · cert · listener (npm test) · e2e (npm run test:e2e)
android/  Android-App (Kotlin): MainActivity (WebView, Zertifikat-Fingerabdruck), VoiceService (Vordergrunddienst)
```

| Paket | Wozu |
|---|---|
| `ws` | WebSocket-Server (Node hat keinen eingebauten) |
| `selfsigned` | Zertifikat mit Adressen im SAN, ohne OpenSSL |
| `qrcode-terminal` | QR-Code im Terminal |
| `playwright` (nur Entwicklung) | Ende-zu-Ende-Test mit echtem Chromium |

Chat läuft über das Signaling-WebSocket (nicht per DataChannel): So kann der Server Länge und Rate begrenzen, es funktioniert schon vor dem Audio-Aufbau, und es ist nur ein Senden statt eines pro Teilnehmer.

## Tests

```bash
npm test          # Raumlogik, Zertifikat, HTTP/HTTPS-Port, WebSocket-Signaling (ohne Browser)
```

Ende-zu-Ende mit echtem Chromium und Fake-Mikrofon (Verbindung, Ton in beiden Richtungen, Mute, Push-to-Talk, Lautstärke, Chat, Reconnect, Seite neu laden, 6er-Mesh, Raum voll):

```bash
# einmalig (Browser landen in node_modules):
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium      # PowerShell: $env:PLAYWRIGHT_BROWSERS_PATH='0'; npx playwright install chromium
npm run test:e2e
```

### Praktisch geprüft

Von Hand ausprobiert (zwei Desktop-Browser plus ein Android-Handy im selben WLAN): Beitritt per QR-Code samt Zertifikatswarnung, Sprechen in beide Richtungen, Chat, Stumm, Push-to-Talk, Lautstärke pro Person, Wechsel der Audioquelle, Wiederverbinden nach Standby. Nicht geprüft: iOS-Safari, Firefox, Safari am Mac und der Echo-Test (Punkt 6 unten).

### Manuell zu prüfen (nicht automatisch testbar)

Diese Punkte sind **nicht** automatisiert getestet. Bitte mit echten Geräten prüfen:

1. **iOS-Safari:** QR scannen → Hilfeseite → Zertifikatswarnung bestätigen → Mikrofon erlauben → Ton von und zu einem PC? Banner „Ton aktivieren“ erscheint/funktioniert? Lautstärkeregler wirksam? Push-to-Talk-Button halten/loslassen, auch wenn der Finger rutscht?
2. **Android-Chrome:** gleiche Schritte; Push-to-Talk; Bildschirm bleibt an (Wake Lock)?
3. **Zusammenspiel Desktop-Chrome ↔ iOS-Safari ↔ Android-Chrome** gleichzeitig: Verbinden sich alle zuverlässig (ICE nur im LAN)?
4. **Hintergrund:** Handy sperren/App wechseln, 30 s warten, zurückkehren – kommt Ton wieder, verbindet sich die Seite neu?
5. **Neu laden:** Auf dem Handy die Seite kurz nach dem Beitritt neu laden und wieder betreten – hören sich alle wieder (in Chromium automatisch getestet, in iOS-Safari nicht)?
6. **Echo:** Laptop-Lautsprecher ohne Kopfhörer (Chrome, Firefox, Safari am Mac): Hören die anderen sich selbst? Die Wiedergabe läuft über Web Audio; ob der Browser diese Ausgabe in die Echo-Unterdrückung einbezieht, ist nicht bei allen Browsern/Systemen sicher. Im Zweifel Kopfhörer empfehlen.
7. **Firewall/Isolation:** Gerät in anderem WLAN-Modus (Gäste-WLAN) – ist die Fehlermeldung verständlich?
