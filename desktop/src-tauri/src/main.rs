#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod oauth_callback;
mod sse;
mod transport;
mod window_controls;

use tauri::Manager;

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                window_controls::prepare_window(&window)?;
            }
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            std::fs::File::open(directory.parent().ok_or("Missing app directory parent")?)?
                .sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
            }
            let legacy = transport::State::new(directory.clone())?;
            let setup =
                transport::server_setup::Setup::new(directory.clone()).unwrap_or_else(|error| {
                    transport::server_setup::Setup::unavailable(directory.clone(), error)
                });
            let registry =
                transport::environments::Registry::new(directory, legacy.mutation_gate())?;
            // Fence stale ephemeral routes before the webview can issue its first request.
            let _ = setup.restore_bindings(&registry);
            app.manage(transport::server_setup::terminal::Terminals::default());
            app.manage(transport::server_setup::reboot::Reboots::default());
            app.manage(std::sync::Arc::new(setup));
            app.manage(registry);
            app.manage(legacy);
            app.manage(oauth_callback::State::default());
            tauri::async_runtime::spawn(transport::server_setup::lifecycle::run(
                app.handle().clone(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            transport::server_setup::setup_list,
            transport::server_setup::terminal::terminal_target,
            transport::server_setup::terminal::terminal_open,
            transport::server_setup::terminal::terminal_read,
            transport::server_setup::terminal::terminal_write,
            transport::server_setup::terminal::terminal_resize,
            transport::server_setup::terminal::terminal_close,
            transport::server_setup::reboot::server_reboot_review,
            transport::server_setup::reboot::server_reboot_apply,
            transport::server_setup::reboot::server_reboot_status,
            transport::server_setup::restart::setup_restart_candidates,
            transport::server_setup::restart::setup_restart_review,
            transport::server_setup::restart::setup_restart_stop,
            transport::server_setup::restart::setup_restart_apply,
            transport::server_setup::restart::setup_restart_status,
            transport::server_setup::setup_export_log,
            transport::server_setup::history::setup_history_list,
            transport::server_setup::history::setup_history_archive,
            transport::server_setup::history::setup_history_restore,
            transport::server_setup::diagnostics::setup_diagnostics,
            transport::server_setup::diagnostics::setup_diagnostics_cancel,
            transport::server_setup::diagnostics::setup_diagnostics_export,
            transport::server_setup::diagnostics::setup_diagnostic_guide,
            transport::server_setup::connections_wake,
            transport::server_setup::setup_choose_identity,
            transport::server_setup::setup_scan,
            transport::server_setup::setup_trust,
            transport::server_setup::setup_inspect,
            transport::server_setup::setup_tunnel,
            transport::server_setup::setup_disconnect,
            transport::provider_transfer::provider_transfer_review,
            transport::provider_transfer::provider_transfer_start,
            transport::server_setup::auto_update::automatic_updates_status,
            transport::server_setup::auto_update::automatic_updates_enable,
            transport::server_setup::auto_update::automatic_updates_disable,
            transport::server_setup::auto_update::automatic_updates_tick,
            transport::server_setup::auto_update::automatic_updates_recover,
            transport::server_setup::update::environment_update_check,
            transport::server_setup::update::environment_update_start,
            transport::server_setup::update::environment_update_status,
            transport::server_setup::update::environment_update_cancel,
            transport::server_setup::install::setup_plan,
            transport::server_setup::install::setup_install,
            transport::server_setup::install::setup_install_status,
            transport::server_setup::install::setup_install_cancel,
            transport::server_setup::install::setup_finish,
            window_controls::set_sidebar_window_controls,
            window_controls::sidebar_pointer_inside,
            window_controls::set_window_blur,
            transport::environments::environment_remove,
            transport::environments::environment_list,
            transport::environments::environment_discover,
            transport::environments::environment_register,
            transport::environments::environment_select,
            transport::environments::environment_rename,
            transport::environments::environment_disconnect,
            transport::environments::environment_connection_policy,
            transport::environments::environment_connection_info,
            transport::environments::environment_query,
            transport::environments::environment_browser_request,
            transport::environments::environment_agent_request,
            transport::environments::environment_send_command,
            transport::environments::environment_retry_command,
            transport::environments::environment_enroll_device,
            transport::environments::environment_stream_events,
            transport::environments::environment_artifact,
            transport::environments::environment_save_artifact,
            transport::environments::environment_save_workspace_file,
            transport::connection_info,
            transport::set_endpoint,
            transport::clear_legacy_endpoint,
            transport::query,
            transport::agent_request,
            transport::browser_request,
            oauth_callback::oauth_callback_start,
            oauth_callback::oauth_callback_wait,
            oauth_callback::oauth_callback_cancel,
            transport::stream_events,
            transport::disconnect,
            transport::send_command,
            transport::retry_command,
            transport::pair,
            transport::enroll_device,
            transport::artifact,
            transport::save_artifact,
            transport::save_workspace_file,
            transport::open_url
        ])
        .build(tauri::generate_context!())
        .expect("Outpost could not start");
    app.run(|app, event| {
        let setup = app.state::<std::sync::Arc<transport::server_setup::Setup>>();
        match event {
            tauri::RunEvent::Exit => {
                app.state::<transport::server_setup::reboot::Reboots>()
                    .close();
                app.state::<transport::server_setup::terminal::Terminals>()
                    .close();
                setup.close();
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Focused(true),
                ..
            } => setup.wake(),
            _ => {}
        }
    });
}
