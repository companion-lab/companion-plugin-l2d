# Third-party notices

## Live2D Cubism Core

`assets/core/live2dcubismcore.min.js` (fetched locally by
`scripts/fetch-core.mjs`, **not committed**) is the Live2D Cubism Core
runtime, © Live2D Inc., distributed as "Redistributable Code" under the
Live2D Proprietary Software License Agreement:
https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html

It is downloaded unmodified from the official Live2D CDN
(<https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js>) and
served to the webview as a runtime script (bundling it is not possible — its
emscripten preamble references node builtins).

## Live2D models

This repository ships **no character models**. Models are imported at
runtime by the user (Settings → Live2D → Models) and live outside this
repository, in the plugin's data dir. Imported models are third-party works
with their own license terms — their license files accompany the model
folder, and respecting them is the user's responsibility.

## Runtime libraries

- **pixi.js** — MIT © PixiJS contributors
- **pixi-live2d-display** — MIT © guansss and contributors
