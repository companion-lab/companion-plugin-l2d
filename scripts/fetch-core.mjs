// Fetch the Live2D Cubism Core runtime into assets/core/ (gitignored —
// Live2D's proprietary runtime is not committed to this repository).
//
//   node scripts/fetch-core.mjs      (also runs on postinstall)
//
// The plugin cannot render without it: the backend serves this file to the
// webview as the Cubism 4 runtime script before any model loads.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_URL = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";

const dest = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "core",
  "live2dcubismcore.min.js",
);

if (existsSync(dest)) {
  console.log("[fetch-core] already present:", dest);
  process.exit(0);
}

console.log(`[fetch-core] downloading ${CORE_URL}`);
const res = await fetch(CORE_URL);
if (!res.ok) {
  console.error(`[fetch-core] download failed: HTTP ${res.status} ${res.statusText}`);
  console.error("[fetch-core] the plugin cannot render models without the Cubism Core.");
  process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
console.log("[fetch-core] wrote", dest);
