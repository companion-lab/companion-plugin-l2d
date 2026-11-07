//! Live2D avatar backend for companion.
//!
//! Model library: the bundled model ships in the plugin package's
//! `assets/models/`; user-imported models live in the plugin data dir
//! (`plugins-data/<id>/models/`). Model files stream to the webview through
//! the Tauri asset protocol (`l2d.load_model` returns absolute paths; the
//! assetProtocol scope covers both roots) — see the README for why base64
//! over IPC doesn't scale to a multi-file bundle.
//!
//! Imports arrive from the settings window in chunks (multi-MB base64 IPC
//! responses wedge the webview after a few calls, so nothing crosses IPC in
//! one piece): `l2d.import_begin` opens a staging dir, `l2d.import_chunk`
//! appends offset-checked chunks, `l2d.import_commit` places the tree as a
//! new model (unzipping when the session is a zip). Offsets make chunk
//! retries idempotent.
//!
//! RPC surface (called via `ctx.backend.call` from the frontend):
//! - `l2d.list_models` → `{ models: [{ id, name, dir, settingsFile, kind }] }`
//! - `l2d.load_model { id }` → `{ id, name, kind, dir, dirAbs, settingsFile,
//!   corePath, files: [{ path, abs }] }`
//! - `l2d.read_file { id, path }` → `{ path, base64 }` (small files)
//! - `l2d.core` → bare base64 of the Cubism Core runtime (~207 KB)
//! - `l2d.import_begin { name }` → `{ token }`
//! - `l2d.import_chunk { token, path, offset, base64 }` → `{ received: n }`
//! - `l2d.import_commit { token, mode, name }` → `{ id, name }`
//! - `l2d.delete_model { id }` → `{}`
//! - `companion-plugin-l2d.ping` → `{ pong: true }`
//!
//! The Cubism Core is served as a runtime `<script>` (blob URL) instead of
//! being bundled: its emscripten preamble statically requires node `fs`/
//! `path` fallbacks that a browser bundle must not reference.

use companion_plugin_sdk::{export_plugin, Plugin, PluginCtx, ToolDef};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Multi-dot Cubism file names matched by suffix — `Path::extension()` only
/// yields the last segment ("json"), which would exclude every settings,
/// motion and expression file.
const MODEL_NAME_SUFFIXES: &[&str] = &[
    ".model3.json",
    ".physics3.json",
    ".cdi3.json",
    ".motion3.json",
    ".exp3.json",
    ".userdata3.json",
    ".pose3.json",
];

/// Single-extension model files matched by extension.
const MODEL_FILE_EXTS: &[&str] = &["moc3", "png", "jpg", "jpeg", "webp"];

fn is_model_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if MODEL_NAME_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return true;
    }
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| MODEL_FILE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Per-file and per-session import caps (the IceGirl bundle is ~19 MB; these
/// are abuse guards, not UX limits).
const MAX_IMPORT_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMPORT_SESSION_BYTES: u64 = 256 * 1024 * 1024;
const IMPORT_TMP_DIR: &str = "import-tmp";
const CUSTOM_MODELS_DIR: &str = "models";

/// Sanitize a relative path coming from the webview (upload entry or zip
/// entry): backslashes normalize to separators, then every component must be
/// a plain name — no absolute, no `..`, no empty.
fn sanitize_rel_path(rel: &str) -> Result<PathBuf, String> {
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(format!("path must be relative: {rel}"));
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(&normalized).components() {
        match comp {
            std::path::Component::Normal(part) => clean.push(part),
            _ => return Err(format!("unsafe path component in {rel}")),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("empty path".into());
    }
    Ok(clean)
}

/// Sanitize a user-provided model name: separators, control characters and
/// dots become `-` (dots add nothing and `..` games die here), trim, cap
/// length. Empty results are rejected.
fn sanitize_model_name(name: &str) -> Result<String, String> {
    let mut clean = String::new();
    for ch in name.chars() {
        if ch.is_alphanumeric() || matches!(ch, '-' | '_' | ' ' | '(' | ')') {
            clean.push(ch);
        } else {
            clean.push('-');
        }
    }
    let clean = clean.trim().trim_matches('-').trim().to_string();
    let clean = clean.chars().take(80).collect::<String>();
    if clean.is_empty() {
        return Err("invalid model name".into());
    }
    Ok(clean)
}

/// First free directory name under `root`: `base`, `base-2`, `base-3`, …
fn free_dir_name(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    for n in 2..10_000 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", std::process::id())
}

/// One model dir under `root`: `(dir, settings file stem, settings file)`,
/// sorted by dir name. A model dir holds at least one `*.model3.json` (the
/// first sorted one wins — model dirs ship exactly one).
fn scan_model_dirs(root: &Path) -> Vec<(PathBuf, String, String)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let mut settings: Vec<String> = Vec::new();
        if let Ok(files) = fs::read_dir(&dir) {
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().into_owned();
                if name.ends_with(".model3.json") {
                    settings.push(name);
                }
            }
        }
        settings.sort();
        let Some(settings_file) = settings.into_iter().next() else {
            continue;
        };
        let stem = settings_file
            .strip_suffix(".model3.json")
            .unwrap_or(&settings_file)
            .to_owned();
        out.push((dir, stem, settings_file));
    }
    out
}

