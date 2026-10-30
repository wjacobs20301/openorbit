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

/// Writes a PNG the user picked in the native "Save as" dialog (Save Image).
#[tauri::command]
fn write_png_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let is_png = Path::new(&path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"));
    if !is_png || !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("Only PNG images can be written".into());
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Writes a video or KMZ the user picked in the "Save as" dialog. The bytes arrive raw
/// (these can be large); the path comes percent-encoded in the `x-path` header.
#[tauri::command]
fn write_binary_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw file bytes".into());
    };
    let path = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .ok_or("Missing path")?;
    let allowed = Path::new(&path).extension().is_some_and(|ext| {
        ["mp4", "webm", "kmz"]
            .iter()
            .any(|ok| ext.eq_ignore_ascii_case(ok))
    });
    if !allowed {
        return Err("Only MP4, WebM or KMZ files can be written".into());
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// Decodes %XX escapes (the path is sent with encodeURIComponent).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        .invoke_handler(tauri::generate_handler![
            write_text_file,
            write_png_file,
            write_binary_file,
            clear_tile_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenOrbit");
}
