//! The desktop window (D7, ADR-0078): it only shows the Vite bundle, which talks to the local
//! daemon over HTTP and WebSockets; the plugins give it system notifications and a way to open
//! the editor or a shell. No domain logic lives here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running the MetatorAI desktop app");
}
