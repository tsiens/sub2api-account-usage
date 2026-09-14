'use strict';

const vscode = require('vscode');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const SECRET_ADMIN_API_KEY = 'sub2apiAccountUsage.adminApiKey';
const SECRET_ACCESS_TOKEN = 'sub2apiAccountUsage.accessToken';
const SECRET_REFRESH_TOKEN = 'sub2apiAccountUsage.refreshToken';
const SECRET_EMAIL = 'sub2apiAccountUsage.email';

const DISPLAY_TIMEZONE = 'Asia/Shanghai';
const ACCOUNT_PAGE_SIZE = 100;
const PROVIDER_ICONS = Object.freeze({
  openai: 'openai',
  codex: 'openai',
  'azure-openai': 'openai',
  anthropic: 'claude',
  claude: 'claude',
  google: 'google-gemini',
  gemini: 'google-gemini',
  xai: 'xai',
  grok: 'xai',
  kimi: 'kimi',
  moonshot: 'kimi',
  copilot: 'copilot',
  github: 'copilot'
});
const ACCOUNT_STATS_COMMAND = 'sub2apiAccountUsage.showAccountStats';

let controlStatusBarItem;
let output;
let refreshTimer;
let accountRotationTimer;
let accountRotationIndex = 0;
let rotatingAccounts = [];
let rotatingAccountsTooltip;
let extensionContext;
let refreshInFlight = false;
let refreshTokenInFlight;
let lastRefreshStartedAt = 0;
let statusTickTimer;
let currentAccountResult;
let expiredRefreshKeys = new Set();

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Sub2API 账户用量');
  controlStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  controlStatusBarItem.name = 'Sub2API 账户用量';
  controlStatusBarItem.command = 'sub2apiAccountUsage.refresh';
  controlStatusBarItem.text = '$(sparkle) Sub2API';
  controlStatusBarItem.tooltip = 'Sub2API 账户用量 — 点击刷新';
  controlStatusBarItem.show();

  context.subscriptions.push(
    output,
    controlStatusBarItem,
    vscode.commands.registerCommand('sub2apiAccountUsage.login', loginCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.setAdminApiKey', setAdminApiKeyCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.configureAuth', configureAuthenticationCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.logout', logoutCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.refresh', () => refreshUsage({ interactive: true })),
    vscode.commands.registerCommand('sub2apiAccountUsage.setRefreshInterval', setRefreshIntervalCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.setRotationInterval', setRotationIntervalCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.setServer', setServerCommand),
    vscode.commands.registerCommand('sub2apiAccountUsage.showLogs', () => output.show(true)),
    vscode.commands.registerCommand(ACCOUNT_STATS_COMMAND, showAccountStatsCommand),
    vscode.window.onDidChangeWindowState(handleWindowStateChange),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('sub2apiAccountUsage')) {
        log('Configuration changed; restarting refresh timer.');
        startRefreshTimer();
      }
    })
  );

  log('Extension activated.');
  startRefreshTimer();
}

function deactivate() {
  clearRefreshTimer();
  stopStatusTick();
  stopAccountRotation();
}

function config() {
  const c = vscode.workspace.getConfiguration('sub2apiAccountUsage');
  const baseUrl = String(c.get('baseUrl', '') || '').trim().replace(/\/+$/, '');
  return {
    baseUrl,
    updateInterval: Math.max(30, Number(c.get('updateInterval', 300))),
    rotationInterval: Math.max(1, Number(c.get('rotationInterval', 5))),
    requestTimeout: Math.max(1000, Number(c.get('requestTimeout', 15000))),
    allowInsecureTls: Boolean(c.get('allowInsecureTls', false))
  };
}

function startRefreshTimer() {
  clearRefreshTimer();
  const { updateInterval } = config();
  if (!vscode.window.state.focused) {
    log(`Automatic refresh paused while the window is in the background (interval=${updateInterval}s).`);
    return;
  }
  log(`Automatic refresh every ${updateInterval}s while the window is focused.`);
  void refreshUsageIfDue();
}

function clearRefreshTimer() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

function scheduleNextRefresh() {
  clearRefreshTimer();
  if (!vscode.window.state.focused) return;

  const intervalMs = config().updateInterval * 1000;
  const elapsed = lastRefreshStartedAt > 0 ? Date.now() - lastRefreshStartedAt : 0;
  const delay = lastRefreshStartedAt > 0
    ? Math.max(0, intervalMs - elapsed)
    : intervalMs;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshUsageIfDue();
  }, delay);
}

async function refreshUsageIfDue() {
  if (!vscode.window.state.focused) {
    clearRefreshTimer();
    return;
  }

  const intervalMs = config().updateInterval * 1000;
  const elapsed = lastRefreshStartedAt > 0 ? Date.now() - lastRefreshStartedAt : intervalMs;
  if (elapsed < intervalMs) {
    scheduleNextRefresh();
    return;
  }

  await refreshUsage({ interactive: false });
  scheduleNextRefresh();
}

function handleWindowStateChange(state) {
  if (!state.focused) {
    clearRefreshTimer();
    log('VS Code window moved to the background; automatic refresh paused.');
    return;
  }

  log('VS Code window became active; checking whether usage refresh is due.');
  void refreshUsageIfDue();
}

