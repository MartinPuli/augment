/**
 * GHOST serial protocol simulation: an in-memory fake Arduino speaking ghost-serial/0.1.
 *
 *   pnpm exec tsx scripts/conn-serial-sim.ts
 *
 * Prints PASS/FAIL per check; exits non-zero on any failure.
 */
import {
  createLineSplitter,
  createSerialHandler,
  manifestToSpecs,
  probeManifest,
  serialCapToSpec,
  validateArgs,
  type LineIO,
} from "../src/lib/connector/drivers/serial-protocol";
import { InvokeError, type InvokeContext } from "../src/lib/connector/types";

/* ---------------- fake Arduino ---------------- */

class FakeArduino {
  silent = false; // never replies to invocations
  jammed = false; // servo.move replies ok:false
  received: string[] = [];
  private led = false;
  private angle = 0;
  constructor(private emit: (text: string) => void) {}

  /** Raw bytes from the host (may contain several lines). */
  input(text: string) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      this.received.push(line);
      setTimeout(() => this.handle(line), 3);
    }
  }

  private handle(line: string) {
    if (line.trim() === "?") {
      // boot noise first, split across chunks, then the manifest
      this.emit("\r\nBooting ESP-ROM...\r\nready");
      this.emit("\r\n");
      const manifest = {
        ghost: "0.1",
        name: "Desk Arduino",
        capabilities: [
          { id: "led.set", kind: "act", title: "Set LED", params: { on: { type: "boolean", required: true } }, unit: null },
          {
            id: "servo.move",
            kind: "act",
            title: "Move servo",
            description: "Move the desk servo to an angle",
            params: { angle: { type: "number", minimum: 0, maximum: 180 } },
            required: ["angle"],
            unit: "deg",
          },
          { id: "light.read", kind: "measure", title: "Ambient light", params: {}, unit: "lux" },
          { id: "cam.live", kind: "stream", title: "not allowed over serial" },
        ],
      };
      const s = JSON.stringify(manifest) + "\n";
      this.emit(s.slice(0, 40));
      this.emit(s.slice(40));
      return;
    }
    let msg: { id: string; cap: string; args: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (this.silent) return;
    const reply = (o: Record<string, unknown>) => this.emit(JSON.stringify({ id: msg.id, ...o }) + "\r\n");
    switch (msg.cap) {
      case "led.set":
        this.led = msg.args.on === true;
        return reply({ ok: true, value: this.led });
      case "servo.move": {
        if (this.jammed) return reply({ ok: false, error: "servo stalled" });
        const a = msg.args.angle;
        if (typeof a !== "number" || a < 0 || a > 180) return reply({ ok: false, error: "bad angle (device-side)" });
        this.angle = a;
        return reply({ ok: true, value: this.angle, unit: "deg" });
      }
      case "light.read":
        return reply({ ok: true, value: 412, unit: "lux" });
      default:
        return reply({ ok: false, error: "unknown cap" });
    }
  }
}

/** Host-side LineIO wired to the fake device through a real line splitter. */
function connect(): { io: LineIO; dev: FakeArduino } {
  const listeners = new Set<(l: string) => void>();
  const splitter = createLineSplitter((l) => listeners.forEach((fn) => fn(l)));
  const dev = new FakeArduino((text) => setTimeout(() => splitter.push(text), 1));
  const io: LineIO = {
    async write(line) {
      dev.input(line);
    },
    onLine(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return { io, dev };
}

let seq = 0;
function makeCtx(capability_id: string, ms = 2000): InvokeContext & { abort: (r?: string) => void } {
  const ac = new AbortController();
  const deadline = Date.now() + ms;
  const t = setTimeout(() => ac.abort(new InvokeError("deadline", "failed")), ms + 50);
  ac.signal.addEventListener("abort", () => clearTimeout(t));
  return {
    invocation_id: `inv_${++seq}`,
    device_id: "dev_sim",
    local_key: "serial-desk-arduino-2341-43",
    capability_id,
    lease_id: null,
    lease_revision: 0,
    deadline,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    signal: ac.signal,
    upload: async () => {
      throw new Error("upload not available in the serial sim");
    },
    abort: (r = "cancelled") => ac.abort(r),
  };
}

/* ---------------- checks ---------------- */

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
async function expectInvokeError(p: Promise<unknown> | (() => unknown), state: string, re?: RegExp) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert(e instanceof InvokeError, `expected InvokeError, got ${String(e)}`);
    assert(e.state === state, `expected state "${state}", got "${e.state}" (${e.message})`);
    if (re) assert(re.test(e.message), `message ${JSON.stringify(e.message)} does not match ${re}`);
    return;
  }
  throw new Error(`expected InvokeError(${state}) but it resolved`);
}

