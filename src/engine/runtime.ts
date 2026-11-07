// Live2D runtime bootstrap: the Cubism 4 Core must exist on the page BEFORE
// pixi-live2d-display's cubism4 module evaluates — the module checks for the
// `Live2DCubismCore` global at import time and refuses to load otherwise.
// The core therefore arrives first (fetched from the backend, injected as a
// script — bundling it would drag emscripten's node fs/path fallbacks into
// the browser bundle), and the library is imported dynamically afterwards.
//
// esbuild inlines dynamic imports as lazy module closures, so the library's
// body (and its runtime check) runs on the first getLive2DRuntime() call —
// with the core already in place.

import * as PIXI from "pixi.js";
import type { PluginContext } from "../../../../sdk/js/@companion/plugin";
import { base64ToUint8Array } from "./base64";
import { callWithRetry } from "../retry";

type Cubism4Module = typeof import("pixi-live2d-display/cubism4");

let runtime: Promise<Cubism4Module> | null = null;

/** Cubism 4 runtime (Live2DModel et al.), safe to call from both the engine
 *  and the loader; the work happens once. */
export function getLive2DRuntime(ctx: PluginContext): Promise<Cubism4Module> {
  runtime ??= (async () => {
    await ensureCubismCore(ctx);
    const mod = await import("pixi-live2d-display/cubism4");
    mod.Live2DModel.registerTicker(PIXI.Ticker);
    return mod;
  })();
  return runtime;
}

// The official Core script is served by the backend and injected as a blob
// script on first boot; pixi-live2d-display reads the `Live2DCubismCore`
// global, so the script only has to exist before the library evaluates.
let coreLoading: Promise<void> | null = null;

function ensureCubismCore(ctx: PluginContext): Promise<void> {
  if ((globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    return Promise.resolve();
  }
  coreLoading ??= (async () => {
    const { base64 } = await callWithRetry(
      () => ctx.backend.call<{ base64: string }>("l2d.core"),
      ctx.log,
      "l2d.core",
      { timeoutMs: 30_000, retries: 3 },
    );
    const url = URL.createObjectURL(
      new Blob([base64ToUint8Array(base64)], { type: "text/javascript" }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Cubism Core script failed to execute"));
        document.head.appendChild(script);
      });
    } finally {
      // Evaluated synchronously by the load event; the URL can go.
      URL.revokeObjectURL(url);
    }
    if (!(globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
      throw new Error("Cubism Core loaded but did not define Live2DCubismCore");
    }
  })();
  return coreLoading;
}
