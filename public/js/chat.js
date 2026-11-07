// Chat-Anzeige. Alle Nutzerdaten gehen ausschließlich über textContent in den DOM (kein innerHTML).
const MAX_MESSAGES = 200; // ältere Einträge werden aus dem DOM entfernt – es gibt keinen Verlauf

export function createChat({ logEl, formEl, inputEl, send, getSelfId }) {
  formEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    inputEl.value = '';
  });

  return {
    add({ from, name, text, ts }) {
      const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
      const li = document.createElement('li');
      if (from === getSelfId()) li.className = 'mine';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = name;
      const body = document.createElement('span');
      body.className = 'text';
      body.textContent = text;
      const time = document.createElement('time');
      time.textContent = new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      li.append(who, body, time);
      logEl.append(li);
      while (logEl.children.length > MAX_MESSAGES) logEl.firstChild.remove();
      if (nearBottom || from === getSelfId()) logEl.scrollTop = logEl.scrollHeight;
    },
    clear() {
      logEl.replaceChildren();
    },
  };
}
