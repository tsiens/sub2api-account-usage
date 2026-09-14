'use strict';

const http = require('http');
const https = require('https');

const DISPLAY_TIMEZONE = 'Asia/Shanghai';
const ACCOUNT_PAGE_SIZE = 100;
const DEFAULT_UPDATE_URL = 'https://github.com/tsiens/sub2api-account-usage';

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

class UsageService {
  constructor({ store, logger = () => {} }) {
    this.store = store;
    this.logger = logger;
    this.refreshTokenInFlight = undefined;
  }

  getConfig() {
    const saved = this.store.getConfig();
    let updateUrl = DEFAULT_UPDATE_URL;
    try { updateUrl = normalizeUpdateUrl(saved.updateUrl); } catch { /* Use the built-in update source. */ }
    return {
      baseUrl: String(saved.baseUrl || '').trim().replace(/\/+$/, ''),
      updateInterval: Math.max(30, Number(saved.updateInterval) || 300),
      rotationInterval: Math.max(1, Number(saved.rotationInterval) || 5),
      requestTimeout: Math.max(1000, Number(saved.requestTimeout) || 15000),
      allowInsecureTls: Boolean(saved.allowInsecureTls),
      showFloatingBar: saved.showFloatingBar !== false,
      floatAlwaysOnTop: saved.floatAlwaysOnTop !== false,
      updateUrl
    };
  }

  async getAuthMode() {
    if (await this.store.getSecret('adminApiKey')) return 'api-key';
    if (await this.store.getSecret('accessToken')) return 'bearer';
    return 'none';
  }

  async hasAuthentication() {
    return (await this.getAuthMode()) !== 'none';
  }

  async setConfig(values) {
    const current = this.getConfig();
    const next = { ...current, ...values };
    if (next.baseUrl) {
      const parsed = new URL(String(next.baseUrl).trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('服务器地址只支持 http 或 https。');
      }
      if (parsed.pathname && parsed.pathname !== '/') {
        throw new Error('服务器地址只能填写根地址，不要带 /api/v1 或其他路径。');
      }
      next.baseUrl = parsed.toString().replace(/\/+$/, '');
    } else {
      next.baseUrl = '';
    }
    next.updateInterval = Math.max(30, Math.floor(Number(next.updateInterval) || 300));
    next.rotationInterval = Math.max(1, Math.floor(Number(next.rotationInterval) || 5));
    next.requestTimeout = Math.max(1000, Math.floor(Number(next.requestTimeout) || 15000));
    next.allowInsecureTls = Boolean(next.allowInsecureTls);
    next.showFloatingBar = next.showFloatingBar !== false;
    next.floatAlwaysOnTop = next.floatAlwaysOnTop !== false;
    next.updateUrl = normalizeUpdateUrl(next.updateUrl);
    this.store.setConfig(next);
    return this.getConfig();
  }

  async login(email, password) {
    if (!this.getConfig().baseUrl) throw new Error('请先配置 Sub2API 服务器地址。');
    if (!email || !password) throw new Error('邮箱和密码不能为空。');
    let auth = await this.apiRequest('/api/v1/auth/login', {
      method: 'POST', body: { email, password }, auth: false
    });
    if (auth && auth.requires_2fa === true) {
      if (!auth.temp_token) throw new Error('服务器要求 2FA，但没有返回临时令牌。');
      return { requires2fa: true, tempToken: auth.temp_token, email };
    }
    await this.saveJwtAuth(auth, email);
    return { requires2fa: false };
  }

  async completeLogin(tempToken, totpCode, email) {
    if (!/^\d{6}$/.test(String(totpCode || '').trim())) {
      throw new Error('请输入 6 位数字验证码。');
    }
    const auth = await this.apiRequest('/api/v1/auth/login/2fa', {
      method: 'POST',
      body: { temp_token: tempToken, totp_code: String(totpCode).trim() },
      auth: false
    });
    await this.saveJwtAuth(auth, email);
    return { requires2fa: false };
  }

  async setAdminApiKey(apiKey) {
    const value = String(apiKey || '').trim();
    if (value.length < 8) throw new Error('API Key 看起来过短。');
    await this.store.setSecret('adminApiKey', value);
    await this.store.deleteSecret('accessToken');
    await this.store.deleteSecret('refreshToken');
    await this.store.deleteSecret('email');
    try {
      await this.listAccounts();
    } catch (error) {
      await this.store.deleteSecret('adminApiKey');
      throw error;
    }
  }

  async logout() {
    const refreshToken = await this.store.getSecret('refreshToken');
    if (refreshToken && !(await this.store.getSecret('adminApiKey'))) {
      try {
        await this.apiRequest('/api/v1/auth/logout', {
          method: 'POST', body: { refresh_token: refreshToken }, auth: false
        });
      } catch (error) {
        this.logger(`Remote logout failed; clearing local secrets anyway: ${errorMessage(error)}`);
      }
    }
    await Promise.all(['adminApiKey', 'accessToken', 'refreshToken', 'email']
      .map((key) => this.store.deleteSecret(key)));
  }

