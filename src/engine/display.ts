// Display transform shared by the engine (runtime) and the settings section
// (persistence + live updates through the l2d-display-changed event).

export type DisplaySettings = {
  /** Multiplier over the base fit-to-window scale. */
  scale: number;
  /** Horizontal offset from center, CSS px. */
  x: number;
  /** Vertical offset from center, CSS px (positive = down). */
  y: number;
  /** Head/eye tracking of the global cursor. */
  tracking: boolean;
};

export const DEFAULT_DISPLAY: DisplaySettings = { scale: 1, x: 0, y: 0, tracking: true };

/** Merge a partially-known stored/blob payload into a full DisplaySettings,
 *  falling back per-field to the defaults (the storage may predate a field). */
export function coerceDisplay(value: unknown): DisplaySettings {
  const v = (value ?? {}) as Partial<DisplaySettings>;
  return {
    scale: typeof v.scale === "number" ? v.scale : DEFAULT_DISPLAY.scale,
    x: typeof v.x === "number" ? v.x : DEFAULT_DISPLAY.x,
    y: typeof v.y === "number" ? v.y : DEFAULT_DISPLAY.y,
    tracking: typeof v.tracking === "boolean" ? v.tracking : DEFAULT_DISPLAY.tracking,
  };
}
