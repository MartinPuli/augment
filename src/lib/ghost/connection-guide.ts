/** Connection recipes are guidance, never permissions or executable instructions. */
import type { Device } from "./contracts";

export interface ConnectionGuide {
  method: string;
  steps: string[];
  limitations: string[];
  adapter_required: boolean;
  input_label?: string;
}

export function connectionGuide(device: Device): ConnectionGuide {
  const meta = device.meta ?? {};
  const unsupported = meta.candidate === true || meta.support === "unsupported";
  const result: ConnectionGuide = { method: device.transport, steps: [], limitations: [], adapter_required: unsupported };
  if (device.transport === "browser") {
    result.method = device.device_class === "phone" ? "paired-phone-browser" : "desktop-browser";
    result.steps = device.device_class === "phone"
      ? ["Open /join on the phone using the coordinator's HTTPS address.", "Reuse this browser's saved pairing, or pair and have the owner confirm it.", "Enable the sensors you want to lend, then publish the device."]
      : ["Open GHOST in the same browser and owner session.", "Open Connect hardware and enable the desired camera, microphone or speaker."];
    result.limitations = ["Keep the tab open; background suspension can make the device unavailable.", "Remembered pairing does not enable sensors automatically. Browser permission and the owner's enable action are still required."];
    if (device.capabilities.some((c) => c.capability_id.startsWith("audio."))) {
      result.steps.push("For a Bluetooth or USB microphone, connect it through the operating system first, then select that audio input in GHOST.", "Test audio.level for a short sound-level reading before recording a clip.");
      result.limitations.push("Web Bluetooth does not carry Bluetooth Classic microphone audio. dBFS is not calibrated sound pressure.");
      const connections = meta.module_connections as Record<string, unknown> | undefined;
      const mic = connections?.microphone as { input_label?: unknown } | undefined;
      if (typeof mic?.input_label === "string") result.input_label = mic.input_label;
    }
  } else if (device.transport === "bluetooth") {
    result.method = "web-bluetooth-ble";
    result.steps = ["Use a browser that exposes Web Bluetooth, over HTTPS or localhost.", "Power on the device, open Connect hardware and choose the matching BLE profile.", "Select the device in the browser chooser; GHOST will publish only the capabilities its driver recognizes."];
    result.limitations = ["A click is required for initial selection; a saved device name is not a new permission grant.", "Unknown GATT services require a driver. Seeing a device does not imply control."];
  } else if (device.transport === "wifi-lan") {
    result.method = typeof meta.driver === "string" ? `lan:${meta.driver}` : "lan:unknown";
    result.steps = ["Run the GHOST coordinator or LAN gateway on the same network as the device.", "Run the network scan to refresh its address and driver availability.", "Check its current published capability schema before invoking it."];
    result.limitations = ["A cloud coordinator cannot reach a private LAN without a local gateway.", "A TV needs a supported protocol; proximity and Bluetooth visibility alone are insufficient."];
    if (meta.driver === "roku") {
      result.steps.splice(1, 0, "On Roku, enable network control under Settings > System > Advanced system settings > Control by mobile apps > Network access.");
      result.limitations.push("Roku remote-key acknowledgments do not prove what appeared on the screen. Other TV brands need their own adapter.");
    }
  } else if (device.transport === "serial") {
    result.method = "ghost-serial";
    result.steps = ["Connect the board to the computer hosting the browser connector.", "Install firmware implementing the GHOST serial protocol.", "Open Connect hardware, choose USB serial board and select its port."];
    result.limitations = ["An arbitrary serial port is not a supported actuator until its firmware speaks the expected protocol."];
  } else if (device.transport === "http-public") {
    result.steps = ["Load the operator's supported public-source adapter.", "Refresh the catalog and invoke a published observation capability."];
    result.limitations = ["Public observations do not provide control of the operator's device."];
  } else {
    result.steps = ["Start the device's connector or adapter and reconnect it to this coordinator.", "Republish the same connector identity and local_key to retain the device identity.", "Use only currently published capabilities and their current input schemas."];
    result.limitations = ["This transport needs a working connector implementation; GHOST cannot infer an undocumented hardware protocol."];
  }
  return result;
}
