"use client";
/**
 * GHOST live video over WebRTC.
 *
 * Viewer side: openDeviceStream(deviceId) — signals through this tab's own device-channel socket
 * (the desktop local connector). The coordinator checks that this viewer may watch the device and
 * relays to the phone's connector, which answers with its camera track.
 *
 *   viewer ─signal{to:"device", data:{device_id, kind:"offer", sdp}}─▶ coordinator ─▶ phone
 *   viewer ◀─signal{from:"device", data:{kind:"answer"|"ice"|"bye"|"error"}}─ coordinator ◀─ phone
 *
 * Device side: see createStreamResponder (re-exported here).
 */
import { getLocalConnector } from "./local";
import { openDeviceStreamVia } from "./webrtc-viewer";

export { createStreamResponder, ICE_SERVERS, type StreamResponder, type SignalData } from "./webrtc-device";

/** Open a live video stream from a device (e.g. a paired phone's camera) through this tab's connector. */
export async function openDeviceStream(deviceId: string): Promise<{ stream: MediaStream; close(): void }> {
  return openDeviceStreamVia(await getLocalConnector(), deviceId);
}

export { openDeviceStreamVia };
