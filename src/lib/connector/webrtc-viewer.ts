/**
 * Viewer side of the GHOST WebRTC live stream, independent of React/Next: give it any connected
 * GhostConnector (its socket carries the signaling) and a device_id.
 */
import type { GhostConnector } from "./client";
import { ICE_SERVERS, asSignal } from "./webrtc-device";

export async function openDeviceStreamVia(
  conn: GhostConnector,
  deviceId: string,
): Promise<{ stream: MediaStream; close(): void }> {
  const session_id = `rtc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addTransceiver("video", { direction: "recvonly" });
  const stream = new MediaStream();
  let closed = false;
  let offerSent = false;
  const earlyIce: RTCIceCandidateInit[] = [];
  const pendingRemoteIce: RTCIceCandidateInit[] = [];
  let remoteSet = false;
  let negotiated = false;

  const send = (data: Record<string, unknown>) => conn.sendSignal(session_id, "device", { device_id: deviceId, ...data });

  let unsub = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      send({ kind: "bye" });
    } catch {}
    unsub();
    stream.getTracks().forEach((t) => t.stop());
    try {
      pc.close();
    } catch {}
  };

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Live stream timed out: the device did not answer (is camera.stream enabled and the phone awake?)")), 15_000);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    pc.ontrack = (e) => {
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      clearTimeout(timer);
      negotiated = true;
      resolve();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") fail(new Error("WebRTC connection failed (network/NAT): try the same Wi-Fi or a TURN server"));
    };
    const offError = conn.on("message", (m) => {
      // Coordinator refusals are not session-tagged: only attribute them while negotiating.
      if (m.type === "error" && /^signal:/i.test(m.message) && !closed && !negotiated) {
        fail(new Error(m.message.replace(/^signal:\s*/i, "Live stream refused: ")));
        close();
      }
    });
    const offSignal = conn.onViewerSignal(session_id, (raw) => {
      const msg = asSignal(raw);
      if (!msg || closed) return;
      if (msg.kind === "answer") {
        pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
          .then(async () => {
            remoteSet = true;
            for (const c of pendingRemoteIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
          })
          .catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
      } else if (msg.kind === "ice" && msg.candidate) {
        if (remoteSet) pc.addIceCandidate(msg.candidate).catch(() => {});
        else pendingRemoteIce.push(msg.candidate);
      } else if (msg.kind === "error") {
        fail(new Error(msg.message));
        close();
      } else if (msg.kind === "bye") {
        stream.getTracks().forEach((t) => t.stop());
        fail(new Error(`stream ended: ${msg.reason ?? "device left"}`));
        close();
      }
    });
    unsub = () => {
      offError();
      offSignal();
    };
  });

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const c = e.candidate.toJSON();
    if (offerSent) send({ kind: "ice", candidate: c });
    else earlyIce.push(c);
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!send({ kind: "offer", sdp: pc.localDescription?.sdp ?? offer.sdp })) {
      throw new Error("device channel is not connected");
    }
    offerSent = true;
    for (const c of earlyIce.splice(0)) send({ kind: "ice", candidate: c });
    await ready;
  } catch (e) {
    close();
    throw e;
  }
  return { stream, close };
}
