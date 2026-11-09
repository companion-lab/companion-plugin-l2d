// The Live2D avatar engine — this plugin's counterpart of the vrm plugin's
// engine. The main window's Live2DCanvas widget mounts the canvas and calls
// startLive2DEngine; everything the host's bus exposes (ctx.avatar control
// surface, click-through pixel probes) is answered by the handlers installed
// here via ctx.avatar.provide.
//
// Runs ONLY in the main window (the backdrop widget only exists there); in
// the settings window the bus stays at no-ops, same as the vrm engine.
//
// Rendering is PixiJS + pixi-live2d-display against the Cubism 4 Core; both
// arrive through engine/runtime.ts (the library import is deferred until the
// core script is on the page — see runtime.ts). The model bundle is fetched
// from the plugin backend as base64 (see loader.ts).

import * as PIXI from "pixi.js";
import type { PluginContext } from "@companion-lab/plugin";
import { loadLive2DModel, type LoadedModel } from "./loader";
import { resolveNamed } from "./names";
import { coerceDisplay, DEFAULT_DISPLAY, type DisplaySettings } from "./display";
import { getLive2DRuntime } from "./runtime";
import { callWithRetry } from "../retry";
import { tauriInvoke } from "../vendor/tauri-events";

// ─── Types & constants ───

type FpsCap = "thirty" | "sixty" | "uncapped";

type PerfConfigShape = {
  max_pixel_ratio: number;
  fps_cap: FpsCap;
  antialias: boolean;
};

const DISPLAY_STORAGE_KEY = "display";
const MODEL_STORAGE_KEY = "active_model";

/** Expression auto-reset, matching the vrm plugin's emotion resetMs. */
const EMOTION_RESET_MS = 4_000;

/** TTS viseme → ParamMouthOpenY gain. The tts plugin emits aa/ih/ou/ee/oh
 *  (and "neutral" to stop); Live2D's single mouth-open param only cares how
 *  wide, so each viseme contributes a share of its weight. */
const VISEME_MOUTH_OPEN: Record<string, number> = {
  aa: 1.0,
  oh: 0.7,
  ee: 0.55,
  ih: 0.35,
  ou: 0.25,
};

// ─── Engine error surface (drives the main-window error overlay) ───

type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();

/** Subscribe to engine/model-load failures (main window only). */
export function onEngineError(l: ErrorListener): () => void {
  errorListeners.add(l);
  return () => errorListeners.delete(l);
}

function reportError(message: string): void {
  errorListeners.forEach((l) => l(message));
}

/** Alpha byte under a CSS point of the renderer's drawing buffer, or null.
 *  Requires the renderer to be created with preserveDrawingBuffer: true. */
function canvasPixelAlpha(
  app: PIXI.Application,
  cssX: number,
  cssY: number,
): number | null {
  try {
    const renderer = app.renderer as PIXI.Renderer;
    const gl = renderer.gl;
    if (!gl) return null;
    const dpr = renderer.resolution;
    const x = Math.floor(cssX * dpr);
    // GL origin is bottom-left; the CSS point is top-left.
    const y = Math.floor(gl.drawingBufferHeight - cssY * dpr);
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) {
      return null;
    }
    const px = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px[3];
  } catch {
    return null;
  }
}

// ─── Engine lifecycle ───

let activeStop: (() => void) | null = null;

/** Start the Live2D engine on the given canvas. Idempotent: a start while
 *  one is already running is a no-op (StrictMode remounts stop first). */
export function startLive2DEngine(ctx: PluginContext, canvas: HTMLCanvasElement): void {
  if (activeStop) return;
  activeStop = runEngine(ctx, canvas);
}

/** Stop the engine and return the bus to no-ops (main window unmount). */
export function stopLive2DEngine(): void {
  activeStop?.();
  activeStop = null;
}

