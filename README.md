# Live2D Avatar (companion-plugin-l2d)

Renders a Live2D (Cubism 4) character on the desktop overlay and answers the
app's avatar bus — the Live2D counterpart of the `vrm` plugin. Chat replies
can drive expressions (`<<emotion:…>>` tags), TTS drives the mouth
(`setViseme` → `ParamMouthOpenY`), and the core click-through hit test reads
the canvas alpha through the bus.

**This repository ships no character models.** The Cubism Core runtime is
fetched locally (`scripts/fetch-core.mjs`, see below) and models are
user-imported at runtime (Settings → Live2D → Models) — both stay out of
git.

## Model delivery

Model files stream to the webview through the **Tauri asset protocol**: the
backend returns absolute paths in the `l2d.load_model` manifest and the
frontend rewrites the settings JSON's FileReferences to asset URLs, so
textures/moc3/motions stream with the webview's native loaders. (Multi-MB
base64 over IPC — the vrm plugin's approach for single-file VRMs — wedges the
macOS webview's IPC after a few responses on a bundle this size.) The host
enables the protocol scoped to `$APPDATA/plugins/**` and
`$APPDATA/plugins-data/**` in `tauri.conf.json`.

## Setup

```sh
pnpm install        # also fetches the Cubism Core (postinstall)
pnpm build          # stage the package to dist/package
pnpm build --zip    # also write dist/<id>-<version>.zip
```

The repo is standalone: the frontend imports the SDK through the published
`@companion-lab/plugin` package (the host app aliases that import to its own
SDK copy at load time), types resolve from this repo's own devDependencies,
and no build step references paths outside this directory. `pnpm fetch-core`
re-downloads the Cubism Core if `assets/core/` is empty — without it the
engine reports the missing runtime instead of rendering.

For development against a companion-tauri checkout, the app's own build
wrapper works too and produces a byte-identical bundle:
`node app/scripts/build-plugin.mjs plugin-repos/companion-plugin-l2d --backend --out plugins/companion-plugin-l2d`.

## Runtime

- **PixiJS 6 + pixi-live2d-display (cubism4)** — the pairing the library
  documents (its peer deps target `@pixi/*@6`; PixiJS 7 removed those
  packages).
- **Cubism Core** — downloaded into `assets/core/` by `scripts/fetch-core.mjs`
  and served to the webview as a runtime script by the backend (bundling it
  is not possible: its emscripten preamble references node builtins). See
  `THIRD-PARTY-NOTICES.md` for licenses.

`src/engine/model-settings.ts` enriches each model's settings JSON at load
time, because most model3.json files under-declare what a desktop avatar
needs:

- an `Idle` motion group (a motion aliased `idle`, else the first bundled
  motion) plus one group per motion keyed by its stable id;
- one expression entry per `.exp3.json` file, keyed by stable id, plus a
  synthesized no-op `neutral` expression (index 0) to fade back to;
- `EyeBlink`/`LipSync` parameter groups with the standard Cubism param ids
  (`ParamEyeLOpen/ROpen`, `ParamMouthOpenY`) when the model ships them empty.

