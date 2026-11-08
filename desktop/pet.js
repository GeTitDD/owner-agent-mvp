// 桌宠窗口：渲染 mascot 皮肤，并把 Owner 五态映射到 Codex 会话阶段。
//
// 皮肤来自主进程（内置 Cindy 套装 + 用户自定义目录）；这里只负责展示与拖拽。
(() => {
  const pet = document.getElementById('pet');
  const mascot = document.getElementById('mascot');
  const badge = document.getElementById('badge');
  const hint = document.getElementById('hint');
  const phaseDot = document.getElementById('phaseDot');
  let startX = 0;
  let startY = 0;
  let downAt = 0;
  let moved = false;
  let polling = false;
  let currentMascot = '';

  const states = ['idle', 'working', 'waiting', 'done', 'error'];
  // 与 Cindy Agent Island / Codex 会话阶段一致的命名。
  const phaseOf = (state) => ({
    idle: 'idle', working: 'running', waiting: 'needs-interaction',
    done: 'completed', error: 'error'
  })[state] ?? 'idle';

  const applyMascot = (info) => {
    if (!info?.url || info.url === currentMascot) return;
    currentMascot = info.url;
    mascot.src = info.url;
    mascot.alt = info.label ?? info.skin ?? 'mascot';
    pet.dataset.skin = info.skin ?? '';
  };

  const applyView = (view) => {
    const state = states.includes(view?.state) ? view.state : 'idle';
    const phase = phaseOf(state);
    pet.dataset.phase = phase;
    pet.dataset.state = state;
    applyMascot(view?.mascot);
    const pending = Array.isArray(view?.pending) ? view.pending.length : 0;
    badge.hidden = pending <= 0;
    if (pending > 0) badge.textContent = pending > 9 ? '9+' : String(pending);
    phaseDot.dataset.phase = phase;
    const text = String(view?.stage ?? 'Owner Companion');
    hint.textContent = text;
    pet.title = `${view?.mascot?.label ?? 'Owner Companion'} · ${text}`;
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
