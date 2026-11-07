// Standalone plugin build — no monorepo paths.
//
//   pnpm build                # stage the package to dist/package
//   pnpm build --zip          # also write dist/<id>-<version>.zip
//
// Uses companion-cli's buildPlugin (esbuild bundle + cargo build + manifest),
// pointing the SDK at this repo's own @companion-lab/plugin install — the
// host app aliases the same import to its SDK at load time, so the bundle
// always runs against what the installed host provides.
//
// companion-cli's `build` subcommand zips the staging dir, but its zip step
// reads the staged `assets` directory entry with readFileSync (EISDIR), so
// this script drives buildPlugin directly and zips with the system zip when
// asked.

import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const { buildPlugin } = require("companion-cli/lib/build.mjs");
const esbuild = require("esbuild");

const wantZip = process.argv.includes("--zip");
const outDir = path.join(repoRoot, "dist", "package");
rmSync(outDir, { recursive: true, force: true });

const { manifest, files } = await buildPlugin({
  pluginDir: repoRoot,
  outDir,
  frontend: true,
  backend: true,
  esbuild,
  sdkDir: path.join(repoRoot, "node_modules", "@companion-lab", "plugin"),
  log: (msg) => console.log(msg.split(`${repoRoot}/`).join("")),
});

console.log(`[build] staged ${files.length} file(s) -> ${path.relative(repoRoot, outDir)}`);

if (wantZip) {
  const zipName = `${manifest.id}-${manifest.version ?? "0.0.0"}.zip`;
  const outPath = path.join(repoRoot, "dist", zipName);
  rmSync(outPath, { force: true });
  mkdirSync(path.dirname(outPath), { recursive: true });
  const prev = process.cwd();
  process.chdir(outDir);
  try {
    execSync(`zip -qr ${JSON.stringify(outPath)} .`, { stdio: "inherit" });
  } finally {
    process.chdir(prev);
  }
  console.log(`[build] wrote ${path.relative(repoRoot, outPath)}`);
}

if (!existsSync(path.join(outDir, "assets", "core", "live2dcubismcore.min.js"))) {
  console.warn(
    "[build] NOTE: assets/core/live2dcubismcore.min.js is missing — run `pnpm fetch-core` " +
      "before distributing, or the plugin cannot render.",
  );
}
