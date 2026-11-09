// 桌宠窗口：渲染静态皮肤或 Codex Pet 精灵动画，并把 Owner 五态映射到会话阶段。
//
// 动画格式参考 Codex Pet / Petdex：
//   - pet.json + spritesheet（默认 8 列 × 9/11 行，192×208 帧）；
//   - states 指定每个状态所在的精灵行与帧时长；
//   - 没有 spritesheet 的静态皮肤用 CSS 做呼吸/跳动/抖动。
(() => {
  const pet = document.getElementById('pet');
  const mascot = document.getElementById('mascot');
  const sprite = document.getElementById('sprite');
  const badge = document.getElementById('badge');
  const hint = document.getElementById('hint');
  const phaseDot = document.getElementById('phaseDot');
  let startX = 0;
  let startY = 0;
  let downAt = 0;
  let moved = false;
  let polling = false;
  let currentMascot = '';
  let spriteInfo = null;
  let spriteRaf = null;
  let activeAnimation = null;
  let frameIndex = 0;
  let lastFrameAt = 0;
  let hintTimer = null;

  const states = ['idle', 'working', 'waiting', 'done', 'error'];
  const phaseOf = (state) => ({
    idle: 'idle', working: 'running', waiting: 'needs-interaction',
    done: 'completed', error: 'error'
  })[state] ?? 'idle';

  const flashHint = (text) => {
    if (hintTimer) clearTimeout(hintTimer);
    hint.textContent = text;
    hintTimer = setTimeout(() => { hint.textContent = pet.dataset.stage ?? 'Owner'; }, 1800);
  };

  const layoutSprite = () => {
    if (!spriteInfo) return;
    const info = spriteInfo;
    const max = 96;
    const scale = Math.min(max / info.frameWidth, max / info.frameHeight);
    const width = Math.max(1, Math.round(info.frameWidth * scale));
    const height = Math.max(1, Math.round(info.frameHeight * scale));
    sprite.style.width = `${width}px`;
    sprite.style.height = `${height}px`;
    sprite.style.backgroundImage = `url("${info.url}")`;
    sprite.style.backgroundSize = `${info.columns * width}px ${info.rows * height}px`;
  };

  const showFrame = (row, column) => {
    if (!spriteInfo) return;
    const width = Number.parseFloat(sprite.style.width) || 1;
    const height = Number.parseFloat(sprite.style.height) || 1;
    sprite.style.backgroundPosition = `-${column * width}px -${row * height}px`;
  };

  const pickAnimation = (phase) => {
    if (!spriteInfo) return null;
    const candidates = {
      idle: ['idle'],
      running: ['running', 'running-right', 'idle'],
      'needs-interaction': ['waiting', 'review', 'idle'],
      completed: ['review', 'waving', 'idle'],
      error: ['failed', 'idle']
    }[phase] ?? ['idle'];
    for (const name of candidates) {
      const state = spriteInfo.states?.[name];
      if (state) return { name, ...state };
    }
    return null;
  };

  const setAnimation = (phase, force = false) => {
    const next = pickAnimation(phase);
    if (!next) return;
    if (!force && activeAnimation?.name === next.name) return;
    activeAnimation = next;
    frameIndex = 0;
    lastFrameAt = performance.now();
    showFrame(next.row, 0);
  };

  const tick = (time) => {
    if (!spriteInfo || !activeAnimation) return;
    const anim = activeAnimation;
    const duration = frameIndex >= (anim.frames ?? 1) - 1
      ? (anim.lastFrameDurationMs ?? anim.durationMs)
      : anim.durationMs;
    if (time - lastFrameAt >= duration) {
      const frames = anim.frames ?? 1;
      if (frameIndex < frames - 1) frameIndex += 1;
      else if (anim.loop !== false) frameIndex = 0;
      lastFrameAt = time;
      showFrame(anim.row, frameIndex);
    }
    spriteRaf = requestAnimationFrame(tick);
  };

  const stopSprite = () => {
    if (spriteRaf) cancelAnimationFrame(spriteRaf);
    spriteRaf = null;
    spriteInfo = null;
    activeAnimation = null;
    sprite.hidden = true;
    sprite.style.backgroundImage = '';
  };

  const startSprite = (info) => {
    stopSprite();
    spriteInfo = info;
    sprite.hidden = false;
    mascot.hidden = true;
    mascot.dataset.static = 'false';
    layoutSprite();
    setAnimation(pet.dataset.phase || 'idle', true);
    spriteRaf = requestAnimationFrame(tick);
  };

  const applyMascot = (info) => {
    if (!info || (!info.url && !info.sprite?.url)) return;
    const key = `${info.skin}:${info.kind ?? 'static'}:${info.sprite?.url ?? info.url}`;
    if (key === currentMascot) return;
    currentMascot = key;
    pet.dataset.skin = info.skin ?? '';
    if (info.kind === 'sprite' && info.sprite) {
      startSprite({ ...info.sprite, url: info.sprite.url ?? info.url });
    } else {
      stopSprite();
      mascot.hidden = false;
      mascot.dataset.static = 'true';
      mascot.src = info.url;
      mascot.alt = info.label ?? info.skin ?? 'mascot';
    }
    pet.title = `${info.label ?? 'Owner Companion'} · ${pet.dataset.stage ?? ''}`;
  };

  const applyView = (view) => {
    const state = states.includes(view?.state) ? view.state : 'idle';
    const phase = phaseOf(state);
    pet.dataset.phase = phase;
    pet.dataset.state = state;
    pet.dataset.stage = String(view?.stage ?? 'Owner Companion');
    applyMascot(view?.mascot);
    if (spriteInfo) setAnimation(phase);
    const pending = Array.isArray(view?.pending) ? view.pending.length : 0;
    badge.hidden = pending <= 0;
    if (pending > 0) badge.textContent = pending > 9 ? '9+' : String(pending);
    phaseDot.dataset.phase = phase;
    hint.textContent = pet.dataset.stage;
    pet.title = `${view?.mascot?.label ?? 'Owner Companion'} · ${pet.dataset.stage}`;
    pet.setAttribute('aria-label', `Owner Companion · ${pet.dataset.stage}`);
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

  // 右键直接打开皮肤选择，而不是隐藏宠物；隐藏放在悬停工具条里。
  pet.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.companion.openSkinPicker();
  });

  const cycleSkin = async () => {
    try {
      const catalog = await window.companion.mascots.list();
      const skins = catalog.skins ?? [];
      if (!skins.length) return;
      const index = Math.max(0, skins.findIndex((skin) => skin.id === catalog.current));
      const next = skins[(index + 1) % skins.length];
      await window.companion.mascots.set({ skin: next.id });
      currentMascot = '';
      await poll();
      flashHint(`皮肤：${next.label}`);
    } catch (error) {
      flashHint(String(error?.message ?? error));
    }
  };

  document.getElementById('skinNext').addEventListener('click', (event) => {
    event.stopPropagation();
    void cycleSkin();
  });
  document.getElementById('skinPicker').addEventListener('click', (event) => {
    event.stopPropagation();
    window.companion.openSkinPicker();
  });
  document.getElementById('hidePet').addEventListener('click', (event) => {
    event.stopPropagation();
    window.companion.hidePet();
  });

  void poll();
  window.setInterval(poll, 3000);
})();
