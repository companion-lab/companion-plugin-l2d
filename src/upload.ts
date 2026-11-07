// Chunked model import transport.
//
// Live2D models are multi-file bundles (~19 MB for the demo), and multi-MB
// base64 over IPC wedges the webview after a few responses (the same lesson
// the asset-protocol model delivery learned). Uploads therefore cross IPC in
// ~1 MB offset-checked chunks into a backend staging session:
//
//   import_begin { name }        → { token }
//   import_chunk { token, path, offset, base64 }   (offset 0 truncates, so a
//                                                   retried start is safe)
//   import_commit { token, mode, name }            (mode: "folder" | "zip")
//
// Folder uploads read a webkitdirectory input (every File carries its
// webkitRelativePath); zip uploads send one file and let the backend extract.

import type { PluginContext } from "@companion-lab/plugin";
import { callWithRetry } from "./retry";

export const UPLOAD_CHUNK_BYTES = 1 << 20; // 1 MiB of raw bytes per chunk

/** `Model/IceGirl.model3.json` → `IceGirl.model3.json` (folder pickers prefix
 *  every path with the picked folder's name). */
export function stripRootSegment(webkitRelativePath: string): string {
  const idx = webkitRelativePath.indexOf("/");
  return idx === -1 ? webkitRelativePath : webkitRelativePath.slice(idx + 1);
}

/** `Model/IceGirl.model3.json` → `Model`; no separator → the whole path. */
export function rootSegment(path: string): string {
  const idx = path.indexOf("/");
  return idx === -1 ? path : path.slice(0, idx);
}

/** Chunk plan for a byte size (pure, tested). */
export function chunkOffsets(
  size: number,
  chunkBytes = UPLOAD_CHUNK_BYTES,
): Array<{ offset: number; length: number }> {
  const chunks: Array<{ offset: number; length: number }> = [];
  for (let offset = 0; offset < size; offset += chunkBytes) {
    chunks.push({ offset, length: Math.min(chunkBytes, size - offset) });
  }
  return chunks;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve(comma === -1 ? "" : dataUrl.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

export type ImportProgress = {
  /** Human progress line, e.g. `tex/texture_00.png · 3.2 / 19.0 MB`. */
  line: string;
};

type ImportResult = { id: string; name: string };

/** Upload one file into the session in chunks. A chunk failure past the
 *  first offset restarts the file from zero (the backend truncates on
 *  offset 0); a second failure at the same file gives up. */
async function uploadFile(
  ctx: PluginContext,
  token: string,
  rel: string,
  file: Blob,
  onProgress: (sentBytes: number) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sent = 0;
    let failed = false;
    while (sent < file.size) {
      const length = Math.min(UPLOAD_CHUNK_BYTES, file.size - sent);
      const base64 = await blobToBase64(file.slice(sent, sent + length));
      try {
        await callWithRetry(
          () =>
            ctx.backend.call("l2d.import_chunk", {
              token,
              path: rel,
              offset: sent,
              base64,
            }),
          ctx.log,
          `l2d.import_chunk ${rel}@${sent}`,
        );
      } catch (e) {
        if (attempt === 1) throw e;
        failed = true;
        break;
      }
      sent += length;
      onProgress(sent);
    }
    if (!failed) return;
  }
}

function fmtBytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Import a picked model folder (webkitdirectory File list). The model name
 *  comes from the folder; the backend resolves collisions (`-2`, `-3`, …). */
export async function importFolder(
  ctx: PluginContext,
  files: File[],
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  if (files.length === 0) throw new Error("no files selected");
  const name = rootSegment(files[0].webkitRelativePath || files[0].name);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let doneBytes = 0;

  const { token } = await callWithRetry(
    () => ctx.backend.call<{ token: string }>("l2d.import_begin", { name }),
    ctx.log,
    "l2d.import_begin",
  );

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = stripRootSegment(file.webkitRelativePath || file.name);
    if (!rel) continue;
    onProgress?.({
      line: `${rel} · ${fmtBytes(doneBytes)} / ${fmtBytes(totalBytes)} (${i + 1}/${files.length})`,
    });
    await uploadFile(ctx, token, rel, file, (sent) => {
      onProgress?.({
        line: `${rel} · ${fmtBytes(doneBytes + sent)} / ${fmtBytes(totalBytes)} (${i + 1}/${files.length})`,
      });
    });
    doneBytes += file.size;
  }

  onProgress?.({ line: `placing ${name}…` });
  const result = await callWithRetry(
    () => ctx.backend.call<ImportResult>("l2d.import_commit", { token, mode: "folder", name }),
    ctx.log,
    "l2d.import_commit",
    { timeoutMs: 30_000 },
  );
  onProgress?.({ line: `imported ${result.name}` });
  return result;
}

/** Import a zipped model folder; the backend extracts it. */
export async function importZip(
  ctx: PluginContext,
  file: File,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const name = file.name.replace(/\.[^/.]+$/, "") || "model";
  const totalBytes = file.size;

  const { token } = await callWithRetry(
    () => ctx.backend.call<{ token: string }>("l2d.import_begin", { name }),
    ctx.log,
    "l2d.import_begin",
  );

  await uploadFile(ctx, token, "model.zip", file, (sent) => {
    onProgress?.({ line: `${file.name} · ${fmtBytes(sent)} / ${fmtBytes(totalBytes)}` });
  });

  onProgress?.({ line: `extracting ${name}…` });
  const result = await callWithRetry(
    () => ctx.backend.call<ImportResult>("l2d.import_commit", { token, mode: "zip", name }),
    ctx.log,
    "l2d.import_commit",
    { timeoutMs: 60_000 },
  );
  onProgress?.({ line: `imported ${result.name}` });
  return result;
}
