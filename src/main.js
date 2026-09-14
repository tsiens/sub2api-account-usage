'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { UsageService, accountDisplayName, formatCountdown, quotaPressure } = require('./core/usage-service');

const APP_ID = 'com.tsiens.sub2api-account-usage';
const PANEL_SIZE = { width: 440, height: 650 };
const FLOAT_BAR_SIZE = { width: 90, height: 30 };
const FLOAT_BAR_LIMITS = { minWidth: 90, maxWidth: 420, edgeSnap: 14 };
const DEFAULT_CONFIG = { baseUrl: '', updateInterval: 300, rotationInterval: 5, requestTimeout: 15000, allowInsecureTls: false, showFloatingBar: true, floatAlwaysOnTop: true };

function normalizeFloatPosition(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

let tray;
let panel;
let floatBar;
let settingsWindow;
let service;
let appStore;
let trayDefaultIcon;
let refreshTimer;
let rotationTimer;
let floatPositionSaveTimer;
let state = { status: 'needs-server', accounts: [], failed: [], message: '请配置 Sub2API 服务器地址。', refreshedAt: null };
let rotationIndex = 0;

class AppStore {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json');
    this.data = { config: { ...DEFAULT_CONFIG }, secrets: {}, floatPosition: null };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.config = { ...DEFAULT_CONFIG, ...(parsed.config || {}) };
      this.data.secrets = parsed.secrets || {};
      this.data.floatPosition = normalizeFloatPosition(parsed.floatPosition);
    } catch {
      // A missing or damaged settings file falls back to defaults.
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  getConfig() { return { ...this.data.config }; }
  setConfig(config) { this.data.config = { ...config }; this.save(); }
  getFloatPosition() { return this.data.floatPosition ? { ...this.data.floatPosition } : null; }
  setFloatPosition(position) {
    this.data.floatPosition = normalizeFloatPosition(position);
    this.save();
  }

  async getSecret(key) {
    const encoded = this.data.secrets[key];
    if (!encoded) return '';
    try {
      return safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(encoded, 'base64'))
        : '';
    } catch { return ''; }
  }

  async setSecret(key, value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全凭据存储不可用。');
    this.data.secrets[key] = safeStorage.encryptString(String(value)).toString('base64');
    this.save();
  }

  async deleteSecret(key) {
    delete this.data.secrets[key];
    this.save();
  }
}

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_SIZE.width,
    height: PANEL_SIZE.height,
    minWidth: 380,
    minHeight: 500,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  panel.on('closed', () => { panel = undefined; });
  panel.on('blur', () => panel.hide());
}

function createFloatBar() {
  if (floatBar) return;
  floatBar = new BrowserWindow({
    width: FLOAT_BAR_SIZE.width,
    height: FLOAT_BAR_SIZE.height,
    resizable: false,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: service ? service.getConfig().floatAlwaysOnTop : true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  setFloatingBarAlwaysOnTop(service ? service.getConfig().floatAlwaysOnTop : true);
  floatBar.loadFile(path.join(__dirname, 'renderer', 'float.html'));
  floatBar.on('closed', () => { floatBar = undefined; });
}

function positionFloatBar() {
  if (!floatBar) return;
  const bounds = floatBar.getBounds();
  const saved = appStore?.getFloatPosition();
  if (saved) {
    const position = clampFloatBounds(saved.x, saved.y, bounds.width, bounds.height);
    floatBar.setPosition(position.x, position.y, false);
    scheduleFloatPositionSave(position.x, position.y);
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const maxX = Math.max(area.x, area.x + area.width - bounds.width);
  const maxY = Math.max(area.y, area.y + area.height - bounds.height);
  floatBar.setPosition(
    Math.round(Math.max(area.x, Math.min(area.x + (area.width - bounds.width) / 2, maxX))),
    Math.round(Math.max(area.y, Math.min(area.y + 18, maxY))),
    false
  );
}

function scheduleFloatPositionSave(x, y) {
  if (!appStore) return;
  clearTimeout(floatPositionSaveTimer);
  floatPositionSaveTimer = setTimeout(() => {
    appStore?.setFloatPosition({ x, y });
  }, 250);
}

function setFloatingBarAlwaysOnTop(enabled) {
  if (!floatBar || floatBar.isDestroyed()) return;
  if (enabled) floatBar.setAlwaysOnTop(true, 'floating');
  else floatBar.setAlwaysOnTop(false);
}

function clampFloatBounds(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  });
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - width);
  const maxY = Math.max(area.y, area.y + area.height - height);
  let nextX = Math.max(area.x, Math.min(Math.round(x), maxX));
  let nextY = Math.max(area.y, Math.min(Math.round(y), maxY));
  if (Math.abs(nextX - area.x) <= FLOAT_BAR_LIMITS.edgeSnap) nextX = area.x;
  if (Math.abs(nextX - maxX) <= FLOAT_BAR_LIMITS.edgeSnap) nextX = maxX;
  if (Math.abs(nextY - area.y) <= FLOAT_BAR_LIMITS.edgeSnap) nextY = area.y;
  if (Math.abs(nextY - maxY) <= FLOAT_BAR_LIMITS.edgeSnap) nextY = maxY;
  return { x: nextX, y: nextY };
}

