// Backend-call resilience, shared by the avatar engine and the settings
// sections.
//
// Backend calls issued from a plugin context occasionally never resolve on
// macOS (queued IPC responses while the page is loading; observed 10s+
// per-call file-op stalls). The wedge window is widest right after a plugin
// (re)activation, when the freshly imported bundle is still evaluating while
// the boot burst of calls goes out — a lost `vrm.list_models` used to leave
// the Avatar Library empty until the next upload-triggered refresh. Race
// each call against a timeout and retry so every consumer always converges
// instead of hanging forever.

const CALL_TIMEOUT_MS = 8_000;
const CALL_RETRIES = 8;
const CALL_RETRY_PAUSE_MS = 500;

export type CallRetryOpts = {
  /** Per-attempt timeout. Default 8s — raise it for calls whose payloads are
   *  huge (model bytes), where a short timeout would stack duplicate
   *  multi-MB transfers on top of a busy webview instead of helping. */
  timeoutMs?: number;
  /** Total attempts (first try included). Default 8. */
  retries?: number;
};

export async function callWithRetry<T>(
  op: (attempt: number) => Promise<T>,
  log: { warn: (m: string) => void },
  label: string,
  opts?: CallRetryOpts,
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? CALL_TIMEOUT_MS;
  const retries = opts?.retries ?? CALL_RETRIES;
  let last: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const attemptPromise = op(attempt);
    const winner = await Promise.race([
      attemptPromise.then(
        (v) => ({ done: true as const, v }),
        (e) => ({ done: true as const, err: e instanceof Error ? e : new Error(String(e)) }),
      ),
      new Promise<{ done: false }>((resolve) =>
        setTimeout(() => resolve({ done: false }), timeoutMs),
      ),
    ]);
    if (winner.done) {
      if ("v" in winner) return winner.v;
      throw winner.err;
    }
    // Timed out: keep waiting for the hung attempt in the background (it may
    // still deliver), and let the loop try a fresh call.
    void attemptPromise.catch(() => undefined);
    last = new Error(`${label}: attempt ${attempt} timed out`);
    log.warn(last.message);
    await new Promise((resolve) => setTimeout(resolve, CALL_RETRY_PAUSE_MS));
  }
  throw last ?? new Error(`${label}: backend call unavailable`);
}
