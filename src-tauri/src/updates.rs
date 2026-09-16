use crate::{
    models::{AvailableUpdate, UpdateUiState, DEFAULT_UPDATE_URL},
    store::append_log,
};
use futures_util::StreamExt;
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    body: Option<String>,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenericRelease {
    version: String,
    download_url: String,
    sha256: Option<String>,
}

pub struct UpdateManager {
    state: Mutex<UpdateUiState>,
    available: Mutex<Option<AvailableUpdate>>,
    downloaded: Mutex<Option<PathBuf>>,
    running: AtomicBool,
    cancel: AtomicBool,
}

impl UpdateManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(UpdateUiState::default()),
            available: Mutex::new(None),
            downloaded: Mutex::new(None),
            running: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
        })
    }

    pub fn state(&self) -> UpdateUiState {
        self.state.lock().expect("update state poisoned").clone()
    }

    pub fn start(self: &Arc<Self>, app: AppHandle, update_url: String, manual: bool) {
        if self.running.swap(true, Ordering::SeqCst) {
            if manual {
                show_window(&app);
                self.emit(&app);
            }
            return;
        }
        self.cancel.store(false, Ordering::SeqCst);
        if manual {
            show_window(&app);
        }
        self.set_state(
            &app,
            UpdateUiState {
                status: "checking".into(),
                message: "正在检查更新…".into(),
                ..Default::default()
            },
        );
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = manager.check_and_download(&app, &update_url).await;
            manager.running.store(false, Ordering::SeqCst);
            if let Err(error) = result {
                if manager.cancel.load(Ordering::SeqCst) {
                    manager.finish_cancel(&app).await;
                } else {
                    append_log(&format!("更新失败：{error}"));
                    manager.set_state(
                        &app,
                        UpdateUiState {
                            status: "error".into(),
                            message: error,
                            ..manager.state()
                        },
                    );
                    if manual {
                        show_window(&app);
                    }
                }
            }
        });
    }

    pub async fn cancel(&self, app: &AppHandle) {
        self.cancel.store(true, Ordering::SeqCst);
        self.set_state(
            app,
            UpdateUiState {
                status: "cancelling".into(),
                message: "正在取消并清空更新缓存…".into(),
                ..self.state()
            },
        );
        if !self.running.load(Ordering::SeqCst) {
            self.finish_cancel(app).await;
        }
    }

    pub fn install(&self, app: &AppHandle) -> Result<bool, String> {
        let path = self
            .downloaded
            .lock()
            .expect("downloaded path poisoned")
            .clone();
        let Some(path) = path else {
            return Ok(false);
        };
        // Silent install so the NSIS setup never blocks on an "app is running" prompt
        // after this process has already exited, then relaunch the updated app.
        Command::new(&path)
            .args(["/S", "/R"])
            .spawn()
            .map_err(|error| format!("启动更新安装程序失败：{error}"))?;
        app.exit(0);
        Ok(true)
    }

    async fn check_and_download(&self, app: &AppHandle, source: &str) -> Result<(), String> {
        if cfg!(debug_assertions) {
            return Err("开发模式不检查更新。".into());
        }
        let available = resolve_update(source).await?;
        let current = Version::parse(&app.package_info().version.to_string())
            .map_err(|error| format!("当前版本号无效：{error}"))?;
        let latest = Version::parse(available.version.trim_start_matches('v'))
            .map_err(|error| format!("远程版本号无效：{error}"))?;
        if latest <= current {
            self.set_state(
                app,
                UpdateUiState {
                    status: "latest".into(),
                    version: current.to_string(),
                    message: "当前已是最新版本。".into(),
                    ..Default::default()
                },
            );
            return Ok(());
        }
        *self.available.lock().expect("available update poisoned") = Some(available.clone());
        self.download(app, &available).await
    }

    async fn download(&self, app: &AppHandle, update: &AvailableUpdate) -> Result<(), String> {
        let cache = updater_cache_directory()?;
        clear_directory(&cache).await?;
        tokio::fs::create_dir_all(&cache)
            .await
            .map_err(|error| format!("创建更新缓存失败：{error}"))?;
        let name = update
            .download_url
            .split('/')
            .next_back()
            .and_then(|value| value.split('?').next())
            .filter(|value| value.to_lowercase().ends_with(".exe"))
            .unwrap_or("Sub2API.Setup.exe");
        let destination = cache.join(name);
        let response = reqwest::Client::new()
            .get(&update.download_url)
            .header(reqwest::header::USER_AGENT, "sub2api-account-usage-tauri")
            .send()
            .await
            .map_err(|error| format!("下载更新失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("下载更新失败：HTTP {}", response.status().as_u16()));
        }
        let total = response.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&destination)
            .await
            .map_err(|error| format!("创建更新文件失败：{error}"))?;
        let mut stream = response.bytes_stream();
        let mut transferred = 0u64;
        let started = Instant::now();
        let mut hasher = Sha256::new();
        self.set_state(
            app,
            UpdateUiState {
                status: "downloading".into(),
                version: update.version.clone(),
                total,
                message: "正在下载更新…".into(),
                ..Default::default()
            },
        );
        while let Some(chunk) = stream.next().await {
            if self.cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            let chunk = chunk.map_err(|error| format!("下载更新失败：{error}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("写入更新文件失败：{error}"))?;
            hasher.update(&chunk);
            transferred += chunk.len() as u64;
            let elapsed = started.elapsed().as_secs_f64().max(0.1);
            self.set_state(
                app,
                UpdateUiState {
                    status: "downloading".into(),
                    version: update.version.clone(),
                    percent: if total > 0 {
                        transferred as f64 * 100.0 / total as f64
                    } else {
                        0.0
                    },
                    transferred,
                    total,
                    speed: (transferred as f64 / elapsed) as u64,
                    message: "正在下载更新…".into(),
                },
            );
        }
        file.flush()
            .await
            .map_err(|error| format!("保存更新文件失败：{error}"))?;
        if let Some(expected) = update.sha256.as_deref().filter(|value| !value.is_empty()) {
            let actual = format!("{:x}", hasher.finalize());
            if !actual.eq_ignore_ascii_case(expected.trim()) {
                let _ = tokio::fs::remove_file(&destination).await;
                return Err("更新文件 SHA-256 校验失败。".into());
            }
        }
        *self.downloaded.lock().expect("downloaded path poisoned") = Some(destination);
        self.set_state(
            app,
            UpdateUiState {
                status: "downloaded".into(),
                version: update.version.clone(),
                percent: 100.0,
                transferred,
                total,
                speed: 0,
                message: "更新已下载完成。".into(),
            },
        );
        show_window(app);
        Ok(())
    }

    async fn finish_cancel(&self, app: &AppHandle) {
        if let Ok(cache) = updater_cache_directory() {
            let _ = clear_directory(&cache).await;
        }
        *self.downloaded.lock().expect("downloaded path poisoned") = None;
        self.set_state(
            app,
            UpdateUiState {
                status: "cancelled".into(),
                message: "已取消，更新缓存已清空。".into(),
                ..Default::default()
            },
        );
    }

    fn set_state(&self, app: &AppHandle, state: UpdateUiState) {
        *self.state.lock().expect("update state poisoned") = state;
        self.emit(app);
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("update-state", self.state());
    }
}

async fn resolve_update(source: &str) -> Result<AvailableUpdate, String> {
    let source = source.trim().trim_end_matches('/');
    let source = if source.is_empty() {
        DEFAULT_UPDATE_URL
    } else {
        source
    };
    if let Some((proxy, owner, repository)) = parse_github_source(source) {
        // Version check and download both go through the address the user configured:
        // a ghproxy prefix is applied to the API call as well, and a plain GitHub URL
        // stays direct.
        let api_url =
            format!("{proxy}https://api.github.com/repos/{owner}/{repository}/releases/latest");
        let response = reqwest::Client::new()
            .get(&api_url)
            .header(reqwest::header::USER_AGENT, "sub2api-account-usage-tauri")
            .send()
            .await
            .map_err(|error| format!("检查 GitHub Release 失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "检查 GitHub Release 失败：HTTP {}",
                response.status().as_u16()
            ));
        }
        let release: GithubRelease = response
            .json()
            .await
            .map_err(|error| format!("解析 GitHub Release 失败：{error}"))?;
        let asset = release
            .assets
            .iter()
            .filter(|asset| asset.name.to_lowercase().ends_with(".exe"))
            .max_by_key(|asset| {
                let name = asset.name.to_lowercase();
                (name.contains("setup"), !name.contains("portable"))
            })
            .ok_or_else(|| "最新 Release 中没有 Windows 安装程序。".to_string())?;
        let digest = fetch_digest(&release, asset, &proxy).await;
        let url = if proxy.is_empty() {
            asset.browser_download_url.clone()
        } else {
            format!("{proxy}{}", asset.browser_download_url)
        };
        return Ok(AvailableUpdate {
            version: release.tag_name.trim_start_matches('v').into(),
            download_url: url,
            sha256: digest,
        });
    }
    let metadata_url = if source.ends_with(".json") {
        source.to_string()
    } else {
        format!("{source}/latest.json")
    };
    let release: GenericRelease = reqwest::Client::new()
        .get(&metadata_url)
        .header(reqwest::header::USER_AGENT, "sub2api-account-usage-tauri")
        .send()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("检查更新失败：{error}"))?
        .json()
        .await
        .map_err(|error| format!("解析更新元数据失败：{error}"))?;
    Ok(AvailableUpdate {
        version: release.version.trim_start_matches('v').into(),
        download_url: release.download_url,
        sha256: release.sha256,
    })
}

