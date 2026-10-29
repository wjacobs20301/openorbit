//! Disk cache for map tiles. The web view requests tiles through the `tiles://` scheme,
//! so places the user has already viewed load instantly and keep working offline.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::http::{header, Request, Response, StatusCode};

const USER_AGENT: &str = concat!("GoogleEarthUltra/", env!("CARGO_PKG_VERSION"), " (open-source desktop globe)");

#[derive(Clone)]
pub struct TileCache {
    dir: PathBuf,
    client: reqwest::Client,
}

impl TileCache {
    pub fn new(dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(&dir)?;
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self { dir, client })
    }

    pub async fn serve(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let Some(url) = upstream_url(&request) else {
            return respond(StatusCode::BAD_REQUEST, Vec::new());
        };
        let path = self.path_for(&url);

        if let Ok(bytes) = read_file(&path).await {
            return respond(StatusCode::OK, bytes);
        }

        match self.client.get(&url).send().await {
            Ok(res) if res.status().is_success() => match res.bytes().await {
                Ok(bytes) => {
                    let bytes = bytes.to_vec();
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&path, &bytes);
                    respond(StatusCode::OK, bytes)
                }
                Err(_) => respond(StatusCode::BAD_GATEWAY, Vec::new()),
            },
            Ok(res) => respond(res.status(), Vec::new()),
            Err(_) => respond(StatusCode::BAD_GATEWAY, Vec::new()),
        }
    }

    /// Removes every cached tile and returns how many files were deleted.
    pub fn clear(&self) -> std::io::Result<usize> {
        let mut removed = 0;
        for shard in std::fs::read_dir(&self.dir)? {
            let shard = shard?.path();
            if shard.is_dir() {
                removed += std::fs::read_dir(&shard)?.count();
                std::fs::remove_dir_all(&shard)?;
            }
        }
        Ok(removed)
    }

    fn path_for(&self, url: &str) -> PathBuf {
        let hash = format!("{:x}", Sha256::digest(url.as_bytes()));
        self.dir.join(&hash[..2]).join(hash)
    }
}

/// `/https/host/a/b?q` -> `https://host/a/b?q`. Only http(s) upstreams are allowed.
fn upstream_url(request: &Request<Vec<u8>>) -> Option<String> {
    let uri = request.uri();
    let (scheme, rest) = uri.path().trim_start_matches('/').split_once('/')?;
    if scheme != "https" && scheme != "http" {
        return None;
    }
    Some(match uri.query() {
        Some(q) => format!("{scheme}://{rest}?{q}"),
        None => format!("{scheme}://{rest}"),
    })
}

async fn read_file(path: &Path) -> std::io::Result<Vec<u8>> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(std::io::Error::other)?
}

fn respond(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, sniff_content_type(&body))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "max-age=86400")
        .body(body)
        .unwrap()
}

fn sniff_content_type(body: &[u8]) -> &'static str {
    match body {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "application/octet-stream",
    }
}
