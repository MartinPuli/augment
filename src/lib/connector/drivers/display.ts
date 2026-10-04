/**
 * Display driver: display.show (full-screen message) and display.flash (bounded, ≤3 Hz color strobe).
 * The page renders the state (see DisplayState) — the driver only validates and times it.
 * Flashing is capped at 3 Hz and 10 s (photosensitive-safety guideline: no more than 3 flashes/s).
 */
import { InvokeError, type CapabilityModule } from "../types";
import { numArg, parseColor, sleep, strArg, toHex } from "../util";

export type DisplayState =
  | { mode: "message"; text: string; emoji?: string; color: string; until: number; invocation_id: string }
  | { mode: "flash"; color: string; hz: number; until: number; invocation_id: string };

export const MAX_FLASH_HZ = 3;

export function enableDisplay(opts: {
  render: (state: DisplayState | null) => void;
  label?: string;
}): CapabilityModule {
  let disposed = false;
  let current: string | null = null;
  return {
    id: "display",
    label: opts.label ?? "Screen",
    capabilities: [
      {
        capability_id: "display.show",
        kind: "act",
        semantic_type: "display.show",
        title: "Show a message on screen",
        description:
          "Take over this phone's screen with a big message (≤140 chars), optional emoji and background color, for 1–60 s. The page reports that it rendered it.",
        input_schema: {
          type: "object",
          properties: {
            text: { type: "string", maxLength: 140 },
            emoji: { type: "string", maxLength: 8 },
            color: { type: "string", description: "#rrggbb background", default: "#0a0b0e" },
            duration_s: { type: "number", minimum: 1, maximum: 60, default: 8 },
          },
          required: ["text"],
          additionalProperties: false,
        },
        verification: "reported_state",
        concurrency_group: "display",
        estimated_ms: 300,
      },
      {
        capability_id: "display.flash",
        kind: "act",
        semantic_type: "display.flash",
        title: "Flash the screen",
        description:
          "Flash the phone screen with a color to attract attention. Safety-bounded: at most 3 flashes per second and 10 seconds.",
        input_schema: {
          type: "object",
          properties: {
            color: { type: "string", description: "#rrggbb", default: "#5df2b5" },
            seconds: { type: "number", minimum: 1, maximum: 10, default: 3 },
            hz: { type: "number", minimum: 0.5, maximum: MAX_FLASH_HZ, default: 2 },
          },
          additionalProperties: false,
        },
        verification: "reported_state",
        concurrency_group: "display",
        estimated_ms: 3000,
      },
    ],
    async handle(capability_id, args, ctx) {
      if (disposed) throw new InvokeError("screen access was turned off by the owner", "failed");
      if (capability_id === "display.show") {
        const text = strArg(args, "text", { maxLen: 140, required: true })!;
        const emoji = strArg(args, "emoji", { maxLen: 8 });
        const color = toHex(parseColor(args.color ?? "#0a0b0e"));
        const duration = numArg(args, "duration_s", { min: 1, max: 60, def: 8 });
        const until = Date.now() + duration * 1000;
        current = ctx.invocation_id;
        opts.render({ mode: "message", text, emoji, color, until, invocation_id: ctx.invocation_id });
        const id = ctx.invocation_id;
        setTimeout(() => {
          if (current === id && !disposed) {
            current = null;
            opts.render(null);
          }
        }, duration * 1000);
        await sleep(60, ctx.signal);
        return {
          value: "shown",
          captured_at: new Date().toISOString(),
          data: { text, emoji: emoji ?? null, color, duration_s: duration },
          note: `Rendered full-screen for ${duration}s (reported by the page; nobody verified it was seen).`,
        };
      }
      if (capability_id === "display.flash") {
        const color = toHex(parseColor(args.color ?? "#5df2b5"));
        const seconds = Math.min(numArg(args, "seconds", { min: 1, max: 10, def: 3 }), Math.max(1, ctx.remainingMs() / 1000 - 0.5));
        const hz = numArg(args, "hz", { min: 0.5, max: MAX_FLASH_HZ, def: 2 });
        const until = Date.now() + seconds * 1000;
        current = ctx.invocation_id;
        opts.render({ mode: "flash", color, hz, until, invocation_id: ctx.invocation_id });
        try {
          await sleep(seconds * 1000, ctx.signal);
        } finally {
          if (current === ctx.invocation_id) {
            current = null;
            opts.render(null);
          }
        }
        return {
          value: "flashed",
          captured_at: new Date().toISOString(),
          data: { color, seconds, hz },
          note: "Flash capped at 3 Hz for photosensitive safety.",
        };
      }
      throw new InvokeError(`unknown capability ${capability_id}`, "rejected");
    },
    onRevoke() {
      current = null;
      opts.render(null);
    },
    dispose() {
      disposed = true;
      opts.render(null);
    },
  };
}