  async refreshUsage() {
    const config = this.getConfig();
    if (!config.baseUrl) return { status: 'needs-server', accounts: [], message: '请先配置 Sub2API 服务器地址。' };
    if (!(await this.hasAuthentication())) {
      return { status: 'needs-auth', accounts: [], message: '请配置 Admin API Key 或管理员登录。' };
    }

    const allAccounts = await this.listAccounts();
    const active = allAccounts.filter(isNotInactive);
    if (active.length === 0) {
      return { status: 'empty', accounts: [], totalAccounts: allAccounts.length, message: allAccounts.length ? '所有账户都处于停用状态。' : '没有找到账户。' };
    }
    const queryable = active.filter(accountSupportsBatchUsage);
    if (queryable.length === 0) {
      return { status: 'empty', accounts: [], totalAccounts: active.length, message: '没有可查询用量的账户。' };
    }
    const batch = await this.getBatchAccountUsage(queryable.map((account) => account.id));
    const results = mapBatchUsageResults(queryable, batch);
    const failed = results.filter((item) => item.error).map((item) => ({
      accountName: accountDisplayName(item.account), error: errorMessage(item.error)
    }));
    return {
      status: results.some((item) => item.usage) ? 'ready' : 'error',
      accounts: results.filter((item) => item.usage).map((item) => ({
        account: item.account, usage: item.usage
      })),
      failed,
      totalAccounts: allAccounts.length,
      refreshedAt: new Date().toISOString(),
      message: failed.length ? `${failed.length} 个账户刷新失败。` : ''
    };
  }

  async getAccountStats(accountId, days = 30) {
    const query = new URLSearchParams({ days: String(days), timezone: DISPLAY_TIMEZONE });
    const raw = await this.apiRequestWithAuthRetry(
      `/api/v1/admin/accounts/${encodeURIComponent(String(accountId))}/stats?${query.toString()}`
    );
    return normalizeAccountStats(raw, days);
  }

  async listAccounts() {
    const accounts = [];
    let page = 1;
    let pages = 1;
    do {
      const query = new URLSearchParams({
        page: String(page), page_size: String(ACCOUNT_PAGE_SIZE),
        include_scheduler_score: '0', sort_by: 'name', sort_order: 'asc', timezone: DISPLAY_TIMEZONE
      });
      const data = await this.apiRequestWithAuthRetry(`/api/v1/admin/accounts?${query.toString()}`);
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      for (const account of items) {
        if (account && account.id !== undefined && account.id !== null && String(account.id).trim()) accounts.push(account);
      }
      pages = Math.max(1, Number(data?.pages) || 1);
      page += 1;
    } while (page <= pages && page <= 1000);
    return accounts;
  }

  async getBatchAccountUsage(accountIds) {
    return this.apiRequestWithAuthRetry('/api/v1/admin/accounts/usage/batch', {
      method: 'POST',
      body: {
        account_ids: accountIds,
        force: true
      }
    });
  }

  async getStoredEmail() {
    return (await this.store.getSecret('email')) || '';
  }

