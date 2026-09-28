'use strict';

const $ = (id) => document.getElementById(id);
let pending2fa = null;
let lastConfigKey = '';
let lastAccountsKey = '';

const icons = { openai: '◉', gpt: '◉', chatgpt: '◉', claude: '◆', anthropic: '◆', 'google-gemini': '✦', google: '✦', gemini: '✦', xai: '×', grok: '×', kimi: 'K', moonshot: 'K', copilot: '●', github: '●', sparkle: '•' };

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clamp(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function pct(value) { return `${Math.round(clamp(value))}%`; }
function token(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(number >= 1e7 ? 1 : 2).replace(/\.0+$/, '')}M`;
  if (Math.abs(number) >= 1e3) return `${(number / 1e3).toFixed(number >= 1e5 ? 0 : 1).replace(/\.0$/, '')}K`;
  return new Intl.NumberFormat('zh-CN').format(number);
}
function integer(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('zh-CN').format(Number(value)) : '-'; }
function countdown(value) {
  const target = Date.parse(String(value || ''));
  if (!Number.isFinite(target)) return '';
  const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  if (!seconds) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}天${hours}时`;
  if (hours) return `${hours}时${minutes}分`;
  return minutes ? `${minutes}分${seconds % 60}秒` : `${seconds % 60}秒`;
}
function provider(account) {
  const platform = account?.platform || account?.group?.platform || '';
  const key = String(platform).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return icons[key] || '•';
}
function level(value) { return Number(value) >= 95 ? 'error' : Number(value) >= 80 ? 'warn' : ''; }

function render(state) {
  const accounts = state.accounts || [];
  const statusTitle = $('statusTitle');
  const dot = $('statusDot');
  const notice = $('notice');
  const list = $('accountList');
  const empty = $('emptyState');
  const refreshed = state.refreshedAt ? new Date(state.refreshedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  $('lastUpdated').textContent = refreshed ? `上次更新 ${refreshed}` : (state.isRefreshing ? '正在刷新…' : '尚未刷新');
  const countLabel = state.role === 'user' ? '个订阅' : '个账户';
  statusTitle.textContent = state.isRefreshing ? '正在刷新…' : accounts.length ? `${accounts.length} ${countLabel}` : state.status === 'error' ? '连接失败' : '需要配置';
  statusTitle.disabled = !accounts.length || state.isRefreshing;
  dot.className = `status-dot ${state.status === 'error' ? 'error' : state.status === 'ready' && accounts.some((item) => Math.max(Number(item.usage?.five_hour?.utilization) || 0, Number(item.usage?.seven_day?.utilization) || 0) >= 95) ? 'warn' : ''}`;
  notice.hidden = !(state.message && (state.status !== 'ready' || state.failed?.length));
  notice.textContent = state.failed?.length ? `${state.message || ''} ${state.failed.map((item) => `${item.accountName}: ${item.error}`).join('；')}` : (state.message || '');
  const accountsKey = JSON.stringify(accounts);
  if (accountsKey !== lastAccountsKey) {
    list.innerHTML = accounts.map((result) => accountCard(result, state.role)).join('');
    lastAccountsKey = accountsKey;
  }
  updateCountdowns();
  empty.hidden = accounts.length > 0;
  if (!accounts.length) {
    $('emptyTitle').textContent = state.status === 'needs-server' ? '还没有连接服务器' : state.status === 'needs-auth' ? '还没有配置鉴权' : '暂无账户用量';
    $('emptyMessage').textContent = state.message || '请在设置中登录你的账户。';
  }
  const config = state.config || {};
  const configKey = JSON.stringify(config);
  if (configKey !== lastConfigKey) {
    fillConfig(config);
    lastConfigKey = configKey;
  }
  $('authMode').textContent = state.role === 'admin' ? '管理员账户' : state.role === 'user' ? '普通用户' : (state.authMode === 'bearer' ? '已登录' : '未配置');
  $('authMode').classList.toggle('ready', state.authMode === 'bearer');
  updateCodexEnabled(config.baseUrl);
}

function accountCard(result, role) {
  const account = result.account || {};
  const usage = result.usage || {};
  const name = role === 'user'
    ? escapeHtml(account.group?.name || '未命名订阅')
    : escapeHtml(account.name || '未命名账户');
  const providerKey = provider(account);
  const providerLabel = escapeHtml(icons[providerKey] || providerKey);
  const blocks = role === 'user'
    ? `${quota('本周', usage.weekly)}${quota('本月', usage.monthly)}`
    : `${quota('5 小时', usage.five_hour)}${quota('7 天', usage.seven_day)}`;
  const headNote = role === 'user'
    ? ''
    : `更新于 ${escapeHtml(formatTime(usage.updated_at))}`;
  const updatedSpan = headNote ? `<span class="updated">${headNote}</span>` : '';
  return `<article class="account-card"><div class="account-head"><div class="account-name"><i class="provider-dot"></i><span>${providerLabel} ${name}</span></div>${updatedSpan}</div>${blocks}</article>`;
}

function quota(label, item) {
  const value = clamp(item?.utilization);
  const reset = countdown(item?.resets_at);
  const windowStats = item?.window_stats || {};
  const status = level(value);
  const meta = (item?.usageUsd != null)
    ? `$${formatUsd(item?.usageUsd)} / $${formatUsd(item?.limitUsd)}`
    : `${integer(windowStats.requests)} req · ${token(windowStats.tokens)} tok`;
  const timeMeta = item?.resets_at ? `重置 ${escapeHtml(formatTime(item?.resets_at))}` : '';
  return `<div class="quota"><div class="quota-row"><span>${label} <small class="quota-countdown" data-reset-at="${escapeHtml(item?.resets_at || '')}"${reset ? '' : ' hidden'}>${escapeHtml(reset)}</small></span><strong class="${value >= 100 ? 'full' : ''}">${pct(value)}</strong></div><div class="progress"><i class="${status}" style="width:${value}%"></i></div><div class="quota-meta"><span>${meta}</span>${timeMeta ? `<span>${timeMeta}</span>` : ''}</div></div>`;
}

function formatUsd(value) {
  const v = Number(value);
  return Number.isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function updateCountdowns() {
  document.querySelectorAll('.quota-countdown').forEach((element) => {
    const value = countdown(element.dataset.resetAt);
    element.textContent = value;
    element.hidden = !value;
  });
}

function formatTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date).replace('/', '-');
}

