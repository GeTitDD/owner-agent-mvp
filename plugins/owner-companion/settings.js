/* global OwnerBridge */
(() => {
  const $ = (id) => document.getElementById(id);

  const setStatus = (text) => { $('settingsStatus').textContent = text; };
  const setError = (text) => {
    const node = $('settingsError');
    node.textContent = String(text ?? '');
    node.hidden = !text;
  };

  const refresh = async () => {
    setError('');
    try {
      const status = await OwnerBridge.call('owner/status', {}, 10000);
      $('baseUrl').value = status?.baseUrl || 'http://127.0.0.1:47831';
      setStatus(status?.paired ? `已连接 · ${status.baseUrl}` : '还没有配对');
    } catch (error) {
      setStatus('无法读取状态');
      setError(String(error?.message ?? error));
    }
  };

  $('pairButton').addEventListener('click', async () => {
    const baseUrl = String($('baseUrl').value ?? '').trim();
    const code = String($('pairCode').value ?? '').trim();
    if (!baseUrl || !code) {
      setError('填好地址和配对码');
      return;
    }
    $('pairButton').disabled = true;
    setError('');
    setStatus('配对中…');
    try {
      const result = await OwnerBridge.call('owner/pair', { baseUrl, code }, 20000);
      $('pairCode').value = '';
      setStatus(`已连接 · ${result?.baseUrl ?? baseUrl}`);
    } catch (error) {
      setStatus('配对失败');
      setError(String(error?.message ?? error));
    } finally {
      $('pairButton').disabled = false;
    }
  });

  $('pairCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('pairButton').click();
    }
  });

  void refresh();
})();
