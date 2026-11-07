// Loads a Live2D model bundle into the webview.
//
// Model files stream through the Tauri asset protocol (http://asset.localhost
// URLs over the backend's absolute paths): the webview fetches textures,
// moc3, motions and expressions with its native loaders, exactly like any
// remote model — no multi-MB base64 payloads cross the IPC. (Base64 over
// IPC was the vrm plugin's approach for single-file VRMs; for a ~19 MB
// multi-file bundle the accumulated eval'd responses wedge the webview's
// IPC — calls stop resolving mid-batch.)
//
// The settings JSON's FileReferences are rewritten to those asset URLs, so
// pixi-live2d-display loads everything directly (the factory's url.resolve
// returns absolute URLs unchanged).

import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type { PluginContext } from "@companion-lab/plugin";
import {
  buildModelSettings,
  neutralExpressionFile,
  NEUTRAL_EXP3_JSON,
} from "./model-settings";
import { collectExpressions, collectMotions, type NamedFile } from "./names";
import { assetUrl } from "../vendor/tauri-events";
import { getLive2DRuntime } from "./runtime";
import { callWithRetry } from "../retry";

export type LoadedModel = {
  model: Live2DModel;
  id: string;
  name: string;
  expressions: NamedFile[];
  motions: NamedFile[];
  /** Destroy the model (asset URLs need no revoking). */
  dispose: () => void;
};

type ModelFileEntry = { path: string; abs: string };

type ModelManifest = {
  id: string;
  name: string;
  dir: string;
  dirAbs: string;
  settingsFile: string;
  corePath: string;
  files: ModelFileEntry[];
};

/** Fetch the manifest and hand the bundle to the pixi-live2d-display factory
 *  as a settings object with asset-protocol URLs. */
export async function loadLive2DModel(ctx: PluginContext, id: string): Promise<LoadedModel> {
  const manifest = await callWithRetry(
    () => ctx.backend.call<ModelManifest>("l2d.load_model", { id }),
    ctx.log,
    "l2d.load_model",
    { timeoutMs: 30_000, retries: 3 },
  );
  if (!manifest?.settingsFile || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`model manifest for ${id} is empty or malformed`);
  }

  // rel path → asset URL, for the settings rewriter.
  const urls = new Map<string, string>();
  for (const f of manifest.files) {
    urls.set(f.path, assetUrl(f.abs));
  }
  // The no-op "neutral" expression the settings builder registers first —
  // cross-fading to it fades any active expression back to the plain face.
  // Served as a data URL (tiny, no disk file).
  urls.set(
    neutralExpressionFile(),
    `data:application/json,${encodeURIComponent(JSON.stringify(NEUTRAL_EXP3_JSON))}`,
  );

  const settingsRel = manifest.settingsFile;
  const settingsUrl = urls.get(settingsRel);
  if (!settingsUrl) throw new Error(`settings file missing from bundle: ${settingsRel}`);
  const raw = JSON.parse(await (await fetch(settingsUrl)).text()) as Record<string, unknown>;

  const expressions = collectExpressions(manifest.files.map((f) => f.path));
  const motions = collectMotions(manifest.files.map((f) => f.path));
  const settings = buildModelSettings(
    raw,
    settingsRel,
    manifest.files.map((f) => f.path),
    expressions,
    motions,
    (rel) => {
      const url = urls.get(rel);
      if (!url) throw new Error(`file missing from bundle: ${rel}`);
      return url;
    },
  );

  // autoInteract off: the canvas is a non-interactive pixel layer behind
  // the host's interaction canvas (pointerEvents: none), so pointer-driven
  // focus registration would never fire anyway — cursor tracking is fed
  // manually by the engine.
  const { Live2DModel } = await getLive2DRuntime(ctx);
  const model = await Live2DModel.from(
    settings as unknown as Parameters<typeof Live2DModel.from>[0],
    { autoInteract: false },
  );

  return {
    model,
    id: manifest.id,
    name: manifest.name,
    expressions,
    motions,
    dispose: () => {
      // The engine's teardown may have destroyed the stage (and this model
      // with it) before calling dispose — a second destroy is a no-op.
      if (!model.destroyed) model.destroy();
    },
  };
}