async function loginCommand() {
  if (!(await ensureServerConfigured())) return;

  const savedEmail = await extensionContext.secrets.get(SECRET_EMAIL);
  const email = await vscode.window.showInputBox({
    title: 'Sub2API 管理员登录',
    prompt: '管理员邮箱',
    value: savedEmail || '',
    ignoreFocusOut: true
  });
  if (!email) return;

  const password = await vscode.window.showInputBox({
    title: 'Sub2API 管理员登录',
    prompt: '管理员密码（仅用于本次登录，不保存）',
    password: true,
    ignoreFocusOut: true
  });
  if (!password) return;

  setLoading('登录中…');
  try {
    let auth = await apiRequest('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false
    });

    if (auth && auth.requires_2fa === true) {
      if (!auth.temp_token) throw new Error('服务器要求 2FA，但没有返回 temp_token。');
      const totpCode = await vscode.window.showInputBox({
        title: 'Sub2API 两步验证',
        prompt: '输入 6 位 TOTP 验证码',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => /^\d{6}$/.test(value.trim()) ? undefined : '请输入 6 位数字验证码'
      });
      if (!totpCode) {
        showNeedsAuth();
        return;
      }
      auth = await apiRequest('/api/v1/auth/login/2fa', {
        method: 'POST',
        body: { temp_token: auth.temp_token, totp_code: totpCode.trim() },
        auth: false
      });
    }

    await extensionContext.secrets.delete(SECRET_ADMIN_API_KEY);
    await saveJwtAuth(auth, email);
    log(`Password login succeeded for ${redactEmail(email)}.`);
    vscode.window.showInformationMessage('Sub2API 账户用量：登录成功。');
    await refreshUsage({ interactive: false });
  } catch (error) {
    const message = errorMessage(error);
    log(`Login failed: ${message}`);
    showNeedsAuth(message);
    vscode.window.showErrorMessage(`Sub2API 登录失败：${message}`);
  }
}

async function configureAuthenticationCommand() {
  if (!(await ensureServerConfigured())) return;

  const mode = await currentAuthMode();
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(key) Admin API Key', description: mode === 'api-key' ? '当前方式；重新填写或更换 API Key' : '推荐；使用 x-api-key，不需要管理员登录态', value: 'api-key' },
      { label: '$(account) 邮箱 + 密码', description: mode === 'bearer' ? '当前方式；重新登录' : '管理员 JWT；支持 TOTP 2FA', value: 'password' },
      { label: '$(trash) 清除已保存鉴权', description: '删除 API Key、JWT、refresh token 和缓存邮箱', value: 'clear' }
    ],
    { title: 'Sub2API 账户用量：配置 / 切换管理员鉴权', ignoreFocusOut: true }
  );
  if (!choice) return;

  if (choice.value === 'api-key') {
    await setAdminApiKeyCommand();
    return;
  }
  if (choice.value === 'password') {
    await loginCommand();
    return;
  }
  await logoutCommand();
}

async function setAdminApiKeyCommand() {
  if (!(await ensureServerConfigured())) return;

  const current = await extensionContext.secrets.get(SECRET_ADMIN_API_KEY);
  const apiKey = await vscode.window.showInputBox({
    title: 'Sub2API Admin API Key',
    prompt: '输入管理员 API Key（通过 x-api-key 访问 Admin API）',
    value: current || '',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim().length >= 8 ? undefined : 'API Key 看起来过短'
  });
  if (!apiKey) return;

  await extensionContext.secrets.store(SECRET_ADMIN_API_KEY, apiKey.trim());
  await extensionContext.secrets.delete(SECRET_ACCESS_TOKEN);
  await extensionContext.secrets.delete(SECRET_REFRESH_TOKEN);
  await extensionContext.secrets.delete(SECRET_EMAIL);
  log('Admin API Key stored in VS Code SecretStorage.');

  try {
    await listAccounts();
    vscode.window.showInformationMessage('Sub2API 账户用量：Admin API Key 已保存并验证。');
    await refreshUsage({ interactive: false });
  } catch (error) {
    await extensionContext.secrets.delete(SECRET_ADMIN_API_KEY);
    const message = errorMessage(error);
    log(`Admin API Key validation failed: ${message}`);
    showNeedsAuth(message);
    vscode.window.showErrorMessage(`Sub2API Admin API Key 验证失败：${message}`);
  }
}

async function logoutCommand() {
  const adminApiKey = await extensionContext.secrets.get(SECRET_ADMIN_API_KEY);
  const refreshToken = await extensionContext.secrets.get(SECRET_REFRESH_TOKEN);

  if (!adminApiKey && refreshToken) {
    try {
      await apiRequest('/api/v1/auth/logout', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        auth: false
      });
    } catch (error) {
      log(`Remote logout failed; clearing local secrets anyway: ${errorMessage(error)}`);
    }
  }

  await clearAuth();
  showNeedsAuth();
  vscode.window.showInformationMessage('Sub2API 账户用量：本地管理员鉴权已清除。');
}

async function setRefreshIntervalCommand() {
  const current = config().updateInterval;
  const raw = await vscode.window.showInputBox({
    title: 'Sub2API 账户用量：自动刷新间隔',
    prompt: '输入自动刷新间隔（秒），最小 30 秒',
    value: String(current),
    placeHolder: '300',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const text = value.trim();
      if (!/^\d+$/.test(text)) return '请输入整数秒数';
      const seconds = Number(text);
      if (!Number.isSafeInteger(seconds) || seconds < 30) return '刷新间隔不能小于 30 秒';
      return undefined;
    }
  });
  if (raw === undefined) return false;

  const seconds = Number(raw.trim());
  await vscode.workspace.getConfiguration('sub2apiAccountUsage').update(
    'updateInterval',
    seconds,
    vscode.ConfigurationTarget.Global
  );
  log(`Refresh interval updated to ${seconds}s.`);
  vscode.window.showInformationMessage(`Sub2API 账户用量：自动刷新间隔已设为 ${formatIntervalLabel(seconds)}。`);
  return true;
}

