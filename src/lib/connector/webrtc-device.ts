/**
 * Device side of the GHOST WebRTC live stream (phone camera → viewer).
 *
 * Signaling payloads (inside the device-channel `signal.data`):
 *   viewer → device: { device_id, kind: "offer", sdp } | { device_id, kind: "ice", candidate } | { device_id, kind: "bye" }
 *   device → viewer: { kind: "answer", sdp } | { kind: "ice", candidate } | { kind: "bye", reason? } | { kind: "error", message }
 * The coordinator authorizes the viewer before relaying; the device only answers while its camera
 * capability is published and the camera track is live.
 */
import type { SignalHandler } from "./types";

export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type SignalData =
  | { kind: "offer"; sdp: string; device_id?: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit | null; device_id?: string }
  | { kind: "bye"; reason?: string; device_id?: string }
  | { kind: "error"; message: string };

export function asSignal(data: unknown): SignalData | null {
  if (!data || typeof data !== "object") return null;
  const k = (data as { kind?: unknown }).kind;
  if (k === "offer" || k === "answer" || k === "ice" || k === "bye" || k === "error") return data as SignalData;
  return null;
}

interface Session {
  pc: RTCPeerConnection;
  device_id: string;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  live: boolean;
}

export interface StreamResponder {
  onSignal: SignalHandler;
  /** Close every live session (revoke / stop access / camera disabled). */
  closeAll(reason?: string): void;
  sessionCount(): number;
}

export function createStreamResponder(opts: {
  /** Current camera track, or null if the camera is off. */
  getTrack: () => MediaStreamTrack | null;
  /** Whether streaming is currently allowed (capability published, not stopped). */
  isAllowed?: () => boolean;
  onLive?: (session_id: string, device_id: string, live: boolean) => void;
  maxSessions?: number;
}): StreamResponder {
  const sessions = new Map<string, Session>();
  const replies = new Map<string, (d: unknown) => void>();
  const max = opts.maxSessions ?? 2;

  const close = (session_id: string, reason?: string, notify = true) => {
    const s = sessions.get(session_id);
    if (!s) return;
    sessions.delete(session_id);
    try {
      s.pc.close();
    } catch {}
    if (s.live) opts.onLive?.(session_id, s.device_id, false);
    if (notify) replies.get(session_id)?.({ kind: "bye", reason });
    replies.delete(session_id);
  };

  const onSignal: SignalHandler = (session_id, data, reply, meta) => {
    const msg = asSignal(data);
    if (!msg) return reply({ kind: "error", message: "malformed signal" });
    replies.set(session_id, reply);
    if (msg.kind === "bye") return close(session_id, "viewer left", false);
    if (msg.kind === "ice") {
      const s = sessions.get(session_id);
      if (!s || !msg.candidate) return;
      if (!s.remoteSet) s.pendingIce.push(msg.candidate);
      else s.pc.addIceCandidate(msg.candidate).catch(() => {});
      return;
    }
    if (msg.kind !== "offer") return;
    void (async () => {
      if (opts.isAllowed && !opts.isAllowed()) return reply({ kind: "error", message: "Live camera is not enabled on this device" });
      const track = opts.getTrack();
      if (!track || track.readyState !== "live") return reply({ kind: "error", message: "Camera is off on this device" });
      if (sessions.has(session_id)) close(session_id, "renegotiate", false);
      if (sessions.size >= max) {
        const oldest = sessions.keys().next().value;
        if (oldest) close(oldest, "replaced by a newer viewer");
      }
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const s: Session = { pc, device_id: meta.device_id, pendingIce: [], remoteSet: false, live: false };
      sessions.set(session_id, s);
      pc.onicecandidate = (e) => {
        if (e.candidate) reply({ kind: "ice", candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected" && !s.live) {
          s.live = true;
          opts.onLive?.(session_id, s.device_id, true);
        }
        if (st === "failed" || st === "closed") close(session_id, st, false);
      };
      try {
        pc.addTrack(track, new MediaStream([track]));
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        s.remoteSet = true;
        for (const c of s.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        reply({ kind: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp });
      } catch (e) {
        reply({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        close(session_id, "negotiation failed", false);
      }
    })();
  };

  return {
    onSignal,
    closeAll(reason) {
      for (const id of [...sessions.keys()]) close(id, reason ?? "stopped");
    },
    sessionCount: () => sessions.size,
  };
}