/// Manifest-worthy relative paths inside a model dir (sorted for stable
/// ordering across the IPC boundary).
fn model_files(dir: &Path) -> Result<Vec<String>, String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> Result<(), String> {
        for entry in
            fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?.flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let path = entry.path();
            if path.is_dir() {
                walk(&path, &rel, out)?;
            } else if is_model_file(&name) {
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(dir, "", &mut files)?;
    files.sort();
    Ok(files)
}

// ─── Import sessions ───

fn staging_dir(tmp_root: &Path, token: &str) -> Result<PathBuf, String> {
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("invalid import token".into());
    }
    let dir = tmp_root.join(format!("import-{token}"));
    if !dir.is_dir() {
        return Err("unknown import session (expired or already committed)".into());
    }
    Ok(dir)
}

fn session_total_path(staging: &Path) -> PathBuf {
    staging.join(".import-total")
}

fn session_total(staging: &Path) -> u64 {
    fs::read_to_string(session_total_path(staging))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Open a staging dir for one import session. The token namespaces the
/// session in the shared tmp root (single-user local app: nanotime + a
/// process-local counter is plenty).
fn import_begin(tmp_root: &Path, _name: &str) -> Result<String, String> {
    fs::create_dir_all(tmp_root).map_err(|e| format!("create tmp dir: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let token = format!("i{nanos:x}{seq:02x}");
    let staging = tmp_root.join(format!("import-{token}"));
    fs::create_dir_all(&staging).map_err(|e| format!("create staging dir: {e}"))?;
    fs::write(session_total_path(&staging), "0").map_err(|e| format!("init total: {e}"))?;
    Ok(token)
}

/// Append one offset-checked chunk. `offset == 0` (re)starts the file — a
/// retried zero-offset chunk truncates, so the frontend can recover from a
/// wedged file transfer by restarting it.
fn import_chunk(
    tmp_root: &Path,
    token: &str,
    rel: &str,
    offset: u64,
    base64_data: &str,
) -> Result<u64, String> {
    use base64::Engine;
    let staging = staging_dir(tmp_root, token)?;
    let rel_path = sanitize_rel_path(rel)?;
    if rel_path.file_name().map(|n| n == ".import-total").unwrap_or(false)
        || rel_path.to_string_lossy().starts_with(".import-total")
    {
        return Err("reserved file name".into());
    }
    let path = staging.join(&rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if offset == 0 {
        fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    } else {
        let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len != offset {
            return Err(format!(
                "offset mismatch for {rel}: have {len}, expected {offset} — restart the file"
            ));
        }
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|e| format!("open {}: {e}", path.display()))?;
        f.write_all(&bytes).map_err(|e| format!("append {}: {e}", path.display()))?;
    }
    let written = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if written > MAX_IMPORT_FILE_BYTES {
        let _ = fs::remove_file(&path);
        return Err(format!("{rel} exceeds the per-file size limit"));
    }
    let total = session_total(&staging) + bytes.len() as u64;
    if total > MAX_IMPORT_SESSION_BYTES {
        return Err("import exceeds the session size limit".into());
    }
    let _ = fs::write(session_total_path(&staging), total.to_string());
    Ok(written)
}

/// If `dir` holds exactly one subdirectory and no files, lift that
/// subdirectory's contents up one level (zips that wrap everything in a
/// folder) — after this, `dir` IS the model dir.
fn flatten_single_root(dir: &Path) -> Result<(), String> {
    let entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .flatten()
        .map(|e| e.path())
        .collect();
    if entries.iter().any(|p| p.is_file()) || entries.len() != 1 || !entries[0].is_dir() {
        return Ok(());
    }
    let inner = entries[0].clone();
    for child in fs::read_dir(&inner).map_err(|e| format!("read {}: {e}", inner.display()))?.flatten() {
        let target = dir.join(child.file_name());
        if target.exists() {
            return Err(format!("cannot flatten: {} exists", target.display()));
        }
        fs::rename(child.path(), &target)
            .map_err(|e| format!("move {}: {e}", child.path().display()))?;
    }
    fs::remove_dir(&inner).map_err(|e| format!("remove {}: {e}", inner.display()))?;
    Ok(())
}

/// Extract a zip into `dest` with guards: entry names sanitize (no
/// traversal), uncompressed size counts against the session cap, and only
/// model files land on disk (readmes/.url junk stays out, same filter the
/// builtin manifest uses). macOS junk (`__MACOSX/`, dotfiles) is skipped.
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name.starts_with("__MACOSX/") || name.split('/').any(|c| c.starts_with('.') && c.len() > 1)
        {
            continue;
        }
        let Ok(rel) = sanitize_rel_path(&name) else {
            return Err(format!("unsafe zip entry: {name}"));
        };
        if entry.is_dir() {
            fs::create_dir_all(dest.join(&rel)).map_err(|e| format!("mkdir: {e}"))?;
            continue;
        }
        if !is_model_file(&rel.to_string_lossy()) {
            continue;
        }
        total += entry.size();
        if total > MAX_IMPORT_SESSION_BYTES {
            return Err("zip exceeds the size limit".into());
        }
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let mut out =
            fs::File::create(&out_path).map_err(|e| format!("create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract {}: {e}", out_path.display()))?;
    }
    Ok(())
}

/// Place a finished staging session as a new model under `models_root`.
/// Returns `(id, display name)`.
fn import_commit(
    tmp_root: &Path,
    models_root: &Path,
    token: &str,
    mode: &str,
    name: &str,
) -> Result<(String, String), String> {
    let staging = staging_dir(tmp_root, token)?;
    let base = sanitize_model_name(name)?;
    let dir_name = free_dir_name(models_root, &base);
    let target = models_root.join(&dir_name);
    fs::create_dir_all(models_root).map_err(|e| format!("create models dir: {e}"))?;

    match mode {
        "folder" => {
            // The staging dir becomes the model dir wholesale.
            fs::rename(&staging, &target).map_err(|e| format!("place model dir: {e}"))?;
        }
        "zip" => {
            fs::create_dir_all(&target).map_err(|e| format!("create model dir: {e}"))?;
            let zips: Vec<PathBuf> = fs::read_dir(&staging)
                .map_err(|e| format!("read staging: {e}"))?
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("zip")).unwrap_or(false))
                .collect();
            match zips.len() {
                1 => {
                    extract_zip(&zips[0], &target)?;
                    flatten_single_root(&target)?;
                }
                0 => return Err("no zip file was uploaded into this session".into()),
                n => return Err(format!("expected one zip, got {n}")),
            }
            let _ = fs::remove_dir_all(&staging);
        }
        other => return Err(format!("unknown import mode: {other}")),
    }

    let found = scan_model_dirs(models_root);
    let Some((_, stem, _)) = found.iter().find(|(dir, _, _)| dir == &target) else {
        // Leave nothing unusable behind.
        let _ = fs::remove_dir_all(&target);
        return Err(
            "no Live2D model (*.model3.json) found in the upload — check the folder/zip contents"
                .into(),
        );
    };
    Ok((format!("custom:{stem}"), stem.clone()))
}