function formatIntervalLabel(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

async function setRotationIntervalCommand() {
  const current = config().rotationInterval;
  const raw = await vscode.window.showInputBox({
    title: 'Sub2API 账户用量：账户切换间隔',
    prompt: '输入多账户状态栏切换间隔（秒），最小 1 秒',
    value: String(current),
    placeHolder: '5',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const text = value.trim();
      if (!/^\d+$/.test(text)) return '请输入整数秒数';
      const seconds = Number(text);
      if (!Number.isSafeInteger(seconds) || seconds < 1) return '切换间隔不能小于 1 秒';
      return undefined;
    }
  });
  if (raw === undefined) return false;

  const seconds = Number(raw.trim());
  await vscode.workspace.getConfiguration('sub2apiAccountUsage').update(
    'rotationInterval',
    seconds,
    vscode.ConfigurationTarget.Global
  );
  log(`Account rotation interval updated to ${seconds}s.`);
  vscode.window.showInformationMessage(`Sub2API 账户用量：账户切换间隔已设为 ${formatIntervalLabel(seconds)}。`);
  return true;
}

async function setServerCommand() {
  const current = config().baseUrl;
  const raw = await vscode.window.showInputBox({
    title: 'Sub2API Server URL',
    prompt: '填写 Sub2API 服务地址，不要带 /api/v1',
    placeHolder: 'https://sub2api.example.com',
    value: current,
    ignoreFocusOut: true,
    validateInput: validateServerUrl
  });
  if (!raw) return false;

  await vscode.workspace.getConfiguration('sub2apiAccountUsage').update(
    'baseUrl',
    raw.trim().replace(/\/+$/, ''),
    vscode.ConfigurationTarget.Global
  );
  log('Server URL updated.');
  return true;
}

function validateServerUrl(value) {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只支持 http/https';
    if (u.pathname && u.pathname !== '/') return '请只填写服务根地址，不要带 /api/v1 或其他路径';
    return undefined;
  } catch {
    return '请输入合法 URL';
  }
}

async function ensureServerConfigured() {
  if (config().baseUrl) return true;
  return Boolean(await setServerCommand());
}

async function promptAuthentication() {
  return configureAuthenticationCommand();
}

async function hasAuthentication() {
  return Boolean(
    (await extensionContext.secrets.get(SECRET_ADMIN_API_KEY)) ||
    (await extensionContext.secrets.get(SECRET_ACCESS_TOKEN))
  );
}

async function refreshUsage({ interactive }) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const started = Date.now();

  try {
    if (!config().baseUrl) {
      showNeedsServer();
      if (!interactive) return;
      await setServerCommand();
      if (!config().baseUrl) return;
    }

    if (!(await hasAuthentication())) {
      showNeedsAuth();
      if (!interactive) return;
      await promptAuthentication();
      if (!(await hasAuthentication())) return;
    }

    lastRefreshStartedAt = Date.now();
    scheduleNextRefresh();
    setRefreshingStatus();
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      renderNoActiveAccounts(0);
      log('No non-inactive accounts found.');
      return;
    }

    const nonInactiveAccounts = accounts.filter(isNotInactive);
    if (nonInactiveAccounts.length === 0) {
      renderNoActiveAccounts(accounts.length);
      log(`No non-inactive accounts found: accounts=${accounts.length}.`);
      return;
    }

    const queryableAccounts = nonInactiveAccounts.filter(accountSupportsBatchUsage);
    if (queryableAccounts.length === 0) {
      renderNoQueryableAccounts(nonInactiveAccounts.length);
      log(`No usage-queryable accounts found: nonInactive=${nonInactiveAccounts.length}.`);
      return;
    }

    const batchUsage = await getBatchAccountUsage(queryableAccounts.map((account) => account.id));
    const results = mapBatchUsageResults(queryableAccounts, batchUsage);

    renderAccounts(results);
    const failed = results.filter((item) => item.error);
    const ok = results.length - failed.length;
    const displayed = results.filter((item) => !item.error).length;
    log(`Usage refreshed in ${Date.now() - started}ms: accounts=${accounts.length}, nonInactive=${nonInactiveAccounts.length}, queryable=${results.length}, displayed=${displayed}, ok=${ok}, failed=${failed.length}.`);

    // Successful refreshes are intentionally silent. Only failures can surface a toast.
    if (interactive && failed.length > 0) {
      vscode.window.showWarningMessage(`Sub2API 账户用量：${failed.length}/${results.length} 个账号刷新失败，详情可查看悬浮信息或日志。`);
    }
  } catch (error) {
    const message = errorMessage(error);

    if (isUnauthorized(error)) {
      showNeedsAuth(message);
      log(`Authentication failed during refresh: ${message}`);
      if (interactive) {
        const choice = await vscode.window.showWarningMessage('Sub2API 管理员鉴权已失效或无效。', '重新配置鉴权');
        if (choice === '重新配置鉴权') await promptAuthentication();
      }
      return;
    }

    renderError(message);
    log(`Refresh failed: ${message}`);
    if (interactive) vscode.window.showErrorMessage(`Sub2API 账户用量刷新失败：${message}`);
  } finally {
    refreshInFlight = false;
  }
}

async function listAccounts() {
  const accounts = [];
  let page = 1;
  let pages = 1;

  do {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(ACCOUNT_PAGE_SIZE),
      include_scheduler_score: '0',
      sort_by: 'name',
      sort_order: 'asc',
      timezone: DISPLAY_TIMEZONE
    });
    const data = await apiRequestWithAuthRetry(`/api/v1/admin/accounts?${query.toString()}`);
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

    for (const account of items) {
      if (account && account.id !== undefined && account.id !== null && String(account.id).trim()) {
        accounts.push(account);
      }
    }

    pages = Math.max(1, Number(data?.pages) || 1);
    page += 1;
  } while (page <= pages && page <= 1000);

  return accounts;
}

function isNotInactive(account) {
  const status = typeof account?.status === 'string' ? account.status.trim().toLowerCase() : '';
  return status !== 'inactive';
}

