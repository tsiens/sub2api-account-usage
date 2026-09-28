use crate::store::{append_log, data_directory};
use serde_json::{json, Value};
use std::{
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const CODEX_CONFIG_REL: &str = ".codex/config.toml";

fn codex_config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(CODEX_CONFIG_REL))
        .ok_or_else(|| "无法获取用户主目录。".into())
}

#[tauri::command]
pub fn open_codex_config() -> Result<(), String> {
    let path = codex_config_path()?;
    if !path.exists() {
        return Err("~/.codex/config.toml 不存在。".into());
    }
    let operation: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = path
        .as_os_str()
        .encode_wide()
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
        return Err("无法打开 config.toml。".into());
    }
    Ok(())
}

fn app_data_dir(app: &str) -> PathBuf {
    data_directory().join("apps").join(app)
}

fn models_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("models.json"))
        .unwrap_or_else(|| app_data_dir("codex").join("models.json"))
}

fn models_dir_path() -> Result<PathBuf, String> {
    // 打包后，模型源文件位于 exe 同目录的 _up_/models 下（Tauri 资源目录）。
    // 用 current_exe 获取可执行文件真实路径，避免依赖 PathResolver 的路径解析差异。
    let exe =
        std::env::current_exe().map_err(|error| format!("获取可执行文件路径失败：{error}"))?;
    let dir = exe
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("_up_")
        .join("models");
    append_log(&format!("models dir: {dir:?} exists={}", dir.exists()));
    Ok(dir)
}

