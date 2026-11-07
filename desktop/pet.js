(() => {
  const pet = document.getElementById('pet');
  const badge = document.getElementById('badge');
  const hint = document.getElementById('hint');
  let startX = 0;
  let startY = 0;
  let downAt = 0;
  let moved = false;
  let polling = false;

  const states = ['idle', 'working', 'waiting', 'done', 'error'];

  const applyView = (view) => {
    const state = states.includes(view?.state) ? view.state : 'idle';
    for (const name of states) pet.classList.toggle(`state-${name}`, name === state);
    const pending = Array.isArray(view?.pending) ? view.pending.length : 0;
    badge.hidden = pending <= 0;
    if (pending > 0) badge.textContent = pending > 9 ? '9+' : String(pending);
    const text = String(view?.stage ?? 'Owner Companion');
    hint.textContent = text;
    pet.title = text;
    pet.setAttribute('aria-label', `Owner Companion · ${text}`);
  };

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      applyView(await window.companion.snapshot());
    } catch {
      applyView({ state: 'error', stage: '本地服务未就绪' });
    } finally {
      polling = false;
    }
  };

  pet.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    moved = false;
    startX = event.screenX;
    startY = event.screenY;
    downAt = Date.now();
    const rect = pet.getBoundingClientRect();
    window.companion.dragStart({
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    });
    try { pet.setPointerCapture(event.pointerId); } catch { /* best effort */ }
  });

  pet.addEventListener('pointermove', (event) => {
    if (!downAt) return;
    if (Math.hypot(event.screenX - startX, event.screenY - startY) > 4) moved = true;
  });

  const finish = () => {
    if (!downAt) return;
    const wasClick = !moved && Date.now() - downAt < 600;
    downAt = 0;
    window.companion.dragEnd();
    if (wasClick) window.companion.showPanel();
  };

  pet.addEventListener('pointerup', finish);
  pet.addEventListener('pointercancel', () => {
    if (!downAt) return;
    downAt = 0;
    window.companion.dragEnd();
  });

  pet.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.companion.hidePet();
  });

  void poll();
  window.setInterval(poll, 3000);
})();
