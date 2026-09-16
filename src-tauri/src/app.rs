use crate::{
    models::{CompleteLoginInput, FloatPosition, LoginInput, LoginResult, MoveDelta, PublicState},
    platform,
    service::{account_display_name, UsageService},
    store::{append_log, Store},
    updates::UpdateManager,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const FLOAT_WIDTH: f64 = 96.0;
const FLOAT_HEIGHT: f64 = 30.0;
const EDGE_SNAP: i32 = 14;

struct RuntimeState {
    store: Arc<Store>,
    service: Arc<UsageService>,
    updates: Arc<UpdateManager>,
    state: Mutex<PublicState>,
    refreshing: AtomicBool,
    rotation_index: AtomicUsize,
    fullscreen: AtomicBool,
    float_positioned: AtomicBool,
    /// Cached so a drag never has to enumerate monitors or query the window size.
    float_monitors: Mutex<Vec<MonitorGeometry>>,
    float_size: Mutex<(i32, i32)>,
    /// Last position we applied ourselves, so a drag does not have to ask Windows for it.
    float_current: Mutex<Option<FloatPosition>>,
    float_theme: Mutex<String>,
    tray_tooltip: Mutex<String>,
}

#[derive(Clone, Copy)]
struct MonitorGeometry {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    work_x: i32,
    work_y: i32,
    work_width: i32,
    work_height: i32,
}

impl MonitorGeometry {
    fn from_monitor(monitor: &tauri::Monitor) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        let work = monitor.work_area();
        Self {
            x: position.x,
            y: position.y,
            width: size.width as i32,
            height: size.height as i32,
            work_x: work.position.x,
            work_y: work.position.y,
            work_width: work.size.width as i32,
            work_height: work.size.height as i32,
        }
    }
}

impl RuntimeState {
    fn public_state(&self) -> PublicState {
        let mut state = self.state.lock().expect("public state poisoned").clone();
        state.config = self.service.config();
        state.auth_mode = self.service.auth_mode();
        state.current_index = self.rotation_index.load(Ordering::SeqCst);
        state
    }

    fn broadcast(&self, app: &AppHandle) {
        let _ = app.emit("state", self.public_state());
    }
}

#[tauri::command]
fn get_state(runtime: State<'_, Arc<RuntimeState>>) -> PublicState {
    runtime.public_state()
}

#[tauri::command]
fn get_update_state(runtime: State<'_, Arc<RuntimeState>>) -> crate::models::UpdateUiState {
    runtime.updates.state()
}

#[tauri::command]
async fn refresh(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
) -> Result<PublicState, String> {
    refresh_usage(&app, runtime.inner().clone()).await;
    Ok(runtime.public_state())
}

#[tauri::command]
async fn save_config(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
    values: Value,
) -> Result<crate::models::Config, String> {
    let previous = runtime.service.config();
    let config = runtime
        .service
        .set_config(values)
        .map_err(|error| error.to_string())?;
    if config.base_url != previous.base_url {
        let mut state = PublicState::initial(config.clone());
        state.status = "needs-auth".into();
        state.message = "服务器地址已更改，请重新配置管理员鉴权。".into();
        *runtime.state.lock().expect("public state poisoned") = state;
        runtime.rotation_index.store(0, Ordering::SeqCst);
    }
    sync_floating_bar(&app, &runtime, false);
    runtime.broadcast(&app);
    if config.update_url != previous.update_url {
        runtime
            .updates
            .start(app.clone(), config.update_url.clone(), false);
    }
    Ok(config)
}

#[tauri::command]
async fn login(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
    values: LoginInput,
) -> Result<LoginResult, String> {
    let result = runtime
        .service
        .login(&values.email, &values.password)
        .await
        .map_err(|error| error.to_string())?;
    if !result.requires_2fa {
        refresh_usage(&app, runtime.inner().clone()).await;
    } else {
        runtime.broadcast(&app);
    }
    Ok(result)
}

#[tauri::command]
async fn complete_login(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
    values: CompleteLoginInput,
) -> Result<LoginResult, String> {
    let result = runtime
        .service
        .complete_login(&values.temp_token, &values.totp_code, &values.email)
        .await
        .map_err(|error| error.to_string())?;
    refresh_usage(&app, runtime.inner().clone()).await;
    Ok(result)
}

