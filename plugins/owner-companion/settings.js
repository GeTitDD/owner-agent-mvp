/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);
  const call = (method, params, timeoutMs) => OwnerBridge.call(method, params, timeoutMs);

  const setError = (text) => {
    const node = $('settingsError');
    node.textContent = String(text ?? '');
    node.hidden = !text;
  };

  const esc = (value) => String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');

  const renderProjects = (projects) => {
    const list = $('projectList');
    if (!projects.length) {
      list.innerHTML = '<div class="muted small">还没有项目。上面填一个目录即可。</div>';
      return;
    }
    list.innerHTML = projects.map((project) => `
      <div class="settings-project" data-id="${esc(project.id)}">
        <div>
          <div>${esc(project.name)}</div>
          <div class="muted small">${esc(project.root)}</div>
        </div>
        <button type="button" class="danger small" data-remove="${esc(project.id)}">移除</button>
      </div>
    `).join('');
  };

  const load = async () => {
    setError('');
    try {
      const [status, projects] = await Promise.all([
        call('owner/status', {}, 10000),
        call('owner/projects/list', {}, 10000)
      ]);
      $('dataDir').textContent = status?.dataDir ?? '';
      $('pluginVersion').textContent = status?.version ?? '';
      renderProjects(projects?.projects ?? []);
    } catch (error) {
      setError(String(error?.message ?? error));
    }
  };

  $('projectAdd').addEventListener('click', async () => {
    const value = String($('projectPath').value ?? '').trim();
    if (!value) return;
    $('projectAdd').disabled = true;
    try {
      await call('owner/projects/add', { path: value }, 20000);
      $('projectPath').value = '';
      await load();
    } catch (error) {
      setError(String(error?.message ?? error));
    } finally {
      $('projectAdd').disabled = false;
    }
  });

  $('projectPath').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('projectAdd').click();
    }
  });

  $('projectList').addEventListener('click', async (event) => {
    const button = event.target.closest?.('button[data-remove]');
    if (!button) return;
    const id = button.dataset.remove;
    if (!id) return;
    try {
      await call('owner/projects/remove', { id }, 10000);
      await load();
    } catch (error) {
      setError(String(error?.message ?? error));
    }
  });

  void load();
})();
