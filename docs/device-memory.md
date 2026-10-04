# Connect devices and remember how

Open `/devices` on the running GHOST server. This setup page does not require a model API key.
It lets you pair a phone, enable a computer's camera/microphone/speaker, connect supported BLE
or USB serial hardware, open LAN discovery, and inspect remembered devices.

## Microphones, including paired Bluetooth microphones

1. Connect a Bluetooth or USB microphone using your computer or phone's normal system settings.
2. Open GHOST over HTTPS, or `localhost` on the same computer. A plain LAN HTTP address does not
   enable browser microphone access on a phone.
3. Under **Microphone input**, refresh the list and select the microphone. Some browsers hide names
   until you grant microphone permission once; you can turn off the microphone, refresh, and select it.
4. Click **Connect microphone** and allow the browser prompt. The active input's actual name is shown.
5. In **Remembered devices**, click **Test sound level**. It measures for one second and records an
   invocation and its numeric observation; it does not save an audio clip.
6. Turn off the microphone before changing inputs. Stop sharing closes its audio tracks.

The browser remembers the last successfully opened selection on this origin. A specifically chosen
input uses an exact device constraint: if it disappears, connection fails explicitly rather than
silently listening through another microphone. Choosing **System default** explicitly follows the
system default on future visits. Permission is never granted automatically by this saved preference.
Browser input IDs stay in browser storage; the shared manifest carries the active input label.

Bluetooth Classic microphone audio comes through the operating system's audio input APIs.
[Web Bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth) connects BLE GATT devices;
it is not a Bluetooth audio pairing interface. Browser microphone capture uses
[getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

## Phones

Choose **Pair a phone**, scan the QR code using a reachable HTTPS address, and confirm the pairing
on the owner computer. On `/join`, enable only the sensors you want to lend and publish the device.
The same microphone selector is available there. Keep the phone tab open and its screen on.
Saved pairing reconnects the connector, but camera/microphone tracks are enabled by the owner again.

## TVs and other nearby devices

Open network discovery and start a scan on your network. The coordinator or LAN gateway must run
there; a cloud server cannot reach private devices just because your browser is near them.
The existing Roku adapter uses [Roku ECP](https://developer.roku.com/dev/docs/external-control-api).
Enable Roku's network control setting, then refresh discovery. Its supported media/remote capabilities
are published in the catalog. Remote-key acknowledgments do not verify the resulting screen.

Other brands require a supported direct adapter or a compatible Home Assistant integration.
Unknown BLE devices can expose a GATT description while remaining candidates for a new driver.
GHOST cannot turn arbitrary Bluetooth visibility into universal device control.

## What the agent remembers

Connection memory is derived from durable coordinator records, automatically; no model has to
remember to call `record_experience` for it to exist:

- Stable device identity, transport, current capabilities and connection guidance.
- Selected microphone label, BLE connection method or recognized LAN driver.
- This agent identity's actual invocation counts and recent outcomes.
- The last successful call for each capability, including arguments and observation references,
  even when more recent attempts failed.
- The audio input label reported by each successful microphone observation. A computer/phone is
  a composite device; changing its microphone does not create a new host device, and old calls
  retain their original input label.
- Offline devices and capabilities that disappeared, clearly marked unavailable.

The existing catalog and invocation tables persist in the configured database (default disk-backed
PGlite, or configured Postgres). Reconnect the same connector credential and `local_key` to retain
identity. Deleting browser storage, replacing the database, or creating a different owner identity
does not preserve that continuity. In-memory test databases deliberately do not persist.

Success counts describe invocation results. An acknowledgment-only call does not prove a physical
outcome. Memory never grants a lease, enables a sensor, or skips current capability validation.
Call arguments and histories are returned only to the principal that made those calls.

## External agents

Both Polty and an authenticated MCP client can call:

```json
{
  "name": "recall_device_connections",
  "arguments": { "query": "microphone", "limit": 5 }
}
```

Optional `device_id` narrows the lookup. The equivalent authenticated HTTP endpoint is
`GET /api/v1/device-connections?q=microphone&limit=5`.
An MCP-capable personal agent uses the existing `/mcp` endpoint and owner token. A client with a
custom HTTP connector can use this API. These interfaces do not establish a verified Dot or Muse
account integration; client installation and authentication must still be tested.

## Repeatable verification

```bash
pnpm devices:memory-test
pnpm exec tsx scripts/microphone-selection-test.ts
pnpm coord:smoke
```

The memory test uses the real coordinator and a disk-backed PGlite database across a restart,
with explicitly simulated hardware. The microphone selection test uses browser API test doubles.
Neither establishes that a physical microphone, BLE device or TV has been tested.
