'use strict';

const $ = (id) => document.getElementById(id);

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function render(state = {}) {
  const status = state.status || 'checking';
  const percent = Math.max(0, Math.min(100, Number(state.percent) || 0));
  const progressVisible = ['checking', 'downloading', 'cancelling'].includes(status);
  const downloaded = status === 'downloaded';
  const closable = ['latest', 'cancelled', 'error', 'downloaded'].includes(status);
  $('updateMessage').textContent = state.message || (status === 'checking' ? '正在检查更新…' : '正在处理更新…');
  $('updateVersion').textContent = state.version ? `版本 ${state.version}` : '';
  $('progressArea').hidden = !progressVisible;
  $('progressArea').classList.toggle('checking', status === 'checking');
  $('progressBar').style.width = `${percent}%`;
  $('progressPercent').textContent = status === 'checking' ? '' : `${Math.round(percent)}%`;
  const transferred = formatBytes(state.transferred);
  const total = formatBytes(state.total);
  const speed = Number(state.speed) > 0 ? ` · ${formatBytes(state.speed)}/秒` : '';
  $('updateDetail').textContent = progressVisible && Number(state.total) > 0 ? `${transferred} / ${total}${speed}` : '';
  const cancellable = status === 'checking' || status === 'downloading';
  $('cancelButton').hidden = !cancellable;
  $('cancelButton').disabled = !cancellable;
  $('installButton').hidden = !downloaded;
  $('closeActionButton').hidden = !closable;
  $('closeActionButton').textContent = downloaded ? '稍后安装' : '关闭';
}

$('closeButton').addEventListener('click', () => window.sub2api.closeUpdate());
$('closeActionButton').addEventListener('click', () => window.sub2api.closeUpdate());
$('cancelButton').addEventListener('click', async () => {
  $('cancelButton').disabled = true;
  try { await window.sub2api.cancelUpdate(); }
  catch (error) { render({ status: 'error', message: error.message || '取消更新失败' }); }
});
$('installButton').addEventListener('click', async () => {
  $('installButton').disabled = true;
  try {
    const started = await window.sub2api.installUpdate();
    if (!started) render({ status: 'error', message: '更新安装包不存在，请重新检查更新。' });
  } catch (error) {
    render({ status: 'error', message: error.message || '启动更新安装失败' });
    $('installButton').disabled = false;
  }
});
window.sub2api.onUpdateState(render);
