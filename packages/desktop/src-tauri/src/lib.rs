//! The desktop window (D7, ADR-0078): it shows the Vite bundle, which talks to the local daemon
//! over HTTP and WebSockets; the plugins give it system notifications and a way to open the
//! editor or a shell. No domain logic lives here. The one command the window can call starts the
//! daemon through the `metator` program when none runs (ADR-0101).

mod daemon;

/// The address of the daemon that serves `folder`, started in the background when none does.
/// Off the main thread: a daemon that has to start takes seconds.
#[tauri::command(async)]
fn ensure_daemon(folder: String) -> Result<String, String> {
    daemon::ensure(&folder)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ensure_daemon])
        .run(tauri::generate_context!())
        .expect("error while running the MetatorAI desktop app");
}
