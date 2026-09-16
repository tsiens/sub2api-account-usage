use crate::models::{Config, FloatPosition, StoreData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

const SECRET_PREFIX: &str = "dpapi:";

pub struct Store {
    path: PathBuf,
    data: RwLock<StoreData>,
}

impl Store {
    pub fn load() -> Result<Self, String> {
        let directory = data_directory();
        let path = directory.join("config.json");
        migrate_legacy_config(&path);
        let mut data = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<StoreData>(&text).ok())
            .unwrap_or_default();

        // Electron safeStorage values are not DPAPI blobs in this format. Deliberately
        // discard them so this Tauri build always starts with a clean authentication state.
        data.secrets
            .retain(|_, value| value.starts_with(SECRET_PREFIX));

        let store = Self {
            path,
            data: RwLock::new(data),
        };
        store.save()?;
        Ok(store)
    }

    pub fn config(&self) -> Config {
        self.data.read().expect("store poisoned").config.clone()
    }

    pub fn set_config(&self, config: Config) -> Result<(), String> {
        self.data.write().expect("store poisoned").config = config;
        self.save()
    }

    pub fn float_position(&self) -> Option<FloatPosition> {
        self.data.read().expect("store poisoned").float_position
    }

    pub fn set_float_position(&self, position: FloatPosition) -> Result<(), String> {
        self.data.write().expect("store poisoned").float_position = Some(position);
        self.save()
    }

    pub fn secret(&self, key: &str) -> String {
        let encoded = self
            .data
            .read()
            .expect("store poisoned")
            .secrets
            .get(key)
            .cloned();
        encoded
            .and_then(|value| value.strip_prefix(SECRET_PREFIX).map(str::to_owned))
            .and_then(|value| BASE64.decode(value).ok())
            .and_then(|bytes| unprotect(&bytes).ok())
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .unwrap_or_default()
    }

    pub fn set_secret(&self, key: &str, value: &str) -> Result<(), String> {
        let protected = protect(value.as_bytes())?;
        self.data.write().expect("store poisoned").secrets.insert(
            key.to_string(),
            format!("{SECRET_PREFIX}{}", BASE64.encode(protected)),
        );
        self.save()
    }

    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        self.data
            .write()
            .expect("store poisoned")
            .secrets
            .remove(key);
        self.save()
    }

    pub fn clear_authentication(&self) -> Result<(), String> {
        let mut data = self.data.write().expect("store poisoned");
        data.secrets = BTreeMap::new();
        drop(data);
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
        }
        let data = self.data.read().expect("store poisoned");
        let text = serde_json::to_string_pretty(&*data)
            .map_err(|error| format!("序列化配置失败：{error}"))?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, text).map_err(|error| format!("写入配置失败：{error}"))?;
        if self.path.exists() {
            fs::remove_file(&self.path).map_err(|error| format!("替换配置失败：{error}"))?;
        }
        fs::rename(temporary, &self.path).map_err(|error| format!("保存配置失败：{error}"))
    }
}

/// Settings live next to the executable so the whole app stays portable inside its
/// install directory. If that directory cannot be written (for example a per-machine
/// install under Program Files), fall back to the per-user roaming profile.
pub fn data_directory() -> PathBuf {
    static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            if let Some(directory) = install_directory() {
                if is_writable(&directory) {
                    return directory;
                }
            }
            legacy_directory()
        })
        .clone()
}

fn install_directory() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn legacy_directory() -> PathBuf {
    dirs::config_dir()
        .map(|path| path.join("sub2api-account-usage"))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn is_writable(directory: &Path) -> bool {
    let probe = directory.join(".sub2api-write-test");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Moves settings written by an earlier build out of `%APPDATA%` into the install
/// directory. Runs at most once because the source file is removed afterwards.
fn migrate_legacy_config(target: &Path) {
    if target.exists() {
        return;
    }
    let legacy = legacy_directory().join("config.json");
    if !legacy.exists() || legacy == target {
        return;
    }
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::rename(&legacy, target) {
        Ok(()) => {}
        Err(_) => {
            if fs::copy(&legacy, target).is_ok() {
                let _ = fs::remove_file(&legacy);
            }
        }
    }
}

pub fn append_log(message: &str) {
    let directory = data_directory();
    let _ = fs::create_dir_all(&directory);
    let line = format!("[{}] {message}\n", chrono::Utc::now().to_rfc3339());
    let path = directory.join("app.log");
    let _ = append(&path, line.as_bytes());
}

fn append(path: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(content)
}

fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows DPAPI 加密失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "Windows DPAPI 解密失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{protect, unprotect};

    #[test]
    fn dpapi_round_trip() {
        let protected = protect("测试凭据-123".as_bytes()).expect("protect");
        assert_ne!(protected, "测试凭据-123".as_bytes());
        assert_eq!(
            unprotect(&protected).expect("unprotect"),
            "测试凭据-123".as_bytes()
        );
    }
}
