#[cfg(target_os = "macos")]
extern "C" {
    fn outpost_set_window_controls(window: *mut std::ffi::c_void, visible: bool, x: f64, y: f64);
    fn outpost_sidebar_pointer_inside(window: *mut std::ffi::c_void, width: f64) -> bool;
}

// Called only from Tauri's main-thread setup, before the first window paint.
#[cfg(target_os = "macos")]
pub fn prepare_window(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    unsafe { outpost_set_window_controls(window.ns_window()?, false, 24.0, 35.0) };
    Ok(())
}

#[cfg(target_os = "macos")]
async fn on_main<T: Send + 'static>(
    window: tauri::WebviewWindow,
    action: impl FnOnce(*mut std::ffi::c_void) -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let result = target
                .ns_window()
                .map(action)
                .map_err(|error| error.to_string());
            let _ = sender.try_send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or("Window closed before updating its controls")?
}

#[tauri::command]
pub async fn set_sidebar_window_controls(
    window: tauri::WebviewWindow,
    visible: bool,
    x: f64,
    y: f64,
) -> Result<(), String> {
    if !x.is_finite()
        || !y.is_finite()
        || !(0.0..=10000.0).contains(&x)
        || !(0.0..=10000.0).contains(&y)
    {
        return Err("Invalid window-control position".into());
    }
    #[cfg(target_os = "macos")]
    return on_main(window, move |pointer| unsafe {
        outpost_set_window_controls(pointer, visible, x, y)
    })
    .await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, visible, x, y);
        Ok(())
    }
}

#[tauri::command]
pub async fn sidebar_pointer_inside(
    window: tauri::WebviewWindow,
    width: f64,
) -> Result<bool, String> {
    if !width.is_finite() || width < 0.0 {
        return Err("Invalid sidebar bounds".into());
    }
    #[cfg(target_os = "macos")]
    return on_main(window, move |pointer| unsafe {
        outpost_sidebar_pointer_inside(pointer, width)
    })
    .await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, width);
        Ok(false)
    }
}
