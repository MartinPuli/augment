"use client";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** JSON fetch against the GHOST coordinator (/api/v1) with the session cookie. */
export async function ghost<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 45_000);
  init?.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    const r = await fetch(path.startsWith("/api/") ? path : `/api/v1${path}`, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      credentials: "include",
      headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!r.ok) {
      const msg =
        (json && typeof json === "object" && ("error" in json || "message" in json)
          ? String((json as Record<string, unknown>).error ?? (json as Record<string, unknown>).message)
          : `HTTP ${r.status}`) || `HTTP ${r.status}`;
      throw new HttpError(r.status, msg, json);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an image and return a downscaled JPEG as base64 for Claude's vision input.
 */
export async function imageToBase64(url: string, maxDim = 1024): Promise<{ data: string; media_type: "image/jpeg" } | null> {
  try {
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) return null;
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.82));
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(bin), media_type: "image/jpeg" };
  } catch {
    return null;
  }
}