fn delete_custom_model(models_root: &Path, stem: &str) -> Result<(), String> {
    let dir = models_root.join(sanitize_model_name(stem)?);
    // Resolve the canonical path and require it to stay inside the custom
    // models root (belt and braces on top of the sanitized stem).
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("model not found: {e}"))?;
    let root = models_root
        .canonicalize()
        .map_err(|e| format!("models dir: {e}"))?;
    if !canonical.starts_with(&root) {
        return Err("model path escaped the library".into());
    }
    fs::remove_dir_all(&canonical).map_err(|e| format!("delete: {e}"))
}

/// Backend state. Add fields here as the plugin grows; keep the ctx to emit
/// events or log outside `init`.
pub struct CompanionPluginL2d {
    ctx: Option<PluginCtx>,
}

impl Default for CompanionPluginL2d {
    fn default() -> Self {
        Self::new()
    }
}

impl CompanionPluginL2d {
    pub fn new() -> Self {
        CompanionPluginL2d { ctx: None }
    }

    /// Bundled model library: `<package>/assets/models/`. Falls back to the
    /// source tree during development, where the dylib runs from cargo's
    /// target dir and has no package dir (same dev fallback as the vrm
    /// backend's `assets_model_dir`).
    fn builtin_root(&self) -> Option<PathBuf> {
        self.assets_subdir("models")
    }

