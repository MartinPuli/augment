/** Browser API test doubles only: no physical input or recording. */
import assert from "node:assert/strict";
import { enableMicrophone, listMicrophoneInputs, rememberedMicrophoneInput } from "../src/lib/connector/drivers/microphone";
import type { InvokeContext } from "../src/lib/connector/types";

async function main() {
  const saved = new Map<string, string>();
  const calls: MediaStreamConstraints[] = [];
  let fail = false;
  let checks = 0;
  const track = { label: "SIMULATED Bluetooth microphone", readyState: "live", stopped: false,
    getSettings: () => ({ deviceId: "selected-input" }), stop() { this.readyState = "ended"; this.stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  class FakeAudioContext {
    state = "running";
    resume = async () => {};
    close = async () => {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(buffer: Float32Array) { buffer.fill(0.25); } }; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true, AudioContext: FakeAudioContext } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key),
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    enumerateDevices: async () => [{ kind: "audioinput", deviceId: "selected-input", label: track.label }, { kind: "videoinput", deviceId: "camera", label: "Camera" }],
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      calls.push(constraints);
      if (fail) throw new DOMException("input disconnected", "OverconstrainedError");
      track.readyState = "live"; track.stopped = false;
      return stream;
    },
  } } });
  function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }
  const inputs = await listMicrophoneInputs();
  check("listing inputs never starts capture", () => { assert.equal(calls.length, 0); assert.equal(inputs.length, 1); });
  const mic = await enableMicrophone({ deviceId: "selected-input" });
  check("explicit selection uses an exact input constraint", () => assert.deepEqual((calls[0].audio as MediaTrackConstraints).deviceId, { exact: "selected-input" }));
  check("successful selection remembers its ID locally", () => assert.equal(rememberedMicrophoneInput()?.deviceId, "selected-input"));
  check("shared connection hint includes a label without the browser input ID", () => assert.deepEqual(mic.connection, { method: "browser-audio-input", input_label: track.label }));
  await mic.dispose?.();
  check("stopping sharing releases the microphone track", () => assert.equal(track.stopped, true));
  fail = true;
  const before = calls.length;
  await assert.rejects(enableMicrophone({ deviceId: "unplugged-input" }), /selected microphone is unavailable/);
  check("missing selection fails without retrying a different microphone", () => assert.equal(calls.length, before + 1));
  check("failed selection cannot overwrite remembered successful input", () => assert.equal(rememberedMicrophoneInput()?.deviceId, "selected-input"));
  fail = false;
  const defaultMic = await enableMicrophone();
  check("choosing system default explicitly clears the pinned selection", () => assert.equal(rememberedMicrophoneInput()?.deviceId, ""));
  track.readyState = "ended";
  const ctx = { signal: new AbortController().signal, remainingMs: () => 10000 } as InvokeContext;
  await assert.rejects(defaultMic.handle("audio.level", { seconds: 1 }, ctx), /microphone disconnected/);
  check("ended inputs cannot report a successful measurement", () => assert.equal(track.readyState, "ended"));
  await defaultMic.dispose?.();
  console.log(`${checks} checks passed. Browser APIs were SIMULATED.`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
