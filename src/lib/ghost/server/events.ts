import type { GhostEvent } from "../contracts";
import { S } from "./state";

/** Publish an event to every subscriber (SSE streams, MCP, tests). Never throws. */
export function emit(event: GhostEvent): void {
  for (const fn of [...S().listeners]) {
    try {
      fn(event);
    } catch (e) {
      console.error("[ghost] event listener failed", e);
    }
  }
}

/** Subscribe to all coordinator events. Returns an unsubscribe function. */
export function subscribe(fn: (event: GhostEvent) => void): () => void {
  S().listeners.add(fn);
  return () => {
    S().listeners.delete(fn);
  };
}

export function log(level: "info" | "warn" | "error", message: string): void {
  if (level === "error") console.error(`[ghost] ${message}`);
  else if (process.env.GHOST_QUIET !== "1") console.log(`[ghost] ${message}`);
  emit({ type: "log", level, message, at: new Date().toISOString() });
}