fn parse_github_source(value: &str) -> Option<(String, String, String)> {
    let marker = "https://github.com/";
    let position = value.find(marker)?;
    let proxy = value[..position].to_string();
    if !proxy.is_empty() && !(proxy.starts_with("http://") || proxy.starts_with("https://")) {
        return None;
    }
    let path = &value[position + marker.len()..];
    let mut parts = path.trim_matches('/').split('/');
    let owner = parts.next()?.trim();
    let repository = parts.next()?.trim_end_matches(".git");
    if owner.is_empty() || repository.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((proxy, owner.into(), repository.into()))
}

async fn fetch_digest(
    release: &GithubRelease,
    executable: &GithubAsset,
    proxy: &str,
) -> Option<String> {
    let checksum = release.assets.iter().find(|asset| {
        asset
            .name
            .eq_ignore_ascii_case(&format!("{}.sha256", executable.name))
    })?;
    let text = reqwest::Client::new()
        .get(format!("{proxy}{}", checksum.browser_download_url))
        .header(reqwest::header::USER_AGENT, "sub2api-account-usage-tauri")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    normalized_digest(&text).map(str::to_string).or_else(|| {
        release
            .body
            .as_deref()
            .and_then(|body| normalized_digest(body).map(str::to_string))
    })
}

/// Accepts both `sha256: <hex>` / `sha256:<hex>` lines and bare hashes.
fn normalized_digest(text: &str) -> Option<&str> {
    text.split_whitespace().find_map(|part| {
        let candidate = part
            .strip_prefix("sha256:")
            .or_else(|| part.strip_prefix("SHA256:"))
            .unwrap_or(part);
        (candidate.len() == 64
            && candidate
                .chars()
                .all(|character| character.is_ascii_hexdigit()))
        .then_some(candidate)
    })
}

fn updater_cache_directory() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("sub2api-account-usage-updater"))
        .ok_or_else(|| "无法确定更新缓存目录。".to_string())
}

async fn clear_directory(path: &Path) -> Result<(), String> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("清空更新缓存失败：{error}")),
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("update") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::parse_github_source;

    #[test]
    fn parses_github_and_proxy_sources() {
        assert_eq!(
            parse_github_source("https://github.com/tsiens/sub2api-account-usage"),
            Some((
                String::new(),
                "tsiens".into(),
                "sub2api-account-usage".into()
            ))
        );
        assert_eq!(
            parse_github_source(
                "https://ghproxy.net/https://github.com/tsiens/sub2api-account-usage"
            ),
            Some((
                "https://ghproxy.net/".into(),
                "tsiens".into(),
                "sub2api-account-usage".into()
            ))
        );
    }
}
