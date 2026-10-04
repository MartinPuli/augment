/** Fresh headless Chrome + FAKE microphone. Does not capture the user's audio or scan the LAN. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { DeviceConnectionMemory } from "../src/lib/ghost/client/api-types";

async function main() {
  const origin = process.env.GHOST_ORIGIN || "http://localhost:3300";
  const shots = process.env.SHOTS || "/tmp/ghost-device-test";
  await fs.mkdir(shots, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", chromium.executablePath()].find(existsSync),
    headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let checks = 0;
  function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
  try {
    await page.goto(`${origin}/devices`);
    await page.getByRole("button", { name: /^Connect microphone\b/ }).waitFor({ timeout: 60000 });
    const selector = page.getByLabel("Microphone input", { exact: true });
    await page.waitForFunction(() => document.querySelector("select")!.options.length > 1);
    const input = await selector.locator("option").evaluateAll((options) => options.map((o) => ({ id: (o as HTMLOptionElement).value, label: o.textContent })).find((o) => o.id && o.id !== "default"));
    assert(input?.id, "fake microphone should be enumerable");
    await selector.selectOption(input.id);
    await page.getByRole("button", { name: /^Connect microphone\b/ }).click();
    await page.getByRole("button", { name: "Turn off microphone", exact: true }).waitFor();
    await page.getByRole("button", { name: "Test sound level", exact: true }).waitFor();
    check("device setup works without a model call", () => assert.equal(errors.length, 0));
    await page.getByRole("button", { name: "Test sound level", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "This call is now remembered" }).waitFor();
    let memories = await context.request.get(`${origin}/api/v1/device-connections`).then((r) => r.json() as Promise<DeviceConnectionMemory[]>);
    const first = memories.find((m) => m.guide.input_label);
    check("real browser driver returns a numeric observation from FAKE audio", () => {
      assert(first); assert.equal(first.history.succeeded, 1); assert(first.history.last_successful[0].observation_id);
    });
    check("actual input label is published in durable connection memory", () => {
      assert(first?.guide.input_label?.includes("Fake"));
      assert.equal(first?.history.last_successful[0].input_label, first?.guide.input_label);
    });
    await page.screenshot({ path: `${shots}/desktop.png`, fullPage: true });
    await page.reload();
    await page.getByRole("button", { name: /^Connect microphone\b/ }).waitFor();
    await page.waitForFunction((id) => document.querySelector("select")?.value === id, input.id);
    const enabledAfterReload = await page.getByRole("button", { name: "Turn off microphone", exact: true }).count();
    check("browser reload restores the chosen input without enabling it", () => assert.equal(enabledAfterReload, 0));
    await page.getByRole("button", { name: /^Connect microphone\b/ }).click();
    await page.getByRole("button", { name: "Turn off microphone", exact: true }).waitFor();
    memories = await context.request.get(`${origin}/api/v1/device-connections`).then((r) => r.json() as Promise<DeviceConnectionMemory[]>);
    check("connector reload retains device identity and previous evidence", () => assert.equal(memories.find((m) => m.device_id === first?.device_id)?.history.succeeded, 1));
    await page.getByRole("button", { name: "Turn off microphone", exact: true }).click();
    await page.getByRole("button", { name: /^Connect microphone\b/ }).waitFor();
    await page.evaluate(() => localStorage.setItem("ghost.microphone.input.v1", JSON.stringify({ deviceId: "nonexistent-test-input", label: "SIMULATED disconnected input" })));
    await page.reload();
    await page.getByRole("button", { name: /^Connect microphone\b/ }).waitFor();
    await page.waitForFunction(() => document.querySelector("select")?.value === "nonexistent-test-input");
    await page.getByRole("button", { name: /^Connect microphone\b/ }).click();
    await page.getByText("The selected microphone is unavailable.", { exact: false }).waitFor();
    const enabledAfterMissing = await page.getByRole("button", { name: "Turn off microphone", exact: true }).count();
    check("missing remembered input fails explicitly without starting another microphone", () => assert.equal(enabledAfterMissing, 0));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${shots}/mobile.png`, fullPage: true });
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check("device setup fits a phone viewport", () => assert.equal(fits, true));
    check("no uncaught browser errors", () => assert.deepEqual(errors, []));
    console.log(`${checks} checks passed. Chrome audio was FAKE. Screenshots: ${shots}`);
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
