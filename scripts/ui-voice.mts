// Dev utility: end-to-end voice test. Feeds a WAV file as the microphone, taps the mic, screenshots.
// Usage: pnpm exec tsx scripts/ui-voice.mts <wav> <out.png> [waitMs]
import { chromium } from "playwright-core";

const [wav, out = "voice.png", waitMs = "25000"] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs: string[] = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.click('button[aria-label="Talk to Polty"]');
const t0 = Date.now();
let lastCaption = "";
while (Date.now() - t0 < Number(waitMs)) {
  const cap = await page.locator("p.line-clamp-2").first().textContent().catch(() => "");
  if (cap && cap !== lastCaption) {
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s caption: ${cap.slice(0, 120)}`);
    lastCaption = cap;
  }
  await page.waitForTimeout(300);
}
await page.screenshot({ path: out });
console.log(logs.slice(0, 10).join("\n") || "no console errors");
await browser.close();