function resizeFloatBar(requestedWidth) {
  if (!floatBar || floatBar.isDestroyed()) return;
  const width = Math.max(
    FLOAT_BAR_LIMITS.minWidth,
    Math.min(Math.round(Number(requestedWidth) || FLOAT_BAR_SIZE.width), FLOAT_BAR_LIMITS.maxWidth)
  );
  const bounds = floatBar.getBounds();
  const position = clampFloatBounds(
    bounds.x + (bounds.width - width) / 2,
    bounds.y,
    width,
    FLOAT_BAR_SIZE.height
  );
  floatBar.setBounds({ ...position, width, height: FLOAT_BAR_SIZE.height }, false);
  scheduleFloatPositionSave(position.x, position.y);
}

function moveFloatBar(delta = {}) {
  if (!floatBar || floatBar.isDestroyed()) return;
  const dx = Number(delta.dx);
  const dy = Number(delta.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const bounds = floatBar.getBounds();
  const position = clampFloatBounds(bounds.x + dx, bounds.y + dy, bounds.width, bounds.height);
  floatBar.setPosition(position.x, position.y, false);
  scheduleFloatPositionSave(position.x, position.y);
}

function syncFloatingBar(enabled, alwaysOnTop = service?.getConfig().floatAlwaysOnTop !== false) {
  if (enabled) {
    createFloatBar();
    setFloatingBarAlwaysOnTop(alwaysOnTop);
    positionFloatBar();
    floatBar.showInactive();
    floatBar.webContents.send('state', getPublicState());
  } else if (floatBar) {
    floatBar.hide();
  }
}

function createTray() {
  trayDefaultIcon = nativeImage.createFromPath(path.join(__dirname, '..', 'icon.png'));
  tray = new Tray(trayDefaultIcon);
  tray.setToolTip('Sub2API 账户用量');
  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const alwaysOnTop = service?.getConfig().floatAlwaysOnTop !== false;
  const menu = Menu.buildFromTemplate([
    { label: '设置', click: () => showPanel('settings') },
    {
      label: '悬浮条置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => {
        void service.setConfig({ floatAlwaysOnTop: item.checked }).then((config) => {
          syncFloatingBar(config.showFloatingBar, config.floatAlwaysOnTop);
          updateTrayMenu();
          broadcastState();
        });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function showPanel(view = 'dashboard', focus = '') {
  if (!panel) createPanel();
  positionPanel();
  panel.show();
  panel.webContents.send('navigate', { view, focus });
  panel.webContents.send('state', getPublicState());
}

function positionPanel() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const area = display.workArea;
  const bounds = panel.getBounds();
  panel.setPosition(Math.max(area.x, area.x + area.width - bounds.width - 12), Math.max(area.y, area.y + area.height - bounds.height - 12), false);
}

function togglePanel() {
  if (panel && panel.isVisible()) panel.hide();
  else showPanel('dashboard');
}

function getPublicState() {
  return {
    ...state,
    config: service ? service.getConfig() : { ...DEFAULT_CONFIG },
    authMode: state.authMode || 'none',
    currentIndex: rotationIndex
  };
}

async function refreshUsage(interactive = false) {
  if (state.isRefreshing) return getPublicState();
  state = { ...state, isRefreshing: true, message: '正在刷新账户用量…' };
  broadcastState();
  try {
    const next = await service.refreshUsage();
    state = { ...next, isRefreshing: false, authMode: await service.getAuthMode() };
    rotationIndex = 0;
    restartRotation();
    updateTrayText();
    broadcastState();
    return getPublicState();
  } catch (error) {
    state = { status: error.status === 401 ? 'needs-auth' : 'error', accounts: [], failed: [], message: error.message || String(error), isRefreshing: false, authMode: await service.getAuthMode() };
    updateTrayText();
    broadcastState();
    return getPublicState();
  }
}

function broadcastState() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('state', getPublicState());
  if (floatBar && !floatBar.isDestroyed()) floatBar.webContents.send('state', getPublicState());
}

function updateTrayText() {
  if (!tray) return;
  const accounts = state.accounts || [];
  const result = accounts.length ? accounts[rotationIndex % accounts.length] : null;
  if (!result) {
    tray.setImage(trayDefaultIcon);
    tray.setToolTip(`Sub2API 账户用量：${state.message || '暂无数据'}`);
    return;
  }
  const { account, usage } = result;
  const five = Number(usage?.five_hour?.utilization) || 0;
  const seven = Number(usage?.seven_day?.utilization) || 0;
  const countdown = five >= 100 ? formatCountdown(usage.five_hour.resets_at) : seven >= 100 ? formatCountdown(usage.seven_day.resets_at) : '';
  const suffix = countdown || `${Math.round(five)}% · ${Math.round(seven)}%`;
  tray.setImage(trayDefaultIcon);
  tray.setToolTip(`${accountDisplayName(account)}  ${suffix}`);
}

function trayColor(pressure) {
  if (pressure >= 95) return [239, 68, 68];
  if (pressure >= 80) return [234, 179, 8];
  return [34, 197, 94];
}

function createUsageTrayIcon(remaining, color) {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const [red, green, blue] = color;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      if (edge >= 3 || (edge >= 1 && x > 2 && x < size - 3 && y > 2 && y < size - 3)) {
        setRgbaPixel(pixels, size, x, y, [15, 23, 42, 255]);
      }
    }
  }
  for (let y = 2; y < 5; y += 1) {
    for (let x = 5; x < size - 5; x += 1) setRgbaPixel(pixels, size, x, y, [red, green, blue, 255]);
  }

  const glyphs = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111']
  };
  const text = String(Math.max(0, Math.min(100, Math.round(remaining))));
  const scale = text.length === 3 ? 3 : text.length === 2 ? 4 : 5;
  const gap = text.length === 1 ? 0 : scale;
  const width = text.length * 3 * scale + (text.length - 1) * gap;
  const startX = Math.floor((size - width) / 2);
  const startY = 9;
  for (let index = 0; index < text.length; index += 1) {
    const glyph = glyphs[text[index]];
    const glyphX = startX + index * (3 * scale + gap);
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const x = glyphX + gx * scale + sx;
            const y = startY + gy * scale + sy;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            setRgbaPixel(pixels, size, x, y, [248, 250, 252, 255]);
          }
        }
      }
    }
  }
  return nativeImage.createFromBuffer(encodePng(size, size, pixels));
}