    /// User-imported model library: `<data>/models/` (writable).
    fn custom_root(&self) -> Option<PathBuf> {
        self.ctx
            .as_ref()
            .and_then(|ctx| ctx.data_dir())
            .map(|d| d.join(CUSTOM_MODELS_DIR))
    }

    /// Import staging area: `<data>/import-tmp/`.
    fn import_tmp_root(&self) -> Option<PathBuf> {
        self.ctx
            .as_ref()
            .and_then(|ctx| ctx.data_dir())
            .map(|d| d.join(IMPORT_TMP_DIR))
    }

    /// Path of the bundled Cubism Core runtime script.
    fn core_path(&self) -> Option<PathBuf> {
        let path = self.assets_subdir("core")?.join("live2dcubismcore.min.js");
        path.is_file().then_some(path)
    }

    fn assets_subdir(&self, name: &str) -> Option<PathBuf> {
        if let Some(ctx) = &self.ctx {
            if let Some(dir) = ctx.plugin_dir() {
                let dir = dir.join("assets").join(name);
                if dir.is_dir() {
                    return Some(dir);
                }
            }
        }
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join(name);
        dev.is_dir().then_some(dev)
    }

    /// Resolve a model id (`builtin:<stem>` or `custom:<stem>`) to its dir and
    /// settings file.
    fn find_model_dir(&self, id: &str) -> Result<(PathBuf, String, &'static str), String> {
        let Some((kind, stem)) = id.split_once(':').filter(|(_, s)| !s.is_empty()) else {
            return Err(format!(
                "unknown model id: {id} (expected builtin:<name> or custom:<name>)"
            ));
        };
        let kind: &'static str = match kind {
            "builtin" => "builtin",
            "custom" => "custom",
            _ => return Err(format!("unknown model id: {id}")),
        };
        let root = if kind == "builtin" {
            self.builtin_root()
                .ok_or("bundled Live2D model assets are missing from the plugin package")?
        } else {
            self.custom_root().ok_or("plugin data dir unavailable")?
        };
        scan_model_dirs(&root)
            .into_iter()
            .find(|(_, s, _)| s == stem)
            .map(|(dir, _, settings)| (dir, settings, kind))
            .ok_or_else(|| format!("model not found: {id}"))
    }

    fn op_list_models(&self) -> Result<Value, String> {
        let mut models = Vec::new();
        let mut push_root = |root: Option<PathBuf>, kind: &'static str| {
            if let Some(root) = root {
                let _ = fs::create_dir_all(&root);
                for (dir, stem, settings_file) in scan_model_dirs(&root) {
                    models.push(json!({
                        "id": format!("{kind}:{stem}"),
                        "name": stem,
                        "dir": dir.file_name().and_then(|n| n.to_str()).unwrap_or(""),
                        "settingsFile": settings_file,
                        "kind": kind,
                    }));
                }
            }
        };
        // Customs first: the newest thing the user added is the most likely
        // pick, and fallback logic prefers an early entry.
        push_root(self.custom_root(), "custom");
        push_root(self.builtin_root(), "builtin");
        Ok(json!({ "models": models }))
    }

    fn op_load_model(&self, payload: &Value) -> Result<Value, String> {
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .ok_or("load_model: missing id")?;
        let (dir, settings_file, kind) = self.find_model_dir(id)?;
        let files = model_files(&dir)?;
        // Absolute paths go to the webview so it can load files through the
        // Tauri asset protocol (http streaming, no IPC payload limits — see
        // README "Model delivery"). Paths are scoped by the host's
        // assetProtocol scope ($APPDATA/plugins/** and
        // $APPDATA/plugins-data/**).
        let file_entries: Vec<Value> = files
            .iter()
            .map(|rel| {
                json!({
                    "path": rel,
                    "abs": dir.join(rel).to_string_lossy(),
                })
            })
            .collect();
        Ok(json!({
            "id": id,
            "name": id.split_once(':').map(|(_, s)| s).unwrap_or(id),
            "kind": kind,
            "dir": dir.file_name().and_then(|n| n.to_str()).unwrap_or(""),
            "dirAbs": dir.to_string_lossy(),
            "settingsFile": settings_file,
            "corePath": self
                .core_path()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            "files": file_entries,
        }))
    }

    /// Base64 of the Cubism Core runtime (`assets/core/live2dcubismcore.min.js`).
    fn op_core(&self) -> Result<Value, String> {
        use base64::Engine;
        let path = self
            .core_path()
            .ok_or("Cubism Core asset is missing from the plugin package")?;
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
    }

    fn op_read_file(&self, payload: &Value) -> Result<Value, String> {
        use base64::Engine;
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .ok_or("read_file: missing id")?;
        let rel = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or("read_file: missing path")?;
        let clean = sanitize_rel_path(rel).map_err(|e| format!("read_file: {e}"))?;
        let (dir, _, _) = self.find_model_dir(id)?;
        let path = dir.join(&clean);
        let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        Ok(json!({
            "path": rel,
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }))
    }

    fn op_import_begin(&self, payload: &Value) -> Result<Value, String> {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let tmp_root = self.import_tmp_root().ok_or("plugin data dir unavailable")?;
        let token = import_begin(&tmp_root, name)?;
        Ok(json!({ "token": token }))
    }

    fn op_import_chunk(&self, payload: &Value) -> Result<Value, String> {
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .ok_or("import_chunk: missing token")?;
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or("import_chunk: missing path")?;
        let offset = payload
            .get("offset")
            .and_then(Value::as_u64)
            .ok_or("import_chunk: missing offset")?;
        let base64_data = payload
            .get("base64")
            .and_then(Value::as_str)
            .ok_or("import_chunk: missing base64")?;
        let tmp_root = self.import_tmp_root().ok_or("plugin data dir unavailable")?;
        let written = import_chunk(&tmp_root, token, path, offset, base64_data)?;
        Ok(json!({ "received": written }))
    }

    fn op_import_commit(&self, payload: &Value) -> Result<Value, String> {
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .ok_or("import_commit: missing token")?;
        let mode = payload
            .get("mode")
            .and_then(Value::as_str)
            .ok_or("import_commit: missing mode")?;
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let tmp_root = self.import_tmp_root().ok_or("plugin data dir unavailable")?;
        let models_root = self.custom_root().ok_or("plugin data dir unavailable")?;
        let (id, model_name) = import_commit(&tmp_root, &models_root, token, mode, name)?;
        Ok(json!({ "id": id, "name": model_name }))
    }

    fn op_delete_model(&self, payload: &Value) -> Result<Value, String> {
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .ok_or("delete_model: missing id")?;
        let stem = id
            .strip_prefix("custom:")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("delete_model: builtin models cannot be deleted ({id})"))?;
        let models_root = self.custom_root().ok_or("plugin data dir unavailable")?;
        delete_custom_model(&models_root, stem)?;
        Ok(json!({ "deleted": id }))
    }
}