#[tauri::command]
async fn set_api_key(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
    value: String,
) -> Result<PublicState, String> {
    runtime
        .service
        .set_admin_api_key(&value)
        .await
        .map_err(|error| error.to_string())?;
    refresh_usage(&app, runtime.inner().clone()).await;
    Ok(runtime.public_state())
}

#[tauri::command]
async fn logout(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
) -> Result<PublicState, String> {
    runtime
        .service
        .logout()
        .await
        .map_err(|error| error.to_string())?;
    *runtime.state.lock().expect("public state poisoned") = PublicState {
        status: "needs-auth".into(),
        accounts: Vec::new(),
        failed: Vec::new(),
        message: "请配置管理员鉴权。".into(),
        refreshed_at: None,
        is_refreshing: false,
        auth_mode: "none".into(),
        current_index: 0,
        total_accounts: 0,
        config: runtime.service.config(),
    };
    runtime.rotation_index.store(0, Ordering::SeqCst);
    update_tray_tooltip(&app, &runtime);
    runtime.broadcast(&app);
    Ok(runtime.public_state())
}

#[tauri::command]
async fn get_stats(
    runtime: State<'_, Arc<RuntimeState>>,
    account_id: Value,
) -> Result<crate::models::AccountStats, String> {
    runtime
        .service
        .account_stats(&value_key(&account_id), 30)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn begin_float_drag(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("float") else {
        return Ok(());
    };
    refresh_float_geometry(&window, &runtime);
    *runtime
        .float_current
        .lock()
        .expect("float current poisoned") =
        window.outer_position().ok().map(|position| FloatPosition {
            x: position.x,
            y: position.y,
        });
    Ok(())
}

#[tauri::command]
async fn move_float(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
    delta: MoveDelta,
) -> Result<(), String> {
    move_floating_bar(&app, &runtime, delta)
}

#[tauri::command]
async fn end_float_drag(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("float") else {
        return Ok(());
    };
    refresh_float_geometry(&window, &runtime);
    let Ok(current) = window.outer_position() else {
        return Ok(());
    };
    let (width, height) = *runtime.float_size.lock().expect("float size poisoned");
    let position = clamp_float_position(
        &runtime.float_monitors.lock().expect("monitors poisoned"),
        current.x,
        current.y,
        width,
        height,
    );
    let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
    *runtime
        .float_current
        .lock()
        .expect("float current poisoned") = Some(position);
    runtime.store.set_float_position(position)?;
    sample_float_theme_async(&app, &runtime).await;
    Ok(())
}

#[tauri::command]
fn open_panel(app: AppHandle) {
    show_panel(&app, "dashboard", "");
}

#[tauri::command]
fn close_panel(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
async fn cancel_update(
    app: AppHandle,
    runtime: State<'_, Arc<RuntimeState>>,
) -> Result<(), String> {
    runtime.updates.cancel(&app).await;
    Ok(())
}

#[tauri::command]
fn install_update(app: AppHandle, runtime: State<'_, Arc<RuntimeState>>) -> Result<bool, String> {
    runtime.updates.install(&app)
}

#[tauri::command]
fn close_update(app: AppHandle) {
    if let Some(window) = app.get_webview_window("update") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn get_data_directory() -> String {
    crate::store::data_directory().display().to_string()
}

#[tauri::command]
fn get_float_theme(runtime: State<'_, Arc<RuntimeState>>) -> String {
    runtime
        .float_theme
        .lock()
        .expect("float theme poisoned")
        .clone()
}

#[tauri::command]
fn open_log() -> Result<(), String> {
    let path = crate::store::data_directory().join("app.log");
    if !path.exists() {
        std::fs::write(&path, b"").map_err(|error| format!("创建日志文件失败：{error}"))?;
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = std::os::windows::ffi::OsStrExt::encode_wide(path.as_os_str())
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("无法打开日志文件。".into());
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_panel(app, "dashboard", "");
        }))
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_update_state,
            refresh,
            save_config,
            login,
            complete_login,
            set_api_key,
            logout,
            get_stats,
            move_float,
            begin_float_drag,
            end_float_drag,
            get_data_directory,
            get_float_theme,
            open_log,
            open_panel,
            close_panel,
            cancel_update,
            install_update,
            close_update
        ])
        .setup(|app| {
            let store = Arc::new(Store::load().map_err(std::io::Error::other)?);
            let service = Arc::new(UsageService::new(store.clone()));
            let initial = PublicState::initial(service.config());
            let runtime = Arc::new(RuntimeState {
                store,
                service,
                updates: UpdateManager::new(),
                state: Mutex::new(initial),
                refreshing: AtomicBool::new(false),
                rotation_index: AtomicUsize::new(0),
                fullscreen: AtomicBool::new(false),
                float_positioned: AtomicBool::new(false),
                float_monitors: Mutex::new(Vec::new()),
                float_size: Mutex::new((FLOAT_WIDTH as i32, FLOAT_HEIGHT as i32)),
                float_current: Mutex::new(None),
                float_theme: Mutex::new("dark".into()),
                tray_tooltip: Mutex::new(String::new()),
            });
            app.manage(runtime.clone());
            configure_windows(app.handle());
            create_tray(app.handle())?;
            sync_floating_bar(app.handle(), &runtime, true);
            start_timers(app.handle().clone(), runtime.clone());

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                refresh_usage(&handle, runtime.clone()).await;
                runtime
                    .updates
                    .start(handle, runtime.service.config().update_url, false);
            });
            #[cfg(debug_assertions)]
            show_panel(app.handle(), "dashboard", "");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Sub2API account usage");
}

