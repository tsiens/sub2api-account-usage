mod local;
mod release;

use serde_json::Value;
use std::{
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live inside the repository")
        .into()
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("build") => local::build(&args[1..]),
        Some("verify-tag") if args.len() <= 2 => {
            let tag = args.get(1).and_then(|value| value.to_str());
            verify_tag(tag)?;
            Ok(())
        }
        Some("prepare-release") if args.len() == 1 => release::prepare(),
        Some("sign") if args.len() == 1 => release::sign(),
        Some("checksum") if args.len() == 1 => release::checksum(),
        Some("publish") if args.len() == 1 => release::publish(),
        Some("help" | "--help" | "-h") | None => {
            println!("cargo xtask build [--skip-install] [--install-dir PATH]\ncargo xtask verify-tag [TAG]\ncargo xtask prepare-release\ncargo xtask sign\ncargo xtask checksum\ncargo xtask publish");
            Ok(())
        }
        _ => Err("Unknown command or arguments; run cargo xtask --help".into()),
    }
}

fn package_value(manifest: &str, key: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
        } else if in_package {
            if let Some((name, value)) = line.split_once('=') {
                if name.trim() == key {
                    return value
                        .trim()
                        .strip_prefix('"')?
                        .split('"')
                        .next()
                        .map(str::to_string);
                }
            }
        }
    }
    None
}

fn app_config() -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(
        root().join("src-tauri/tauri.conf.json"),
    )?)?)
}

fn version() -> Result<String> {
    let config = app_config()?;
    let version = config["version"].as_str().ok_or("Missing Tauri version")?;
    let manifest = fs::read_to_string(root().join("src-tauri/Cargo.toml"))?;
    if package_value(&manifest, "version").as_deref() != Some(version) {
        return Err("Cargo and Tauri package versions do not match".into());
    }
    Ok(version.into())
}

fn verify_tag(explicit: Option<&str>) -> Result<String> {
    let tag = explicit
        .map(str::to_string)
        .or_else(|| env::var("GITHUB_REF_NAME").ok())
        .ok_or("Missing release tag")?;
    if tag.strip_prefix('v') != Some(version()?.as_str()) {
        return Err(format!("Tag {tag} does not match the current app version").into());
    }
    println!("Verified release tag: {tag}");
    Ok(tag)
}

fn installer_path() -> Result<PathBuf> {
    let config = app_config()?;
    let name = config["productName"]
        .as_str()
        .ok_or("Missing productName")?;
    Ok(root()
        .join("src-tauri/target/release/bundle/nsis")
        .join(format!("{name}_{}_x64-setup.exe", version()?)))
}

fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.current_dir(root());
    command
}

fn checked(command: &mut Command, description: &str) -> Result<()> {
    if !command.status()?.success() {
        return Err(format!("{description} failed").into());
    }
    Ok(())
}

fn capture(command: &mut Command, description: &str) -> Result<Output> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!(
            "{description} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_read_from_package_not_dependencies() {
        let manifest = "[package]\nversion = \"1.2.4\"\n[dependencies]\nversion = \"99\"\n";
        assert_eq!(package_value(manifest, "version").as_deref(), Some("1.2.4"));
    }
}