impl Plugin for CompanionPluginL2d {
    fn init(&mut self, ctx: PluginCtx) -> Result<(), String> {
        ctx.info("companion-plugin-l2d ready");
        self.ctx = Some(ctx);
        Ok(())
    }

    fn handle(&mut self, method: &str, payload: Value) -> Result<Value, String> {
        // Per-call trace, same spirit as the vrm backend's call log: the only
        // window into frontend liveness from the launcher's stdout. Import
        // chunks are traced without body, one line per chunk.
        let started = std::time::Instant::now();
        let result = match method {
            "companion-plugin-l2d.ping" => Ok(json!({ "pong": true })),
            "l2d.list_models" => self.op_list_models(),
            "l2d.load_model" => self.op_load_model(&payload),
            "l2d.read_file" => self.op_read_file(&payload),
            "l2d.core" => self.op_core(),
            "l2d.import_begin" => self.op_import_begin(&payload),
            "l2d.import_chunk" => self.op_import_chunk(&payload),
            "l2d.import_commit" => self.op_import_commit(&payload),
            "l2d.delete_model" => self.op_delete_model(&payload),
            _ => Err(format!("unknown method: {method}")),
        };
        if let Some(ctx) = &self.ctx {
            match &result {
                Ok(_) => ctx.info(&format!("{method} in {:?} ok=true", started.elapsed())),
                Err(e) => ctx.info(&format!("{method} in {:?} ok=false: {e}", started.elapsed())),
            }
        }
        result
    }