fn configure_windows(app: &AppHandle) {
    for label in ["main", "update"] {
        if let Some(window) = app.get_webview_window(label) {
            let window_for_event = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window_for_event.hide();
                }
                WindowEvent::Focused(false) if window_for_event.label() == "main" => {
                    let _ = window_for_event.hide();
                }
                _ => {}
            });
        }
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    let runtime = app.state::<Arc<RuntimeState>>();
    let startup_checked = platform::startup_enabled().unwrap_or_else(|error| {
        append_log(&error);
        false
    });
    let startup = CheckMenuItem::with_id(
        app,
        "startup",
        "开机自启动",
        true,
        startup_checked,
        None::<&str>,
    )?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        "float-always-on-top",
        "悬浮条置顶",
        true,
        runtime.service.config().float_always_on_top,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings,
            &update,
            &startup,
            &always_on_top,
            &separator,
            &exit,
        ],
    )?;
    let startup_item = startup.clone();
    let top_item = always_on_top.clone();
    let icon = Image::from_bytes(include_bytes!("../../icon.png"))?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Sub2API 账户用量")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "settings" => show_panel(app, "settings", ""),
            "check-update" => {
                let runtime = app.state::<Arc<RuntimeState>>();
                runtime
                    .updates
                    .start(app.clone(), runtime.service.config().update_url, true);
            }
            "startup" => {
                let checked = startup_item.is_checked().unwrap_or(false);
                if let Err(error) = platform::set_startup_enabled(checked) {
                    let _ = startup_item.set_checked(!checked);
                    append_log(&error);
                }
            }
            "float-always-on-top" => {
                let runtime = app.state::<Arc<RuntimeState>>();
                let checked = top_item.is_checked().unwrap_or(true);
                let _ = runtime
                    .service
                    .set_config(json!({ "floatAlwaysOnTop": checked }));
                sync_floating_bar(app, &runtime, false);
                runtime.broadcast(app);
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

async fn refresh_usage(app: &AppHandle, runtime: Arc<RuntimeState>) {
    if runtime.refreshing.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let mut state = runtime.state.lock().expect("public state poisoned");
        state.is_refreshing = true;
        state.message = "正在刷新账户用量…".into();
    }
    runtime.broadcast(app);
    match runtime.service.refresh_usage().await {
        Ok(next) => {
            *runtime.state.lock().expect("public state poisoned") = PublicState {
                status: next.status,
                accounts: next.accounts,
                failed: next.failed,
                message: next.message,
                refreshed_at: next.refreshed_at,
                is_refreshing: false,
                auth_mode: runtime.service.auth_mode(),
                current_index: 0,
                total_accounts: next.total_accounts,
                config: runtime.service.config(),
            };
        }
        Err(error) => {
            let message = error.to_string();
            append_log(&format!("刷新账户用量失败：{message}"));
            let authentication_failed = message.contains("过期") || message.contains("鉴权");
            let previous = runtime.state.lock().expect("public state poisoned").clone();
            *runtime.state.lock().expect("public state poisoned") = PublicState {
                status: if authentication_failed {
                    "needs-auth"
                } else {
                    "error"
                }
                .into(),
                accounts: if authentication_failed {
                    Vec::new()
                } else {
                    previous.accounts
                },
                failed: Vec::new(),
                message,
                refreshed_at: if authentication_failed {
                    None
                } else {
                    previous.refreshed_at
                },
                is_refreshing: false,
                auth_mode: runtime.service.auth_mode(),
                current_index: 0,
                total_accounts: if authentication_failed {
                    0
                } else {
                    previous.total_accounts
                },
                config: runtime.service.config(),
            };
        }
    }
    runtime.rotation_index.store(0, Ordering::SeqCst);
    runtime.refreshing.store(false, Ordering::SeqCst);
    update_tray_tooltip(app, &runtime);
    runtime.broadcast(app);
}