function accountSupportsBatchUsage(account) {
  const platform = typeof account?.platform === 'string' ? account.platform.trim().toLowerCase() : '';
  const type = typeof account?.type === 'string' ? account.type.trim().toLowerCase() : '';
  if (platform === 'anthropic') return type === 'oauth' || type === 'setup-token';
  if (platform === 'gemini') return true;
  if (platform === 'antigravity') return type === 'oauth';
  if (platform === 'openai') return type === 'oauth';
  if (platform === 'grok') return type === 'oauth';
  return false;
}

async function getBatchAccountUsage(accountIds) {
  return apiRequestWithAuthRetry('/api/v1/admin/accounts/usage/batch', {
    method: 'POST',
    body: {
      account_ids: accountIds,
      force: true
    }
  });
}

function mapBatchUsageResults(accounts, batch) {
  const usageByAccount = batch && typeof batch.usage === 'object' && batch.usage ? batch.usage : {};
  const errorsByAccount = batch && typeof batch.errors === 'object' && batch.errors ? batch.errors : {};
  return accounts.map((account) => {
    const key = String(account.id);
    try {
      if (errorsByAccount[key]) throw new Error(String(errorsByAccount[key]));
      const usage = usageByAccount[key];
      if (!usage) throw new Error('批量接口未返回该账户用量。');
      validateUsage(usage);
      return { account, usage, error: null };
    } catch (error) {
      return { account, usage: null, error };
    }
  });
}

async function getAccountStats(accountId, days) {
  const query = new URLSearchParams({
    days: String(days),
    timezone: DISPLAY_TIMEZONE
  });
  return apiRequestWithAuthRetry(
    `/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}/stats?${query.toString()}`
  );
}

async function showAccountStatsCommand(input) {
  const accountId = input && input.accountId !== undefined ? String(input.accountId).trim() : '';
  if (!accountId) {
    vscode.window.showErrorMessage('Sub2API 账户用量：无法打开趋势图，账户 ID 无效。');
    return;
  }

  const accountName = String(input.accountName || '未命名账户');
  const panel = vscode.window.createWebviewPanel(
    'sub2apiAccountUsage.accountStats',
    `${accountName} · 使用趋势`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionContext.extensionUri, 'media')]
    }
  );

  panel.webview.html = accountStatsLoadingHtml(accountName);

  try {
    const stats = await getAccountStats(accountId, 30);
    const chartScriptUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionContext.extensionUri, 'media', 'chart.umd.min.js')
    );
    const normalized30Days = normalizeAccountStats(stats, 30);
    panel.webview.html = accountStatsChartHtml(panel.webview, chartScriptUri, {
      accountName,
      stats: normalized30Days
    });
    log(`Account stats loaded: account=${accountId}, source=${Array.isArray(stats?.history) ? stats.history.length : 0}, 30d=${normalized30Days.history.length}.`);
  } catch (error) {
    const message = errorMessage(error);
    log(`Account stats failed for account=${accountId}: ${message}`);
    panel.webview.html = accountStatsErrorHtml(accountName, message);
  }
}

function normalizeAccountStats(raw, days) {
  const history = Array.isArray(raw?.history) ? raw.history : [];
  const requestedDays = Math.max(1, Math.floor(Number(days) || 30));
  const byDate = new Map();
  for (const item of history) {
    const date = normalizeDateKey(item?.date);
    if (!date) continue;
    const existing = byDate.get(date) || { requests: 0, tokens: 0 };
    existing.requests += finiteNonNegative(item?.requests);
    existing.tokens += finiteNonNegative(item?.tokens);
    byDate.set(date, existing);
  }

  const endDate = normalizeDateKey(raw?.summary?.today?.date)
    || Array.from(byDate.keys()).sort().at(-1)
    || dateKeyInDisplayTimezone(new Date());
  const endTime = Date.parse(`${endDate}T00:00:00Z`);
  const points = [];
  for (let offset = requestedDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(endTime - offset * 86_400_000).toISOString().slice(0, 10);
    const values = byDate.get(date) || { requests: 0, tokens: 0 };
    points.push({
      label: `${date.slice(5, 7)}/${date.slice(8, 10)}`,
      date,
      requests: values.requests,
      tokens: values.tokens
    });
  }
  return summarizeAccountStats(points);
}

function summarizeAccountStats(points) {
  return {
    history: points,
    totalRequests: points.reduce((sum, item) => sum + item.requests, 0),
    totalTokens: points.reduce((sum, item) => sum + item.tokens, 0)
  };
}

function normalizeDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0] ? '' : match[0];
}

