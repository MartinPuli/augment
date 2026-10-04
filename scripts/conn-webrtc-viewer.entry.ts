/**
 * Browser bundle for scripts/conn-webrtc-e2e.ts: a bare viewer that opens a phone's live camera
 * through GHOST signaling (no React/Next). Exposes window.__ghostView(ownerToken, deviceId).
 */
import { GhostConnector } from "../src/lib/connector/client";
import { openDeviceStreamVia } from "../src/lib/connector/webrtc-viewer";

declare global {
  interface Window {
    __ghostView: (ownerToken: string, deviceId: string) => Promise<Record<string, unknown>>;
  }
}

window.__ghostView = async (ownerToken, deviceId) => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const conn = new GhostConnector({
    url: `${proto}//${location.host}/v1/device-channel`,
    connectorKind: "desktop-browser",
    label: "webrtc e2e viewer",
    ownerToken,
    storage: null,
  });
  conn.start();
  const t0 = Date.now();
  while (!conn.isOnline) {
    if (Date.now() - t0 > 8000) return { ok: false, stage: "connect", status: conn.getSnapshot() };
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    const { stream } = await openDeviceStreamVia(conn, deviceId);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.srcObject = stream;
    document.body.appendChild(v);
    await v.play().catch(() => {});
    const t1 = Date.now();
    while (v.videoWidth === 0) {
      if (Date.now() - t1 > 10000) return { ok: false, stage: "frames", tracks: stream.getTracks().length };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: true, width: v.videoWidth, height: v.videoHeight, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, stage: "negotiate", error: e instanceof Error ? e.message : String(e) };
  }
};