fn start_timers(app: AppHandle, runtime: Arc<RuntimeState>) {
    let refresh_app = app.clone();
    let refresh_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let interval = refresh_runtime.service.config().update_interval;
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            if platform::idle_seconds() < interval {
                refresh_usage(&refresh_app, refresh_runtime.clone()).await;
            }
        }
    });

    let rotation_app = app.clone();
    let rotation_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let interval = rotation_runtime.service.config().rotation_interval;
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            let count = rotation_runtime
                .state
                .lock()
                .expect("public state poisoned")
                .accounts
                .len();
            if count > 1 {
                rotation_runtime
                    .rotation_index
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |index| {
                        Some((index + 1) % count)
                    })
                    .ok();
                update_tray_tooltip(&rotation_app, &rotation_runtime);
            }
        }
    });

    let tooltip_app = app.clone();
    let tooltip_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            update_tray_tooltip(&tooltip_app, &tooltip_runtime);
        }
    });

    let window_app = app.clone();
    let window_runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticks = 0u32;
        loop {
            let fullscreen = platform::foreground_is_fullscreen();
            let previous = window_runtime.fullscreen.swap(fullscreen, Ordering::SeqCst);
            if fullscreen != previous {
                sync_floating_bar(&window_app, &window_runtime, false);
            }
            if !fullscreen {
                // Reading a desktop pixel costs 20ms+ per point on Windows, so sample the
                // background at a low rate instead of on every tick.
                ticks += 1;
                if ticks % 3 == 0 {
                    sample_float_theme_async(&window_app, &window_runtime).await;
                }
                if window_runtime.service.config().float_always_on_top {
                    if let Some(window) = window_app.get_webview_window("float") {
                        let _ = window.set_always_on_top(true);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        }
    });

    let update_app = app;
    let update_runtime = runtime;
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
            update_runtime.updates.start(
                update_app.clone(),
                update_runtime.service.config().update_url,
                false,
            );
        }
    });
}

fn show_panel(app: &AppHandle, view: &str, focus: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    position_panel(&window);
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("navigate", json!({ "view": view, "focus": focus }));
    if let Some(runtime) = app.try_state::<Arc<RuntimeState>>() {
        runtime.broadcast(app);
    }
}

fn toggle_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_panel(app, "dashboard", "");
        }
    }
}

fn position_panel(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window
        .current_monitor()
        .or_else(|_| window.primary_monitor())
    else {
        return;
    };
    let area = monitor.work_area();
    let size = window.outer_size().unwrap_or(PhysicalSize::new(440, 650));
    let x = area.position.x + area.size.width as i32 - size.width as i32 - 12;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - 12;
    let _ = window.set_position(PhysicalPosition::new(
        x.max(area.position.x),
        y.max(area.position.y),
    ));
}

fn sync_floating_bar(app: &AppHandle, runtime: &RuntimeState, initial: bool) {
    let Some(window) = app.get_webview_window("float") else {
        return;
    };
    let config = runtime.service.config();
    let visible = config.show_floating_bar && !runtime.fullscreen.load(Ordering::SeqCst);
    let _ = window.set_always_on_top(config.float_always_on_top);
    // Logical units keep the CSS layout identical on every DPI scale factor.
    let _ = window.set_size(LogicalSize::new(FLOAT_WIDTH, FLOAT_HEIGHT));
    refresh_float_geometry(&window, runtime);
    if visible {
        if initial || !runtime.float_positioned.swap(true, Ordering::SeqCst) {
            position_floating_bar(&window, runtime.store.float_position());
        }
        let _ = window.show();
        runtime.broadcast(app);
        if let Some(state) = app.try_state::<Arc<RuntimeState>>() {
            spawn_float_theme_sample(app, &state.inner().clone());
        }
    } else {
        let _ = window.hide();
    }
}

