// Builds the pixi-live2d-display settings JSON for a Live2D model bundle.
//
// The bundled IceGirl.model3.json declares only Moc/Textures/Physics/
// DisplayInfo — no Motions, no Expressions, and empty EyeBlink/LipSync
// parameter groups — so this enriches it from the bundle's file list:
// - an "Idle" motion group (the VTube Studio idle) plus one group per motion
//   keyed by its stable id, so `model.motion(id)` triggers it directly;
// - an expression entry per exp3 file with explicit fade times (the exp3
//   files carry none; without them the SDK uses its own defaults);
// - EyeBlink/LipSync parameter groups (standard Cubism param ids) so idle
//   blinking and lip sync have targets.
//
// Every FileReferences path is rewritten through `resolvePath` — the loader
// passes absolute blob URLs, which the factory's url.resolve returns
// unchanged — and a string `url` field is set because ModelSettings'
// constructor requires one.

import type { NamedFile } from "./names";

export const EYE_BLINK_PARAMS = ["ParamEyeLOpen", "ParamEyeROpen"];
export const LIPSYNC_PARAMS = ["ParamMouthOpenY"];
export const EXPRESSION_FADE_MS = 500;
export const MOTION_FADE_MS = 500;

/** Synthesized first expression: an empty param set that cross-fades from
 *  any active expression back to the model's neutral face. Lives at index 0
 *  so it is also the manager's defaultExpression (its resetExpression()
 *  target). */
export const NEUTRAL_EXPRESSION = "neutral";

type FileReferences = {
  Moc: string;
  Textures: string[];
  Physics?: string;
  DisplayInfo?: string;
  Motions?: Record<string, Array<{ File: string; FadeInTime?: number; FadeOutTime?: number }>>;
  Expressions?: Array<{ Name: string; File: string; FadeInTime?: number; FadeOutTime?: number }>;
};

export type ModelSettingsJSON = {
  url: string;
  name?: string;
  FileReferences: FileReferences;
  Groups?: Array<{ Target: string; Name: string; Ids: string[] }>;
  HitAreas?: Array<{ Id: string; Name: string }>;
  [key: string]: unknown;
};

/**
 * @param raw           parsed model3.json from the bundle
 * @param settingsFile  settings file name inside the model dir
 * @param files         every manifest-worthy relative path in the model dir
 * @param expressions   expression clips from names.collectExpressions
 * @param motions       motion clips from names.collectMotions
 * @param resolvePath   relative path → loadable URL (blob URL at runtime)
 */
export function buildModelSettings(
  raw: Record<string, unknown>,
  settingsFile: string,
  files: string[],
  expressions: NamedFile[],
  motions: NamedFile[],
  resolvePath: (rel: string) => string,
): ModelSettingsJSON {
  const fr = (raw.FileReferences ?? {}) as Partial<FileReferences>;
  if (typeof fr.Moc !== "string" || !Array.isArray(fr.Textures) || fr.Textures.length === 0) {
    throw new Error(`${settingsFile}: FileReferences.Moc/Textures missing or malformed`);
  }
  for (const tex of fr.Textures) {
    if (typeof tex !== "string") {
      throw new Error(`${settingsFile}: FileReferences.Textures must be strings`);
    }
  }

  // Motions: each clip gets its own group keyed by id (one motion each, so a
  // group name is a direct trigger), plus the "Idle" group the runtime
  // autoplays when nothing else is playing — the aliased idle motion if
  // present, else the first bundled motion.
  const motionGroups: NonNullable<FileReferences["Motions"]> = {};
  const has = (needle: string) => files.some((f) => f === needle || f.endsWith(`/${needle}`));
  const entryOf = (clip: NamedFile) => {
    if (!has(clip.file)) throw new Error(`motion file missing from bundle: ${clip.file}`);
    return { File: resolvePath(clip.file), FadeInTime: MOTION_FADE_MS, FadeOutTime: MOTION_FADE_MS };
  };
  for (const clip of motions) {
    motionGroups[clip.id] = [entryOf(clip)];
  }
  if (motions.length > 0) {
    const idle = motions.find((m) => m.id === "idle") ?? motions[0];
    motionGroups.Idle = [entryOf(idle)];
  }

  // Expressions: synthesized neutral first (the manager's reset target),
  // then every exp3 file keyed by id. Neutral resolves to an empty-params
  // exp3 blob the loader synthesizes — see NEUTRAL_EXP3_JSON.
  const expressionEntries: NonNullable<FileReferences["Expressions"]> = [
    {
      Name: NEUTRAL_EXPRESSION,
      File: resolvePath(`__l2d_neutral__${NEUTRAL_EXPRESSION}.exp3.json`),
      FadeInTime: EXPRESSION_FADE_MS,
      FadeOutTime: EXPRESSION_FADE_MS,
    },
  ];
  for (const clip of expressions) {
    if (!has(clip.file)) throw new Error(`expression file missing from bundle: ${clip.file}`);
    expressionEntries.push({
      Name: clip.id,
      File: resolvePath(clip.file),
      FadeInTime: EXPRESSION_FADE_MS,
      FadeOutTime: EXPRESSION_FADE_MS,
    });
  }

  // Parameter groups: keep whatever the model declares, fill in EyeBlink and
  // LipSync when missing or empty (IceGirl ships both empty).
  const groups = ((raw.Groups as ModelSettingsJSON["Groups"]) ?? []).map((g) => ({ ...g }));
  fillGroup(groups, "EyeBlink", EYE_BLINK_PARAMS);
  fillGroup(groups, "LipSync", LIPSYNC_PARAMS);

  return {
    ...(raw as Omit<ModelSettingsJSON, "url" | "FileReferences" | "Groups">),
    url: resolvePath(settingsFile),
    FileReferences: {
      Moc: resolvePath(fr.Moc),
      Textures: fr.Textures.map(resolvePath),
      ...(typeof fr.Physics === "string" ? { Physics: resolvePath(fr.Physics) } : {}),
      ...(typeof fr.DisplayInfo === "string" ? { DisplayInfo: resolvePath(fr.DisplayInfo) } : {}),
      ...(Object.keys(motionGroups).length > 0 ? { Motions: motionGroups } : {}),
      ...(expressions.length > 0 ? { Expressions: expressionEntries } : {}),
    },
    Groups: groups,
  };
}

function fillGroup(
  groups: NonNullable<ModelSettingsJSON["Groups"]>,
  name: string,
  ids: string[],
): void {
  const existing = groups.find(
    (g) => g.Target === "Parameter" && g.Name === name,
  );
  if (existing && Array.isArray(existing.Ids) && existing.Ids.length > 0) return;
  if (existing) {
    existing.Ids = [...ids];
    return;
  }
  groups.push({ Target: "Parameter", Name: name, Ids: [...ids] });
}

/** A no-op Cubism 4 expression: no parameters, so cross-fading to it shows
 *  the model's plain face. */
export const NEUTRAL_EXP3_JSON = {
  Type: "Live2D Expression",
  FadeInTime: EXPRESSION_FADE_MS,
  FadeOutTime: EXPRESSION_FADE_MS,
  Parameters: [],
};

/** The fake settings-relative path the neutral expression is registered
 *  under; the loader serves this from a synthesized blob instead of the
 *  backend. */
export function neutralExpressionFile(): string {
  return `__l2d_neutral__${NEUTRAL_EXPRESSION}.exp3.json`;
}
