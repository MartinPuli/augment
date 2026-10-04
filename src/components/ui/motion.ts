/**
 * Motion tokens. Every animation in the UI is "duration X, easing/spring Y, for reason Z":
 * feedback, spatial continuity, a state change, or a rare earned delight.
 *
 * - Stay under 300 ms for anything that is not a rare moment; exits are faster than entries.
 * - Springs for anything touchable or interruptible (they re-target from where they are).
 * - `gentle` is the default; `bouncy` only for momentum or a rare success.
 * The CSS side mirrors these as `ease-standard` / `ease-move` in globals.css.
 */
export const duration = {
  instant: 0.11,
  fast: 0.18,
  base: 0.24,
  deliberate: 0.38,
  celebratory: 0.7,
} as const;

export const ease = {
  /** strong ease-out: anything entering or exiting */
  standard: [0.23, 1, 0.32, 1],
  /** ease-in-out: something already on screen repositioning */
  move: [0.77, 0, 0.175, 1],
} as const;

export const spring = {
  gentle: { type: "spring", stiffness: 260, damping: 26, mass: 1 },
  snappy: { type: "spring", stiffness: 460, damping: 30, mass: 1 },
  bouncy: { type: "spring", stiffness: 520, damping: 13, mass: 1 },
} as const;

/** Light haptic tick on supporting phones (Android); a no-op elsewhere. Fire with the visual. */
export function haptic(pattern: number | number[] = 8) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