function dateKeyInDisplayTimezone(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function accountStatsLoadingHtml(accountName) {
  return accountStatsMessageHtml(accountName, '正在加载 30 天使用数据…', false);
}

function accountStatsErrorHtml(accountName, message) {
  return accountStatsMessageHtml(accountName, `加载失败：${message}`, true);
}

function accountStatsMessageHtml(accountName, message, isError) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .message { margin-top: 32px; color: ${isError ? 'var(--vscode-errorForeground)' : 'var(--vscode-descriptionForeground)'}; }
  </style>
</head>
<body>
  <h1>${escapeHtml(accountName)}</h1>
  <div class="message">${escapeHtml(message)}</div>
</body>
</html>`;
}

function accountStatsChartHtml(webview, chartScriptUri, payload) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { padding: 22px 24px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0; }
    main { padding: 18px 24px 24px; }
    .summary { display: flex; flex-wrap: wrap; gap: 24px; margin-bottom: 18px; color: var(--vscode-descriptionForeground); }
    .summary strong { margin-left: 6px; color: var(--vscode-foreground); font-size: 16px; }
    .chart-wrap { position: relative; width: 100%; height: min(62vh, 560px); min-height: 320px; }
    canvas { width: 100% !important; height: 100% !important; }
    .empty { position: absolute; inset: 0; display: none; place-items: center; color: var(--vscode-descriptionForeground); }
    .empty.visible { display: grid; }
    @media (max-width: 640px) {
      main { padding-inline: 14px; }
      .chart-wrap { min-height: 280px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(payload.accountName)}</h1>
  </header>
  <main>
    <div class="summary">
      <span>请求<strong id="requestTotal">0</strong></span>
      <span>Token<strong id="tokenTotal">0</strong></span>
    </div>
    <div class="chart-wrap">
      <canvas id="usageChart" aria-label="账户使用趋势"></canvas>
      <div class="empty" id="emptyState">该时间范围暂无使用数据</div>
    </div>
  </main>
  <script nonce="${nonce}" src="${chartScriptUri}"></script>
  <script nonce="${nonce}">
    const payload = ${data};
    const selected = payload.stats;
    const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
    const integer = new Intl.NumberFormat('zh-CN');
    const css = getComputedStyle(document.documentElement);
    const foreground = css.getPropertyValue('--vscode-foreground').trim() || '#cccccc';
    const muted = css.getPropertyValue('--vscode-descriptionForeground').trim() || '#888888';
    const border = css.getPropertyValue('--vscode-panel-border').trim() || 'rgba(127,127,127,.25)';
    const context = document.getElementById('usageChart').getContext('2d');
    const chart = new Chart(context, {
      type: 'line',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 220 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: foreground, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
          tooltip: {
            callbacks: {
              label: (item) => item.dataset.yAxisID === 'tokens'
                ? ' Token：' + integer.format(item.parsed.y)
                : ' 请求：' + integer.format(item.parsed.y)
            }
          }
        },
        scales: {
          x: { ticks: { color: muted, maxRotation: 0, autoSkip: true }, grid: { color: border } },
          requests: {
            type: 'linear', position: 'left', beginAtZero: true,
            title: { display: true, text: '请求', color: '#f97316' },
            ticks: { color: '#f97316', callback: (value) => compact.format(value) },
            grid: { color: border }
          },
          tokens: {
            type: 'linear', position: 'right', beginAtZero: true,
            title: { display: true, text: 'Token', color: '#22c55e' },
            ticks: { color: '#22c55e', callback: (value) => compact.format(value) },
            grid: { drawOnChartArea: false }
          }
        }
      }
    });

    const history = selected.history || [];
    chart.data.labels = history.map((item) => item.label || item.date);
    chart.data.datasets = [
      {
        label: '请求', data: history.map((item) => item.requests), yAxisID: 'requests',
        borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,.12)',
        pointBackgroundColor: '#f97316', pointRadius: 2, pointHoverRadius: 4,
        borderWidth: 2, tension: .28, fill: false
      },
      {
        label: 'Token', data: history.map((item) => item.tokens), yAxisID: 'tokens',
        borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.12)',
        pointBackgroundColor: '#22c55e', pointRadius: 2, pointHoverRadius: 4,
        borderWidth: 2, tension: .28, fill: false
      }
    ];
    chart.update();
    document.getElementById('requestTotal').textContent = integer.format(selected.totalRequests || 0);
    document.getElementById('tokenTotal').textContent = compact.format(selected.totalTokens || 0);
    document.getElementById('emptyState').classList.toggle('visible', history.every((item) => item.requests === 0 && item.tokens === 0));
  </script>
</body>
</html>`;
}

async function apiRequestWithAuthRetry(path, options = {}) {
  try {
    return await apiRequest(path, { ...options, auth: true });
  } catch (error) {
    const mode = await currentAuthMode();
    if (!isUnauthorized(error) || mode !== 'bearer') throw error;

    log('Admin request returned 401; trying JWT refresh once.');
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      const authError = new Error('管理员登录已过期，请重新登录。');
      authError.status = 401;
      throw authError;
    }
    return apiRequest(path, { ...options, auth: true });
  }
}

async function currentAuthMode() {
  if (await extensionContext.secrets.get(SECRET_ADMIN_API_KEY)) return 'api-key';
  if (await extensionContext.secrets.get(SECRET_ACCESS_TOKEN)) return 'bearer';
  return 'none';
}

async function refreshAccessToken() {
  if (refreshTokenInFlight) return refreshTokenInFlight;

  refreshTokenInFlight = (async () => {
    const refreshToken = await extensionContext.secrets.get(SECRET_REFRESH_TOKEN);
    if (!refreshToken) return false;
    try {
      const auth = await apiRequest('/api/v1/auth/refresh', {
        method: 'POST',
        body: { refresh_token: refreshToken },
        auth: false
      });
      await saveJwtAuth(auth, await extensionContext.secrets.get(SECRET_EMAIL));
      log('Access token refreshed.');
      return true;
    } catch (error) {
      log(`Token refresh failed: ${errorMessage(error)}`);
      await extensionContext.secrets.delete(SECRET_ACCESS_TOKEN);
      await extensionContext.secrets.delete(SECRET_REFRESH_TOKEN);
      return false;
    } finally {
      refreshTokenInFlight = undefined;
    }
  })();

  return refreshTokenInFlight;
}

async function saveJwtAuth(auth, email) {
  if (!auth || typeof auth.access_token !== 'string' || !auth.access_token) {
    throw new Error('登录响应中缺少 access_token。');
  }
  await extensionContext.secrets.store(SECRET_ACCESS_TOKEN, auth.access_token);
  if (typeof auth.refresh_token === 'string' && auth.refresh_token) {
    await extensionContext.secrets.store(SECRET_REFRESH_TOKEN, auth.refresh_token);
  }
  if (email) await extensionContext.secrets.store(SECRET_EMAIL, String(email));
}

async function clearAuth() {
  await extensionContext.secrets.delete(SECRET_ADMIN_API_KEY);
  await extensionContext.secrets.delete(SECRET_ACCESS_TOKEN);
  await extensionContext.secrets.delete(SECRET_REFRESH_TOKEN);
  await extensionContext.secrets.delete(SECRET_EMAIL);
}

