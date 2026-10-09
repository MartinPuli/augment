// Downloads the 3D icon illustrations (Thiings, https://www.thiings.co) into public/illustrations/
// so the UI serves them locally. The files are git-ignored: Thiings icons are free for personal use,
// and the whole collection needs a commercial licence, so they are never redistributed from this
// public repository. Missing files fall back to a line icon in the UI.
// Usage: pnpm exec tsx scripts/fetch-illustrations.ts [--force] [--soft]
// `pnpm build` runs it with --soft, so hosted builds (Vercel, Docker) fetch them too; --soft never
// fails the build (the UI falls back to line icons for anything that didn't download).
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ILLUSTRATIONS, THIINGS_CDN } from "../src/components/ui/illustrations";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "illustrations");
mkdirSync(outDir, { recursive: true });
const UA = { "user-agent": "ghost-fetch-illustrations/1.0" };

/** The thing's own image is the `imageUrl` right before its own `shareUrl` in the page data. */
async function imageUrl(slug: string): Promise<string> {
  const res = await fetch(`https://www.thiings.co/things/${slug}`, {
    headers: UA,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`page ${slug} → HTTP ${res.status}`);
  const html = (await res.text()).replace(/\\"/g, '"');
  const share = `"shareUrl":"https://www.thiings.co/things/${slug}"`;
  const at = html.indexOf(share);
  if (at < 0) throw new Error(`no thing "${slug}" on thiings.co`);
  const before = html.slice(Math.max(0, at - 600), at);
  const m = [...before.matchAll(/"imageUrl":"(https:\/\/[^"]+)"/g)].pop();
  if (!m) throw new Error(`no image for "${slug}"`);
  return m[1];
}

async function main() {
  const force = process.argv.includes("--force");
  const soft = process.argv.includes("--soft");
  let failed = 0;
  const get = (url: string) => fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  const one = async (name: string, { slug, image }: { slug: string; image?: string }) => {
    const dest = join(outDir, `${name}.png`);
    if (!force && existsSync(dest)) return console.log(`• ${name} already present`);
    try {
      // the known CDN image first (fast); look it up from the thing's page only if that fails
      let url = image ? `${THIINGS_CDN}/image-${image}.png` : await imageUrl(slug);
      let res = await get(url);
      if (!res.ok && image) res = await get((url = await imageUrl(slug)));
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, dest);
      console.log(`✓ ${name.padEnd(12)} ${(statSync(dest).size / 1e3).toFixed(0).padStart(5)} kB  ← thiings.co/things/${slug}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  };
  // a few at a time: fast on CI, polite to thiings.co
  const queue = Object.entries(ILLUSTRATIONS);
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await one(job[0], job[1]);
  }));
  if (failed) {
    console.warn(`${failed} illustration(s) missing; the UI shows line icons for them.`);
    if (!soft) process.exitCode = 1;
  }
}

void main();
