// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Windows 壳（Tauri 2）：
//!   * 加载 Taro 产出的 H5（`client/dist`，hash 路由，见 tauri.conf.json）
//!   * 系统托盘常驻 + 关闭时收进托盘
//!   * 开机自启（tauri-plugin-autostart）
//!   * 本地通知（tauri-plugin-notification）+ Rust 侧定时线程
//!
//! 滚动排程的「排程表」由前端通过 `set_schedule` 整体推送（先取消全部再由前端重算），
//! Rust 侧只负责「到点弹窗」，即使窗口最小化/隐藏也照常触发；
//! 触发过的条目通过 `qqsa://fired` 事件与 `take_last_fired` 交给前端做点击跳转。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_single_instance::init as single_instance;

/// 与前端 `NotifyRequest` 一一对应（camelCase，见 src/services/notify/tauri.ts）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    pub id: String,
    pub title: String,
    pub body: String,
    /// 触发时间：epoch 毫秒
    pub at: i64,
    #[serde(default)]
    pub high_priority: bool,
    #[serde(default)]
    pub route: String,
    #[serde(default)]
    pub alert_id: String,
    #[serde(default)]
    pub item_id: String,
}

#[derive(Default)]
pub struct SchedulerState {
    /// 当前待触发的滚动窗口（由前端整体替换）
    entries: Mutex<Vec<ScheduleEntry>>,
    /// 已触发但前端还没取走的条目（用于 alert 去重）
    fired: Mutex<Vec<ScheduleEntry>>,
    /// 最近一次触发（用于前端启动时补做点击跳转）
    last_fired: Mutex<Option<ScheduleEntry>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 启动日志：release 无控制台时唯一的诊断线索
// ---------------------------------------------------------------------------

/// 追加一行到 `%LOCALAPPDATA%\Autonotice\app.log`；任何失败都静默忽略（绝不因为它再崩）
fn append_log(line: &str) {
    let dir = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Autonotice");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    else {
        return;
    };
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{secs}] {line}");
}

// ---------------------------------------------------------------------------
// 前端可调用的命令
// ---------------------------------------------------------------------------

/// 用新的滚动窗口整体替换排程表（前端已先取消全部旧排程）
#[tauri::command]
fn set_schedule(state: State<'_, SchedulerState>, entries: Vec<ScheduleEntry>) -> usize {
    let mut guard = state.entries.lock().unwrap();
    *guard = entries;
    guard.len()
}

#[tauri::command]
fn clear_schedule(state: State<'_, SchedulerState>) {
    state.entries.lock().unwrap().clear();
}

/// 取走「已触发」列表（用于高优告警去重）
#[tauri::command]
fn take_fired(state: State<'_, SchedulerState>) -> Vec<ScheduleEntry> {
    std::mem::take(&mut *state.fired.lock().unwrap())
}

/// 取走「最近一次触发」（用于启动/回前台时补跳转）
#[tauri::command]
fn take_last_fired(state: State<'_, SchedulerState>) -> Option<ScheduleEntry> {
    state.last_fired.lock().unwrap().take()
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn send_now(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Rust 侧定时线程（不依赖 WebView 存活）
// ---------------------------------------------------------------------------

fn spawn_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));

        let now = now_ms();
        let due: Vec<ScheduleEntry> = {
            let state = app.state::<SchedulerState>();
            let mut guard = match state.entries.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            let (due, rest): (Vec<ScheduleEntry>, Vec<ScheduleEntry>) =
                guard.drain(..).partition(|e| e.at <= now);
            *guard = rest;
            due
        };

        if due.is_empty() {
            continue;
        }

        let state = app.state::<SchedulerState>();
        for entry in due {
            let _ = app
                .notification()
                .builder()
                .title(entry.title.clone())
                .body(entry.body.clone())
                .show();

            if let Ok(mut fired) = state.fired.lock() {
                fired.push(entry.clone());
            }
            if let Ok(mut last) = state.last_fired.lock() {
                *last = Some(entry.clone());
            }
            // 通知已弹出；前端监听该事件即可在用户点击窗口时直达详情
            let _ = app.emit("qqsa://fired", entry.clone());
        }
    });
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &autostart_item, &separator, &quit_item])?;

    let autostart_toggle = autostart_item.clone();

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Autonotice")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let _ = if enabled { manager.disable() } else { manager.enable() };
                let _ = autostart_toggle.set_checked(!enabled);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------

fn main() {
    // release 无控制台：把 panic / 致命错误落盘，避免「双击没反应、毫无线索」
    std::panic::set_hook(Box::new(|info| append_log(&format!("panic: {info}"))));
    append_log("--- app start ---");

    let result = tauri::Builder::default()
        // 单实例：多次双击 exe 不再生成第二个进程，而是把已存在窗口拉到前台
        .plugin(single_instance(|app, _argv, _reason| {
            append_log("single-instance: duplicate launch, focusing existing window");
            focus_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--minimized")
                .build(),
        )
        .manage(SchedulerState::default())
        .invoke_handler(tauri::generate_handler![
            set_schedule,
            clear_schedule,
            take_fired,
            take_last_fired,
            set_autostart,
            autostart_enabled,
            send_now
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            append_log("setup: begin");

            // 托盘失败不阻断启动：窗口该显示还是显示
            if let Err(e) = setup_tray(&handle) {
                append_log(&format!("setup_tray failed (窗口仍会显示): {e}"));
            }
            spawn_scheduler(handle.clone());

            // 开机自启带 --minimized：直接收进托盘
            let minimized = std::env::args().any(|a| a == "--minimized");
            match handle.get_webview_window("main") {
                Some(window) => {
                    if minimized {
                        let _ = window.hide();
                        append_log("setup: started minimized");
                    } else {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                        append_log("setup: main window shown");
                    }
                }
                None => append_log("setup: main window not found (config visible=true 兜底显示)"),
            }
            append_log("setup: done");
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 = 收进托盘；定时线程继续工作，保证到点仍能提醒
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!());

    if let Err(e) = result {
        append_log(&format!("fatal: {e}"));
    }
}