fn position_floating_bar(window: &tauri::WebviewWindow, saved: Option<FloatPosition>) {
    let monitors: Vec<MonitorGeometry> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(MonitorGeometry::from_monitor)
        .collect();
    let (width, height) = cached_float_size(window);
    let position = if let Some(saved) = saved {
        clamp_float_position(&monitors, saved.x, saved.y, width, height)
    } else if let Ok(Some(primary)) = window.primary_monitor() {
        let area = primary.work_area();
        FloatPosition {
            x: area.position.x + (area.size.width as i32 - width) / 2,
            y: area.position.y + 18,
        }
    } else {
        FloatPosition { x: 0, y: 18 }
    };
    let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
}

fn move_floating_bar(
    app: &AppHandle,
    runtime: &RuntimeState,
    delta: MoveDelta,
) -> Result<(), String> {
    let window = app
        .get_webview_window("float")
        .ok_or_else(|| "悬浮条窗口不存在。".to_string())?;
    if !delta.dx.is_finite() || !delta.dy.is_finite() {
        return Ok(());
    }
    let current = runtime
        .float_current
        .lock()
        .expect("float current poisoned")
        .unwrap_or_else(|| {
            window
                .outer_position()
                .map(|position| FloatPosition {
                    x: position.x,
                    y: position.y,
                })
                .unwrap_or_default()
        });
    let (width, height) = *runtime.float_size.lock().expect("float size poisoned");
    let position = clamp_float_position(
        &runtime.float_monitors.lock().expect("monitors poisoned"),
        current.x + delta.dx.round() as i32,
        current.y + delta.dy.round() as i32,
        width,
        height,
    );
    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())?;
    *runtime
        .float_current
        .lock()
        .expect("float current poisoned") = Some(position);
    Ok(())
}

/// Physical size of the floating bar, used for clamping and background sampling.
fn cached_float_size(window: &tauri::WebviewWindow) -> (i32, i32) {
    window
        .outer_size()
        .map(|size| (size.width as i32, size.height as i32))
        .unwrap_or((FLOAT_WIDTH as i32, FLOAT_HEIGHT as i32))
}

/// Refreshes the cached monitor list and window size; called at drag start and end so the
/// per-move path stays free of monitor enumeration and window queries.
fn refresh_float_geometry(window: &tauri::WebviewWindow, runtime: &RuntimeState) {
    let monitors: Vec<MonitorGeometry> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(MonitorGeometry::from_monitor)
        .collect();
    if !monitors.is_empty() {
        *runtime.float_monitors.lock().expect("monitors poisoned") = monitors;
    }
    *runtime.float_size.lock().expect("float size poisoned") = cached_float_size(window);
}

fn clamp_float_position(
    monitors: &[MonitorGeometry],
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> FloatPosition {
    let center_x = x + width / 2;
    let center_y = y + height / 2;
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| {
            center_x >= monitor.x
                && center_x < monitor.x + monitor.width
                && center_y >= monitor.y
                && center_y < monitor.y + monitor.height
        })
        .or_else(|| monitors.first())
    else {
        return FloatPosition { x, y };
    };
    let min_x = monitor.work_x;
    let min_y = monitor.work_y;
    let max_x = monitor.work_x + monitor.work_width - width;
    let max_y = monitor.work_y + monitor.work_height - height;
    let mut next_x = x.clamp(min_x, max_x.max(min_x));
    let mut next_y = y.clamp(min_y, max_y.max(min_y));
    if (next_x - min_x).abs() <= EDGE_SNAP {
        next_x = min_x;
    }
    if (next_x - max_x).abs() <= EDGE_SNAP {
        next_x = max_x;
    }
    if (next_y - min_y).abs() <= EDGE_SNAP {
        next_y = min_y;
    }
    if (next_y - max_y).abs() <= EDGE_SNAP {
        next_y = max_y;
    }
    FloatPosition {
        x: next_x,
        y: next_y,
    }
}

/// Samples the desktop behind the floating bar and flips the black/white theme.
///
/// The GDI read runs on the blocking pool because a single desktop pixel read can take
/// tens of milliseconds; keeping it off the async workers and off the pointer path is
/// what makes dragging feel immediate.
async fn sample_float_theme_async(app: &AppHandle, runtime: &RuntimeState) {
    let Some(window) = app.get_webview_window("float") else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let position = window
        .outer_position()
        .ok()
        .map(|position| FloatPosition {
            x: position.x,
            y: position.y,
        })
        .or_else(|| {
            *runtime
                .float_current
                .lock()
                .expect("float current poisoned")
        });
    let Some(position) = position else {
        return;
    };
    let (width, height) = *runtime.float_size.lock().expect("float size poisoned");
    let theme = tauri::async_runtime::spawn_blocking(move || {
        platform::background_theme(position.x, position.y, width, height)
    })
    .await
    .ok()
    .flatten();
    let Some(theme) = theme else {
        return;
    };
    let mut current = runtime.float_theme.lock().expect("float theme poisoned");
    if current.as_str() != theme {
        *current = theme.into();
    }
    let _ = app.emit("float-color", theme);
}

