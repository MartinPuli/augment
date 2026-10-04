/**
 * Web Serial driver: a USB-serial board (Arduino, ESP32, Pico...) speaking the GHOST serial line
 * protocol (see serial-protocol.ts). requestSerialDevice() must be called from a user gesture:
 * navigator.serial.requestPort() is its first call.
 */
import { InvokeError, type DriverDevice } from "../types";
import { errorMessage, makeManifest, sleep, slug } from "../util";
import {
  DEFAULT_BAUD,
  SERIAL_PROTOCOL,
  createLineSplitter,
  createSerialHandler,
  manifestToSpecs,
  probeManifest,
  type LineIO,
} from "./serial-protocol";

const USB_VENDORS: Record<number, string> = {
  0x2341: "Arduino",
  0x2a03: "Arduino",
  0x1a86: "WCH (CH340 USB-serial)",
  0x10c4: "Silicon Labs (CP210x USB-serial)",
  0x0403: "FTDI",
  0x303a: "Espressif",
  0x2e8a: "Raspberry Pi (Pico)",
  0x239a: "Adafruit",
  0x0d28: "micro:bit (Arm DAPLink)",
};

/** Time to let a board finish its auto-reset after the port is opened (DTR toggles on open). */
const RESET_SETTLE_MS = 1500;
const PROBE_TIMEOUT_MS = 2500;

export function serialSupport(): { supported: boolean; reason?: string } {
  if (typeof navigator === "undefined") return { supported: false, reason: "not running in a browser" };
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { supported: false, reason: "Web Serial needs HTTPS (secure context) or localhost" };
  }
  if (!("serial" in navigator) || !navigator.serial) {
    const ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return { supported: false, reason: "iOS browsers do not support Web Serial; use Chrome or Edge on a desktop" };
    if (/Android/i.test(ua)) return { supported: false, reason: "Web Serial is not available on Android browsers; use Chrome or Edge on a desktop" };
    return { supported: false, reason: "Web Serial needs Chrome, Edge or Opera on desktop (Firefox and Safari do not support it)" };
  }
  return { supported: true };
}

