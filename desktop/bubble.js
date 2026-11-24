// 形态 A：桌宠气泡只承载一件事——最上面那条待办。
// 没有待办就整块隐藏，避免桌面上常驻一块空白。
(() => {
  const root = document.getElementById('bubble');
  const kicker = document.getElementById('kicker');
  const title = document.getElementById('title');
  const meta = document.getElementById('meta');
  let lastVisible = null;

  const clip = (text, max) => {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  };

  const paint = (view) => {
    const pending = Array.isArray(view?.pending) ? view.pending : [];
    const top = pending[0];
    if (!top) {
      if (lastVisible !== false) window.companion.bubbleState({ visible: false });
      lastVisible = false;
      root.hidden = true;
      return;
    }
    root.hidden = false;
    kicker.textContent = pending.length > 1 ? `待你决定 · ${pending.length} 件` : '待你决定';
    title.textContent = clip(top.title || '有一件事等你确认', 30);
    meta.textContent = clip(top.summary || '', 46);
    if (lastVisible !== true) window.companion.bubbleState({ visible: true });
    lastVisible = true;
  };

  const poll = async () => {
    try {
      paint(await window.companion.snapshot());
    } catch {
      // 主进程重启或服务未就绪时保持现状，下一次轮询再试。
    }
  };

  root.addEventListener('click', () => window.companion.showPanel());
  void poll();
  setInterval(() => { void poll(); }, 4000);
})();