async function apiRequest(path, options = {}) {
  const c = config();
  if (!c.baseUrl) throw new Error('尚未配置 Sub2API Server URL。');

  const url = new URL(path, `${c.baseUrl}/`);
  const method = options.method || 'GET';
  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'sub2api-account-usage-vscode/0.0.9'
  };

  let bodyBuffer;
  if (options.body !== undefined) {
    bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(bodyBuffer.length);
  }

  let authLabel = 'no-auth';
  if (options.auth !== false) {
    const adminApiKey = await extensionContext.secrets.get(SECRET_ADMIN_API_KEY);
    const accessToken = await extensionContext.secrets.get(SECRET_ACCESS_TOKEN);

    if (adminApiKey) {
      headers['x-api-key'] = adminApiKey;
      authLabel = 'api-key';
    } else if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
      authLabel = 'bearer';
    } else {
      const err = new Error('尚未配置管理员鉴权');
      err.status = 401;
      throw err;
    }
    headers['X-Admin-UI-Request'] = '1';
  }

  log(`${method} ${url.origin}${url.pathname}${redactQuery(url.search)} [${authLabel}]`);

  const raw = await requestJson(url, {
    method,
    headers,
    bodyBuffer,
    timeout: c.requestTimeout,
    allowInsecureTls: c.allowInsecureTls
  });

  return unwrapApiResponse(raw);
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https;
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      timeout: options.timeout
    };

    if (url.protocol === 'https:' && options.allowInsecureTls) {
      requestOptions.rejectUnauthorized = false;
    }

    const req = client.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            const err = new Error(`HTTP ${res.statusCode}: 服务器返回的不是 JSON`);
            err.status = res.statusCode;
            err.responseText = text.slice(0, 200);
            reject(err);
            return;
          }
        }

        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          const err = new Error(extractServerMessage(data) || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.data = data;
          reject(err);
          return;
        }
        resolve(data);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`请求超时（${options.timeout}ms）`)));
    req.on('error', reject);
    if (options.bodyBuffer) req.write(options.bodyBuffer);
    req.end();
  });
}

function unwrapApiResponse(raw) {
  if (raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'code')) {
    if (raw.code !== 0) {
      const err = new Error(raw.message || `API error code ${raw.code}`);
      err.code = raw.code;
      err.data = raw;
      throw err;
    }
    return raw.data;
  }
  return raw;
}

function extractServerMessage(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.message === 'string') return data.message;
  if (typeof data.detail === 'string') return data.detail;
  if (typeof data.error === 'string') return data.error;
  if (data.error && typeof data.error.message === 'string') return data.error.message;
  return '';
}

function isUnauthorized(error) {
  return Boolean(error && (error.status === 401 || error.code === 'INVALID_ADMIN_KEY'));
}

function validateUsage(usage) {
  if (!usage || typeof usage !== 'object') throw new Error('usage 响应为空。');
  if (!usage.five_hour || !usage.seven_day) throw new Error('usage 响应缺少 five_hour 或 seven_day。');
  if (!Number.isFinite(Number(usage.five_hour.utilization))) throw new Error('five_hour.utilization 无效。');
  if (!Number.isFinite(Number(usage.seven_day.utilization))) throw new Error('seven_day.utilization 无效。');
}

function quotaPressure(usage) {
  return Math.max(clampPct(usage.five_hour.utilization), clampPct(usage.seven_day.utilization));
}

function renderAccounts(results) {
  expiredRefreshKeys.clear();
  const accounts = results
    .filter((result) => !result.error)
    .sort((a, b) => quotaPressure(a.usage) - quotaPressure(b.usage));
  const failed = results.filter((result) => result.error);

  controlStatusBarItem.name = 'Sub2API 账户用量';
  controlStatusBarItem.command = 'sub2apiAccountUsage.refresh';

  if (accounts.length === 0) {
    stopAccountRotation();
    renderNoQueryableAccounts(0, failed);
  } else if (accounts.length === 1) {
    stopAccountRotation();
    renderSingleAccount(accounts[0]);
  } else {
    startAccountRotation(accounts);
  }

  controlStatusBarItem.show();
}

function renderSingleAccount(result) {
  currentAccountResult = result;
  const { account, usage } = result;
  const name = accountDisplayName(account);
  const five = usage.five_hour;
  const seven = usage.seven_day;
  const fivePct = clampPct(five.utilization);
  const sevenPct = clampPct(seven.utilization);
  const worst = Math.max(fivePct, sevenPct);

  controlStatusBarItem.text = statusTextForResult(result);
  controlStatusBarItem.backgroundColor = worst >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= 80
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;

  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [ACCOUNT_STATS_COMMAND] };
  md.supportHtml = true;
  appendAccountUsageTable(md, account, usage);
  controlStatusBarItem.tooltip = md;
  startStatusTick();
}

function createAccountsTooltip(accounts, rotationInterval) {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [ACCOUNT_STATS_COMMAND] };
  md.supportHtml = true;
  md.appendMarkdown(`### ${accounts.length} 个账户用量\n\n每 ${rotationInterval} 秒切换状态栏账户。\n\n`);
  accounts.forEach((result, index) => {
    if (index > 0) md.appendMarkdown(`\n\n---\n\n`);
    appendAccountUsageTable(md, result.account, result.usage);
  });
  return md;
}

function startAccountRotation(accounts) {
  stopAccountRotation();
  const rotationInterval = config().rotationInterval;
  rotatingAccounts = accounts;
  rotatingAccountsTooltip = createAccountsTooltip(accounts, rotationInterval);
  accountRotationIndex = 0;
  renderRotatingAccount();
  accountRotationTimer = setInterval(() => {
    accountRotationIndex = (accountRotationIndex + 1) % rotatingAccounts.length;
    renderRotatingAccount();
  }, rotationInterval * 1000);
  startStatusTick();
}

