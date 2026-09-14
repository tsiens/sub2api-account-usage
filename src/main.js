'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { CancellationToken, CancellationError } = require('builder-util-runtime');
const { UsageService, DEFAULT_UPDATE_URL, accountDisplayName, formatCountdown, quotaPressure } = require('./core/usage-service');

const APP_ID = 'com.tsiens.sub2api-account-usage';
const PANEL_SIZE = { width: 440, height: 650 };
const UPDATE_WINDOW_SIZE = { width: 410, height: 260 };
const FLOAT_BAR_SIZE = { width: 90, height: 30 };
const FLOAT_BAR_LIMITS = { minWidth: 90, maxWidth: 420, edgeSnap: 14 };
const DEFAULT_CONFIG = { baseUrl: '', updateUrl: DEFAULT_UPDATE_URL, updateInterval: 300, rotationInterval: 5, requestTimeout: 15000, allowInsecureTls: false, showFloatingBar: true, floatAlwaysOnTop: true };
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

function normalizeFloatPosition(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

let tray;
let panel;
let updateWindow;
let floatBar;
let settingsWindow;
let service;
let appStore;
let trayDefaultIcon;
let refreshTimer;
let rotationTimer;
let floatPositionSaveTimer;
let floatTopTimer;
let fullscreenWatcher;
let fullscreenSuppressed = false;
let updateCheckTimer;
let updateDownloadInFlight = false;
let updateCheckInFlight = false;
let manualUpdateCheckPending = false;
let updateCancellationToken;
let updateDownloadPromise;
let updateCancellationRequested = false;
let updateCancelInFlight = false;
let quittingForUpdate = false;
let configuredUpdateUrl = '';
let autoUpdaterInitialized = false;
let updateUiState = { status: 'idle', version: '', percent: 0, transferred: 0, total: 0, speed: 0, message: '' };
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
    hasShadow: false,
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
  if (enabled) {
    floatBar.setAlwaysOnTop(true, 'screen-saver');
    floatBar.moveTop();
  }
  else floatBar.setAlwaysOnTop(false);
}

function restartFloatBarTopTimer(enabled) {
  clearInterval(floatTopTimer);
  floatTopTimer = undefined;
  if (!enabled) return;
  floatTopTimer = setInterval(() => {
    if (!floatBar || floatBar.isDestroyed() || fullscreenSuppressed || !floatBar.isVisible()) return;
    if (service?.getConfig().floatAlwaysOnTop === false) return;
    floatBar.setAlwaysOnTop(true, 'screen-saver');
    floatBar.moveTop();
  }, 500);
}

function getTaskbarArea(display) {
  const bounds = display.bounds;
  const workArea = display.workArea;
  const top = workArea.y - bounds.y;
  const bottom = bounds.y + bounds.height - (workArea.y + workArea.height);
  const left = workArea.x - bounds.x;
  const right = bounds.x + bounds.width - (workArea.x + workArea.width);
  if (top > 0) return { edge: 'top', x: bounds.x, y: bounds.y, width: bounds.width, height: top };
  if (bottom > 0) return { edge: 'bottom', x: bounds.x, y: workArea.y + workArea.height, width: bounds.width, height: bottom };
  if (left > 0) return { edge: 'left', x: bounds.x, y: bounds.y, width: left, height: bounds.height };
  if (right > 0) return { edge: 'right', x: workArea.x + workArea.width, y: bounds.y, width: right, height: bounds.height };
  return null;
}

function clampFloatBounds(x, y, width, height) {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2)
  });
  // Allow the bar to enter the taskbar area; the taskbar snap below centers it there.
  const area = display.bounds;
  const maxX = Math.max(area.x, area.x + area.width - width);
  const maxY = Math.max(area.y, area.y + area.height - height);
  let nextX = Math.max(area.x, Math.min(Math.round(x), maxX));
  let nextY = Math.max(area.y, Math.min(Math.round(y), maxY));
  if (Math.abs(nextX - area.x) <= FLOAT_BAR_LIMITS.edgeSnap) nextX = area.x;
  if (Math.abs(nextX - maxX) <= FLOAT_BAR_LIMITS.edgeSnap) nextX = maxX;
  if (Math.abs(nextY - area.y) <= FLOAT_BAR_LIMITS.edgeSnap) nextY = area.y;
  if (Math.abs(nextY - maxY) <= FLOAT_BAR_LIMITS.edgeSnap) nextY = maxY;

  const taskbar = getTaskbarArea(display);
  const overlapsTaskbar = taskbar && nextX < taskbar.x + taskbar.width && nextX + width > taskbar.x &&
    nextY < taskbar.y + taskbar.height && nextY + height > taskbar.y;
  if (overlapsTaskbar) {
    if (taskbar.edge === 'top' || taskbar.edge === 'bottom') {
      nextY = Math.round(taskbar.y + (taskbar.height - height) / 2);
    } else {
      nextX = Math.round(taskbar.x + (taskbar.width - width) / 2);
    }
  }
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
  if (service?.getConfig().floatAlwaysOnTop !== false) floatBar.moveTop();
  scheduleFloatPositionSave(position.x, position.y);
}

