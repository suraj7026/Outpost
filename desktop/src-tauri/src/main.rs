#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sse;
mod transport;
mod window_controls;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                window_controls::prepare_window(&window)?;
            }
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            }
            app.manage(transport::State::new(directory)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_controls::set_sidebar_window_controls,
            window_controls::sidebar_pointer_inside,
            transport::connection_info,
            transport::set_endpoint,
            transport::query,
            transport::agent_request,
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
