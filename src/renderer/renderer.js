'use strict';

const $ = (id) => document.getElementById(id);
let pending2fa = null;
let chart = null;
let activeView = 'dashboard';
let lastConfigKey = '';
let lastAccountsKey = '';
let statsRequest = 0;

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
  const key = String(account?.platform || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
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
  statusTitle.textContent = state.isRefreshing ? '正在刷新…' : accounts.length ? `${accounts.length} 个账户` : state.status === 'error' ? '连接失败' : '需要配置';
  dot.className = `status-dot ${state.status === 'error' ? 'error' : state.status === 'ready' && accounts.some((item) => Math.max(Number(item.usage?.five_hour?.utilization) || 0, Number(item.usage?.seven_day?.utilization) || 0) >= 95) ? 'warn' : ''}`;
  notice.hidden = !(state.message && (state.status !== 'ready' || state.failed?.length));
  notice.textContent = state.failed?.length ? `${state.message || ''} ${state.failed.map((item) => `${item.accountName}: ${item.error}`).join('；')}` : (state.message || '');
  const accountsKey = JSON.stringify(accounts);
  if (accountsKey !== lastAccountsKey) {
    list.innerHTML = accounts.map((result) => accountCard(result)).join('');
    list.querySelectorAll('[data-account-id]').forEach((button) => button.addEventListener('click', () => openStats(button.dataset.accountId, button.dataset.accountName)));
    lastAccountsKey = accountsKey;
  }
  updateCountdowns();
  empty.hidden = accounts.length > 0;
  if (!accounts.length) {
    $('emptyTitle').textContent = state.status === 'needs-server' ? '还没有连接服务器' : state.status === 'needs-auth' ? '还没有配置鉴权' : '暂无账户用量';
    $('emptyMessage').textContent = state.message || '请在设置中配置服务器和管理员鉴权。';
  }
  const config = state.config || {};
  const configKey = JSON.stringify(config);
  if (configKey !== lastConfigKey) {
    fillConfig(config);
    lastConfigKey = configKey;
  }
  $('authMode').textContent = state.authMode === 'api-key' ? 'Admin API Key' : state.authMode === 'bearer' ? '管理员登录' : '未配置';
  $('authMode').classList.toggle('ready', ['api-key', 'bearer'].includes(state.authMode));
}

function accountCard(result) {
  const account = result.account || {};
  const usage = result.usage || {};
  const name = escapeHtml(account.name || '未命名账户');
  const providerKey = provider(account);
  const providerLabel = escapeHtml(icons[providerKey] || providerKey);
  return `<article class="account-card"><div class="account-head"><button class="account-name account-link" data-account-id="${escapeHtml(account.id)}" data-account-name="${name}"><i class="provider-dot"></i><span>${providerLabel} ${name}</span></button><span class="updated">更新于 ${escapeHtml(formatTime(usage.updated_at))}</span></div>${quota('5 小时', usage.five_hour)}${quota('7 天', usage.seven_day)}</article>`;
}

function quota(label, item) {
  const value = clamp(item?.utilization);
  const reset = countdown(item?.resets_at);
  const windowStats = item?.window_stats || {};
  const status = level(value);
  return `<div class="quota"><div class="quota-row"><span>${label} <small class="quota-countdown" data-reset-at="${escapeHtml(item?.resets_at || '')}"${reset ? '' : ' hidden'}>${escapeHtml(reset)}</small></span><strong class="${value >= 100 ? 'full' : ''}">${pct(value)}</strong></div><div class="progress"><i class="${status}" style="width:${value}%"></i></div><div class="quota-meta"><span>${integer(windowStats.requests)} req · ${token(windowStats.tokens)} tok</span><span>重置 ${escapeHtml(formatTime(item?.resets_at))}</span></div></div>`;
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
  $('updateUrl').value = config.updateUrl || '';
  $('updateInterval').value = config.updateInterval ?? 300;
  $('rotationInterval').value = config.rotationInterval ?? 5;
  $('requestTimeout').value = config.requestTimeout ?? 15000;
  $('allowInsecureTls').checked = Boolean(config.allowInsecureTls);
  $('showFloatingBar').checked = config.showFloatingBar !== false;
}