async function main() {
  const { io, dev } = connect();

  const manifest = await probeManifest(io, 1000);
  await check("probeManifest returns the manifest (boot noise ignored, split chunks joined)", () => {
    assert(manifest, "no manifest");
    assert(manifest.name === "Desk Arduino", `name ${manifest.name}`);
    assert(manifest.capabilities.length === 4, `caps ${manifest.capabilities.length}`);
  });
  if (!manifest) {
    console.log("cannot continue without a manifest");
    process.exit(1);
  }

  const { specs, skipped } = manifestToSpecs(manifest);
  await check("manifestToSpecs: 3 specs, stream capability skipped", () => {
    assert(specs.length === 3, `specs ${specs.map((s) => s.capability_id).join(",")}`);
    assert(skipped.length === 1 && /stream/.test(skipped[0]), `skipped ${JSON.stringify(skipped)}`);
  });
  await check("serialCapToSpec shapes: kind, verification, schema, unit", () => {
    const servo = specs.find((s) => s.capability_id === "servo.move")!;
    assert(servo.kind === "act" && servo.verification === "acknowledgment", "servo kind/verification");
    assert(servo.semantic_type === "servo.move", "semantic_type");
    assert(servo.input_schema.additionalProperties === false, "additionalProperties");
    assert(JSON.stringify(servo.input_schema.required) === '["angle"]', "required");
    assert(servo.output?.unit === "deg", "unit");
    const light = specs.find((s) => s.capability_id === "light.read")!;
    assert(light.kind === "measure" && light.verification === "observation", "light kind/verification");
    const def = serialCapToSpec({ id: "relay.toggle" });
    assert(def.kind === "act", "default kind act");
    let threw = false;
    try {
      serialCapToSpec({ id: "x.y", kind: "teleport" });
    } catch {
      threw = true;
    }
    assert(threw, "unknown kind must throw");
  });

  const handler = createSerialHandler(io, specs);

  await check("servo.move 90 → ok", async () => {
    const out = await handler("servo.move", { angle: 90 }, makeCtx("servo.move"));
    assert(out.value === 90, `value ${out.value}`);
    assert(out.unit === "deg", `unit ${out.unit}`);
    assert(typeof out.captured_at === "string" && !Number.isNaN(Date.parse(out.captured_at)), "captured_at");
  });

  await check("servo.move \"45\" (numeric string) coerced → ok", async () => {
    const out = await handler("servo.move", { angle: "45" }, makeCtx("servo.move"));
    assert(out.value === 45, `value ${out.value}`);
  });

  await check("servo.move 999 rejected before reaching the device", async () => {
    const before = dev.received.length;
    await expectInvokeError(handler("servo.move", { angle: 999 }, makeCtx("servo.move")), "rejected", /<= 180/);
    assert(dev.received.length === before, "device received the invalid command");
  });

  await check("unknown argument rejected", async () => {
    const before = dev.received.length;
    await expectInvokeError(handler("servo.move", { angle: 10, speed: 3 }, makeCtx("servo.move")), "rejected", /unknown argument "speed"/);
    assert(dev.received.length === before, "device received the invalid command");
  });

  await check("wrong type rejected (angle: true, on: 'yes')", async () => {
    await expectInvokeError(handler("servo.move", { angle: true }, makeCtx("servo.move")), "rejected");
    await expectInvokeError(handler("led.set", { on: "yes" }, makeCtx("led.set")), "rejected");
  });

  await check("missing required argument rejected", async () => {
    await expectInvokeError(handler("servo.move", {}, makeCtx("servo.move")), "rejected", /required/);
  });

  await check("unknown capability rejected", async () => {
    await expectInvokeError(handler("cam.live", {}, makeCtx("cam.live")), "rejected");
  });

  await check("led.set on:true → ok, value true", async () => {
    const out = await handler("led.set", { on: true }, makeCtx("led.set"));
    assert(out.value === true, `value ${out.value}`);
  });

  await check("light.read → value 412 lux", async () => {
    const out = await handler("light.read", {}, makeCtx("light.read"));
    assert(out.value === 412 && out.unit === "lux", `got ${out.value} ${out.unit}`);
  });

  await check("device ok:false → failed with the device's error", async () => {
    dev.jammed = true;
    try {
      await expectInvokeError(handler("servo.move", { angle: 30 }, makeCtx("servo.move")), "failed", /servo stalled/);
    } finally {
      dev.jammed = false;
    }
  });

  await check("silent device: act → unknown (short deadline)", async () => {
    dev.silent = true;
    try {
      const t0 = Date.now();
      await expectInvokeError(handler("servo.move", { angle: 10 }, makeCtx("servo.move", 150)), "unknown", /no reply/);
      assert(Date.now() - t0 < 1000, "waited too long");
    } finally {
      dev.silent = false;
    }
  });

  await check("silent device: measure → failed (short deadline)", async () => {
    dev.silent = true;
    try {
      await expectInvokeError(handler("light.read", {}, makeCtx("light.read", 150)), "failed", /no reply/);
    } finally {
      dev.silent = false;
    }
  });

  await check("abort after send on act → unknown", async () => {
    dev.silent = true;
    try {
      const ctx = makeCtx("servo.move", 2000);
      const p = handler("servo.move", { angle: 20 }, ctx);
      setTimeout(() => ctx.abort("revoked"), 20);
      await expectInvokeError(p, "unknown");
    } finally {
      dev.silent = false;
    }
  });

  await check("works again after silence (replies matched by id)", async () => {
    const out = await handler("servo.move", { angle: 120 }, makeCtx("servo.move"));
    assert(out.value === 120, `value ${out.value}`);
  });

  await check("concurrent invocations matched by id", async () => {
    const [a, b] = await Promise.all([
      handler("servo.move", { angle: 33 }, makeCtx("servo.move")),
      handler("light.read", {}, makeCtx("light.read")),
    ]);
    assert(a.value === 33 && b.value === 412, `got ${a.value}, ${b.value}`);
  });

  await check("probeManifest on a device that never answers → null", async () => {
    const quiet: LineIO = { write: async () => {}, onLine: () => () => {} };
    const m = await probeManifest(quiet, 100);
    assert(m === null, "expected null");
  });

  await check("line splitter drops lines > 4 KB, keeps the next one", () => {
    const got: string[] = [];
    const sp = createLineSplitter((l) => got.push(l));
    sp.push("x".repeat(3000));
    sp.push("y".repeat(3000)); // overflow → discard until newline
    sp.push("zzz\r\nok-line\n");
    sp.push("a".repeat(5000) + "\nafter\n");
    assert(JSON.stringify(got) === '["ok-line","after"]', `got ${JSON.stringify(got.map((g) => g.slice(0, 10)))}`);
    assert(sp.dropped === 2, `dropped ${sp.dropped}`);
  });

  await check("validateArgs: enum / integer / string limits", () => {
    const spec = serialCapToSpec({
      id: "mode.set",
      params: {
        mode: { type: "string", enum: ["a", "b"] },
        n: { type: "integer", minimum: 1, maximum: 5 },
        label: { type: "string", maxLength: 4 },
      },
    });
    assert(JSON.stringify(validateArgs(spec, { mode: "a", n: 3 })) === '{"mode":"a","n":3}', "valid args");
    for (const bad of [{ mode: "c" }, { n: 2.5 }, { n: 9 }, { label: "toolong" }, { label: "a\nb" }]) {
      let state = "";
      try {
        validateArgs(spec, bad);
      } catch (e) {
        state = e instanceof InvokeError ? e.state : "other";
      }
      assert(state === "rejected", `expected rejection for ${JSON.stringify(bad)}`);
    }
  });

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL  sim crashed:", e);
  process.exit(1);
});