function setRgbaPixel(bitmap, size, x, y, color) {
  const offset = (y * size + x) * 4;
  bitmap[offset] = color[0];
  bitmap[offset + 1] = color[1];
  bitmap[offset + 2] = color[2];
  bitmap[offset + 3] = color[3];
}

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * width * 4;
    const targetStart = y * (width * 4 + 1);
    scanlines[targetStart] = 0;
    pixels.copy(scanlines, targetStart + 1, sourceStart, sourceStart + width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(payload), 8 + data.length);
  return chunk;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function restartRotation() {
  clearInterval(rotationTimer);
  const interval = service.getConfig().rotationInterval * 1000;
  if ((state.accounts || []).length < 2) return;
  rotationTimer = setInterval(() => {
    rotationIndex = (rotationIndex + 1) % state.accounts.length;
    updateTrayText();
    broadcastState();
  }, interval);
}

function restartRefreshTimer() {
  clearInterval(refreshTimer);
  const intervalSeconds = service.getConfig().updateInterval;
  refreshTimer = setInterval(() => {
    if (powerMonitor.getSystemIdleTime() >= intervalSeconds) return;
    void refreshUsage(false);
  }, intervalSeconds * 1000);
}

function showLogs() {
  showPanel('settings', 'logs');
}

function registerIpc() {
  ipcMain.handle('get-state', () => getPublicState());
  ipcMain.handle('refresh', () => refreshUsage(true));
  ipcMain.handle('save-config', async (_event, values) => {
    const config = await service.setConfig(values);
    restartRefreshTimer();
    restartRotation();
    syncFloatingBar(config.showFloatingBar, config.floatAlwaysOnTop);
    updateTrayMenu();
    broadcastState();
    return config;
  });
  ipcMain.handle('login', async (_event, values) => {
    const result = await service.login(values.email, values.password);
    state.authMode = result.requires2fa ? 'pending-2fa' : 'bearer';
    if (!result.requires2fa) await refreshUsage(false);
    return result;
  });
  ipcMain.handle('complete-login', async (_event, values) => {
    const result = await service.completeLogin(values.tempToken, values.totpCode, values.email);
    state.authMode = 'bearer';
    await refreshUsage(false);
    return result;
  });
  ipcMain.handle('set-api-key', async (_event, apiKey) => {
    await service.setAdminApiKey(apiKey);
    state.authMode = 'api-key';
    await refreshUsage(false);
    return getPublicState();
  });
  ipcMain.handle('logout', async () => {
    await service.logout();
    state = { status: 'needs-auth', accounts: [], failed: [], message: '请配置管理员鉴权。', authMode: 'none' };
    updateTrayText();
    broadcastState();
    return getPublicState();
  });
  ipcMain.handle('get-stats', async (_event, accountId) => service.getAccountStats(accountId, 30));
  ipcMain.on('resize-float', (event, width) => {
    if (floatBar && event.sender === floatBar.webContents) resizeFloatBar(width);
  });
  ipcMain.on('move-float', (event, delta = {}) => {
    if (!floatBar || event.sender !== floatBar.webContents) return;
    moveFloatBar(delta);
  });
  ipcMain.on('open-panel', () => showPanel('dashboard'));
  ipcMain.on('close-panel', () => panel?.hide());
}

async function initialize() {
  app.setAppUserModelId(APP_ID);
  appStore = new AppStore();
  service = new UsageService({ store: appStore, logger: (message) => appendLog(message) });
  registerIpc();
  createPanel();
  createTray();
  state.authMode = await service.getAuthMode();
  const config = service.getConfig();
  syncFloatingBar(config.showFloatingBar, config.floatAlwaysOnTop);
  restartRefreshTimer();
  if (!app.isPackaged) showPanel('dashboard');
  await refreshUsage(false);
}

function appendLog(message) {
  try {
    const file = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch { /* Logging must never interrupt usage refresh. */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => showPanel('dashboard'));
  app.whenReady().then(initialize);
  app.on('window-all-closed', (event) => event.preventDefault());
  app.on('before-quit', () => {
    clearInterval(refreshTimer);
    clearInterval(rotationTimer);
    clearTimeout(floatPositionSaveTimer);
    if (floatBar && !floatBar.isDestroyed()) {
      const [x, y] = floatBar.getPosition();
      appStore?.setFloatPosition({ x, y });
    }
  });
}