function runEngine(ctx: PluginContext, canvas: HTMLCanvasElement): () => void {
  let cancelled = false;
  let disposed = false;
  const cleanups: Array<() => void> = [];

  const appRef = { current: null as PIXI.Application | null };
  const loadedRef = { current: null as LoadedModel | null };
  const displayRef = { current: { ...DEFAULT_DISPLAY } };
  const swapGen = { current: 0 };

  // Lipsync state: latest viseme target + smoothed current opening, applied
  // to the core model right before its per-frame update (see attach()).
  const mouth = { target: 0, current: 0, active: false };
  // One active chat-driven expression at a time, auto-reset like vrm's
  // emotions.
  let emotionTimer: number | null = null;

  const applyDisplay = () => {
    const app = appRef.current;
    const loaded = loadedRef.current;
    if (!app || !loaded) return;
    const renderer = app.renderer;
    const cw = renderer.width / renderer.resolution;
    const ch = renderer.height / renderer.resolution;
    const d = displayRef.current;
    // Container.width/height return bounds multiplied by the current scale;
    // divide it back out so `base` is computed from the model's natural size.
    // applyDisplay runs again on every window resize (and display-settings
    // change) — without this the previous scale feeds into the fit and the
    // model blows up after the first resize.
    const naturalW = loaded.model.width / (loaded.model.scale.x || 1);
    const naturalH = loaded.model.height / (loaded.model.scale.y || 1);
    const base = Math.min(cw / naturalW, ch / naturalH);
    loaded.model.scale.set(base * d.scale);
    loaded.model.anchor.set(0.5, 0.5);
    loaded.model.position.set(cw / 2 + d.x, ch / 2 + d.y);
  };

  const clearEmotionTimer = () => {
    if (emotionTimer !== null) {
      window.clearTimeout(emotionTimer);
      emotionTimer = null;
    }
  };

  /** Cross-fade to the synthesized neutral expression (the first entry). */
  const clearEmotion = () => {
    clearEmotionTimer();
    const em = loadedRef.current?.model.internalModel.motionManager.expressionManager;
    if (em) void em.setExpression("neutral").catch(() => undefined);
  };

  const setEmotion = (name: string) => {
    const loaded = loadedRef.current;
    if (!loaded) return;
    if (!name || name === "neutral") {
      clearEmotion();
      return;
    }
    const clip = resolveNamed(name, loaded.expressions);
    if (!clip) {
      // VRM-vocabulary names with no Live2D counterpart ("shake") arrive
      // here; ignore rather than flash a wrong expression.
      ctx.log.info(`no Live2D expression for "${name}"`);
      return;
    }
    clearEmotionTimer();
    void loaded.model.expression(clip.id).catch(() => undefined);
    emotionTimer = window.setTimeout(clearEmotion, EMOTION_RESET_MS);
  };

  /** Gallery clicks persist until another expression is picked (the bundled
   *  model has costume expressions — ponytail, cat ears — that shouldn't
   *  self-reset after 4s like chat emotions). */
  const testExpression = (name: string) => {
    const loaded = loadedRef.current;
    if (!loaded) return;
    if (!name || name === "neutral") {
      clearEmotion();
      return;
    }
    const clip = resolveNamed(name, loaded.expressions);
    if (!clip) return;
    clearEmotionTimer();
    void loaded.model.expression(clip.id).catch(() => undefined);
  };

  const triggerMotion = (name: string) => {
    const loaded = loadedRef.current;
    if (!loaded) return;
    const clip = resolveNamed(name, loaded.motions);
    if (!clip) {
      ctx.log.info(`no Live2D motion for "${name}"`);
      return;
    }
    void loaded.model.motion(clip.id, undefined, 2 /* NORMAL */).catch(() => undefined);
  };

  /** Per-frame mouth drive: runs in the "beforeModelUpdate" hook, after the
   *  motion/expression/blink layers have written parameters and right before
   *  coreModel.update() commits them — lipsync wins over the idle motion.
   *  While silent we don't write the param at all, so expressions that move
   *  the mouth keep it. */
  const applyMouth = () => {
    if (!mouth.active && mouth.current <= 0.01) return;
    // Attack fast, release slower — reads as articulation, not a flap.
    const k = mouth.target > mouth.current ? 0.5 : 0.18;
    mouth.current += (mouth.target - mouth.current) * k;
    if (mouth.current < 0.005 && mouth.target === 0) {
      mouth.current = 0;
      mouth.active = false;
      return;
    }
    // The lib types coreModel as a bare `object`; the Cubism 4 core exposes
    // the param writer we need.
    const core = loadedRef.current?.model.internalModel.coreModel as {
      setParameterValueById?: (id: string, value: number) => void;
    } | undefined;
    core?.setParameterValueById?.("ParamMouthOpenY", mouth.current);
  };

  const setViseme = (name: string, weight?: number) => {
    if (!name || name === "neutral") {
      mouth.target = 0;
      return;
    }
    const gain = VISEME_MOUTH_OPEN[name] ?? 0.5;
    mouth.target = Math.min(1, gain * (weight ?? 1));
    mouth.active = true;
  };

  /** Cursor tracking: the canvas never receives pointer events (it sits
   *  behind the host interaction canvas), so the cursor position is polled
   *  through the host command cursor_global — window-local CSS coords that
   *  are NOT clamped to the window, so the gaze keeps pointing at the cursor
   *  while it is outside the window or on another display (model.focus() is
   *  angle-based, so out-of-bounds targets extrapolate correctly). null only
   *  means no cursor position is available (unsupported platform); the last
   *  gaze is kept then. Targets are smoothed by the FocusController itself. */
  const startTracking = () => {
    const id = window.setInterval(() => {
      const loaded = loadedRef.current;
      if (!loaded || !displayRef.current.tracking) return;
      void tauriInvoke<[number, number, number, number] | null>("cursor_global")
        .then((cursor) => {
          if (cancelled || loadedRef.current !== loaded) return;
          if (!cursor) return;
          const [x, y, w, h] = cursor;
          if (w <= 0 || h <= 0) return;
          loaded.model.focus(x, y);
        })
        .catch(() => undefined);
    }, 120);
    cleanups.push(() => window.clearInterval(id));
  };

  const attach = (loaded: LoadedModel) => {
    const app = appRef.current;
    if (!app || disposed || cancelled) {
      loaded.dispose();
      return;
    }
    const prev = loadedRef.current;
    if (prev) {
      prev.model.internalModel.off("beforeModelUpdate", applyMouth);
      prev.dispose();
      app.stage.removeChild(prev.model);
    }
    loadedRef.current = loaded;
    app.stage.addChild(loaded.model);
    loaded.model.internalModel.on("beforeModelUpdate", applyMouth);
    applyDisplay();
    clearEmotionTimer();
    ctx.log.info(`Live2D model attached: ${loaded.id}`);
  };

  /** Load and attach a model by id. Resolves false on failure (already
   *  reported to the error overlay + l2d-status) so callers can fall back. */
  const swapTo = async (id: string): Promise<boolean> => {
    const gen = ++swapGen.current;
    try {
      const loaded = await loadLive2DModel(ctx, id);
      if (gen !== swapGen.current || cancelled) {
        loaded.dispose();
        return false;
      }
      attach(loaded);
      void ctx.storage.set(MODEL_STORAGE_KEY, id).catch(() => undefined);
      ctx.events.emit("l2d-status", {
        ok: true,
        id: loaded.id,
        name: loaded.name,
        expressions: loaded.expressions.map((e) => e.id),
        motions: loaded.motions.map((m) => m.id),
      });
      return true;
    } catch (e) {
      if (gen === swapGen.current && !cancelled) {
        const message = e instanceof Error ? e.message : String(e);
        reportError(`Live2D model load failed: ${message}`);
        ctx.log.error(`model load failed: ${message}`);
        ctx.events.emit("l2d-status", { ok: false, id, error: message });
      }
      return false;
    }
  };

  // ── Expose live avatar control to other plugins (via ctx.avatar) ──
  // Installed before the boot sequence, mirroring the vrm engine: calls
  // arriving during the boot race are queued by the bus and replayed on
  // install... which already happened, so they land on live refs.
  ctx.avatar.provide({
    setEmotion: (name) => setEmotion(name),
    triggerMotion: (name) => triggerMotion(name),
    setViseme: (name, weight) => setViseme(name, weight),
    // Custom library entries are VRM-shaped (baked poses / preset blendshape
    // weights) with no Live2D equivalent; resolve them by name against the
    // bundled clips and drop what doesn't match.
    registerMotion: (def) => {
      if (typeof def?.name === "string") triggerMotion(def.name);
    },
    registerEmotion: (def) => {
      if (typeof def?.name === "string") setEmotion(def.name);
    },
    loadModel: async (source) => {
      // Live2D bundles are multi-file; raw single-file bytes can't be handed
      // to the loader.
      if (source.base64) {
        throw new Error("Live2D models load from the plugin library by id, not raw bytes");
      }
      if (source.id) await swapTo(source.id);
    },
    loadVrmaBase64: async () => {
      throw new Error(".vrma motion baking requires the VRM avatar engine");
    },
    reloadLibrary: () => {},
    describeCapabilities: () => ({
      emotions: loadedRef.current?.expressions.map((e) => e.id) ?? [],
      motions: loadedRef.current?.motions.map((m) => m.id) ?? [],
    }),
    pixelAlphaAt: (x, y) => {
      const app = appRef.current;
      return app ? canvasPixelAlpha(app, x, y) : null;
    },
  });

  // ── Settings-window contributions drive the engine through plugin events
  // (broadcast across windows); the engine only exists in the main window,
  // so these listeners are the single responders.
  cleanups.push(ctx.events.on("l2d-expression-test", (payload) => {
    if (typeof payload === "string") testExpression(payload);
  }));
  cleanups.push(ctx.events.on("l2d-motion-test", (payload) => {
    if (typeof payload === "string") triggerMotion(payload);
  }));
  cleanups.push(ctx.events.on("l2d-load", (payload) => {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id) void swapTo(id);
  }));
  cleanups.push(
    ctx.events.on("l2d-display-changed", (payload) => {
      displayRef.current = coerceDisplay(payload);
      applyDisplay();
    }),
  );

  // ── Boot ──
  void (async () => {
    try {
      // Core script + lazy library import must both complete before any
      // model load (runtime.ts memoizes the pair).
      await getLive2DRuntime(ctx);
      if (cancelled) return;

      // Persisted display settings, so scale/offset/tracking survive reloads.
      try {
        const stored = await ctx.storage.get<unknown>(DISPLAY_STORAGE_KEY);
        if (stored) displayRef.current = coerceDisplay(stored);
      } catch {
        /* defaults are fine */
      }

      // Perf config lives in the vrm plugin's backend (same read the vrm
      // engine does); a cross-plugin call must name the host command — this
      // plugin's ctx.backend.call routes to the l2d backend only. Falls
      // back to sane defaults if the read fails.
      let perf: PerfConfigShape = { max_pixel_ratio: 2, fps_cap: "sixty", antialias: true };
      try {
        perf = await callWithRetry(
          () =>
            tauriInvoke<PerfConfigShape>("plugin_call", {
              plugin_id: "vrm",
              method: "vrm.get_performance_config",
            }),
          ctx.log,
          "get_performance_config",
        );
      } catch (e) {
        ctx.log.warn(
          `perf config unavailable, using defaults: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (cancelled) return;

      const app = new PIXI.Application({
        view: canvas,
        width: canvas.clientWidth || canvas.width,
        height: canvas.clientHeight || canvas.height,
        backgroundAlpha: 0,
        antialias: perf.antialias,
        resolution: Math.min(window.devicePixelRatio || 1, perf.max_pixel_ratio || 2),
        // autoDensity must stay off: on every resize Pixi pins the canvas CSS
        // to the logical size in px (view.style.width = Npx), overriding the
        // widget's width/height:100%. The canvas then stops tracking the
        // window, the ResizeObserver below never fires again, and the avatar
        // keeps the boot-time size after a Companion Window resize. With it
        // off, CSS sizing tracks the window and `resolution` alone handles
        // DPR sharpness (canvasPixelAlpha maps through renderer.resolution).
        autoDensity: false,
        // Click-through hit tests read pixels out of the drawing buffer.
        preserveDrawingBuffer: true,
      });
      appRef.current = app;
      const fps = perf.fps_cap === "thirty" ? 30 : perf.fps_cap === "sixty" ? 60 : null;
      if (fps) {
        app.ticker.maxFPS = fps;
        PIXI.Ticker.shared.maxFPS = fps;
      }
      cleanups.push(() => {
        app.destroy(false, { children: true });
        appRef.current = null;
      });

      // Track canvas resizes (the window can be resized by the host's
      // window-size feature).
      const ro = new ResizeObserver(() => {
        const a = appRef.current;
        if (!a) return;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (w > 0 && h > 0) {
          a.renderer.resize(w, h);
          applyDisplay();
        }
      });
      ro.observe(canvas);
      cleanups.push(() => ro.disconnect());

      startTracking();

      // Active model: the stored selection if it still exists, else the
      // first library entry (imports sort before builtins in the backend).
      // With an empty library the engine idles quietly — imports from the
      // settings Models section arrive via the l2d-load event.
      try {
        const list = await callWithRetry(
          () =>
            ctx.backend.call<{ models: Array<{ id: string }> }>("l2d.list_models"),
          ctx.log,
          "l2d.list_models",
        );
        const available = list.models ?? [];
        const stored = await ctx.storage.get<string>(MODEL_STORAGE_KEY).catch(() => null);
        const target =
          typeof stored === "string" && stored && available.some((m) => m.id === stored)
            ? stored
            : available[0]?.id;
        if (target) {
          await swapTo(target);
        } else {
          ctx.log.info(
            "no models in the library yet — import one in Settings → Live2D → Models",
          );
          ctx.events.emit("l2d-status", { ok: true, empty: true });
        }
      } catch (e) {
        ctx.log.warn(`model listing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      if (!cancelled) {
        const message = e instanceof Error ? e.message : String(e);
        reportError(`Live2D engine boot failed: ${message}`);
        ctx.log.error(`boot failed: ${message}`);
      }
    }
  })();

  return () => {
    cancelled = true;
    disposed = true;
    clearEmotionTimer();
    mouth.active = false;
    mouth.target = 0;
    mouth.current = 0;
    loadedRef.current?.model.internalModel.off("beforeModelUpdate", applyMouth);
    for (const cleanup of cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        /* teardown best-effort */
      }
    }
    loadedRef.current?.dispose();
    loadedRef.current = null;
    ctx.avatar.provide({}); // back to no-ops; live handlers died with the scene
  };
}
