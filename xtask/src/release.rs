use crate::{
    capture, checked, command, installer_path, package_value, root, verify_tag, version, Result,
};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

fn release_installer() -> Result<PathBuf> {
    Ok(root()
        .join("release")
        .join(format!("Sub2API.Setup.{}.exe", version()?)))
}

fn checksum_path(installer: &Path) -> PathBuf {
    let mut path = installer.as_os_str().to_os_string();
    path.push(".sha256");
    path.into()
}

pub fn prepare() -> Result<()> {
    let source = installer_path()?;
    if !source.is_file() {
        return Err(format!("Installer not found: {}", source.display()).into());
    }
    fs::create_dir_all(root().join("release"))?;
    let destination = release_installer()?;
    fs::copy(source, &destination)?;
    println!("Prepared installer: {}", destination.display());
    Ok(())
}

struct TemporaryFile(PathBuf);

impl TemporaryFile {
    fn create(label: &str, content: &[u8]) -> Result<Self> {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let path = env::temp_dir().join(format!("sub2api-{label}-{}-{stamp}", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let guard = Self(path);
        std::io::Write::write_all(&mut file, content)?;
        Ok(guard)
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn find_sign_tool(directory: &Path, tools: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            find_sign_tool(&entry.path(), tools)?;
        } else if entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case("signtool.exe")
            && entry
                .path()
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "x64")
        {
            tools.push(entry.path());
        }
    }
    Ok(())
}

pub fn sign() -> Result<()> {
    let encoded = env::var("WINDOWS_CERTIFICATE_BASE64").unwrap_or_default();
    if encoded.trim().is_empty() {
        println!("No signing certificate configured; checksum verification remains mandatory.");
        return Ok(());
    }
    let password = env::var("WINDOWS_CERTIFICATE_PASSWORD")
        .map_err(|_| "Missing signing certificate password")?;
    if password.trim().is_empty() {
        return Err("Missing signing certificate password".into());
    }
    let encoded: String = encoded
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let certificate = TemporaryFile::create(
        "signing.pfx",
        &base64::engine::general_purpose::STANDARD.decode(encoded)?,
    )?;
    let kits = PathBuf::from(env::var_os("ProgramFiles(x86)").ok_or("Cannot locate Windows SDK")?)
        .join("Windows Kits/10/bin");
    let mut tools = Vec::new();
    find_sign_tool(&kits, &mut tools)?;
    tools.sort();
    let tool = tools.last().ok_or("signtool.exe was not found")?;
    let installer = release_installer()?;
    checked(
        command(tool)
            .args([
                "sign",
                "/fd",
                "SHA256",
                "/td",
                "SHA256",
                "/tr",
                "http://timestamp.digicert.com",
                "/f",
            ])
            .arg(&certificate.0)
            .arg("/p")
            .arg(password)
            .arg(&installer),
        "Authenticode signing",
    )?;
    checked(
        command(tool).args(["verify", "/pa", "/v"]).arg(installer),
        "Authenticode verification",
    )
}

fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn checksum() -> Result<()> {
    let installer = release_installer()?;
    let name = installer
        .file_name()
        .ok_or("Missing installer name")?
        .to_string_lossy();
    fs::write(
        checksum_path(&installer),
        format!("{}  {name}\n", digest(&installer)?),
    )?;
    println!("Generated SHA-256 checksum");
    Ok(())
}

fn tag_body(object: &str) -> Result<&str> {
    let (_, notes) = object.split_once("\n\n").ok_or("Invalid annotated tag")?;
    if notes.trim().is_empty() {
        return Err("Annotated tag has no release notes".into());
    }
    Ok(notes)
}

fn repository() -> Result<String> {
    if let Ok(repository) = env::var("GITHUB_REPOSITORY") {
        return Ok(repository);
    }
    let manifest = fs::read_to_string(root().join("src-tauri/Cargo.toml"))?;
    let url = package_value(&manifest, "repository").ok_or("Missing repository URL")?;
    Ok(url
        .strip_prefix("https://github.com/")
        .ok_or("Repository must be on GitHub")?
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .into())
}

pub fn publish() -> Result<()> {
    let tag = verify_tag(None)?;
    let repository = repository()?;
    // Fetch the tag object because checkout may have replaced it with a commit ref.
    checked(
        command("git").args([
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            &format!("refs/tags/{tag}:refs/tags/{tag}"),
        ]),
        "Fetch annotated tag",
    )?;
    let kind = capture(
        command("git").args(["cat-file", "-t", &format!("refs/tags/{tag}")]),
        "Read tag type",
    )?;
    if String::from_utf8_lossy(&kind.stdout).trim() != "tag" {
        return Err("Release tag must be annotated".into());
    }
    let object = capture(
        command("git").args(["cat-file", "tag", &format!("refs/tags/{tag}")]),
        "Read annotated tag",
    )?;
    let object = String::from_utf8(object.stdout)?;
    let notes_file = root().join("release/release-notes.md");
    fs::write(&notes_file, tag_body(&object)?)?;

    let installer = release_installer()?;
    let checksum = checksum_path(&installer);
    if !installer.is_file() || !checksum.is_file() {
        return Err("Installer or checksum is missing".into());
    }
    let installer_name = installer
        .file_name()
        .ok_or("Missing installer name")?
        .to_string_lossy();
    let checksum_name = checksum
        .file_name()
        .ok_or("Missing checksum name")?
        .to_string_lossy();
    let existing = command("gh")
        .args(["api", &format!("repos/{repository}/releases/tags/{tag}")])
        .output()?;
    if existing.status.success() {
        let release: Value = serde_json::from_slice(&existing.stdout)?;
        let names: Vec<_> = release["assets"]
            .as_array()
            .ok_or("Invalid release assets")?
            .iter()
            .filter_map(|asset| asset["name"].as_str())
            .collect();
        if !names.contains(&installer_name.as_ref()) || !names.contains(&checksum_name.as_ref()) {
            return Err(
                "Existing Release is incomplete; remove it manually before rebuilding".into(),
            );
        }
        let old_checksum = TemporaryFile::create("existing-checksum", b"")?;
        checked(
            command("gh")
                .args([
                    "release",
                    "download",
                    &tag,
                    "--repo",
                    &repository,
                    "--pattern",
                    &checksum_name,
                    "--output",
                ])
                .arg(&old_checksum.0)
                .arg("--clobber"),
            "Download existing checksum",
        )?;
        let old_hash = fs::read_to_string(&old_checksum.0)?;
        let new_hash = fs::read_to_string(&checksum)?;
        if old_hash.split_whitespace().next() != new_hash.split_whitespace().next() {
            return Err(
                "Release already exists with a different installer; publish a new version instead"
                    .into(),
            );
        }
        checked(
            command("gh")
                .args([
                    "release",
                    "edit",
                    &tag,
                    "--repo",
                    &repository,
                    "--title",
                    &tag,
                    "--notes-file",
                ])
                .arg(notes_file),
            "Update release notes",
        )?;
        println!("Existing immutable Release matches this build; no assets were replaced.");
    } else {
        let response: Value = serde_json::from_slice(&existing.stdout).unwrap_or(Value::Null);
        if response["status"] != "404" && response["status"] != 404 {
            return Err(format!(
                "Check existing release failed: {}",
                String::from_utf8_lossy(&existing.stderr).trim()
            )
            .into());
        }
        checked(
            command("gh")
                .args(["release", "create", &tag])
                .arg(installer)
                .arg(checksum)
                .args(["--repo", &repository, "--title", &tag, "--notes-file"])
                .arg(notes_file),
            "Publish GitHub Release",
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_notes_preserve_the_full_body_verbatim() {
        let notes = "- 流式支持开关\n- 重启桌面应用\n\n附加说明\n";
        let object = format!("object abc\ntype commit\ntag v1.2.4\ntagger example\n\n{notes}");
        assert_eq!(tag_body(&object).unwrap(), notes);
        assert!(tag_body("object abc\n\n\n").is_err());
    }
}