    fn tools(&mut self) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "companion_plugin_l2d_ping".into(),
            description: "Check that the companion-plugin-l2d backend is reachable.".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }]
    }
}

export_plugin!(CompanionPluginL2d::new());

#[cfg(test)]
mod tests {
    use super::*;

    /// The manifest must include the multi-dot Cubism files (settings,
    /// motions, expressions) — a plain extension() match on "json" would
    /// silently drop all of them (regression: the model loaded textures only
    /// and every load failed with "settings file missing from bundle").
    #[test]
    fn is_model_file_matches_multidot_names() {
        for name in [
            "IceGirl.model3.json",
            "IceGirl.physics3.json",
            "IceGirl.cdi3.json",
            "DaiJi.motion3.json",
            "生气.exp3.json",
            "IceGirl.moc3",
            "IceGirl.8192/texture_00.png",
            "icon.jpg",
        ] {
            assert!(is_model_file(name), "{name} should be included");
        }
        for name in ["Read me.txt", "模型説明.txt", "模型.url", ".DS_Store", "items.json"] {
            assert!(!is_model_file(name), "{name} should be excluded");
        }
    }

    #[test]
    fn sanitize_rel_path_rejects_traversal_and_absolute() {
        for bad in [
            "/etc/passwd",
            "../secret",
            "a/../../secret",
            "a\\..\\..\\secret",
            "..",
            "",
            "././",
        ] {
            assert!(sanitize_rel_path(bad).is_err(), "{bad:?} should be rejected");
        }
        assert_eq!(
            sanitize_rel_path("sub/dir/IceGirl.model3.json")
                .unwrap()
                .to_string_lossy(),
            "sub/dir/IceGirl.model3.json"
        );
        assert_eq!(
            sanitize_rel_path("win\\path\\texture.png")
                .unwrap()
                .to_string_lossy(),
            "win/path/texture.png"
        );
    }

    #[test]
    fn sanitize_model_name_strips_separators() {
        assert_eq!(sanitize_model_name("IceGirl").unwrap(), "IceGirl");
        assert_eq!(sanitize_model_name("My Model (v2)").unwrap(), "My Model (v2)");
        assert_eq!(sanitize_model_name("../../etc").unwrap(), "etc");
        assert_eq!(sanitize_model_name("a/b\\c").unwrap(), "a-b-c");
        assert_eq!(sanitize_model_name("  ..x..  ").unwrap(), "x");
        assert!(sanitize_model_name("///").is_err());
        assert!(sanitize_model_name("").is_err());
    }

    #[test]
    fn free_dir_name_avoids_collisions() {
        let root = std::env::temp_dir().join(format!("l2d-test-freedir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(free_dir_name(&root, "Model"), "Model");
        fs::create_dir_all(root.join("Model")).unwrap();
        assert_eq!(free_dir_name(&root, "Model"), "Model-2");
        fs::create_dir_all(root.join("Model-2")).unwrap();
        assert_eq!(free_dir_name(&root, "Model"), "Model-3");
        let _ = fs::remove_dir_all(&root);
    }

    fn test_roots(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("l2d-test-{tag}-{}", std::process::id()));
        let tmp_root = base.join("import-tmp");
        let models_root = base.join("models");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&models_root).unwrap();
        (tmp_root, models_root)
    }