function syncFloatingBar(enabled, alwaysOnTop = service?.getConfig().floatAlwaysOnTop !== false) {
  restartFloatBarTopTimer(enabled && !fullscreenSuppressed && alwaysOnTop);
  if (enabled && !fullscreenSuppressed) {
    createFloatBar();
    setFloatingBarAlwaysOnTop(alwaysOnTop);
    positionFloatBar();
    floatBar.showInactive();
    setFloatingBarAlwaysOnTop(alwaysOnTop);
    floatBar.webContents.send('state', getPublicState());
  } else if (floatBar) {
    floatBar.hide();
  }
}

function applyFullscreenSuppression(isFullscreen) {
  if (fullscreenSuppressed === isFullscreen) return;
  fullscreenSuppressed = isFullscreen;
  if (isFullscreen) {
    floatBar?.hide();
    return;
  }
  if (service) {
    const config = service.getConfig();
    syncFloatingBar(config.showFloatingBar, config.floatAlwaysOnTop);
  }
}

function startFullscreenWatcher() {
  if (process.platform !== 'win32' || fullscreenWatcher) return;

  const script = String.raw`
$signature = @'
using System;
using System.Runtime.InteropServices;

public static class Sub2ApiWindowApi {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int CbSize;
        public RECT RcMonitor;
        public RECT RcWork;
        public uint DwFlags;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO monitorInfo);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction Stop

while ($true) {
    $window = [Sub2ApiWindowApi]::GetForegroundWindow()
    $isFullscreen = $false
    if ($window -ne [IntPtr]::Zero) {
        $className = New-Object System.Text.StringBuilder 256
        [Sub2ApiWindowApi]::GetClassName($window, $className, $className.Capacity) | Out-Null
        $isShellWindow = $className.ToString() -in @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')
        if (-not $isShellWindow) {
            $windowRect = New-Object Sub2ApiWindowApi+RECT
            $monitor = [Sub2ApiWindowApi]::MonitorFromWindow($window, 2)
            $monitorInfo = New-Object Sub2ApiWindowApi+MONITORINFO
            $monitorInfo.CbSize = [Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
            if ($monitor -ne [IntPtr]::Zero -and [Sub2ApiWindowApi]::GetWindowRect($window, [ref]$windowRect) -and [Sub2ApiWindowApi]::GetMonitorInfo($monitor, [ref]$monitorInfo)) {
                $monitorRect = $monitorInfo.RcMonitor
                $isFullscreen = $windowRect.Left -eq $monitorRect.Left -and
                    $windowRect.Top -eq $monitorRect.Top -and
                    $windowRect.Right -eq $monitorRect.Right -and
                    $windowRect.Bottom -eq $monitorRect.Bottom
            }
        }
    }
    if ($isFullscreen) { [Console]::WriteLine('1') } else { [Console]::WriteLine('0') }
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 600
}
`;

  fullscreenWatcher = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

  let buffer = '';
  fullscreenWatcher.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line === '1') applyFullscreenSuppression(true);
      if (line === '0') applyFullscreenSuppression(false);
    }
  });
  fullscreenWatcher.on('error', () => { fullscreenWatcher = undefined; });
  fullscreenWatcher.on('exit', () => { fullscreenWatcher = undefined; });
}

function stopFullscreenWatcher() {
  if (!fullscreenWatcher) return;
  fullscreenWatcher.kill();
  fullscreenWatcher = undefined;
}

function updateFeedFromUrl(value) {
  const raw = String(value || DEFAULT_UPDATE_URL).trim();
  const proxy = raw.match(/^(https?:\/\/[^/]+\/)https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (proxy) {
    const repository = `https://github.com/${proxy[2]}/${proxy[3].replace(/\.git$/i, '')}`;
    return { provider: 'generic', url: `${proxy[1]}${repository}/releases/latest/download/` };
  }
  const parsed = new URL(raw);
  const github = parsed.hostname.toLowerCase() === 'github.com'
    ? parsed.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
    : null;
  if (github) return { provider: 'github', owner: github[1], repo: github[2], private: false };
  return { provider: 'generic', url: `${parsed.toString().replace(/\/+$/, '')}/` };
}

function getUpdateCacheDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(localAppData, 'sub2api-account-usage-updater');
}

