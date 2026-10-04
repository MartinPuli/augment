// Downloads the nature background loop (and its poster) into public/media/ so the demo machine
// serves it locally instead of streaming it from the CDN. The files are git-ignored.
// Usage: pnpm exec tsx scripts/fetch-background.ts [videoUrl] [posterUrl]
// Footage: Mixkit "Calm sea with paddleboarder" (dawn) — Mixkit Stock Video Free License
// (https://mixkit.co/license/#videoFree). See docs/credits.md.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VIDEO =
  (process.argv[2]?.startsWith("http") ? process.argv[2] : undefined) ?? process.env.NEXT_PUBLIC_BG_VIDEO_URL ?? "https://assets.mixkit.co/videos/2079/2079-720.mp4";
const POSTER =
  (process.argv[3]?.startsWith("http") ? process.argv[3] : undefined) ?? process.env.NEXT_PUBLIC_BG_POSTER_URL ?? "https://assets.mixkit.co/videos/2079/2079-thumb-720-0.jpg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "media");
mkdirSync(outDir, { recursive: true });

async function download(url: string, file: string) {
  const dest = join(outDir, file);
  const res = await fetch(url, { headers: { "user-agent": "ghost-fetch-background/1.0" } });
  if (!res.ok || !res.body) throw new Error(`${url} → HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
  renameSync(tmp, dest);
  console.log(`✓ ${file}  ${(statSync(dest).size / 1e6).toFixed(1)} MB  ← ${url}`);
}

async function main() {
  const force = process.argv.includes("--force");
  for (const [url, file] of [
    [VIDEO, "nature.mp4"],
    [POSTER, "nature.jpg"],
  ] as const) {
    if (!force && existsSync(join(outDir, file))) {
      console.log(`• ${file} already present (pass --force to refresh)`);
      continue;
    }
    await download(url, file);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