    /// A chunked folder import lands as `custom:<stem>` with a model3.json at
    /// its root; offset-checked retries are idempotent.
    #[test]
    fn folder_import_session_roundtrip() {
        let (tmp_root, models_root) = test_roots("folder");
        let token = import_begin(&tmp_root, "My Model").unwrap();

        let chunk = |rel: &str, offset: u64, data: &[u8]| -> u64 {
            let b64 = {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(data)
            };
            import_chunk(&tmp_root, &token, rel, offset, &b64).unwrap()
        };

        chunk("IceGirl.model3.json", 0, b"{\"Version\":3}");
        // Retried zero-offset chunk truncates instead of duplicating.
        assert_eq!(chunk("IceGirl.model3.json", 0, b"{\"Version\":3}"), 13);
        // Offset-mismatched appends are rejected.
        assert!(import_chunk(
            &tmp_root,
            &token,
            "IceGirl.model3.json",
            99,
            "eA=="
        )
        .is_err());
        chunk("tex/moc3.bin", 0, b"MOC3");
        chunk("tex/moc3.bin", 4, b"DATA");

        let (id, name) = import_commit(&tmp_root, &models_root, &token, "folder", "My Model")
            .unwrap();
        assert_eq!(id, "custom:IceGirl");
        assert_eq!(name, "IceGirl");
        let dir = models_root.join("My Model");
        assert!(dir.join("IceGirl.model3.json").is_file());
        assert_eq!(fs::read(dir.join("tex/moc3.bin")).unwrap(), b"MOC3DATA");
        let found = scan_model_dirs(&models_root);
        assert_eq!(found.len(), 1);
    }

    /// A zip session extracts (deflate-compressed), flattens a single root
    /// folder, keeps only model files, and lands as a custom model.
    #[test]
    fn zip_import_session_roundtrip() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let (tmp_root, models_root) = test_roots("zip");
        let zip_path = std::env::temp_dir().join(format!("l2d-test-zip-src-{}.zip", std::process::id()));
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zw = ZipWriter::new(file);
            let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zw.add_directory("MyModel/textures", opts).unwrap();
            let add = |zw: &mut ZipWriter<fs::File>, name: &str, data: &[u8]| {
                zw.start_file(name, opts).unwrap();
                zw.write_all(data).unwrap();
            };
            add(&mut zw, "MyModel/IceGirl.model3.json", b"{\"Version\":3}");
            add(&mut zw, "MyModel/IceGirl.moc3", b"MOC3");
            add(&mut zw, "MyModel/textures/texture_00.png", b"\x89PNG");
            add(&mut zw, "MyModel/Read me.txt", b"junk");
            add(&mut zw, "__MACOSX/._junk", b"junk");
            zw.finish().unwrap();
        }

        let token = import_begin(&tmp_root, "Zipped").unwrap();
        let b64 = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(fs::read(&zip_path).unwrap())
        };
        import_chunk(&tmp_root, &token, "model.zip", 0, &b64).unwrap();
        let (id, name) =
            import_commit(&tmp_root, &models_root, &token, "zip", "Zipped").unwrap();
        assert_eq!(id, "custom:IceGirl");
        assert_eq!(name, "IceGirl");

        let dir = models_root.join("Zipped");
        // Flattened: model3.json sits at the model root, not in an inner dir.
        assert!(dir.join("IceGirl.model3.json").is_file());
        assert!(dir.join("IceGirl.moc3").is_file());
        assert!(dir.join("textures/texture_00.png").is_file());
        // Non-model files (Read me.txt) and macOS junk never landed.
        assert!(!dir.join("Read me.txt").exists());
        assert!(!dir.join("__MACOSX").exists());
        let _ = fs::remove_file(&zip_path);
    }

    /// Committing an upload with no model in it fails and cleans up.
    #[test]
    fn import_commit_without_model_cleans_up() {
        let (tmp_root, models_root) = test_roots("empty");
        let token = import_begin(&tmp_root, "Junk").unwrap();
        let b64 = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(b"not a model")
        };
        import_chunk(&tmp_root, &token, "junk.png", 0, &b64).unwrap();
        assert!(import_commit(&tmp_root, &models_root, &token, "folder", "Junk").is_err());
        assert!(!models_root.join("Junk").exists());
    }

    #[test]
    fn delete_custom_model_only_touches_the_library() {
        let (tmp_root, models_root) = test_roots("delete");
        let model = models_root.join("Mine");
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("Mine.model3.json"), "{}").unwrap();

        delete_custom_model(&models_root, "Mine").unwrap();
        assert!(!model.exists());
        assert!(delete_custom_model(&models_root, "Mine").is_err());
        // Sanitized stem: traversal attempts can't escape the root.
        assert!(delete_custom_model(&models_root, "../../etc").is_err());
        let _ = tmp_root;
    }

    #[test]
    fn unknown_method_is_an_error() {
        let mut plugin = CompanionPluginL2d::new();
        assert!(plugin.handle("nope", json!({})).is_err());
        assert!(plugin.handle("companion-plugin-l2d.ping", json!({})).is_ok());
    }
}