function switchView(view) {
  activeView = view;
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

async function openStats(accountId, accountName) {
  const request = ++statsRequest;
  switchView('stats');
  $('statsTitle').textContent = accountName || '使用趋势';
  $('chartMessage').textContent = '加载中…';
  $('chartMessage').hidden = false;
  try {
    const stats = await window.sub2api.getStats(accountId);
    if (request !== statsRequest) return;
    $('totalRequests').textContent = integer(stats.totalRequests);
    $('totalTokens').textContent = token(stats.totalTokens);
    const history = stats.history || [];
    const context = $('usageChart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(context, {
      type: 'line',
      data: { labels: history.map((item) => item.label), datasets: [
        { label: '请求', data: history.map((item) => item.requests), borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,.12)', yAxisID: 'requests', tension: .28, pointRadius: 2, borderWidth: 2 },
        { label: 'Token', data: history.map((item) => item.tokens), borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,.12)', yAxisID: 'tokens', tension: .28, pointRadius: 2, borderWidth: 2 }
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { labels: { color: '#8e9aa8', usePointStyle: true } } }, scales: { x: { ticks: { color: '#8e9aa8', maxTicksLimit: 8 }, grid: { color: '#2d353f' } }, requests: { beginAtZero: true, ticks: { color: '#fb923c' }, grid: { color: '#2d353f' } }, tokens: { beginAtZero: true, position: 'right', ticks: { color: '#4ade80' }, grid: { drawOnChartArea: false } } } }
    });
    $('chartMessage').hidden = history.some((item) => item.requests || item.tokens);
    if (!history.some((item) => item.requests || item.tokens)) $('chartMessage').textContent = '该时间范围暂无使用数据';
  } catch (error) {
    if (request !== statsRequest) return;
    $('chartMessage').textContent = error.message || '加载趋势失败';
  }
}

async function saveConfig(event) {
  event.preventDefault();
  try {
    await window.sub2api.saveConfig({ baseUrl: $('baseUrl').value.trim(), updateUrl: $('updateUrl').value.trim(), updateInterval: Number($('updateInterval').value), rotationInterval: Number($('rotationInterval').value), requestTimeout: Number($('requestTimeout').value), allowInsecureTls: $('allowInsecureTls').checked, showFloatingBar: $('showFloatingBar').checked });
    toast('连接设置已保存');
  } catch (error) { toast(error.message || '保存失败'); }
}

async function saveApiKey(event) {
  event.preventDefault();
  try { await window.sub2api.setApiKey($('apiKey').value); $('apiKey').value = ''; toast('Admin API Key 已验证'); }
  catch (error) { toast(error.message || 'API Key 验证失败'); }
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

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$('refreshButton').addEventListener('click', async () => {
  try { await window.sub2api.refresh(); toast('刷新完成'); }
  catch (error) { toast(error.message || '刷新失败'); }
});
$('closeButton').addEventListener('click', () => window.sub2api.close());
$('settingsShortcut').addEventListener('click', () => switchView('settings'));
$('emptySettingsButton').addEventListener('click', () => switchView('settings'));
$('backButton').addEventListener('click', () => switchView('dashboard'));
$('configForm').addEventListener('submit', saveConfig);
$('apiKeyForm').addEventListener('submit', saveApiKey);
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
window.sub2api.onNavigate(({ view, focus }) => { switchView(view); if (focus === 'server') $('baseUrl').focus(); if (focus === 'auth') $('apiKey').focus(); });
window.setInterval(updateCountdowns, 1000);
window.sub2api.getState().then(render).catch((error) => toast(error.message || '加载状态失败'));
