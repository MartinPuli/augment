/**
 * 3D icon illustrations from Thiings (https://www.thiings.co), by name → Thiings slug and the id of
 * its image on Thiings' CDN. Downloaded into public/illustrations/<name>.png by
 * scripts/fetch-illustrations.ts (git-ignored; `pnpm build` fetches them on hosted builds too).
 * To add one: find the thing on thiings.co, add its slug here (image is optional: the script
 * looks it up from the slug page when it's missing or stale), re-run the script, then use
 * <Illustration name="…" />.
 */
export const THIINGS_CDN = "https://lftz25oez4aqbxpq.public.blob.vercel-storage.com";

export const ILLUSTRATIONS = {
  polty: { slug: "ghost", image: "8Cvd0AfwhFnKyOx2wMK320kkduDnS0" },
  weather: { slug: "sun", image: "o53JuZpiN3JOy3N3lXQMLmskV0OslK" },
  calendar: { slug: "calendar", image: "ij7GEZhfmzLNlLgDJVhkST8FIm5rJV" },
  video: { slug: "television", image: "ob5X6P6AiLzXqRjJXCOedM4RaJ3Joa" },
  transit: { slug: "train", image: "B6HK6QalkOwIxTOxbj2guRpL5YQjAL" },
  camera: { slug: "cctv", image: "74phE0rsFJmY4aKzmdUvRKmJA6g5qh" },
  bridge: { slug: "bridge", image: "3p7bOUpPgDoSblqXDNtZCyxBV6DngL" },
  phone: { slug: "smartphone", image: "LxbDZUY1gzuzF4AEv0OHAqsSGpAng8" },
  router: { slug: "router", image: "HSXnqaOUs8Hl1qCYBPXfDRrjEDY55k" },
  plane: { slug: "airplane", image: "v0LP91OBaZckcNrHRNpH4uXzImn4v5" },
  chat: { slug: "chat-bubble", image: "ojyJBpIQ9Ktog9Md3IseRIXqSlExpm" },
  search: { slug: "magnifying-glass", image: "QPl7zSOxUKmFrWf7nOJIZNsfnurbAG" },
  robot: { slug: "robot", image: "JLGCwuVRfvOMwVMpimP9wXFiu6Nw4x" },
  satellite: { slug: "satellite-dish", image: "vGq6s0QYIpUuIgj2lZOX1xv2kZqPXA" },
  lightbulb: { slug: "light-bulb", image: "BkZNLc7O2vCGCXXFm5uD2hypleNGCV" },
  key: { slug: "key", image: "MUeRFCYcMO6Cp1jlR2ZQd0B6wGD5G3" },
  chip: { slug: "microchip", image: "QfNvZbqRddD0j4juPGQ7apbgXMuWRM" },
  wave: { slug: "ocean-wave", image: "Lv1O6ZPgw8KitIy69wNyWyxQKvJhQM" },
  headphones: { slug: "headphones", image: "i8kglgSpa6qTxfOFu2nYODqRk7MUo1" },
  notebook: { slug: "notebook", image: "V5g1BA4Fg3Mgks7vN6n3eaXb8KBz0g" },
  radar: { slug: "radar", image: "qWA7YLibCvxwxvmamVgK4Cz3EtKlWI" },
  wallet: { slug: "wallet", image: "r5QxxRu1dvIND6CpaRBYLTnJmCfzNM" },
  timer: { slug: "stopwatch", image: "VssSUjp7tvqQZndCA7aaNBblydpBgj" },
  news: { slug: "newspaper", image: "wlcgN77ahS7HUP9FrUG73KtE4IOQFz" },
  map: { slug: "map", image: "SsfjxCJh43Hr1dqzkbFWUGH3ICZQbH" },
  globe: { slug: "globe", image: "KBUXl6AhDj2IsoZnozHL39yX1acqa5" },
  compass: { slug: "compass", image: "lJtgyMsZAMhsOQy6TgetNuRXs9wjhj" },
} as const satisfies Record<string, { slug: string; image?: string }>;

export type IllustrationName = keyof typeof ILLUSTRATIONS;
