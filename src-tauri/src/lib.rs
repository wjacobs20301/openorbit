mod tile_cache;

use std::path::Path;
use tauri::Manager;
use tile_cache::TileCache;

/// Writes a file the user picked in the native "Save as" dialog. Only KML is allowed.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let is_kml = Path::new(&path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("kml"));
    if !is_kml {
        return Err("Only .kml files can be written".into());
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_tile_cache(cache: tauri::State<'_, TileCache>) -> Result<usize, String> {
    cache.clear().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_cache_dir()?.join("tiles");
            app.manage(TileCache::new(dir)?);
            Ok(())
        })
        // `tiles://localhost/https/host/path` fetches https://host/path once and serves it from disk afterwards.
        .register_asynchronous_uri_scheme_protocol("tiles", |ctx, request, responder| {
            let cache = ctx.app_handle().state::<TileCache>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(cache.serve(request).await);
            });
        })
        .invoke_handler(tauri::generate_handler![write_text_file, clear_tile_cache])
        .run(tauri::generate_context!())
        .expect("error while running OpenOrbit");
}