fn app_backups_dir(app: &str) -> Result<PathBuf, String> {
    let dir = app_data_dir(app).join("backups");
    fs::create_dir_all(&dir).map_err(|error| format!("创建备份目录失败：{error}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn get_codex_config() -> Result<String, String> {
    let path = codex_config_path()?;
    if path.exists() {
        fs::read_to_string(&path).map_err(|error| format!("读取 config.toml 失败：{error}"))
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub fn prepare_models() -> Result<(), String> {
    // 模型来源直接读取打包进资源目录的 models/ 文件夹，
    // 这里只需确保输出文件 models.json 的父目录存在。
    if let Some(parent) = models_path().parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建模型目录失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_codex_config(base_url: String, bearer_token: String) -> Result<(), String> {
    let config_path = codex_config_path()?;
    let catalog = "~/.codex/models.json".to_string();
    let mut content = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|error| format!("读取 config.toml 失败：{error}"))?
    } else {
        String::new()
    };

    content = set_toml_key(&content, "model_provider", "\"sub2api\"");
    content = set_toml_key(&content, "preferred_auth_method", "\"apikey\"");
    content = set_toml_key(&content, "forced_login_method", "\"api\"");
    content = set_toml_key(&content, "model_catalog_json", &format!("\"{catalog}\""));
    let base = base_url.trim_end_matches('/');
    let provider = format!(
        "[model_providers.sub2api]\nname = \"AI\"\nbase_url = \"{base}/v1\"\nexperimental_bearer_token = \"{bearer_token}\"\nwire_api = \"responses\""
    );
    content = upsert_table(&content, "[model_providers.sub2api]", &provider);
    write_if_changed(&config_path, &content, "codex", "config")
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("解析 {} 失败：{error}", path.display()))
}

#[tauri::command]
pub fn list_model_files() -> Result<Value, String> {
    let dir = models_dir_path()?;
    append_log(&format!(
        "list_model_files: {dir:?} exists={}",
        dir.exists()
    ));
    if !dir.exists() {
        return Ok(json!([]));
    }
    let mut files = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&dir)
        .map_err(|error| error.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let content = read_json(&path)?;
        let group = name
            .split('-')
            .next()
            .map(str::to_string)
            .unwrap_or_else(|| name.clone());
        files.push(json!({
            "name": name,
            "group": group,
            "content": content,
        }));
    }
    Ok(json!(files))
}

#[tauri::command]
pub fn read_models() -> Result<Value, String> {
    let path = models_path();
    if !path.exists() {
        return Ok(json!({"models": []}));
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("读取 models.json 失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析 models.json 失败：{error}"))
}

#[tauri::command]
pub fn save_models(models: Value) -> Result<(), String> {
    let path = models_path();

    // 从勾选的 slug 列表组装完整的模型对象。
    let selected: Vec<String> = models
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    // 读取所有源文件，建立 slug -> 完整模型对象 的映射。
    let dir = models_dir_path()?;
    let mut by_slug: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    if dir.exists() {
        for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let content = read_json(&path)?;
            let items = content
                .get("models")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for item in items {
                if let Some(slug) = item.get("slug").and_then(|v| v.as_str()) {
                    by_slug.insert(slug.to_string(), item.clone());
                }
            }
        }
    }

    // 从现有 models.json 补充无法溯源的模型（源文件中没有的旧模型），
    // 保证勾选后它们的完整对象不会丢失。
    if path.exists() {
        if let Ok(prev) = read_json(&path) {
            let prev_items = prev
                .get("models")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for item in prev_items {
                let key = item
                    .get("modelName")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("slug").and_then(|v| v.as_str()))
                    .or_else(|| item.get("id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| item.to_string());
                by_slug.entry(key).or_insert_with(|| item.clone());
            }
        }
    }

    // 按勾选顺序提取模型（找不到则跳过）。
    let mut out_models: Vec<Value> = Vec::new();
    for slug in &selected {
        if let Some(model) = by_slug.get(slug) {
            out_models.push(model.clone());
        }
    }

    let text = serde_json::to_string_pretty(&json!({ "models": out_models }))
        .map_err(|error| format!("序列化失败：{error}"))?;
    write_if_changed(&path, &text, "codex", "models")
}

#[tauri::command]
pub fn list_backups(app: String) -> Result<Value, String> {
    let dir = app_backups_dir(&app)?;
    if !dir.exists() {
        return Ok(json!([]));
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let meta = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if meta.is_file() {
            items.push(json!({
                "name": name,
                "app": app,
                "size": meta.len(),
            }));
        }
    }
    // 按文件名中的时间戳倒序（最新的在最前），避免按整个文件名排序时
    // "models.*" 与 "config.*" 相互错位。
    items.sort_by(|a, b| {
        fn stamp(name: &str) -> u64 {
            name.rsplit('.')
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        }
        stamp(b["name"].as_str().unwrap_or_default())
            .cmp(&stamp(a["name"].as_str().unwrap_or_default()))
    });
    Ok(json!(items))
}

#[tauri::command]
pub fn preview_backup(app: String, name: String) -> Result<String, String> {
    let path = app_backups_dir(&app)?.join(&name);
    if !path.exists() {
        return Err("备份不存在。".into());
    }
    fs::read_to_string(&path).map_err(|error| format!("读取备份失败：{error}"))
}

#[tauri::command]
pub fn delete_backup(app: String, name: String) -> Result<(), String> {
    let path = app_backups_dir(&app)?.join(&name);
    if !path.exists() {
        return Err("备份不存在。".into());
    }
    fs::remove_file(&path).map_err(|error| format!("删除备份失败：{error}"))
}

#[tauri::command]
pub fn restore_backup(app: String, name: String) -> Result<(), String> {
    let path = app_backups_dir(&app)?.join(&name);
    if !path.exists() {
        return Err("备份不存在。".into());
    }
    let target = restore_target(&app, &name)?;
    fs::copy(&path, &target).map_err(|error| format!("还原备份失败：{error}"))?;
    append_log(&format!("已从备份还原：{name}"));
    Ok(())
}

fn restore_target(app: &str, name: &str) -> Result<PathBuf, String> {
    if app == "codex" && name.starts_with("config.") {
        codex_config_path()
    } else if app == "codex" && name.starts_with("models.") {
        Ok(models_path())
    } else {
        Err("未知备份类型。".into())
    }
}

fn back_up_content(content: &str, app: &str, kind: &str) -> Result<(), String> {
    let dir = app_backups_dir(app)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let name = format!("{kind}.{stamp}.bak");
    fs::write(dir.join(&name), content).map_err(|error| format!("备份失败：{error}"))?;
    Ok(())
}

/// 仅当目标文件内容与将写入的新内容不同时才写入；写入后用新内容生成一次备份，
/// 使得每个备份都对应一次保存动作产生的新版本（旧的在上次保存时已备份）。
fn write_if_changed(path: &Path, content: &str, app: &str, kind: &str) -> Result<(), String> {
    let changed = match fs::read_to_string(path) {
        Ok(existing) => existing != content,
        Err(_) => true,
    };
    if !changed {
        return Ok(());
    }
    write_atomic(path, content)?;
    back_up_content(content, app, kind)
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|error| format!("写入失败：{error}"))?;
    fs::rename(&tmp, path).map_err(|error| format!("替换文件失败：{error}"))
}

fn set_toml_key(content: &str, key: &str, value: &str) -> String {
    let mut out = String::new();
    let mut replaced = false;
    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with(&format!("{key} =")) || trimmed == key {
            out.push_str(&format!("{key} = {value}\n"));
            replaced = true;
        } else if !replaced && trimmed.starts_with('[') {
            out.push_str(&format!("{key} = {value}\n"));
            replaced = true;
            out.push_str(line);
            out.push('\n');
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    if !replaced {
        // Keep trailing newline sane.
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("{key} = {value}\n"));
    }
    out
}

fn upsert_table(content: &str, header: &str, body: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    if let Some(start) = lines.iter().position(|line| line.trim_start() == header) {
        let mut end = start + 1;
        while end < lines.len() && !lines[end].starts_with('[') {
            end += 1;
        }
        let mut out = lines[..start].join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(body);
        out.push('\n');
        out.push_str(&lines[end..].join("\n"));
        out
    } else {
        let mut out = content.trim_end().to_string();
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(body);
        out.push('\n');
        out
    }
}