Stable ids come from `src/engine/names.ts`: a per-model alias table (e.g.
the IceGirl model's Chinese file names — 生气 → `angry`) with slugified
fallbacks and a few chat-vocabulary aliases (`happy` → `blush`,
`nod` → `wave`). Emotion names from chat resolve to either form.

## Backend RPC

- `l2d.list_models` → `{ models: [{ id, name, dir, settingsFile, kind }] }`
  (`kind`: `"builtin"` from the package assets — usually empty — or
  `"custom"` from imports)
- `l2d.load_model { id }` → `{ id, name, kind, dir, dirAbs, settingsFile,
corePath, files: [{ path, abs }] }`
- `l2d.read_file { id, path }` → `{ path, base64 }` (path-traversal safe; small files)
- `l2d.core` → bare base64 of the Cubism Core runtime (small, ~207 KB)
- `l2d.import_begin { name }` → `{ token }` — opens a staging session
- `l2d.import_chunk { token, path, offset, base64 }` → `{ received }` —
  offset-checked append (offset 0 truncates, so retried starts are safe)
- `l2d.import_commit { token, mode, name }` → `{ id, name }` — places the
  session as `custom:<stem>` (`mode`: `"folder"` places the tree, `"zip"`
  extracts it, flattens a single root folder, keeps only model files)
- `l2d.delete_model { id }` — custom models only

## Importing models (Settings → Live2D → Models)

**Import folder…** picks a model directory (`webkitdirectory`; needs
`model3.json` + textures + any motions/expressions), **Import zip…** accepts
a zipped model folder. Both upload in ~1 MB offset-checked chunks (multi-MB
base64 IPC responses wedge the webview) into a staging session under the
plugin data dir, then commit as a `custom:` model with collision-safe naming
(`Name`, `Name-2`, …). Name sanitization, path-traversal rejection and size
caps (128 MB/file, 256 MB/session) are enforced in the backend. After a
successful import the model loads immediately; deleting the active model
falls back to another one. With an empty library the engine idles quietly —
no error overlay — until a model is imported.

## Plugin events (cross-window)

- `l2d-load { id }` — switch the active model (Models section)
- `l2d-expression-test {id|string}` — apply an expression, persists until
  changed (gallery clicks; costume expressions shouldn't self-reset)
- `l2d-motion-test {id|string}` — play a motion once
- `l2d-display-changed {scale,x,y,tracking}` — live display transform
- `l2d-status {ok,…}` — engine → sections: model loaded, empty library, or
  failed

## Avatar bus handlers

`setEmotion` (auto-resets after 4s like vrm emotions), `triggerMotion`,
`setViseme`, `loadModel {id}`, `describeCapabilities` (feeds the AI's
emotion/motion vocabulary), `pixelAlphaAt` (click-through). VRM-shaped calls
(`registerMotion`/`registerEmotion`/`reloadLibrary`) are resolved by name
against the loaded model's clips and ignored when nothing matches. `.vrma`
loading rejects — that pipeline is VRM-only.

## Coexistence with the VRM plugin

The avatar bus is single-owner (last engine to install handlers wins) and
both plugins mount a backdrop canvas — enable only one at a time. The
plugin's Status section shows a warning while vrm is also enabled.

## Layout

- `manifest.json` — plugin manifest (id, permissions, build entries)
- `src/` — JS frontend (React), bundled to `frontend.js`
  - `engine/` — PixiJS app, model loader, bus handlers, lipsync/tracking
  - `ModelsSection.tsx` — model library: import (folder/zip), switch, delete
  - `upload.ts` — chunked import transport
  - `sections.tsx` — Status / Expressions / Motions / Display sections
- `backend/` — Rust backend compiled to a cdylib (model serving + imports)
- `assets/core/` — Cubism Core runtime (fetched, gitignored)
- `scripts/fetch-core.mjs` — Cubism Core downloader (postinstall hook)
- `scripts/build.mjs` — standalone package build (`pnpm build`)

### Host-side notes (companion-tauri checkout)

Integrating this plugin with a companion-tauri dev build required three
small host changes: `BUNDLED_IDS` gained `companion-plugin-l2d`
(`plugin_host/mod.rs`), `tauri.conf.json` enables `assetProtocol` scoped to
the plugins dirs, and `join_all_spaces` in `lib.rs` makes the pet window
follow every Space (a stranded window stops painting, which also starves its
animation and IPC loops).

## Tests

```sh
pnpm vitest        # pure modules: name mapping, settings-JSON enrichment, upload chunking
cargo test         # backend: manifest matching, path safety, import sessions
```

## Downloading releases

CI builds installable zips on every push to `main` (the "Build plugin"
workflow). To publish a release, push a tag matching the version in
`manifest.json`:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release gets one zip per platform — download the one for your machine
and import it in the Companion app via **Settings → Plugins → Import
plugin…**:

| File | Platform |
|---|---|
| `companion-plugin-l2d-0.1.0-linux-x86_64.zip` | Linux (Intel/AMD 64-bit) |
| `companion-plugin-l2d-0.1.0-macos-arm64.zip` | macOS (Apple Silicon) |
| `companion-plugin-l2d-0.1.0-macos-x86_64.zip` | macOS (Intel) |
| `companion-plugin-l2d-0.1.0-windows-x86_64.zip` | Windows (64-bit) |

Non-tag runs of the workflow publish the same zips as run artifacts for
testing. CI never touches the zips committed under `dist/`.
