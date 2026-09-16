use std::{mem::size_of, os::windows::ffi::OsStrExt};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, POINT, RECT},
    Graphics::{
        Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        Gdi::{
            GetDC, GetMonitorInfoW, GetPixel, MonitorFromWindow, ReleaseDC, MONITORINFO,
            MONITOR_DEFAULTTONEAREST,
        },
    },
    System::{
        Registry::{
            RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
            RRF_RT_REG_SZ,
        },
        SystemInformation::GetTickCount64,
    },
    UI::{
        Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
        WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowRect},
    },
};

const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "Sub2API Account Usage";

pub fn startup_enabled() -> Result<bool, String> {
    let expected = startup_command()?;
    let Some(value) = read_registry_string(RUN_KEY, RUN_VALUE)? else {
        return Ok(false);
    };
    Ok(value == expected)
}

pub fn set_startup_enabled(enabled: bool) -> Result<(), String> {
    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    let status = if enabled {
        let command = wide(&startup_command()?);
        unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                command.as_ptr().cast(),
                (command.len() * size_of::<u16>()) as u32,
            )
        }
    } else {
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) }
    };
    if status == ERROR_SUCCESS || (!enabled && status == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        Err(format!(
            "修改开机自启动失败：{}",
            std::io::Error::from_raw_os_error(status as i32)
        ))
    }
}

fn startup_command() -> Result<String, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法获取应用程序路径：{error}"))?;
    Ok(format!("\"{}\"", executable.display()))
}

fn read_registry_string(key: &str, name: &str) -> Result<Option<String>, String> {
    let key = wide(key);
    let name = wide(name);
    let mut byte_count = 0u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut byte_count,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(format!(
            "读取开机自启动失败：{}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    let mut value = vec![0u16; (byte_count as usize).div_ceil(size_of::<u16>())];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            value.as_mut_ptr().cast(),
            &mut byte_count,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!(
            "读取开机自启动失败：{}",
            std::io::Error::from_raw_os_error(status as i32)
        ));
    }
    let length = value
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(value.len());
    Ok(Some(String::from_utf16_lossy(&value[..length])))
}

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}

pub fn idle_seconds() -> u64 {
    let mut input = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut input) } == 0 {
        return 0;
    }
    let uptime = unsafe { GetTickCount64() };
    uptime.saturating_sub(input.dwTime as u64) / 1000
}

pub fn foreground_is_fullscreen() -> bool {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return false;
    }
    let mut class_name = [0u16; 256];
    let length = unsafe { GetClassNameW(window, class_name.as_mut_ptr(), class_name.len() as i32) };
    let class_name = String::from_utf16_lossy(&class_name[..length.max(0) as usize]);
    if matches!(
        class_name.as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return false;
    }
    let mut window_rect = RECT::default();
    if unsafe { GetWindowRect(window, &mut window_rect) } == 0 {
        return false;
    }
    let mut visible_rect = RECT::default();
    if unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut visible_rect as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        )
    } == 0
    {
        window_rect = visible_rect;
    }
    let monitor = unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return false;
    }
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT::default(),
        rcWork: RECT::default(),
        dwFlags: 0,
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return false;
    }
    rect_covers_monitor(&window_rect, &info.rcMonitor)
}

fn rect_covers_monitor(window: &RECT, monitor: &RECT) -> bool {
    const TOLERANCE: i32 = 2;
    (window.left - monitor.left).abs() <= TOLERANCE
        && (window.top - monitor.top).abs() <= TOLERANCE
        && (window.right - monitor.right).abs() <= TOLERANCE
        && (window.bottom - monitor.bottom).abs() <= TOLERANCE
}

pub fn background_theme(x: i32, y: i32, width: i32, height: i32) -> Option<&'static str> {
    let points = [
        POINT {
            x: x + width / 2,
            y: y - 6,
        },
        POINT {
            x: x + width / 2,
            y: y + height + 6,
        },
        POINT {
            x: x - 6,
            y: y + height / 2,
        },
        POINT {
            x: x + width + 6,
            y: y + height / 2,
        },
        POINT {
            x: x + 12,
            y: y - 5,
        },
        POINT {
            x: x + width - 12,
            y: y + height + 5,
        },
    ];
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return None;
    }
    let mut red = 0u32;
    let mut green = 0u32;
    let mut blue = 0u32;
    let mut count = 0u32;
    for point in points {
        let pixel = unsafe { GetPixel(dc, point.x, point.y) };
        if pixel == u32::MAX {
            continue;
        }
        red += pixel & 0xff;
        green += (pixel >> 8) & 0xff;
        blue += (pixel >> 16) & 0xff;
        count += 1;
    }
    unsafe { ReleaseDC(std::ptr::null_mut(), dc) };
    if count == 0 {
        return None;
    }
    let luminance = (red / count) as f64 * 0.299
        + (green / count) as f64 * 0.587
        + (blue / count) as f64 * 0.114;
    Some(if luminance >= 160.0 { "light" } else { "dark" })
}

#[cfg(test)]
mod tests {
    use super::rect_covers_monitor;
    use windows_sys::Win32::Foundation::RECT;

    #[test]
    fn fullscreen_comparison_allows_small_frame_rounding_only() {
        let monitor = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        assert!(rect_covers_monitor(
            &RECT {
                left: -1,
                top: 0,
                right: 1921,
                bottom: 1080,
            },
            &monitor
        ));
        assert!(!rect_covers_monitor(
            &RECT {
                left: 0,
                top: 0,
                right: 1920,
                bottom: 1040,
            },
            &monitor
        ));
    }
}