function fillConfig(config) {
  $('baseUrl').value = config.baseUrl || '';
  $('updateInterval').value = config.updateInterval ?? 300;
  $('rotationInterval').value = config.rotationInterval ?? 5;
  $('requestTimeout').value = config.requestTimeout ?? 15000;
  $('allowInsecureTls').checked = Boolean(config.allowInsecureTls);
}

function switchView(view) {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item.id === `${view}View`));
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
}

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2800);
}

async function saveConfig(event) {
  event.preventDefault();
  try {
    await window.sub2api.saveConfig({ baseUrl: $('baseUrl').value.trim(), updateInterval: Number($('updateInterval').value), rotationInterval: Number($('rotationInterval').value), requestTimeout: Number($('requestTimeout').value), allowInsecureTls: $('allowInsecureTls').checked });
    toast('连接设置已保存');
  } catch (error) { toast(error.message || '保存失败'); }
}

async function login(event) {
  event.preventDefault();
  try {
    const result = await window.sub2api.login({ email: $('email').value.trim(), password: $('password').value });
    if (result.requires2fa) { pending2fa = result; $('password').value = ''; $('totpBox').hidden = false; toast('请输入 TOTP 验证码'); }
    else { $('password').value = ''; toast('登录成功'); }
  } catch (error) { toast(error.message || '登录失败'); }
}

async function complete2fa() {
  if (!pending2fa) return;
  try { await window.sub2api.completeLogin({ tempToken: pending2fa.tempToken, totpCode: $('totpCode').value, email: pending2fa.email }); pending2fa = null; $('password').value = ''; $('totpCode').value = ''; $('totpBox').hidden = true; toast('登录成功'); }
  catch (error) { toast(error.message || '验证码错误'); }
}

