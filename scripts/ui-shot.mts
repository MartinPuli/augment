// Dev utility: screenshot the GHOST UI with the local Chrome (headless).
// Usage: pnpm exec tsx scripts/ui-shot.mts <url> <out.png> [prompt] [waitMs] [width] [height]
import { chromium } from "playwright-core";

const [url = "http://localhost:3000/", out = "shot.png", prompt, waitMs = "2500", w = "1440", h = "900", clickSel] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal"],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
const logs: string[] = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
if (prompt) {
  await page.keyboard.press("Escape");
  await page.click('button[aria-label="Type"]', { force: true });
  await page.fill("input[placeholder]", prompt);
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(Number(waitMs));
if (clickSel) {
  await page.click(clickSel);
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: out });
console.log(logs.slice(0, 15).join("\n") || "no console errors");
await browser.close();
