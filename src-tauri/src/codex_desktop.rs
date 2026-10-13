use std::{collections::HashSet, mem::size_of, thread, time::Duration};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER, ERROR_SUCCESS, HANDLE,
        HWND, INVALID_HANDLE_VALUE, LPARAM, WAIT_OBJECT_0,
    },
    Storage::Packaging::Appx::GetApplicationUserModelId,
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE},
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        Threading::{
            OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        },
    },
    UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, PostMessageW, SW_SHOWNORMAL, WM_CLOSE,
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

struct Process {
    id: u32,
    parent: u32,
    name: String,
}

fn processes() -> Result<Vec<Process>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "读取进程列表失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut result = Vec::new();
    let mut available = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    while available {
        let length = entry
            .szExeFile
            .iter()
            .position(|&value| value == 0)
            .unwrap_or(entry.szExeFile.len());
        result.push(Process {
            id: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
            name: String::from_utf16_lossy(&entry.szExeFile[..length]),
        });
        available = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    Ok(result)
}

fn application_id(process: HANDLE) -> Option<String> {
    let mut length = 0;
    if unsafe { GetApplicationUserModelId(process, &mut length, std::ptr::null_mut()) }
        != ERROR_INSUFFICIENT_BUFFER
    {
        return None;
    }
    let mut value = vec![0u16; length as usize];
    if unsafe { GetApplicationUserModelId(process, &mut length, value.as_mut_ptr()) }
        != ERROR_SUCCESS
    {
        return None;
    }
    let length = value
        .iter()
        .position(|&character| character == 0)
        .unwrap_or(value.len());
    let id = String::from_utf16_lossy(&value[..length]);
    id.starts_with("OpenAI.Codex_").then_some(id)
}

fn running_desktops(snapshot: &[Process]) -> Vec<(u32, String)> {
    snapshot
        .iter()
        .filter_map(|process| {
            if !process.name.eq_ignore_ascii_case("ChatGPT.exe")
                && !process.name.eq_ignore_ascii_case("Codex.exe")
            {
                return None;
            }
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.id) };
            if handle.is_null() {
                return None;
            }
            let handle = OwnedHandle(handle);
            application_id(handle.0).map(|id| (process.id, id))
        })
        .collect()
}