function renderRotatingAccount() {
  if (rotatingAccounts.length === 0) return;
  const result = rotatingAccounts[accountRotationIndex];
  currentAccountResult = result;
  const name = accountDisplayName(result.account);
  const fivePct = clampPct(result.usage.five_hour.utilization);
  const sevenPct = clampPct(result.usage.seven_day.utilization);
  const worst = Math.max(fivePct, sevenPct);

  controlStatusBarItem.text = statusTextForResult(result);
  controlStatusBarItem.backgroundColor = worst >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= 80
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  controlStatusBarItem.tooltip = rotatingAccountsTooltip;
  controlStatusBarItem.show();
}

function statusTextForResult(result) {
  const { account, usage } = result;
  const name = accountDisplayName(account);
  const icon = providerIcon(account);
  const fivePct = clampPct(usage.five_hour.utilization);
  const sevenPct = clampPct(usage.seven_day.utilization);

  let suffix;
  if (fivePct >= 100) {
    const cd = formatCountdown(usage.five_hour.resets_at);
    suffix = cd || '';
  } else if (sevenPct >= 100) {
    const cd = formatCountdown(usage.seven_day.resets_at);
    suffix = cd || '';
  } else {
    suffix = `${formatPct(fivePct)} · ${formatPct(sevenPct)}`;
  }

  const text = suffix ? `${truncate(name, 16)}  ${suffix}` : truncate(name, 16);
  return `$(${icon}) ${text}`;
}

function stopAccountRotation() {
  if (accountRotationTimer) clearInterval(accountRotationTimer);
  accountRotationTimer = undefined;
  accountRotationIndex = 0;
  rotatingAccounts = [];
  rotatingAccountsTooltip = undefined;
  currentAccountResult = undefined;
  stopStatusTick();
}

/* 每分钟计算所有账户所有时间窗口的重置剩余时间，并刷新状态栏与悬浮信息；不依赖窗口前后台状态。 */
function startStatusTick() {
  stopStatusTick();
  statusTickTimer = setInterval(() => {
    refreshCountdowns();
  }, 60 * 1000);
}

function stopStatusTick() {
  if (statusTickTimer) clearInterval(statusTickTimer);
  statusTickTimer = undefined;
}

function refreshCountdowns() {
  if (!currentAccountResult) return;
  if (shouldRefreshExpiredWindows()) {
    void refreshUsage({ interactive: false });
  }

  const worst = quotaPressure(currentAccountResult.usage);
  controlStatusBarItem.text = statusTextForResult(currentAccountResult);
  controlStatusBarItem.backgroundColor = worst >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : worst >= 80
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;

  if (rotatingAccounts.length > 0) {
    rotatingAccountsTooltip = createAccountsTooltip(rotatingAccounts, config().rotationInterval);
    controlStatusBarItem.tooltip = rotatingAccountsTooltip;
  } else {
    const { account, usage } = currentAccountResult;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: [ACCOUNT_STATS_COMMAND] };
    md.supportHtml = true;
    appendAccountUsageTable(md, account, usage);
    controlStatusBarItem.tooltip = md;
  }
  controlStatusBarItem.show();
}

/* 检查是否有账户的某个时间窗口倒计时已归零；若发现新的归零窗口，则记录并触发一次全量刷新。 */
function shouldRefreshExpiredWindows() {
  const accounts = rotatingAccounts.length > 0 ? rotatingAccounts : [currentAccountResult];
  let shouldRefresh = false;

  for (const result of accounts) {
    if (!result || result.error || !result.usage) continue;
    const accountId = result.account && result.account.id !== undefined ? String(result.account.id) : '?';
    const windows = [
      { key: 'five_hour', data: result.usage.five_hour },
      { key: 'seven_day', data: result.usage.seven_day }
    ];
    for (const { key, data } of windows) {
      const resetsAt = data && data.resets_at;
      const target = parseApiTimestamp(resetsAt);
      if (!target) continue;
      if (target.getTime() - Date.now() > 0) continue; // 尚未归零
      const refreshKey = `${accountId}:${key}:${resetsAt}`;
      if (expiredRefreshKeys.has(refreshKey)) continue;
      expiredRefreshKeys.add(refreshKey);
      log(`Window expired, requesting usage refresh: account=${accountId} window=${key}`);
      shouldRefresh = true;
    }
  }
  return shouldRefresh;
}

function appendAccountUsageTable(md, account, usage) {
  const name = escapeHtml(accountDisplayName(account));
  const commandArgs = encodeURIComponent(JSON.stringify([{
    accountId: String(account.id),
    accountName: accountDisplayName(account)
  }]));
  md.appendMarkdown(`<table>\n<tbody>\n<tr>`);
  md.appendMarkdown(
    `<td colspan="3"><h3>${codiconHtml(providerIcon(account))} ` +
    `<a href="command:${ACCOUNT_STATS_COMMAND}?${commandArgs}">${name}</a></h3></td>` +
    `<td align="right"><h3><small>${codiconHtml('sync')} ` +
    `${escapeHtml(formatMonthDayTime(usage?.updated_at))}</small></h3></td>`
  );
  md.appendMarkdown(`</tr>\n`);
  appendQuotaRows(md, '5小时', usage?.five_hour);
  appendQuotaRows(md, '7天', usage?.seven_day);
  md.appendMarkdown(`</tbody>\n</table>`);
}

function appendQuotaRows(md, label, window) {
  const stats = window && typeof window.window_stats === 'object' ? window.window_stats : {};
  const pct = clampPct(window?.utilization);
  const countdown = escapeHtml(formatCountdown(window?.resets_at));
  md.appendMarkdown(
    `<tr>` +
    `<td colspan="2"><strong>${escapeHtml(label)}</strong>` +
    (countdown ? ` <small>${countdown}</small>` : '') +
    `</td>` +
    `<td align="center">${formatInteger(stats.requests)} req &nbsp; ${formatCompactTokenValue(stats.tokens)} tok</td>` +
    `<td align="right"><small>${codiconHtml('clock')} ` +
    `${escapeHtml(formatMonthDayTime(window?.resets_at))}</small></td>` +
    `</tr>\n`
  );
  md.appendMarkdown(
    `<tr>` +
    `<td colspan="4"><code>${progressBar(pct)}</code>&nbsp;&nbsp;<strong>${formatPct(pct)}</strong></td>` +
    `</tr>\n`
  );
}

