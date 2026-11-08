// Read-side helpers the settings sections share: model listing and the clip
// lists for the active model (fetched fresh from the backend — the settings
// window has no engine to ask).

import type { PluginContext } from "@companion-lab/plugin";
import { collectExpressions, collectMotions, type NamedFile } from "./engine/names";
import { callWithRetry } from "./retry";

export type ModelMeta = {
  id: string;
  name: string;
  dir: string;
  settingsFile: string;
  /** "builtin" (shipped in the plugin package) or "custom" (imported). */
  kind: "builtin" | "custom";
};

export type ModelClips = {
  id: string;
  expressions: NamedFile[];
  motions: NamedFile[];
};

export async function listModels(ctx: PluginContext): Promise<ModelMeta[]> {
  const list = await callWithRetry(
    () => ctx.backend.call<{ models: ModelMeta[] }>("l2d.list_models"),
    ctx.log,
    "l2d.list_models",
  );
  return (list.models ?? []).map((m) => ({
    ...m,
    kind: m.kind === "custom" ? "custom" : "builtin",
  }));
}

/** Clip lists for one model id. Only the file manifest is needed (no model
 *  bytes). Throws when the manifest can't be loaded (deleted/invalid id). */
export async function fetchModelClips(ctx: PluginContext, id: string): Promise<ModelClips> {
  const manifest = await callWithRetry(
    () => ctx.backend.call<{ files: Array<{ path: string }> }>("l2d.load_model", { id }),
    ctx.log,
    "l2d.load_model",
  );
  const paths = (manifest.files ?? []).map((f) => f.path);
  return {
    id,
    expressions: collectExpressions(paths),
    motions: collectMotions(paths),
  };
}

/** Clip lists for the active model: the stored selection, else the first
 *  bundled model. Falls back down the list when the stored model was
 *  deleted. */
export async function fetchActiveModelClips(ctx: PluginContext): Promise<ModelClips | null> {
  const models = await listModels(ctx);
  if (models.length === 0) return null;
  const stored = await ctx.storage
    .get<string>("active_model")
    .catch(() => null as string | null);
  const candidates = [
    typeof stored === "string" && stored ? stored : null,
    "builtin:IceGirl",
    models[0]?.id ?? null,
  ].filter((id): id is string => Boolean(id));
  for (const id of candidates) {
    const model = models.find((m) => m.id === id);
    if (!model) continue;
    try {
      return await fetchModelClips(ctx, id);
    } catch {
      // Deleted/invalid model — try the next candidate.
    }
  }
  return null;
}
