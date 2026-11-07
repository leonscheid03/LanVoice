// Push-to-Talk: Leertaste am PC, gedrückt gehaltener Button am Touch-Gerät.
// Wichtigste Aufgabe neben dem Drücken: sicher wieder LOSLASSEN, sonst bleibt das Mikrofon offen.

// Textfelder behalten die Leertaste (Tippen im Chat). Schieberegler/Checkboxen/Buttons nicht.
const TEXT_FIELD = 'input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select';

export function setupPushToTalk({ button, isActive, onChange }) {
  let held = false;
  const set = (value) => {
    if (held === value) return;
    held = value;
    button.classList.toggle('held', value);
    onChange(value);
  };

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || !isActive()) return;
    if (ev.target instanceof Element && ev.target.matches(TEXT_FIELD)) return;
    ev.preventDefault(); // verhindert Scrollen und "Klick" auf einen fokussierten Button
    if (!ev.repeat) set(true);
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code !== 'Space' || !held) return;
    ev.preventDefault();
    set(false);
  });

  // Touch/Maus: Pointer Events decken beides ab. setPointerCapture hält das Ereignis auch dann,
  // wenn der Finger beim Halten leicht vom Button rutscht.
  button.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    try {
      button.setPointerCapture(ev.pointerId);
    } catch {
      /* z. B. synthetisches Ereignis ohne aktiven Zeiger – Drücken zählt trotzdem */
    }
    set(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => set(false));
  }
  button.addEventListener('contextmenu', (ev) => ev.preventDefault()); // Langdruck-Menü auf Mobilgeräten

  // Fenster verliert den Fokus / App im Hintergrund: Loslass-Ereignis würde nie ankommen.
  window.addEventListener('blur', () => set(false));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) set(false);
  });

  return { release: () => set(false), get held() { return held; } };
}
