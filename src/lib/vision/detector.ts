/**
 * Main-thread handle for the detection worker.
 *
 *   const det = createDetector({ model: "dfine-n" });
 *   await det.ready;
 *   const boxes = await det.detect(await createImageBitmap(video)); // bitmap is transferred
 *
 * Only one frame is in flight at a time: callers should skip frames while `busy` is true (adaptive
 * frame-skipping falls out of this naturally).
 */
import { getModel, type VisionModelSpec } from "./models";
import type { Detection, DetectorBackend } from "./types";
import type { WorkerIn, WorkerOut } from "./detector.worker";

export interface DetectorOptions {
  model?: string;
  backend?: "auto" | "webgpu" | "wasm";
  /** Lowest score returned (the tracker uses low-score boxes for its second association stage). */
  minScore?: number;
  onProgress?: (p: { loaded: number; total: number }) => void;
}

export interface Detector {
  ready: Promise<void>;
  detect(bitmap: ImageBitmap): Promise<Detection[]>;
  readonly backend: DetectorBackend;
  readonly model: VisionModelSpec;
  /** Model input side actually used (may be reduced on CPU). */
  readonly input: number;
  readonly busy: boolean;
  /** Last inference round-trip in ms (worker side, incl. preprocessing). */
  readonly lastMs: number;
  dispose(): void;
}

export function createDetector(opts: DetectorOptions = {}): Detector {
  const spec = getModel(opts.model);
  const worker = new Worker(new URL("./detector.worker.ts", import.meta.url), { type: "module", name: "ghost-detector" });
  let backend: DetectorBackend = "none";
  let input = spec.input;
  let lastMs = 0;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve(d: Detection[]): void; reject(e: Error): void }>();

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  ready.catch(() => {}); // avoid unhandled rejection noise; callers observe it explicitly

  worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    switch (m.type) {
      case "progress":
        opts.onProgress?.({ loaded: m.loaded, total: m.total });
        break;
      case "ready":
        backend = m.backend;
        input = m.input;
        resolveReady();
        break;
      case "result": {
        lastMs = m.ms;
        backend = m.backend;
        const p = pending.get(m.id);
        pending.delete(m.id);
        p?.resolve(m.detections);
        break;
      }
      case "error": {
        if (m.id !== undefined) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          p?.reject(new Error(m.message));
        } else if (m.fatal) {
          rejectReady(new Error(m.message));
        }
        break;
      }
    }
  };
  worker.onerror = (ev) => {
    const err = new Error(ev.message || "detector worker crashed");
    rejectReady(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const init: WorkerIn = { type: "init", modelId: spec.id, backend: opts.backend, minScore: opts.minScore };
  worker.postMessage(init);

  return {
    ready,
    get backend() {
      return backend;
    },
    get model() {
      return spec;
    },
    get input() {
      return input;
    },
    get busy() {
      return pending.size > 0;
    },
    get lastMs() {
      return lastMs;
    },
    detect(bitmap: ImageBitmap) {
      if (disposed) {
        bitmap.close();
        return Promise.reject(new Error("detector disposed"));
      }
      const id = nextId++;
      return new Promise<Detection[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg: WorkerIn = { type: "detect", id, bitmap };
        worker.postMessage(msg, [bitmap]);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of pending.values()) p.reject(new Error("detector disposed"));
      pending.clear();
      try {
        worker.postMessage({ type: "dispose" } satisfies WorkerIn);
      } catch {}
      setTimeout(() => worker.terminate(), 50);
    },
  };
}
