// Minimal vendored Tauri event bridge — same approach as the voice plugin's
// src/tauri.ts: the plugin bundle cannot resolve @tauri-apps/api (features/
// has no node_modules chain to the app's), so the primitives we need are read
// straight off window.__TAURI_INTERNALS__, mirroring @tauri-apps/api v2
// core.js/event.js:
// - listen → invoke("plugin:event|listen", { event, target, handler })
// - emit   → invoke("plugin:event|emit", { event, payload })
// - invoke → raw core command call (get_performance_config; the perf config
//   is host-owned state the engine reads directly)
//
// Used ONLY for host-global channels the plugin-namespaced ctx.events can't
// reach: the idle-mixer broadcast ("idle-mixer-changed"), the perf broadcast
// ("perf-changed"), and reading the perf config itself. Everything else goes
// through ctx.*.

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  transformCallback: (callback?: (response: unknown) => void, once?: boolean) => number;
  metadata?: { currentWindow?: { label?: string }; currentWebview?: { label?: string } };
}

function internals(): TauriInternals | undefined {
  return typeof window !== "undefined"
    ? (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    : undefined;
}

/** Label of the webview this bundle runs in ("main" | "settings"), when known. */
export function currentWindowLabel(): string {
  return internals()?.metadata?.currentWindow?.label ?? "";
}

/** Listen to a host-global (non-plugin-namespaced) Tauri event. */
export function tauriListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const t = internals();
  if (!t || typeof t.invoke !== "function" || typeof t.transformCallback !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  const handlerId = t.transformCallback((e: unknown) => {
    handler((e as { payload?: T })?.payload as T);
  });
  return t
    .invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: handlerId })
    .then((eventId) => {
      return () => {
        void t
          .invoke("plugin:event|unlisten", { event, eventId })
          .catch(() => {});
      };
    });
}

/** Emit a host-global (non-plugin-namespaced) Tauri event. */
export function tauriEmit(event: string, payload?: unknown): Promise<void> {
  const t = internals();
  if (!t || typeof t.invoke !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  return t.invoke("plugin:event|emit", { event, payload }).then(() => undefined);
}

/** Invoke a host (core) Tauri command directly — for host-owned state the
 *  plugin reads outside its namespaced surface (currently the perf config). */
export function tauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const t = internals();
  if (!t || typeof t.invoke !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  return t.invoke(cmd, args) as Promise<T>;
}

/** Tauri v2 asset-protocol URL for an absolute file path. Used to stream
 *  plugin model files into the webview without multi-MB IPC payloads. The
 *  host must enable the asset protocol with a scope covering the path
 *  (tauri.conf.json app.security.assetProtocol).
 *
 *  The URL form is platform-specific (`asset://localhost/...` on macOS,
 *  `http://asset.localhost/...` on Windows), so this delegates to the host's
 *  convertFileSrc when available — the same source of truth
 *  @tauri-apps/api's convertFileSrc uses. */
export function assetUrl(absolutePath: string): string {
  const t = internals() as
    | { convertFileSrc?: (path: string, protocol?: string) => string }
    | undefined;
  if (typeof t?.convertFileSrc === "function") {
    return t.convertFileSrc(absolutePath);
  }
  return `asset://localhost/${encodeURIComponent(absolutePath)}`;
}