fn spawn_float_theme_sample(app: &AppHandle, runtime: &Arc<RuntimeState>) {
    let app = app.clone();
    let runtime = runtime.clone();
    tauri::async_runtime::spawn(async move {
        sample_float_theme_async(&app, &runtime).await;
    });
}

fn update_tray_tooltip(app: &AppHandle, runtime: &RuntimeState) {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    let state = runtime.state.lock().expect("public state poisoned");
    let tooltip = if state.accounts.is_empty() {
        format!("Sub2API 账户用量：{}", state.message)
    } else {
        let index = runtime.rotation_index.load(Ordering::SeqCst) % state.accounts.len();
        let item = &state.accounts[index];
        let five = item
            .usage
            .pointer("/five_hour/utilization")
            .and_then(number)
            .unwrap_or(0.0);
        let seven = item
            .usage
            .pointer("/seven_day/utilization")
            .and_then(number)
            .unwrap_or(0.0);
        let countdown = if five >= 100.0 {
            format_countdown(item.usage.pointer("/five_hour/resets_at"))
        } else if seven >= 100.0 {
            format_countdown(item.usage.pointer("/seven_day/resets_at"))
        } else {
            String::new()
        };
        let suffix = if countdown.is_empty() {
            format!("{}% · {}%", five.round(), seven.round())
        } else {
            countdown
        };
        format!("{}  {suffix}", account_display_name(&item.account))
    };
    let mut previous = runtime.tray_tooltip.lock().expect("tray tooltip poisoned");
    if *previous != tooltip {
        let _ = tray.set_tooltip(Some(&tooltip));
        *previous = tooltip;
    }
}

fn format_countdown(value: Option<&Value>) -> String {
    let Some(target) = value
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
    else {
        return String::new();
    };
    let seconds = (target.with_timezone(&Utc) - Utc::now())
        .num_seconds()
        .max(0);
    if seconds == 0 {
        return String::new();
    }
    let days = seconds / 86_400;
    let hours = seconds % 86_400 / 3600;
    let minutes = seconds % 3600 / 60;
    let remaining = seconds % 60;
    if days > 0 {
        format!("{days}天{hours}时")
    } else if hours > 0 {
        format!("{hours}时{minutes}分")
    } else if minutes > 0 {
        format!("{minutes}分{remaining}秒")
    } else {
        format!("{remaining}秒")
    }
}

fn value_key(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        value => value.to_string().trim_matches('"').to_string(),
    }
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::{clamp_float_position, MonitorGeometry};
    use crate::models::FloatPosition;

    fn monitor_with_work_area(
        work_x: i32,
        work_y: i32,
        work_width: i32,
        work_height: i32,
    ) -> MonitorGeometry {
        MonitorGeometry {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            work_x,
            work_y,
            work_width,
            work_height,
        }
    }

    #[test]
    fn floating_bar_stays_above_bottom_taskbar() {
        let monitor = monitor_with_work_area(0, 0, 1920, 1040);
        assert_eq!(
            clamp_float_position(&[monitor], 900, 1060, 96, 30),
            FloatPosition { x: 900, y: 1010 }
        );
    }

    #[test]
    fn floating_bar_stays_below_top_taskbar() {
        let monitor = monitor_with_work_area(0, 40, 1920, 1040);
        assert_eq!(
            clamp_float_position(&[monitor], 900, 0, 96, 30),
            FloatPosition { x: 900, y: 40 }
        );
    }

    #[test]
    fn floating_bar_stays_clear_of_side_taskbars() {
        let left = monitor_with_work_area(48, 0, 1872, 1080);
        assert_eq!(
            clamp_float_position(&[left], 0, 500, 96, 30),
            FloatPosition { x: 48, y: 500 }
        );

        let right = monitor_with_work_area(0, 0, 1872, 1080);
        assert_eq!(
            clamp_float_position(&[right], 1900, 500, 96, 30),
            FloatPosition { x: 1776, y: 500 }
        );
    }
}