  async apiRequestWithAuthRetry(path, options = {}) {
    try {
      return await this.apiRequest(path, { ...options, auth: true });
    } catch (error) {
      if (!isUnauthorized(error) || (await this.getAuthMode()) !== 'bearer') throw error;
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        const authError = new Error('管理员登录已过期，请重新登录。');
        authError.status = 401;
        throw authError;
      }
      return this.apiRequest(path, { ...options, auth: true });
    }
  }

  async refreshAccessToken() {
    if (this.refreshTokenInFlight) return this.refreshTokenInFlight;
    this.refreshTokenInFlight = (async () => {
      const refreshToken = await this.store.getSecret('refreshToken');
      if (!refreshToken) return false;
      try {
        const auth = await this.apiRequest('/api/v1/auth/refresh', {
          method: 'POST', body: { refresh_token: refreshToken }, auth: false
        });
        await this.saveJwtAuth(auth, await this.store.getSecret('email'));
        return true;
      } catch (error) {
        this.logger(`Token refresh failed: ${errorMessage(error)}`);
        await this.store.deleteSecret('accessToken');
        await this.store.deleteSecret('refreshToken');
        return false;
      } finally {
        this.refreshTokenInFlight = undefined;
      }
    })();
    return this.refreshTokenInFlight;
  }

  async saveJwtAuth(auth, email) {
    if (!auth || typeof auth.access_token !== 'string' || !auth.access_token) {
      throw new Error('登录响应中缺少 access_token。');
    }
    await this.store.setSecret('accessToken', auth.access_token);
    if (auth.refresh_token) await this.store.setSecret('refreshToken', auth.refresh_token);
    if (email) await this.store.setSecret('email', String(email));
    await this.store.deleteSecret('adminApiKey');
  }

  async apiRequest(path, options = {}) {
    const config = this.getConfig();
    if (!config.baseUrl) throw new Error('尚未配置 Sub2API Server URL。');
    const url = new URL(path, `${config.baseUrl}/`);
    const headers = {
      Accept: 'application/json', 'Accept-Language': 'zh-CN',
      'User-Agent': 'sub2api-account-usage-electron/1.0.0'
    };
    let bodyBuffer;
    if (options.body !== undefined) {
      bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(bodyBuffer.length);
    }
    if (options.auth !== false) {
      const apiKey = await this.store.getSecret('adminApiKey');
      const accessToken = await this.store.getSecret('accessToken');
      if (apiKey) headers['x-api-key'] = apiKey;
      else if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      else {
        const error = new Error('尚未配置管理员鉴权');
        error.status = 401;
        throw error;
      }
      headers['X-Admin-UI-Request'] = '1';
    }
    this.logger(`${options.method || 'GET'} ${url.origin}${url.pathname} [${options.auth === false ? 'no-auth' : 'auth'}]`);
    const raw = await requestJson(url, {
      method: options.method || 'GET', headers, bodyBuffer,
      timeout: config.requestTimeout, allowInsecureTls: config.allowInsecureTls
    });
    return unwrapApiResponse(raw);
  }
}

function requestJson(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'http:' ? http : https;
    const requestOptions = {
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: options.method,
      headers: options.headers, timeout: options.timeout
    };
    if (url.protocol === 'https:' && options.allowInsecureTls) requestOptions.rejectUnauthorized = false;
    const req = client.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (text) {
          try { data = JSON.parse(text); } catch {
            const error = new Error(`HTTP ${res.statusCode}: 服务器返回的不是 JSON`);
            error.status = res.statusCode;
            reject(error);
            return;
          }
        }
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          const error = new Error(extractServerMessage(data) || `HTTP ${res.statusCode}`);
          error.status = res.statusCode;
          error.data = data;
          reject(error);
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
      const error = new Error(raw.message || `API error code ${raw.code}`);
      error.code = raw.code;
      error.data = raw;
      throw error;
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

function isNotInactive(account) {
  return String(account?.status || '').trim().toLowerCase() !== 'inactive';
}

function accountSupportsBatchUsage(account) {
  const platform = String(account?.platform || '').trim().toLowerCase();
  const type = String(account?.type || '').trim().toLowerCase();
  if (platform === 'anthropic') return type === 'oauth' || type === 'setup-token';
  if (platform === 'gemini') return true;
  if (platform === 'antigravity') return type === 'oauth';
  if (platform === 'openai') return type === 'oauth';
  if (platform === 'grok') return type === 'oauth';
  return false;
}

function accountDisplayName(account) {
  return String(account?.name || '').trim() || '未命名账户';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
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
    points.push({ label: `${date.slice(5, 7)}/${date.slice(8, 10)}`, date, requests: values.requests, tokens: values.tokens });
  }
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
    timeZone: DISPLAY_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function normalizeUpdateUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_UPDATE_URL;
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('更新地址只支持 http 或 https。');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('更新地址不能包含账号、密码、查询参数或片段。');
  }
  return parsed.toString().replace(/\/+$/, '');
}

module.exports = {
  UsageService,
  DEFAULT_UPDATE_URL,
  accountDisplayName,
  clampPct: (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  },
  formatCountdown,
  formatApiTimestamp,
  formatCompactTokenValue,
  formatInteger,
  providerIcon: (account) => {
    const key = String(account?.platform || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    return PROVIDER_ICONS[key] || 'sparkle';
  },
  quotaPressure: (usage) => Math.max(
    Math.min(100, Math.max(0, Number(usage?.five_hour?.utilization) || 0)),
    Math.min(100, Math.max(0, Number(usage?.seven_day?.utilization) || 0))
  )
};

function formatCountdown(value) {
  const target = parseApiTimestamp(value);
  if (!target) return '';
  const seconds = Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000));
  if (!seconds) return '';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (days > 0) return `${days}天${hours}时`;
  if (hours > 0) return `${hours}时${minutes}分`;
  if (minutes > 0) return `${minutes}分${remainingSeconds}秒`;
  return `${remainingSeconds}秒`;
}

function parseApiTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, '$1');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatApiTimestamp(value) {
  const date = parseApiTimestamp(value);
  if (!date) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIMEZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

function formatCompactTokenValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2).replace(/\.0+$/, '')}M`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return formatInteger(number);
}

function formatInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('zh-CN').format(number) : '-';
}
