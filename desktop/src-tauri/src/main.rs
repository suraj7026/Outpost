#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sse;
mod transport;

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn outpost_install_sidebar(
        window: *mut c_void,
        webview: *mut c_void,
        callback: unsafe extern "C" fn(*const c_char),
    );
    fn outpost_update_sidebar(items: *const c_char, selected: *const c_char);
}

unsafe extern "C" fn navigate(value: *const c_char) {
    if value.is_null() {
        return;
    }
    let id = CStr::from_ptr(value).to_string_lossy().into_owned();
    if let Some(app) = APP.get() {
        let _ = app.emit("outpost:navigate", id);
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SidebarItem {
    id: String,
    title: String,
    icon: String,
    kind: String,
}

#[tauri::command]
fn update_sidebar(
    app: tauri::AppHandle,
    items: Vec<SidebarItem>,
    selected: String,
) -> Result<(), String> {
    if items.len() > 100
        || items
            .iter()
            .any(|item| item.title.len() > 500 || item.id.len() > 100)
    {
        return Err("Invalid sidebar items".into());
    }
    #[cfg(target_os = "macos")]
    {
        let json = CString::new(serde_json::to_string(&items).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let selection = CString::new(selected).map_err(|e| e.to_string())?;
        app.run_on_main_thread(move || unsafe {
            outpost_update_sidebar(json.as_ptr(), selection.as_ptr());
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            }
            app.manage(transport::State::new(directory)?);
            let _ = APP.set(app.handle().clone());
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                let pointer = window.ns_window()? as usize;
                let webview: &tauri::Webview = window.as_ref();
                webview.set_auto_resize(false)?;
                window.with_webview(move |webview| unsafe {
                    outpost_install_sidebar(pointer as *mut c_void, webview.inner(), navigate);
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            update_sidebar,
            transport::connection_info,
            transport::set_endpoint,
            transport::query,
            transport::stream_events,
            transport::send_command,
            transport::retry_command,
            transport::pair,
            transport::enroll_device,
            transport::artifact,
            transport::save_artifact,
            transport::open_url
        ])
        .run(tauri::generate_context!())
        .expect("Outpost desktop could not start");
}
