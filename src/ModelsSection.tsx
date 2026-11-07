// Model library section (Settings → Live2D → Models): lists builtin +
// imported models, switches the active one, imports model folders or zips
// (chunked upload, see upload.ts), deletes custom models. Import is a
// multi-file flow, so progress renders in the section while the session
// runs; switching emits the l2d-load event the main-window engine answers.

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import { callWithRetry } from "./retry";
import { listModels, type ModelMeta } from "./library";
import { importFolder, importZip, type ImportProgress } from "./upload";

/** Hidden folder-picker input: `webkitdirectory` isn't a React prop, so it
 *  lands on the element via setAttribute. */
function useWebkitDirectory() {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.setAttribute("webkitdirectory", "");
    ref.current?.setAttribute("directory", "");
  }, []);
  return ref;
}

export function ModelsSection({ ctx }: { ctx: PluginContext }) {
  const { SectionCard, Button, ConfirmModal } = ctx.ui;
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const zipRef = useRef<HTMLInputElement | null>(null);
  const folderDirRef = useWebkitDirectory();

  const refresh = async () => {
    try {
      const list = await listModels(ctx);
      setModels(list);
      const stored = await ctx.storage.get<string>("active_model").catch(() => null);
      setActiveId(typeof stored === "string" && stored ? stored : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    // The main window may switch models too (Status section used to own
    // that); keep the active marker in sync.
    return ctx.events.on("l2d-status", (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (p.ok === true && typeof p.id === "string") setActiveId(p.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activate = async (id: string) => {
    setActiveId(id);
    ctx.events.emit("l2d-load", { id });
  };

  const runImport = async (
    work: (onProgress: (p: ImportProgress) => void) => Promise<{ id: string; name: string }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await work((p) => setProgress(p.line));
      await refresh();
      await activate(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
      if (folderRef.current) folderRef.current.value = "";
      if (zipRef.current) zipRef.current.value = "";
    }
  };

  const handleFolder = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    void runImport((onProgress) => importFolder(ctx, files, onProgress));
  };

  const handleZip = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void runImport((onProgress) => importZip(ctx, file, onProgress));
  };

  const confirmDelete = async () => {
    const model = pendingDelete;
    if (!model) return;
    setDeleting(true);
    setError(null);
    try {
      await callWithRetry(
        () => ctx.backend.call("l2d.delete_model", { id: model.id }),
        ctx.log,
        "l2d.delete_model",
      );
      setPendingDelete(null);
      await refresh();
      if (activeId === model.id) {
        // Never leave the app pointed at a model that no longer exists.
        const fallback = models.find((m) => m.id !== model.id);
        if (fallback) await activate(fallback.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const disabled = busy || deleting;

  return (
    <SectionCard title="Models" badge={`${models.length} in library`}>
      <p style={{ margin: "0 0 10px", opacity: 0.75 }}>
        Import a Live2D model folder (model3.json + textures + motions) or a
        zipped one. Imported models land in the plugin's data dir; the bundled
        model stays read-only.
      </p>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => folderRef.current?.click()}
          style={{ padding: "6px 12px", fontSize: 12 }}
        >
          Import folder…
        </Button>
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => zipRef.current?.click()}
          style={{ padding: "6px 12px", fontSize: 12 }}
        >
          Import zip…
        </Button>
      </div>
      <input
        ref={(el) => {
          folderRef.current = el;
          folderDirRef.current = el;
        }}
        type="file"
        multiple
        onChange={handleFolder}
        style={{ display: "none" }}
      />
      <input
        ref={zipRef}
        type="file"
        accept=".zip,application/zip"
        onChange={handleZip}
        style={{ display: "none" }}
      />

      {progress && (
        <div className="item-row" style={{ display: "block" }}>
          <div className="item-meta" style={{ margin: 0 }}>
            {progress}
          </div>
        </div>
      )}
      {error && (
        <div className="error-banner" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {models.map((m) => (
        <div className="item-row" key={m.id} style={{ display: "block" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="item-title">{m.name}</div>
              <div className="item-meta">
                {m.kind === "custom" ? "imported" : "bundled"}
                {activeId === m.id ? " • active" : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              {activeId === m.id ? (
                <Button
                  variant="primary"
                  disabled={disabled}
                  onClick={() => ctx.events.emit("l2d-load", { id: m.id })}
                  style={{ padding: "5px 10px", fontSize: 11 }}
                >
                  Reload
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void activate(m.id)}
                  style={{ padding: "5px 10px", fontSize: 11 }}
                >
                  Use
                </Button>
              )}
              {m.kind === "custom" && (
                <Button
                  variant="danger"
                  disabled={disabled}
                  onClick={() => setPendingDelete(m)}
                  style={{ padding: "5px 10px", fontSize: 11 }}
                >
                  Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      ))}

      {pendingDelete && (
        <ConfirmModal
          title={`Delete ${pendingDelete.name}?`}
          message="The imported model folder is removed from the plugin's data dir. The bundled model stays available."
          confirmLabel="Delete"
          busy={deleting}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </SectionCard>
  );
}
