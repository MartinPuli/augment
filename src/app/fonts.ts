import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Licensed typefaces, self-hosted from public/fonts (git-ignored: this repository is public).
 *
 *   Tiempos (Klim), Regular only: the primary voice of the app (headlines, Polty's words).
 *     "Tiempos Headline" for display sizes, "Tiempos Text" for reading sizes.
 *   Maison Neue (Milieu Grotesque), Book / Medium / Demi: body text for the rest of the UI.
 *
 * Each face lists `local()` first (a copy installed on the machine) and then only the files that
 * actually exist in public/fonts, so a machine without the fonts gets the fallbacks in globals.css
 * instead of 404s. See public/fonts/README.md.
 */
const FACES: {
  family: string;
  weight: number;
  file: string;
  local: string[];
}[] = [
  {
    family: "Tiempos Headline",
    weight: 400,
    file: "TiemposHeadline-Regular",
    local: ["Tiempos Headline Regular", "TiemposHeadline-Regular", "Test Tiempos Headline"],
  },
  {
    family: "Tiempos Text",
    weight: 400,
    file: "TiemposText-Regular",
    local: ["Tiempos Text Regular", "TiemposText-Regular", "Test Tiempos Text"],
  },
  {
    family: "Maison Neue",
    weight: 400,
    file: "MaisonNeue-Book",
    local: ["Maison Neue Book", "MaisonNeue-Book"],
  },
  {
    family: "Maison Neue",
    weight: 500,
    file: "MaisonNeue-Medium",
    local: ["Maison Neue Medium", "MaisonNeue-Medium"],
  },
  {
    family: "Maison Neue",
    weight: 600,
    file: "MaisonNeue-Demi",
    local: ["Maison Neue Demi", "MaisonNeue-Demi"],
  },
];

const FORMATS = [
  ["woff2", "woff2"],
  ["woff", "woff"],
  ["otf", "opentype"],
  ["ttf", "truetype"],
] as const;

export function fontFaceCss(): string {
  const dir = join(process.cwd(), "public", "fonts");
  return FACES.map((f) => {
    const files = FORMATS.filter(([ext]) => existsSync(join(dir, `${f.file}.${ext}`))).map(([ext, fmt]) => `url("/fonts/${f.file}.${ext}") format("${fmt}")`);
    const src = [...f.local.map((n) => `local("${n}")`), ...files].join(", ");
    return `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:${src};}`;
  }).join("\n");
}
