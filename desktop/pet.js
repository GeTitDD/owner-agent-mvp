// 桌宠窗口：渲染静态皮肤或 Codex Pet 精灵动画，并把 Owner 五态映射到会话阶段。
//
// 动画格式参考 Codex Pet / Petdex：
//   - pet.json + spritesheet（8 列 × 9 行 v1；8 列 × 11 行 v2），帧 192×208；
//   - 每行是一个动作，列是帧；不同动作实际帧数不同（idle 6、waving 4、jumping 5…），
//     行尾多余列是透明占位，播到就会闪空；
//   - 动作分工与 Codex 一致：running 表示任务进行中，waiting 等用户确认，
//     review 结果待查看，failed 失败，running-left/right 跟随拖动方向，
//     waving / jumping 是一次性打招呼与庆祝。
// 没有 spritesheet 的静态皮肤用 CSS 做呼吸/跳动/抖动。
(() => {
  const pet = document.getElementById('pet');
  const mascot = document.getElementById('mascot');
  const sprite = document.getElementById('sprite');
  const badge = document.getElementById('badge');
  const hint = document.getElementById('hint');
  const phaseDot = document.getElementById('phaseDot');
  let startX = 0;
  let startY = 0;
  let lastDragX = 0;
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
  let statusLine = 'Owner';
  let basePhase = 'idle';
  let transient = null;
  let dragging = false;

  const states = ['idle', 'working', 'waiting', 'done', 'error'];
  const phaseOf = (state) => ({
    idle: 'idle', working: 'running', waiting: 'needs-interaction',
    done: 'completed', error: 'error'
  })[state] ?? 'idle';

  const flashHint = (text) => {
    if (hintTimer) clearTimeout(hintTimer);
    hint.textContent = text;
    hintTimer = setTimeout(() => { hint.textContent = statusLine; }, 1800);
  };

  const layoutSprite = () => {
    if (!spriteInfo) return;
    const info = spriteInfo;
    // 桌宠窗口 136px：宠物本体占 112px，不再画圆形底盘。
    const max = 112;
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
    // 用整数偏移，避免半像素导致边缘抖动。
    const width = Math.round(Number.parseFloat(sprite.style.width) || 1);
    const height = Math.round(Number.parseFloat(sprite.style.height) || 1);
    sprite.style.backgroundPosition = `-${column * width}px -${row * height}px`;
  };

  /** 取一个动作；缺失时返回 null。 */
  const animOf = (name) => {
    if (!name) return null;
    const state = spriteInfo?.states?.[name];
    return state ? { name, ...state } : null;
  };

  /** 阶段 → 主循环动作（与 Codex 的状态语义一致）。 */
  const phaseAnimation = (phase) => {
    const order = {
      idle: ['idle'],
      running: ['running', 'running-right', 'idle'],
      'needs-interaction': ['waiting', 'review', 'idle'],
      completed: ['review', 'waving', 'idle'],
      error: ['failed', 'idle']
    }[phase] ?? ['idle'];
    for (const name of order) {
      const anim = animOf(name);
      if (anim) return anim;
    }
    return animOf('idle');
  };

  const startAnimation = (anim) => {
    if (!anim) return;
    activeAnimation = anim;
    transient = null;
    frameIndex = 0;
    lastFrameAt = performance.now();
    showFrame(anim.row, 0);
  };

  /** 只播一遍再回到 fallback（Codex 的 waving / jumping 就是一次性动作）。 */
  const playOnce = (name, fallbackName) => {
    const anim = animOf(name);
    if (!anim) return false;
    activeAnimation = anim;
    transient = { fallback: fallbackName ?? null };
    frameIndex = 0;
    lastFrameAt = performance.now();
    showFrame(anim.row, 0);
    return true;
  };

  const tick = (time) => {
    if (!spriteInfo || !activeAnimation) return;
    const anim = activeAnimation;
    const frames = Math.max(1, anim.frames ?? 1);
    const duration = frameIndex >= frames - 1
      ? (anim.lastFrameDurationMs ?? anim.durationMs)
      : anim.durationMs;
    if (time - lastFrameAt >= duration) {
      if (frameIndex < frames - 1) {
        frameIndex += 1;
        lastFrameAt = time;
        showFrame(anim.row, frameIndex);
      } else if (transient) {
        // 一次性动作播完：回到指定动作，其次回到当前阶段的主循环。
        const fallback = animOf(transient.fallback) ?? phaseAnimation(basePhase);
        startAnimation(fallback);
        lastFrameAt = time;
      } else if (anim.loop) {
        frameIndex = 0;
        lastFrameAt = time;
        showFrame(anim.row, 0);
      } else {
        // 非循环且没有后续动作：停在最后一帧。
        lastFrameAt = time;
      }
    }
    spriteRaf = requestAnimationFrame(tick);
  };

  const stopSprite = () => {
    if (spriteRaf) cancelAnimationFrame(spriteRaf);
    spriteRaf = null;
    spriteInfo = null;
    activeAnimation = null;
    transient = null;
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
    basePhase = pet.dataset.phase || 'idle';
    // 换上动画皮肤时先挥手打招呼，再进入当前阶段。
    if (!playOnce('waving', null)) startAnimation(phaseAnimation(basePhase));
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

  /** 阶段变化：running/waiting/review 循环，completed 先跳一下，error 直接哭。 */
  const setPhase = (phase) => {
    const previous = basePhase;
    basePhase = phase;
    if (!spriteInfo) return;
    // 拖动时保持方向奔跑，松手后再回到阶段动作。
    if (dragging) return;
    if (transient) return;
    if (phase === 'completed' && previous !== 'completed' && playOnce('jumping', 'review')) return;
    const next = phaseAnimation(phase);
    if (next && next.name !== activeAnimation?.name) startAnimation(next);
  };

  const applyView = (view) => {
    const state = states.includes(view?.state) ? view.state : 'idle';
    const phase = phaseOf(state);
    pet.dataset.phase = phase;
    pet.dataset.state = state;
    pet.dataset.stage = String(view?.stage ?? 'Owner Companion');
    applyMascot(view?.mascot);
    setPhase(phase);
    const pending = Array.isArray(view?.pending) ? view.pending.length : 0;
    badge.hidden = pending <= 0;
    if (pending > 0) badge.textContent = pending > 9 ? '9+' : String(pending);
    phaseDot.dataset.phase = phase;
    // A 形态：桌宠只承载一件事——待办优先，其次下一步建议。
    const clip = (text, max) => {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim();
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    };
    const top = Array.isArray(view?.pending) ? view.pending[0] : null;
    const next = view?.nextAction;
    statusLine = pending > 0 && top?.title
      ? `待你：${clip(top.title, 9)}`
      : next?.title
        ? clip(next.title, 11)
        : (pet.dataset.stage || 'Owner');
    hint.textContent = statusLine;
    hint.title = statusLine;
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
    dragging = false;
    startX = event.screenX;
    startY = event.screenY;
    lastDragX = event.screenX;
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
    if (Math.hypot(event.screenX - startX, event.screenY - startY) > 4) {
      moved = true;
      if (!dragging) {
        dragging = true;
        transient = null;
        startAnimation(animOf('running-right') ?? phaseAnimation(basePhase));
      }
      // 与 Codex 相同：向左拖用 running-left，向右拖用 running-right。
      if (event.screenX !== lastDragX) {
        const direction = event.screenX - lastDragX;
        lastDragX = event.screenX;
        const name = direction < 0 ? 'running-left' : 'running-right';
        const anim = animOf(name);
        if (anim && anim.name !== activeAnimation?.name) startAnimation(anim);
      }
    }
  });

  const finish = () => {
    if (!downAt) return;
    const wasClick = !moved && Date.now() - downAt < 600;
    downAt = 0;
    window.companion.dragEnd();
    if (dragging) {
      dragging = false;
      startAnimation(phaseAnimation(basePhase));
    }
    if (wasClick) window.companion.showPanel();
  };

  pet.addEventListener('pointerup', finish);
  pet.addEventListener('pointercancel', () => {
    if (!downAt) return;
    downAt = 0;
    window.companion.dragEnd();
    if (dragging) {
      dragging = false;
      startAnimation(phaseAnimation(basePhase));
    }
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