function formatCountdown(resetsAt) {
  const target = parseApiTimestamp(resetsAt);
  if (!target) return '';
  const seconds = Math.max(0, Math.floor((target - Date.now()) / 1000));
  if (seconds <= 0) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${minutes}分`;
  return `${minutes}分`;
}

function parseApiTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, '$1');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function codiconHtml(icon) {
  return `<span class="codicon codicon-${icon}"></span>`;
}

function providerIcon(account) {
  const raw = typeof account?.platform === 'string' ? account.platform : '';
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return PROVIDER_ICONS[key] || 'sparkle';
}

function renderNoActiveAccounts(total) {
  stopAccountRotation();
  controlStatusBarItem.text = '$(circle-slash) Sub2API 无非停用账户';
  controlStatusBarItem.backgroundColor = undefined;
  controlStatusBarItem.tooltip = total > 0
    ? `共扫描 ${total} 个账户，但全部处于停用（inactive）状态。\n\n点击重新扫描。`
    : '没有找到账户。\n\n点击重新扫描。';
  controlStatusBarItem.show();
}

function renderNoQueryableAccounts(total, failed) {
  stopAccountRotation();
  if (failed && failed.length > 0) {
    controlStatusBarItem.text = '$(warning) Sub2API 用量查询失败';
    controlStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.appendMarkdown(`### 用量查询失败\n\n`);
    for (const result of failed.slice(0, 10)) {
      md.appendMarkdown(`- ${escapeMarkdown(accountDisplayName(result.account))}：${escapeMarkdown(errorMessage(result.error))}\n`);
    }
    if (failed.length > 10) md.appendMarkdown(`- 其余 ${failed.length - 10} 个错误请查看日志\n`);
    controlStatusBarItem.tooltip = md;
  } else {
    controlStatusBarItem.text = '$(circle-slash) Sub2API 无可查询用量账户';
    controlStatusBarItem.backgroundColor = undefined;
    controlStatusBarItem.tooltip = `${total} 个非停用账户均不支持用量查询。\n\n点击重新扫描。`;
  }
  controlStatusBarItem.show();
}

function renderError(message) {
  stopAccountRotation();
  controlStatusBarItem.text = '$(warning) Sub2API !';
  controlStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  controlStatusBarItem.tooltip = `Sub2API 账户用量刷新失败：${message}\n\n点击重试；命令面板可运行“Sub2API 账户用量: 查看日志”。`;
  controlStatusBarItem.show();
}

function showNeedsServer() {
  stopAccountRotation();
  controlStatusBarItem.text = '$(server) 配置 Sub2API';
  controlStatusBarItem.backgroundColor = undefined;
  controlStatusBarItem.tooltip = '尚未配置 Sub2API Server URL。\n\n点击后填写你的 Sub2API 服务地址。';
  controlStatusBarItem.show();
}

function showNeedsAuth(reason) {
  stopAccountRotation();
  controlStatusBarItem.text = '$(key) Sub2API 鉴权';
  controlStatusBarItem.backgroundColor = undefined;
  controlStatusBarItem.tooltip = `Sub2API 账户用量：${reason || '需要管理员鉴权'}。\n\n可使用 Admin API Key 或管理员邮箱 + 密码。`;
  controlStatusBarItem.show();
}

function setRefreshingStatus() {
  stopAccountRotation();
  controlStatusBarItem.text = '$(sync~spin) Sub2API 刷新中…';
  controlStatusBarItem.backgroundColor = undefined;
  controlStatusBarItem.tooltip = '正在扫描全部账户并刷新最新用量…';
  controlStatusBarItem.show();
}

function setLoading(text) {
  controlStatusBarItem.text = `$(sync~spin) Sub2API ${text}`;
  controlStatusBarItem.backgroundColor = undefined;
  controlStatusBarItem.show();
}

function accountDisplayName(account) {
  const name = typeof account?.name === 'string' ? account.name.trim() : '';
  return name || '未命名账户';
}

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function formatPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : '?';
}

function progressBar(percent) {
  const n = clampPct(percent);
  const segments = 40;
  const filled = Math.max(n > 0 ? 1 : 0, Math.round((n / 100) * segments));
  return `${'█'.repeat(filled)}${'·'.repeat(Math.max(0, segments - filled))}`;
}

function formatCompactTokenValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.0+$/, '')}M`;
  }
  if (Math.abs(n) >= 1_000) {
    return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  }
  return formatInteger(n);
}

function formatInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(n) : '-';
}

function formatMonthDayTime(value) {
  return formatApiTimestamp(value);
}

function formatApiTimestamp(value) {
  const date = parseApiTimestamp(value);
  if (!date) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIMEZONE,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const time = `${part('hour')}:${part('minute')}`;
  return `${part('month')}-${part('day')} ${time}`;
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+\-.!|>]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function redactEmail(email) {
  const text = String(email || '');
  const at = text.indexOf('@');
  if (at <= 1) return '<redacted-email>';
  return `${text.slice(0, 1)}***${text.slice(at)}`;
}

function redactQuery(search) {
  return search || '';
}

function errorMessage(error) {
  if (!error) return '未知错误';
  if (error.code === 'CERT_HAS_EXPIRED' || error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `${error.message}（如确为可信的自签名证书，可开启 sub2apiAccountUsage.allowInsecureTls）`;
  }
  return error instanceof Error ? error.message : String(error);
}

function log(message) {
  if (!output) return;
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

module.exports = { activate, deactivate };