fn process_tree(snapshot: &[Process], roots: &HashSet<u32>) -> HashSet<u32> {
    let mut tree = roots.clone();
    loop {
        let before = tree.len();
        for process in snapshot {
            if tree.contains(&process.parent) {
                tree.insert(process.id);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

fn restart_tree(snapshot: &[Process], roots: &HashSet<u32>, current: u32) -> HashSet<u32> {
    // This app or VS Code may have been launched by Codex. Leave their trees running.
    let mut protected = HashSet::from([current]);
    for process in snapshot {
        if process.name.eq_ignore_ascii_case("Code.exe")
            || process.name.eq_ignore_ascii_case("Code - Insiders.exe")
        {
            protected.insert(process.id);
        }
    }
    process_tree(snapshot, roots)
        .difference(&process_tree(snapshot, &protected))
        .copied()
        .collect()
}

unsafe extern "system" fn close_window(window: HWND, context: LPARAM) -> i32 {
    let roots = unsafe { &*(context as *const HashSet<u32>) };
    let mut id = 0;
    unsafe {
        GetWindowThreadProcessId(window, &mut id);
    }
    if roots.contains(&id) {
        unsafe {
            PostMessageW(window, WM_CLOSE, 0, 0);
        }
    }
    1
}

pub fn restart() -> Result<String, String> {
    let snapshot = processes()?;
    let desktops = running_desktops(&snapshot);
    let Some((_, launch_id)) = desktops.first() else {
        return Ok("Codex 未运行，无需重启。".into());
    };
    let ids: HashSet<_> = desktops.iter().map(|(id, _)| *id).collect();
    let roots: HashSet<_> = snapshot
        .iter()
        .filter(|process| ids.contains(&process.id) && !ids.contains(&process.parent))
        .map(|process| process.id)
        .collect();
    let tree = restart_tree(&snapshot, &roots, std::process::id());
    // Hold handles before closing any windows, so a reused PID cannot target a different app.
    let mut handles = Vec::new();
    for id in tree {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                id,
            )
        };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                continue;
            }
            return Err(format!("无法结束 Codex 的进程，请检查权限后重试：{error}"));
        }
        let handle = OwnedHandle(handle);
        if roots.contains(&id) && application_id(handle.0).as_ref() != Some(launch_id) {
            return Err("Codex 运行状态已变化，请重新点击重启。".into());
        }
        handles.push(handle);
    }
    unsafe {
        EnumWindows(Some(close_window), &roots as *const HashSet<u32> as LPARAM);
    }
    thread::sleep(Duration::from_millis(1000));
    for handle in &handles {
        if unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0
            && unsafe { TerminateProcess(handle.0, 0) } == 0
            && unsafe { WaitForSingleObject(handle.0, 0) } != WAIT_OBJECT_0
        {
            return Err(format!(
                "退出 Codex 失败：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    for handle in &handles {
        if unsafe { WaitForSingleObject(handle.0, 5000) } != WAIT_OBJECT_0 {
            return Err("Codex 尚未退出，请稍后重试。".into());
        }
    }
    let initialized = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    } >= 0;
    let operation: Vec<_> = "open\0".encode_utf16().collect();
    // AppsFolder resolves the currently installed version from the process's app identity.
    let target: Vec<_> = format!("shell:AppsFolder\\{launch_id}\0")
        .encode_utf16()
        .collect();
    let launched = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
    if launched <= 32 {
        return Err("启动 Codex 失败，请从开始菜单打开。".into());
    }
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(500));
        if running_desktops(&processes()?)
            .iter()
            .any(|(_, id)| id == launch_id)
        {
            return Ok("Codex 已重启。".into());
        }
    }
    Err("已发送启动请求，但未检测到 Codex 启动，请从开始菜单打开。".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_excludes_other_apps_and_includes_nested_children() {
        let snapshot = vec![
            Process {
                id: 100,
                parent: 1,
                name: "ChatGPT.exe".into(),
            },
            Process {
                id: 102,
                parent: 101,
                name: "codex.exe".into(),
            },
            Process {
                id: 101,
                parent: 100,
                name: "ChatGPT.exe".into(),
            },
            Process {
                id: 200,
                parent: 1,
                name: "ChatGPT.exe".into(),
            },
        ];
        assert_eq!(
            process_tree(&snapshot, &HashSet::from([100])),
            HashSet::from([100, 101, 102])
        );
    }

    #[test]
    fn restart_leaves_this_app_and_vscode_running_even_when_codex_launched_them() {
        let snapshot = vec![
            Process {
                id: 100,
                parent: 1,
                name: "ChatGPT.exe".into(),
            },
            Process {
                id: 101,
                parent: 100,
                name: "codex.exe".into(),
            },
            Process {
                id: 102,
                parent: 101,
                name: "sub2api-account-usage.exe".into(),
            },
            Process {
                id: 103,
                parent: 102,
                name: "helper.exe".into(),
            },
            Process {
                id: 200,
                parent: 101,
                name: "Code.exe".into(),
            },
            Process {
                id: 201,
                parent: 200,
                name: "Code.exe".into(),
            },
        ];
        assert_eq!(
            restart_tree(&snapshot, &HashSet::from([100]), 102),
            HashSet::from([100, 101])
        );
    }

    #[test]
    #[ignore = "只读诊断本机的 Codex 桌面应用，不执行重启"]
    fn inspect_running_desktops() {
        let detected = running_desktops(&processes().expect("读取进程列表"));
        for (id, launch_id) in &detected {
            println!("Codex PID={id}, launch_id={launch_id}");
        }
        println!("检测到 {} 个 Codex 桌面进程", detected.len());
    }
}