function sendUpdateState() {
  if (!updateWindow || updateWindow.isDestroyed() || updateWindow.webContents.isLoading()) return;
  updateWindow.webContents.send('update-state', updateUiState);
}

function setUpdateUiState(next) {
  updateUiState = { ...updateUiState, ...next };
  sendUpdateState();
}

function createUpdateWindow() {
  if (updateWindow) return;
  updateWindow = new BrowserWindow({
    width: UPDATE_WINDOW_SIZE.width,
    height: UPDATE_WINDOW_SIZE.height,
    minWidth: UPDATE_WINDOW_SIZE.width,
    minHeight: UPDATE_WINDOW_SIZE.height,
    maxWidth: UPDATE_WINDOW_SIZE.width,
    maxHeight: UPDATE_WINDOW_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  updateWindow.loadFile(path.join(__dirname, 'renderer', 'update.html'));
  updateWindow.webContents.on('did-finish-load', sendUpdateState);
  updateWindow.on('close', (event) => {
    if (!updateDownloadInFlight || updateCancellationRequested) return;
    event.preventDefault();
    void cancelUpdate(true);
  });
  updateWindow.on('closed', () => { updateWindow = undefined; });
}

function showUpdateWindow(next = {}) {
  if (!updateWindow) createUpdateWindow();
  setUpdateUiState(next);
  if (updateWindow.isMinimized()) updateWindow.restore();
  updateWindow.show();
  updateWindow.focus();
  sendUpdateState();
}

async function clearUpdateCache() {
  try {
    await fs.promises.rm(getUpdateCacheDirectory(), { recursive: true, force: true });
    appendLog('更新缓存已清空。');
  } catch (error) {
    appendLog(`清空更新缓存失败：${error.message || error}`);
  }
}

function handleUpdateError(error) {
  if (updateCancellationRequested || error instanceof CancellationError || error?.message === 'cancelled') return;
  quittingForUpdate = false;
  updateCheckInFlight = false;
  updateDownloadInFlight = false;
  manualUpdateCheckPending = false;
  setUpdateUiState({ status: 'error', message: error.message || String(error), percent: 0 });
  appendLog(`自动更新错误：${error.message || error}`);
}

async function cancelUpdate(closeAfter = false) {
  if (updateCancelInFlight) return;
  if (!updateDownloadInFlight && !updateCheckInFlight) {
    await clearUpdateCache();
    setUpdateUiState({ status: 'cancelled', message: '已取消，更新缓存已清空。', percent: 0, transferred: 0, total: 0, speed: 0 });
    if (closeAfter) updateWindow?.hide();
    return;
  }
  updateCancelInFlight = true;
  updateCancellationRequested = true;
  updateCancellationToken?.cancel();
  setUpdateUiState({ status: 'cancelling', message: '正在取消并清空更新缓存…' });
  try {
    await updateDownloadPromise;
  } catch { /* Cancellation is expected here. */ }
  updateCheckInFlight = false;
  updateDownloadInFlight = false;
  updateCancellationToken = undefined;
  updateDownloadPromise = undefined;
  await clearUpdateCache();
  updateCancellationRequested = false;
  manualUpdateCheckPending = false;
  updateCancelInFlight = false;
  setUpdateUiState({ status: 'cancelled', message: '已取消，更新缓存已清空。', percent: 0, transferred: 0, total: 0, speed: 0 });
  if (closeAfter) updateWindow?.hide();
}

function closeUpdateWindow() {
  if (updateDownloadInFlight) {
    void cancelUpdate(true);
    return;
  }
  updateWindow?.hide();
}

function installDownloadedUpdate() {
  if (updateUiState.status !== 'downloaded') return false;
  quittingForUpdate = true;
  autoUpdater.quitAndInstall();
  return true;
}

function checkForUpdates(manual = false) {
  if (manual && (updateDownloadInFlight || updateCheckInFlight)) {
    manualUpdateCheckPending = true;
    showUpdateWindow(updateUiState);
    return;
  }
  if (manual) {
    showUpdateWindow({ status: 'checking', version: '', percent: 0, transferred: 0, total: 0, speed: 0, message: '正在检查更新…' });
  }
  if (!app.isPackaged) {
    if (manual) setUpdateUiState({ status: 'error', message: '开发模式不检查更新。' });
    return;
  }
  if (!configuredUpdateUrl) {
    if (manual) setUpdateUiState({ status: 'error', message: '更新地址未配置。' });
    return;
  }
  updateCheckInFlight = true;
  manualUpdateCheckPending = manual;
  void autoUpdater.checkForUpdates().catch((error) => {
    handleUpdateError(error);
    appendLog(`更新检查失败：${error.message || error}`);
  });
}

function configureAutoUpdater(updateUrl) {
  if (!app.isPackaged) return;
  const nextUrl = String(updateUrl || DEFAULT_UPDATE_URL).trim();
  if (nextUrl === configuredUpdateUrl) return;
  try {
    autoUpdater.setFeedURL(updateFeedFromUrl(nextUrl));
    configuredUpdateUrl = nextUrl;
    checkForUpdates();
  } catch (error) {
    appendLog(`更新地址无效：${error.message || error}`);
  }
}

function setupAutoUpdater(updateUrl) {
  if (!app.isPackaged) return;
  if (!autoUpdaterInitialized) {
    autoUpdaterInitialized = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = {
      info: (...args) => appendLog(`[更新] ${args.join(' ')}`),
      warn: (...args) => appendLog(`[更新] ${args.join(' ')}`),
      error: (...args) => appendLog(`[更新] ${args.join(' ')}`)
    };
    autoUpdater.on('update-available', (info) => {
      updateCheckInFlight = false;
      if (updateDownloadInFlight) return;
      updateDownloadInFlight = true;
      updateCancellationRequested = false;
      updateCancellationToken = new CancellationToken();
      setUpdateUiState({ status: 'downloading', version: info?.version || '新版本', percent: 0, transferred: 0, total: 0, speed: 0, message: '正在下载更新…' });
      appendLog(`发现新版本 ${info?.version || '未知'}，开始自动下载。`);
      updateDownloadPromise = autoUpdater.downloadUpdate(updateCancellationToken).catch((error) => {
        handleUpdateError(error);
        appendLog(`更新下载失败：${error.message || error}`);
      }).finally(() => {
        updateDownloadPromise = undefined;
        updateCancellationToken = undefined;
      });
    });
    autoUpdater.on('download-progress', (progress) => {
      if (!updateDownloadInFlight) return;
      setUpdateUiState({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
        speed: Number(progress?.bytesPerSecond) || 0,
        message: '正在下载更新…'
      });
    });
    autoUpdater.on('update-not-available', () => {
      updateCheckInFlight = false;
      manualUpdateCheckPending = false;
      setUpdateUiState({ status: 'latest', version: autoUpdater.currentVersion?.version || app.getVersion(), percent: 0, message: '当前已是最新版本。' });
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateDownloadInFlight = false;
      manualUpdateCheckPending = false;
      setUpdateUiState({ status: 'downloaded', version: info?.version || '新版本', percent: 100, transferred: 0, total: 0, speed: 0, message: '更新已下载完成。' });
      showUpdateWindow();
    });
    autoUpdater.on('error', (error) => {
      handleUpdateError(error);
    });
    updateCheckTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
  }
  configureAutoUpdater(updateUrl);
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
    { label: '检查更新', click: () => checkForUpdates(true) },
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
  ipcMain.handle('cancel-update', () => cancelUpdate());
  ipcMain.handle('install-update', () => installDownloadedUpdate());
  ipcMain.on('close-update', closeUpdateWindow);
  ipcMain.handle('refresh', () => refreshUsage(true));
  ipcMain.handle('save-config', async (_event, values) => {
    const config = await service.setConfig(values);
    setupAutoUpdater(config.updateUrl);
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
  createUpdateWindow();
  createTray();
  state.authMode = await service.getAuthMode();
  const config = service.getConfig();
  startFullscreenWatcher();
  setupAutoUpdater(config.updateUrl);
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
  app.on('window-all-closed', (event) => {
    if (!quittingForUpdate) event.preventDefault();
  });
  app.on('before-quit', () => {
    clearInterval(refreshTimer);
    clearInterval(rotationTimer);
    clearInterval(updateCheckTimer);
    clearInterval(floatTopTimer);
    updateCheckInFlight = false;
    updateCancellationToken?.cancel();
    clearTimeout(floatPositionSaveTimer);
    stopFullscreenWatcher();
    if (floatBar && !floatBar.isDestroyed()) {
      const [x, y] = floatBar.getPosition();
      appStore?.setFloatPosition({ x, y });
    }
  });
}