async function logout() {
  try {
    await window.sub2api.logout();
    $('password').value = '';
    $('totpCode').value = '';
    toast('本地鉴权已清除');
  } catch (error) { toast(error.message || '清除鉴权失败'); }
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.view === 'codex' && !codexEnabled) {
    toast('请先在设置中填写服务器地址');
    return;
  }
  switchView(button.dataset.view);
  if (button.dataset.view === 'codex') initCodex();
}));
$('refreshButton').addEventListener('click', async () => {
  try { await window.sub2api.refresh(); toast('刷新完成'); }
  catch (error) { toast(error.message || '刷新失败'); }
});
$('statusTitle').addEventListener('click', async () => {
  if ($('statusTitle').disabled) return;
  try { await window.sub2api.openAdminPage(); }
  catch (error) { toast(error.message || '打开后台页面失败'); }
});
$('closeButton').addEventListener('click', () => window.sub2api.close());
$('settingsShortcut').addEventListener('click', () => switchView('settings'));
$('emptySettingsButton').addEventListener('click', () => switchView('settings'));
$('configForm').addEventListener('submit', saveConfig);
$('loginForm').addEventListener('submit', login);
$('totpButton').addEventListener('click', complete2fa);
$('logoutButton').addEventListener('click', logout);
$('openLogButton').addEventListener('click', async () => {
  try { await window.sub2api.openLog(); }
  catch (error) { toast(error.message || '打开日志失败'); }
});
window.sub2api.getDataDirectory()
  .then((directory) => { $('logDirectory').textContent = `${directory}\\app.log`; })
  .catch(() => {});
window.sub2api.onState(render);
window.sub2api.onNavigate(({ view, focus }) => { switchView(view); if (focus === 'server') $('baseUrl').focus(); if (focus === 'auth') $('email').focus(); });
window.setInterval(updateCountdowns, 1000);
window.sub2api.getState().then(render).catch((error) => toast(error.message || '加载状态失败'));

let codexEnabled = false;
let codexModelTree = [];

function updateCodexEnabled(baseUrl) {
  codexEnabled = Boolean(baseUrl && baseUrl.trim());
  document.querySelectorAll('.tab[data-view="codex"]').forEach((tab) => {
    tab.disabled = !codexEnabled;
    tab.classList.toggle('disabled', !codexEnabled);
  });
}

async function initCodex() {
  try {
    const config = await window.sub2api.getCodexConfig();
    $('codexBearerToken').value = extractBearerToken(config);
  } catch (error) {
    toast(error.message || '读取 Codex 配置失败');
  }
  await refreshModelTree(false);
  renderBackups();
}

function extractBearerToken(toml) {
  const match = toml.match(/experimental_bearer_token\s*=\s*"([^"]*)"/);
  return match ? match[1] : '';
}

async function refreshModelTree(forcibly) {
  const treeEl = $('modelTree');
  treeEl.innerHTML = '<div class="model-loading">加载中...</div>';
  try {
    await window.sub2api.prepareModels();
    const [files, own] = await Promise.all([
      window.sub2api.listModelFiles(),
      window.sub2api.readModels(),
    ]);
    await renderModelTree(files, own?.models || []);
  } catch (error) {
    treeEl.innerHTML = `<div class="model-error">${escapeHtml(error.message || '加载失败')}</div>`;
  }
}

async function renderModelTree(files, ownModels) {
  const treeEl = $('modelTree');
  codexModelTree = [];
  let html = '';
  // 已保存模型（models.json）的标识集合，用于恢复勾选
  const savedSet = new Set((ownModels || []).map((m) => String(m?.modelName || m?.slug || m?.id || JSON.stringify(m)).trim()).filter(Boolean));
  for (const file of files || []) {
    const data = file.content;
    const models = Array.isArray(data) ? data : (data?.models || []);
    const fileKey = file.name;
    const ids = models.map((m) => String(m?.modelName || m?.slug || m?.id || JSON.stringify(m)).trim()).filter(Boolean);
    codexModelTree.push({ file: fileKey, group: file.group, models: ids });
    const rows = ids.map((id) => {
      const checked = savedSet.has(id) ? ' checked' : '';
      return `<label class="model-row"><input type="checkbox"${checked} data-file="${escapeHtml(fileKey)}" data-model="${escapeHtml(id)}"><span title="${escapeHtml(id)}">${escapeHtml(id)}</span></label>`;
    }).join('');
    html += `<details class="model-file" open><summary><label class="file-check"><input type="checkbox" data-filecheck="${escapeHtml(fileKey)}"><span>${escapeHtml(fileKey)}</span></label></summary>${rows || '<div class="model-empty">无模型</div>'}</details>`;
  }
  // 无法溯源的旧模型
  const known = new Set();
  codexModelTree.forEach((f) => f.models.forEach((m) => known.add(m)));
  const legacy = (ownModels || []).filter((m) => {
    const id = String(m?.modelName || m?.slug || m?.id || JSON.stringify(m)).trim();
    return id && !known.has(id);
  });
  if (legacy.length) {
    const rows = legacy.map((m) => {
      const id = String(m?.modelName || m?.slug || m?.id || JSON.stringify(m)).trim();
      const checked = savedSet.has(id) ? ' checked' : '';
      return `<label class="model-row"><input type="checkbox"${checked} data-file="旧文件" data-model="${escapeHtml(id)}"><span title="${escapeHtml(id)}">${escapeHtml(id)}</span></label>`;
    }).join('');
    html += `<details class="model-file legacy"><summary><label class="file-check"><input type="checkbox" data-filecheck="旧文件"><span>无法溯源</span></label></summary>${rows}</details>`;
  }
  treeEl.innerHTML = html;
  treeEl.querySelectorAll('input[data-filecheck]').forEach((box) => box.addEventListener('change', () => {
    const file = box.dataset.filecheck;
    treeEl.querySelectorAll(`input[data-file="${CSS.escape(file)}"]`).forEach((m) => { m.checked = box.checked; });
  }));
}

