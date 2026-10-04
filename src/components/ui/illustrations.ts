/**
 * 3D icon illustrations from Thiings (https://www.thiings.co), by name → Thiings slug.
 * Downloaded into public/illustrations/<name>.png by scripts/fetch-illustrations.ts (git-ignored).
 * Add a name here, re-run the script, and use it with <Illustration name="…" />.
 */
export const ILLUSTRATIONS = {
  polty: "ghost",
  weather: "sun",
  calendar: "calendar",
  video: "television",
  transit: "train",
  camera: "cctv",
  bridge: "bridge",
  phone: "smartphone",
  router: "router",
  plane: "airplane",
  chat: "chat-bubble",
  search: "magnifying-glass",
  robot: "robot",
  satellite: "satellite-dish",
  lightbulb: "light-bulb",
  key: "key",
  chip: "microchip",
  wave: "ocean-wave",
  headphones: "headphones",
  notebook: "notebook",
  radar: "radar",
  wallet: "wallet",
  timer: "stopwatch",
  news: "newspaper",
  map: "map",
  globe: "globe",
  compass: "compass",
} as const;

export type IllustrationName = keyof typeof ILLUSTRATIONS;
