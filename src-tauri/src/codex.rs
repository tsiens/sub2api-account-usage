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
    data_directory().join("provider").join(app)
}

fn models_path() -> PathBuf {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("models.json"))
        .unwrap_or_else(|| app_data_dir("codex").join("models.json"))
}

/// 模型网络 source 的本地缓存文件，供模型树展示时快速读取，
/// 避免每次切换标签页都实时拉取网络。
fn sources_cache_path() -> PathBuf {
    app_data_dir("codex").join("sources-cache.json")
}

/// 打包后，模型清单文件位于 exe 同目录的 _up_/models.json（Tauri 资源目录）。
/// 用 current_exe 获取可执行文件真实路径，避免依赖 PathResolver 的路径解析差异。
fn models_manifest_path() -> Result<PathBuf, String> {
    let exe =
        std::env::current_exe().map_err(|error| format!("获取可执行文件路径失败：{error}"))?;
    Ok(exe
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("_up_")
        .join("models.json"))
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
    let original = if config_path.exists() {
        fs::read_to_string(&config_path)
            .map_err(|error| format!("读取 config.toml 失败：{error}"))?
    } else {
        String::new()
    };

    let base = base_url.trim_end_matches('/');
    let catalog_val = format!("\"{catalog}\"");

    let lines: Vec<&str> = original.lines().collect();
    let first_table = lines
        .iter()
        .position(|line| line.trim().starts_with('['))
        .unwrap_or(lines.len());

    let mut out = String::new();
    let mut seen_root = Vec::new();

    // 更新 root 区键值（保持原缩进），其他行原样保留。
    for line in lines.iter().take(first_table) {
        let line = *line;
        let trimmed = line.trim();
        let indent = &line[..line.len() - trimmed.len()];
        let updated = root_value(trimmed, &catalog_val);
        if let Some((key, value)) = updated {
            seen_root.push(key);
            out.push_str(&format!("{indent}{key} = {value}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    // 补齐缺失的 root 键。
    for (key, value) in root_entries(&catalog_val) {
        if !seen_root.contains(&key) {
            out.push_str(&format!("{key} = {value}\n"));
        }
    }

    // 处理从第一个表头开始的其余部分：定位并更新 provider 表的两行，其余原样。
    let mut in_provider = false;
    let mut seen_provider = false;
    // 备份与否由 experimental_bearer_token 是否变化决定。
    let mut changed = false;
    let mut old_token = String::new();
    for line in lines.iter().skip(first_table) {
        let line = *line;
        let trimmed = line.trim();
        let indent = &line[..line.len() - trimmed.len()];
        if trimmed == "[model_providers.sub2api]" {
            in_provider = true;
            seen_provider = true;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_provider {
            if trimmed.starts_with('[') {
                in_provider = false;
            } else if trimmed.starts_with("base_url") {
                out.push_str(&format!("{indent}base_url = \"{base}/v1\"\n"));
                continue;
            } else if trimmed.starts_with("experimental_bearer_token") {
                // 提取旧 token 用于对比（含引号，若缺失则为空串）。
                if let Some(eq) = trimmed.find('=') {
                    old_token = trimmed[eq + 1..].trim().to_string();
                }
                let new_token = format!("\"{bearer_token}\"");
                if old_token != new_token {
                    changed = true;
                }
                out.push_str(&format!(
                    "{indent}experimental_bearer_token = {new_token}\n"
                ));
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }

    // provider 表原本不存在时整体插入。
    if !seen_provider {
        changed = true;
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("[model_providers.sub2api]\n");
        out.push_str("name = \"AI\"\n");
        out.push_str(&format!("base_url = \"{base}/v1\"\n"));
        out.push_str(&format!("experimental_bearer_token = \"{bearer_token}\"\n"));
        out.push_str("wire_api = \"responses\"\n");
    }

    let candidate = if out.ends_with('\n') { out } else { out + "\n" };
    if changed {
        write_atomic(&config_path, &candidate)?;
        back_up_content(&candidate, "codex", "config")
    } else {
        Ok(())
    }
}

fn root_value<'a>(trimmed: &str, catalog_val: &'a str) -> Option<(&'static str, &'a str)> {
    let key = if trimmed.starts_with("model_provider") {
        "model_provider"
    } else if trimmed.starts_with("preferred_auth_method") {
        "preferred_auth_method"
    } else if trimmed.starts_with("forced_login_method") {
        "forced_login_method"
    } else if trimmed.starts_with("model_catalog_json") {
        "model_catalog_json"
    } else {
        return None;
    };
    let value = match key {
        "model_provider" => "\"sub2api\"",
        "preferred_auth_method" => "\"apikey\"",
        "forced_login_method" => "\"api\"",
        "model_catalog_json" => catalog_val,
        _ => unreachable!(),
    };
    Some((key, value))
}

fn root_entries(_catalog_val: &str) -> Vec<(&'static str, &str)> {
    vec![
        ("model_provider", "\"sub2api\""),
        ("preferred_auth_method", "\"apikey\""),
        ("forced_login_method", "\"api\""),
        ("model_catalog_json", _catalog_val),
    ]
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("读取 {} 失败：{error}", path.display()))?;
    serde_json::from_str(&text).map_err(|error| format!("解析 {} 失败：{error}", path.display()))
}

#[tauri::command]
pub async fn list_model_files() -> Result<Value, String> {
    let manifest = read_manifest()?;
    let suppliers = manifest.as_array().cloned().unwrap_or_default();
    let mut files = Vec::new();
    for (index, supplier) in suppliers.iter().enumerate() {
        let name = supplier
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&format!("供应商{}", index + 1))
            .to_string();
        let provider = supplier
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("codex")
            .to_string();
        let source = supplier
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mut error: Option<String> = None;
        let models = if !source.is_empty() {
            match supplier_models(supplier).await {
                Ok(models) => models,
                Err(err) => {
                    error = Some(err);
                    Vec::new()
                }
            }
        } else {
            normalize_models(supplier)
        };

        // 为每个模型注入来源（供应商名），用于唯一锁定同名模型。
        let mut content_models: Vec<Value> = Vec::new();
        for mut model in models {
            if let Some(obj) = model.as_object_mut() {
                obj.insert("sub2api_source".into(), json!(name));
            }
            content_models.push(model);
        }

        files.push(json!({
            "name": name,
            "group": provider,
            "content": json!({ "models": content_models }),
            "error": error,
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
pub async fn save_models(models: Value) -> Result<(), String> {
    let path = models_path();

    // 勾选条目：支持两种形式——
    //   { sub2api_source, model } 复合键（新），或裸 slug 字符串（旧格式向后兼容）。
    // 复合键用于在多源文件间唯一锁定同名模型。
    let selected: Vec<(String, String)> = models
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    if let Some(slug) = v.as_str() {
                        return Some((String::new(), slug.to_string()));
                    }
                    let source = v
                        .get("sub2api_source")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    let slug = v
                        .get("model")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .to_string();
                    if slug.is_empty() {
                        None
                    } else {
                        Some((source, slug))
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // 读取模型清单，建立 (source, slug) -> 完整模型对象 的映射。
    // 对带 source 的条目先网络拉取最新，失败回退到内联 models。
    let mut by_slug: std::collections::HashMap<(String, String), Value> =
        std::collections::HashMap::new();
    let manifest = read_manifest()?;
    for supplier in manifest.as_array().cloned().unwrap_or_default() {
        let name = supplier
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let models = supplier_models(&supplier).await?;
        for mut item in models {
            let slug = item
                .get("slug")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_default();
            if slug.is_empty() {
                continue;
            }
            if let Some(obj) = item.as_object_mut() {
                obj.insert("sub2api_source".into(), json!(name));
            }
            by_slug.insert((name.clone(), slug.clone()), item.clone());
        }
    }

    // 从现有 models.json 补充旧模型：带 sub2api_source 的按 (source, slug) 收录，
    // 否则按 slug 收录到空 source（无法溯源）。
    if path.exists() {
        if let Ok(prev) = read_json(&path) {
            let prev_items = prev
                .get("models")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            for item in prev_items {
                let source = item
                    .get("sub2api_source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let slug = item
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("id").and_then(|v| v.as_str()))
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if !slug.is_empty() {
                    by_slug
                        .entry((source, slug))
                        .or_insert_with(|| item.clone());
                }
            }
        }
    }

    // 按勾选顺序提取模型（找不到则跳过），并为每个模型记录来源，保证可溯源。
    let mut out_models: Vec<Value> = Vec::new();
    for (source, slug) in &selected {
        if let Some(model) = by_slug.get(&(source.clone(), slug.clone())) {
            let mut model = model.clone();
            if let Some(obj) = model.as_object_mut() {
                obj.insert("sub2api_source".into(), json!(source));
            }
            out_models.push(model);
        } else if source.is_empty() {
            // 旧格式（空 source）也尝试用空 source 无法溯源兜底。
            if let Some(model) = by_slug.get(&(String::new(), slug.clone())) {
                let mut model = model.clone();
                if let Some(obj) = model.as_object_mut() {
                    obj.insert("sub2api_source".into(), json!(""));
                }
                out_models.push(model);
            }
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

/// 读取打包携带的模型清单 models.json。
fn read_manifest() -> Result<Value, String> {
    let path = models_manifest_path()?;
    append_log(&format!(
        "models manifest: {path:?} exists={}",
        path.exists()
    ));
    if !path.exists() {
        return Ok(json!([]));
    }
    read_json(&path)
}

/// 归一化一条清单条目里的模型数组。
fn normalize_models(content: &Value) -> Vec<Value> {
    let array = if let Some(arr) = content.as_array() {
        arr.clone()
    } else if let Some(arr) = content.get("models").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        Vec::new()
    };
    // 兼容深层结构：某些 source 返回 { "models": { ... } } 之类的嵌套对象。
    array
        .into_iter()
        .flat_map(|v| {
            if let Some(arr) = v.as_array() {
                arr.clone()
            } else {
                vec![v]
            }
        })
        .collect()
}

/// 从网络地址拉取模型文件内容。对于 github.com / raw.githubusercontent.com 的地址，
/// 直连失败后自动用 gh-proxy.org 前缀重试。
async fn fetch_remote_models(source: &str) -> Result<Value, String> {
    let candidate_urls: Vec<String> =
        if source.contains("github.com") || source.contains("raw.githubusercontent.com") {
            vec![source.to_string(), format!("https://gh-proxy.org/{source}")]
        } else {
            vec![source.to_string()]
        };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;

    let mut last_error: Option<String> = None;
    for url in candidate_urls {
        match fetch_remote_once(&client, &url).await {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "拉取模型数据失败。".into()))
}

async fn fetch_remote_once(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    use reqwest::header::USER_AGENT;
    let response = client
        .get(url)
        .header(USER_AGENT, "sub2api-account-usage-tauri")
        .send()
        .await
        .map_err(|error| format!("拉取模型数据失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("拉取模型数据失败：{error}"))?;
    response
        .json()
        .await
        .map_err(|error| format!("解析模型数据失败：{error}"))
}

/// 返回某供应商条目对应的模型数组。有 source 时优先网络拉取最新；失败回退到
/// 条目内联的 models（本地内置数据）。
async fn supplier_models(supplier: &Value) -> Result<Vec<Value>, String> {
    let source = supplier
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let inline = normalize_models(supplier);
    let name = supplier.get("name").and_then(|v| v.as_str()).unwrap_or("");
    if !source.is_empty() {
        // 优先使用缓存中已拉取的最新模型，避免每次切换标签页都访问网络。
        if let Some(cached) = cached_supplier_models(name) {
            if !cached.is_empty() {
                return Ok(cached);
            }
        }
        // 缓存缺失时实时拉取一次作为兜底。
        match fetch_remote_models(source).await {
            Ok(content) => {
                let remote = normalize_models(&content);
                if !remote.is_empty() {
                    return Ok(remote);
                }
            }
            Err(error) => append_log(&format!("模型网络拉取失败（{source}）：{error}")),
        }
    }
    Ok(inline)
}

/// 读取某个供应商的缓存模型（sources-cache.json），无缓存则返回 None。
fn cached_supplier_models(name: &str) -> Option<Vec<Value>> {
    let path = sources_cache_path();
    let text = fs::read_to_string(&path).ok()?;
    let cache: Value = serde_json::from_str(&text).ok()?;
    let suppliers = cache.get("suppliers")?.as_array()?;
    for supplier in suppliers {
        if supplier.get("name").and_then(|v| v.as_str()) == Some(name) {
            let models = supplier.get("models")?.as_array()?.clone();
            if !models.is_empty() {
                return Some(models);
            }
        }
    }
    None
}

/// 拉取清单中所有带 source 的供应商模型并写入本地缓存。
/// 程序启动和“检查更新”时调用一次，与更新检查节奏保持一致。
pub async fn refresh_model_sources() {
    let manifest = match read_manifest() {
        Ok(manifest) => manifest,
        Err(error) => {
            append_log(&format!("刷新模型 source 失败：{error}"));
            return;
        }
    };
    let suppliers = manifest.as_array().cloned().unwrap_or_default();
    let mut cache_suppliers = Vec::new();
    for supplier in &suppliers {
        let name = supplier
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let source = supplier
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let mut entry = json!({ "name": name });
        if source.is_empty() {
            let models = normalize_models(supplier);
            if !models.is_empty() {
                entry["models"] = json!(models);
            }
        } else {
            match fetch_remote_models(source).await {
                Ok(content) => {
                    let models = normalize_models(&content);
                    entry["models"] = json!(models);
                }
                Err(error) => {
                    append_log(&format!("模型 source 拉取失败（{name}）：{error}"));
                    // 拉取失败时保留本地内联 models 作为兜底。
                    let inline = normalize_models(supplier);
                    if !inline.is_empty() {
                        entry["models"] = json!(inline);
                    }
                }
            }
        }
        cache_suppliers.push(entry);
    }
    if let Some(parent) = sources_cache_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = json!({
        "updated_at": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "suppliers": cache_suppliers,
    });
    if let Err(error) = fs::write(sources_cache_path(), payload.to_string()) {
        append_log(&format!("写入模型 source 缓存失败：{error}"));
    }
    append_log("模型 source 已刷新并写入缓存");
}
