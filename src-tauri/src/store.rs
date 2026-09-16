use crate::models::{Config, FloatPosition, StoreData};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH},
};

const SECRET_PREFIX: &str = "dpapi:";

pub struct Store {
    path: PathBuf,
    data: RwLock<StoreData>,
    write_lock: Mutex<()>,
}

impl Store {
    pub fn load() -> Result<Self, String> {
        let directory = data_directory();
        let path = directory.join("config.json");
        migrate_legacy_config(&path);
        let mut data = load_data(&path)?;

        // Electron safeStorage values are not DPAPI blobs in this format. Deliberately
        // discard them so this Tauri build always starts with a clean authentication state.
        data.secrets
            .retain(|_, value| value.starts_with(SECRET_PREFIX));

        let store = Self {
            path,
            data: RwLock::new(data),
            write_lock: Mutex::new(()),
        };
        store.persist_current()?;
        Ok(store)
    }

    pub fn config(&self) -> Config {
        self.data.read().expect("store poisoned").config.clone()
    }

    pub fn set_config(&self, config: Config, clear_authentication: bool) -> Result<(), String> {
        self.update(|data| {
            data.config = config;
            if clear_authentication {
                data.secrets.clear();
            }
        })
    }

    pub fn float_position(&self) -> Option<FloatPosition> {
        self.data.read().expect("store poisoned").float_position
    }

    pub fn set_float_position(&self, position: FloatPosition) -> Result<(), String> {
        self.update(|data| data.float_position = Some(position))
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

    pub fn clear_authentication(&self) -> Result<(), String> {
        self.update(|data| data.secrets = BTreeMap::new())
    }

    pub fn replace_with_api_key(&self, api_key: &str) -> Result<(), String> {
        let encoded = encode_secret(api_key)?;
        self.update(|data| {
            data.secrets.clear();
            data.secrets.insert("adminApiKey".into(), encoded);
        })
    }

    pub fn replace_with_jwt(
        &self,
        access_token: &str,
        refresh_token: Option<&str>,
        email: &str,
    ) -> Result<(), String> {
        let access = encode_secret(access_token)?;
        let refresh = refresh_token.map(encode_secret).transpose()?;
        let email = (!email.is_empty())
            .then(|| encode_secret(email))
            .transpose()?;
        self.update(|data| {
            data.secrets.clear();
            data.secrets.insert("accessToken".into(), access);
            if let Some(refresh) = refresh {
                data.secrets.insert("refreshToken".into(), refresh);
            }
            if let Some(email) = email {
                data.secrets.insert("email".into(), email);
            }
        })
    }

    pub fn delete_secrets(&self, keys: &[&str]) -> Result<(), String> {
        self.update(|data| {
            for key in keys {
                data.secrets.remove(*key);
            }
        })
    }

    fn update(&self, change: impl FnOnce(&mut StoreData)) -> Result<(), String> {
        let _write = self.write_lock.lock().expect("store write lock poisoned");
        let mut next = self.data.read().expect("store poisoned").clone();
        change(&mut next);
        persist_data(&self.path, &next, true)?;
        *self.data.write().expect("store poisoned") = next;
        Ok(())
    }

    fn persist_current(&self) -> Result<(), String> {
        let _write = self.write_lock.lock().expect("store write lock poisoned");
        let data = self.data.read().expect("store poisoned");
        persist_data(&self.path, &data, false)
    }
}

fn encode_secret(value: &str) -> Result<String, String> {
    let protected = protect(value.as_bytes())?;
    Ok(format!("{SECRET_PREFIX}{}", BASE64.encode(protected)))
}

fn load_data(path: &Path) -> Result<StoreData, String> {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(data) => Ok(data),
            Err(error) => {
                let backup = path.with_extension("json.bak");
                let restored = fs::read_to_string(&backup)
                    .ok()
                    .and_then(|text| serde_json::from_str(&text).ok());
                if let Some(data) = restored {
                    let corrupt = path.with_extension(format!(
                        "json.corrupt-{}",
                        chrono::Utc::now().format("%Y%m%d%H%M%S")
                    ));
                    fs::rename(path, &corrupt)
                        .map_err(|move_error| format!("保留损坏配置失败：{move_error}"))?;
                    Ok(data)
                } else {
                    Err(format!(
                        "配置文件损坏，原文件已保留，请检查 {}：{error}",
                        path.display()
                    ))
                }
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoreData::default()),
        Err(error) => Err(format!("读取配置失败：{error}")),
    }
}

fn persist_data(path: &Path, data: &StoreData, create_backup: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let text =
        serde_json::to_string_pretty(data).map_err(|error| format!("序列化配置失败：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("写入配置失败：{error}"))?;
    if create_backup && path.exists() {
        fs::copy(path, path.with_extension("json.bak"))
            .map_err(|error| format!("备份配置失败：{error}"))?;
    }
    let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(format!("保存配置失败：{}", std::io::Error::last_os_error()));
    }
    Ok(())
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
    static LOG_LOCK: Mutex<()> = Mutex::new(());
    const MAX_LOG_SIZE: u64 = 2 * 1024 * 1024;

    let _guard = LOG_LOCK.lock().expect("log lock poisoned");
    let directory = data_directory();
    let _ = fs::create_dir_all(&directory);
    let line = format!("[{}] {message}\n", chrono::Utc::now().to_rfc3339());
    let path = directory.join("app.log");
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() >= MAX_LOG_SIZE)
    {
        let rotated = directory.join("app.log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&path, rotated);
    }
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
    use super::{load_data, persist_data, protect, unprotect};
    use crate::models::StoreData;
    use std::{fs, time::SystemTime};

    #[test]
    fn dpapi_round_trip() {
        let protected = protect("测试凭据-123".as_bytes()).expect("protect");
        assert_ne!(protected, "测试凭据-123".as_bytes());
        assert_eq!(
            unprotect(&protected).expect("unprotect"),
            "测试凭据-123".as_bytes()
        );
    }

    #[test]
    fn atomic_persistence_keeps_a_recoverable_backup() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "sub2api-store-test-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("config.json");

        let first = StoreData::default();
        persist_data(&path, &first, false).expect("write first config");
        let mut second = first.clone();
        second.config.update_interval = 600;
        persist_data(&path, &second, true).expect("replace config");
        assert_eq!(
            load_data(&path)
                .expect("load current")
                .config
                .update_interval,
            600
        );

        fs::write(&path, "{broken").expect("corrupt current config");
        assert_eq!(
            load_data(&path)
                .expect("recover backup")
                .config
                .update_interval,
            first.config.update_interval
        );
        fs::remove_dir_all(directory).expect("clean test directory");
    }
}
