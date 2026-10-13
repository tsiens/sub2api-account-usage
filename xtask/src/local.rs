use crate::{checked, command, installer_path, version, Result};
use std::{ffi::OsString, path::PathBuf};

pub fn build(args: &[OsString]) -> Result<()> {
    let mut install = true;
    let mut directory = PathBuf::from("S:/sub2api-account-usage");
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--skip-install") => install = false,
            Some("--install-dir") => {
                directory = PathBuf::from(arguments.next().ok_or("Missing --install-dir path")?)
            }
            _ => return Err("Unknown build option".into()),
        }
    }
    if install && !directory.is_absolute() {
        return Err("Installation directory must be absolute".into());
    }
    println!("Building app version {}", version()?);
    // Neither the build nor installation modifies the project's version files.
    checked(
        command("cargo").args(["tauri", "build", "--bundles", "nsis"]),
        "Tauri build",
    )?;
    let installer = installer_path()?;
    if !installer.is_file() {
        return Err(format!("Installer not found: {}", installer.display()).into());
    }
    println!("Installer: {}", installer.display());
    if !install {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let executable = directory.join("sub2api-account-usage.exe");
        windows::stop_app(&executable)?;
        checked(
            windows::hidden(&installer)
                .arg("/S")
                .arg(format!("/D={}", directory.display())),
            "Installer",
        )?;
        if !executable.is_file() {
            return Err("Installed application was not found".into());
        }
        windows::hidden(&executable)
            .current_dir(&directory)
            .spawn()?;
        println!("Installed and started: {}", executable.display());
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Local installation is available only on Windows".into())
    }
}

#[cfg(windows)]
mod windows {
    use crate::Result;
    use std::{
        mem::size_of,
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::Command,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
            },
        },
    };

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn hidden(program: &Path) -> Command {
        let mut command = Command::new(program);
        command.creation_flags(0x08000000);
        command
    }

    pub fn stop_app(executable: &Path) -> Result<()> {
        if !executable.exists() {
            return Ok(());
        }
        let expected = executable.canonicalize()?;
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let snapshot = OwnedHandle(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
        while found {
            let length = entry
                .szExeFile
                .iter()
                .position(|&character| character == 0)
                .unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..length])
                .eq_ignore_ascii_case("sub2api-account-usage.exe")
            {
                let process = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                        0,
                        entry.th32ProcessID,
                    )
                };
                if process.is_null() {
                    return Err(std::io::Error::last_os_error().into());
                }
                let process = OwnedHandle(process);
                let mut path = vec![0u16; 32768];
                let mut length = path.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut length)
                } == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                let actual = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]))
                    .canonicalize()?;
                if actual == expected
                    && unsafe { WaitForSingleObject(process.0, 0) } != WAIT_OBJECT_0
                {
                    if unsafe { TerminateProcess(process.0, 0) } == 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    if unsafe { WaitForSingleObject(process.0, 5000) } != WAIT_OBJECT_0 {
                        return Err("Previous app did not exit".into());
                    }
                }
            }
            found = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
        }
        Ok(())
    }
}