export async function requestSerialDevice(
  opts?: { baudRate?: number },
  hooks?: { onAvailability?: (online: boolean, detail?: string) => void },
): Promise<DriverDevice> {
  const sup = serialSupport();
  if (!sup.supported) throw new Error(sup.reason ?? "Web Serial is not supported");
  // Must be the first await inside the user gesture.
  const port = await navigator.serial.requestPort();

  const baudRate = opts?.baudRate ?? DEFAULT_BAUD;
  try {
    await port.open({ baudRate });
  } catch (e) {
    const msg = errorMessage(e);
    throw new Error(
      /already open|InvalidState/i.test(msg)
        ? "That serial port is already open (close the Arduino Serial Monitor or another tab using it)"
        : `Could not open the serial port: ${msg}`,
    );
  }

  const info = port.getInfo();
  const vid = info.usbVendorId;
  const pid = info.usbProductId;

  /* ---------------- line IO ---------------- */
  const listeners = new Set<(line: string) => void>();
  const splitter = createLineSplitter((line) => {
    for (const fn of [...listeners]) {
      try {
        fn(line);
      } catch {
        /* a listener error must not kill the read loop */
      }
    }
  });

  let disposed = false;
  let online = true;
  const goOffline = (detail = "USB serial disconnected") => {
    if (!online) return;
    online = false;
    if (!disposed) hooks?.onAvailability?.(false, detail);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const readLoop = (async () => {
    const decoder = new TextDecoder();
    // Keep reading across recoverable errors (framing/parity/buffer overrun), stop on fatal ones.
    while (!disposed && port.readable) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) splitter.push(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        if (!/BreakError|FramingError|ParityError|BufferOverrunError/.test(name)) {
          try {
            reader.releaseLock();
          } catch {
            /* ignore */
          }
          reader = null;
          break;
        }
      }
      try {
        reader?.releaseLock();
      } catch {
        /* ignore */
      }
      reader = null;
      if (disposed) break;
    }
    goOffline();
  })();

  const writer = port.writable?.getWriter();
  if (!writer) {
    await port.close().catch(() => {});
    throw new Error("Serial port is not writable");
  }
  const encoder = new TextEncoder();
  let writeChain: Promise<void> = Promise.resolve();
  const io: LineIO = {
    write(line: string) {
      const p = writeChain.then(() => {
        if (!online || disposed) throw new InvokeError("USB serial disconnected", "failed");
        return writer.write(encoder.encode(line));
      });
      writeChain = p.catch(() => {});
      return p;
    },
    onLine(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  const onDisconnect = () => goOffline("USB serial disconnected");
  port.addEventListener("disconnect", onDisconnect);

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    port.removeEventListener("disconnect", onDisconnect);
    listeners.clear();
    try {
      await reader?.cancel();
    } catch {
      /* ignore */
    }
    await readLoop.catch(() => {});
    try {
      writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await port.close();
    } catch {
      /* ignore */
    }
  };

  /* ---------------- probe ---------------- */
  const noise: string[] = [];
  const onNoise = (l: string) => {
    if (noise.length < 3) noise.push(l.slice(0, 120));
  };
  let manifest = null;
  try {
    await sleep(RESET_SETTLE_MS);
    manifest = await probeManifest(io, PROBE_TIMEOUT_MS, { onNoise });
    if (!manifest && online) manifest = await probeManifest(io, PROBE_TIMEOUT_MS, { onNoise });
  } catch (e) {
    await dispose();
    throw new Error(`Serial device stopped responding while probing: ${errorMessage(e)}`);
  }

  const hex = (n: number | undefined) => (n === undefined ? "na" : n.toString(16).padStart(4, "0"));
  const vendorName = vid !== undefined ? USB_VENDORS[vid] : undefined;
  const baseMeta: Record<string, unknown> = {
    usbVendorId: vid ?? null,
    usbProductId: pid ?? null,
    baudRate,
    tested: false,
  };
  const checkOnline = () => {
    if (disposed) throw new InvokeError("serial device was released", "failed");
    if (!online) throw new InvokeError("USB serial disconnected", "failed");
  };

  if (!manifest) {
    const unknownName = "USB serial device (unknown protocol)";
    return {
      manifest: makeManifest({
        local_key: `serial-${slug(unknownName)}-${hex(vid)}-${hex(pid)}`,
        name: unknownName,
        device_class: "other",
        transport: "serial",
        vendor: vendorName,
        icon: "usb",
        capabilities: [],
        meta: {
          ...baseMeta,
          candidate: true,
          protocol: "unknown",
          hint: `No GHOST manifest received at ${baudRate} baud. Flash a sketch that answers "?" with a {"ghost":"0.1",...} line, or try another baud rate.`,
          sample_output: noise,
        },
      }),
      handler: async () => {
        throw new InvokeError("this serial device has no known protocol, so it exposes no capabilities", "rejected");
      },
      dispose,
    };
  }

  const { specs, skipped } = manifestToSpecs(manifest);
  const hasAct = specs.some((s) => s.kind === "act");
  return {
    manifest: makeManifest({
      local_key: `serial-${slug(manifest.name)}-${hex(vid)}-${hex(pid)}`,
      name: manifest.name,
      device_class: hasAct ? "actuator" : "sensor",
      transport: "serial",
      vendor: manifest.vendor ?? vendorName,
      model: manifest.model,
      icon: hasAct ? "cpu" : "gauge",
      capabilities: specs,
      meta: {
        ...baseMeta,
        protocol: SERIAL_PROTOCOL,
        device_protocol_version: manifest.ghost,
        ...(skipped.length ? { skipped_capabilities: skipped } : {}),
      },
    }),
    handler: createSerialHandler(io, specs, { checkOnline }),
    dispose,
  };
}