async function saveCodexConfig() {
  const config = (await window.sub2api.getState());
  const baseUrl = config.config?.baseUrl || '';
  const token = $('codexBearerToken').value.trim();
  await window.sub2api.saveCodexConfig({ baseUrl, bearerToken: token });
}

async function saveModels() {
  const slugs = [];
  document.querySelectorAll('#modelTree input[data-model]:checked').forEach((box) => {
    slugs.push(box.dataset.model);
  });
  await window.sub2api.saveModels(slugs);
}

async function saveCodex() {
  try {
    await saveCodexConfig();
    await saveModels();
    renderBackups();
    toast('配置与模型已保存');
  } catch (error) {
    toast(error.message || '保存失败');
  }
}

$('openCodexConfig').addEventListener('click', () => window.sub2api.openCodexConfig().catch((e) => toast(e.message || '打开失败')));
$('saveCodex').addEventListener('click', saveCodex);

function formatBackupTime(name) {
  const match = name.match(/(\d+)\.bak$/);
  if (!match) return '';
  const date = new Date(Number(match[1]) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date).replace(/\//g, '-');
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function renderBackups() {
  const listEl = $('backupsList');
  const emptyEl = $('backupsEmpty');
  listEl.innerHTML = '<div class="model-loading">加载中...</div>';
  emptyEl.hidden = true;
  try {
    const app = 'codex';
    const backups = await window.sub2api.listBackups(app);
    if (!backups || !backups.length) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    listEl.innerHTML = backups.map((b) => {
      const name = escapeHtml(b.name);
      const time = formatBackupTime(b.name);
      const kind = b.name.startsWith('config.') ? '配置' : (b.name.startsWith('models.') ? '模型' : '备份');
      return `<li class="backups-item">
        <span class="backups-item-name" title="${name}"><strong>${escapeHtml(kind)}</strong><span class="backup-time">${escapeHtml(time || name)}</span></span>
        <span class="backups-item-size">${formatBytes(b.size)}</span>
        <span class="backups-item-actions">
          <button class="secondary-button" data-action="preview" data-name="${name}">打开</button>
          <button class="secondary-button" data-action="restore" data-name="${name}">还原</button>
          <button class="danger-button" data-action="delete" data-name="${name}">删除</button>
        </span>
      </li>`;
    }).join('');
    listEl.querySelectorAll('button[data-action]').forEach((btn) => btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const action = btn.dataset.action;
      if (action === 'preview') previewBackupFile(app, name);
      else if (action === 'restore') restoreBackupFile(app, name);
      else if (action === 'delete') deleteBackupFile(app, name);
    }));
  } catch (error) {
    listEl.innerHTML = `<div class="model-error">${escapeHtml(error.message || '读取备份失败')}</div>`;
  }
}

async function previewBackupFile(app, name) {
  try {
    const content = await window.sub2api.previewBackup(app, name);
    $('previewModalTitle').textContent = name;
    $('previewModalContent').textContent = content;
    $('previewModal').hidden = false;
  } catch (error) {
    toast(error.message || '打开失败');
  }
}

function closePreviewModal() {
  $('previewModal').hidden = true;
}

$('previewModalClose').addEventListener('click', closePreviewModal);
$('previewModal').addEventListener('click', (event) => {
  if (event.target === $('previewModal')) closePreviewModal();
});

async function restoreBackupFile(app, name) {
  try {
    await window.sub2api.restoreBackup(app, name);
    toast('已还原');
    renderBackups();
  } catch (error) {
    toast(error.message || '还原失败');
  }
}

async function deleteBackupFile(app, name) {
  try {
    await window.sub2api.deleteBackup(app, name);
    toast('已删除');
    renderBackups();
  } catch (error) {
    toast(error.message || '删除失败');
  }
}



