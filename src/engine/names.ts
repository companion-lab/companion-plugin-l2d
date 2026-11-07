// Model file naming: stable ids for chat-facing emotion/motion names.
//
// The bundled IceGirl model uses Chinese expression file names
// (生气.exp3.json, …) and capitalized motion names (DaiJi, HuiShou, MeiYan).
// Chat emotion tags and settings UIs want stable ASCII ids, so files map
// through an alias table — anything outside the table falls back to a
// slugified file stem — and resolution accepts either form, so
// `<<emotion:生气>>` and `<<emotion:angry>>` both hit the same expression.

export type NamedFile = {
  /** Stable id (alias when known, slugified stem otherwise). */
  id: string;
  /** Original file stem, as the model author named it. */
  native: string;
  /** Path relative to the model dir. */
  file: string;
};

/** exp3 file stem → stable id, one entry per bundled IceGirl expression. */
const EXPRESSION_ALIASES: Record<string, string> = {
  "生气": "angry",
  "惊讶": "surprised",
  "流泪": "crying",
  "脸红": "blush",
  "脸黑": "dark-face",
  "星星眼": "star-eyes",
  "爱心眼": "heart-eyes",
  "金钱眼": "money-eyes",
  "白眼": "eye-roll",
  "疑惑": "confused",
  "舌头": "tongue",
  "猫耳": "cat-ears",
  "王冠": "crown",
  "翅膀": "wings",
  "手柄": "gamepad",
  "直播套装": "outfit",
  "马尾": "ponytail",
  "披发": "hair-down",
  "歪嘴→": "mouth-right",
  "←歪嘴": "mouth-left",
};

/** motion3 file stem → stable id. DaiJi is the VTube Studio idle animation. */
const MOTION_ALIASES: Record<string, string> = {
  DaiJi: "idle",
  HuiShou: "wave",
  MeiYan: "charm",
};

/** Chat-driven names other plugins send that have no file of their own.
 *  The tts plugin greets mic-on with emotion "happy" and a "nod" motion
 *  (VRM vocabulary); map them to the closest bundled clips. "shake" has no
 *  Live2D counterpart and resolves to nothing on purpose. */
const INPUT_ALIASES: Record<string, string> = {
  happy: "blush",
  nod: "wave",
};

/** Lowercase ASCII slug of a file stem; "" when nothing survives (Chinese
 *  stems outside the alias table), in which case the native stem stays the
 *  id — Cubism expression names are arbitrary strings. */
export function slugify(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collect(files: string[], ext: string, aliases: Record<string, string>): NamedFile[] {
  const out: NamedFile[] = [];
  for (const file of files) {
    if (!file.endsWith(ext)) continue;
    const native = file.slice(0, -ext.length);
    if (!native) continue;
    out.push({ id: aliases[native] ?? (slugify(native) || native), native, file });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

/** Expressions in the bundle (sorted by path for stable ordering). */
export function collectExpressions(files: string[]): NamedFile[] {
  return collect(files, ".exp3.json", EXPRESSION_ALIASES);
}

/** Motions in the bundle (sorted by path for stable ordering). */
export function collectMotions(files: string[]): NamedFile[] {
  return collect(files, ".motion3.json", MOTION_ALIASES);
}

/** Resolve a chat/UI name to a bundled clip: chat aliases first (happy →
 *  blush, nod → wave), then exact id, exact native name, case-insensitive id,
 *  then substring in either direction. "neutral" is the synthesized no-op
 *  expression and resolves like any other id when present in the list. */
export function resolveNamed(input: string, list: NamedFile[]): NamedFile | null {
  const q = (INPUT_ALIASES[input.trim()] ?? input).trim();
  if (!q || list.length === 0) return null;
  const lower = q.toLowerCase();
  return (
    list.find((n) => n.id === q) ??
    list.find((n) => n.native === q) ??
    list.find((n) => n.id.toLowerCase() === lower) ??
    list.find((n) => n.id.toLowerCase().includes(lower) || lower.includes(n.id.toLowerCase())) ??
    null
  );
}
