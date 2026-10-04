"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { listMicrophoneInputs, rememberedMicrophoneInput, type MicrophoneInput } from "@/lib/connector/drivers/microphone";

export function useMicrophoneInput(active: boolean) {
  const [deviceId, setDeviceId] = useState("");
  const [remembered, setRemembered] = useState<MicrophoneInput | null>(null);
  const [inputs, setInputs] = useState<MicrophoneInput[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setInputs(await listMicrophoneInputs()); setError(null); }
    catch { setError("Could not list audio inputs. Check this browser's microphone settings."); }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      const saved = rememberedMicrophoneInput();
      setRemembered(saved);
      setDeviceId(saved?.deviceId ?? "");
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => { clearTimeout(timer); navigator.mediaDevices?.removeEventListener?.("devicechange", refresh); };
  }, [refresh, active]);
  return { deviceId, setDeviceId, remembered, inputs, error, refresh };
}

export function MicrophoneInputPicker({ input, active, activeLabel }: {
  input: ReturnType<typeof useMicrophoneInput>; active: boolean; activeLabel?: string | null;
}) {
  const id = useId();
  const missing = input.deviceId && !input.inputs.some((d) => d.deviceId === input.deviceId);
  return (
    <div className="rounded-xl border border-line bg-ink-2/60 p-3 text-[12px]">
      <label htmlFor={id} className="block font-semibold text-ivory">Microphone input</label>
      <div className="mt-2 flex gap-2">
        <select id={id} value={input.deviceId} disabled={active} onChange={(e) => input.setDeviceId(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-line bg-ink-3 p-2 text-ivory">
          <option value="">System default</option>
          {missing && <option value={input.deviceId}>{input.remembered?.label ?? "Remembered input"} · unavailable</option>}
          {input.inputs.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
        </select>
        <button type="button" onClick={() => void input.refresh()} className="rounded-lg border border-line px-2 text-ivory-dim">Refresh inputs</button>
      </div>
      <p className="mt-2 text-mute">{active ? `Using ${activeLabel || "the selected microphone"}. Turn it off to change inputs.` : "Pair Bluetooth microphones in your system settings first, then select them here. GHOST remembers your successful selection."}</p>
      {!active && input.inputs.every((d) => /^Audio input \d+$/.test(d.label)) && <p className="mt-1 text-mute">Input names may appear after you allow microphone access.</p>}
      {input.error && <p role="status" className="mt-1 text-coral">{input.error}</p>}
    </div>
  );
}
