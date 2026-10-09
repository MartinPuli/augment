---
name: ghost-hardware
description: Connect an agent to owner-authorized cameras, sensors, lights and other physical capabilities through GHOST.
---

# GHOST hardware

Start with the task, then find a capability. A guide is setup knowledge, not evidence that a device exists or permission to use it.

1. Call `recall_device_connections`, then `search_capabilities` with the task, semantic type and location if relevant.
2. Read `get_capability` for the selected ref: input schema, availability, provenance, terms and verification method.
3. Own and public devices may be used directly. For shared devices, obtain a quote and active lease within the user's budget and the owner's approval policy.
4. Call `invoke_capability` with one stable idempotency key for the requested operation. Do not create a new key merely because a request timed out.
5. Inspect the observation and source timestamp. A command acknowledgment is not physical confirmation. Unknown outcomes require a readback before another action.
6. Release the lease and record the connection/result. Check fresh permission and availability next time.

## Connecting a place to the network

Run the outbound gateway on a computer or Raspberry Pi in the device owner's network. No inbound router port is required.

```sh
pnpm hardware:gateway --discover
pnpm hardware:gateway --coordinator https://YOUR-GHOST-HOST --pair CODE --allow LOCAL_KEY
```

The owner generates and confirms the pairing in GHOST. Choose local keys from discovery; `--allow-all` explicitly includes every supported device found now and in future scans. For Home Assistant, configure HA_URL and HA_TOKEN on the gateway host. Keep credentials out of agent prompts and published manifests. Published devices initially belong to their owner; sharing and rental terms are set separately.

Use `--no-discovery` to limit discovery to configured Home Assistant and `--extra-hosts` addresses. The gateway supports the repository's Home Assistant, Shelly, WLED, Tasmota, Elgato, paired Hue, legacy Kasa and Roku drivers. A discovered but unsupported device is not a working integration.

## Use cases

- Remote workshop: read temperature, request a light change, then read its state back.
- Borrowed eyes: obtain a camera lease, request a snapshot, interpret the actual returned image and release access.
- Public coast/road observations: use NOAA measurements or Caltrans camera frames with timestamps and source attribution. Do not describe old images as live.
- ESP32 sensor: identify the exact board; connect through ESPHome/Home Assistant or implement the GHOST connector contract. The ESP32 skill provides firmware guidance, not a preconnected board.

## Extending the framework

A device connector publishes a stable local key, capability IDs, bounded input schemas, availability and evidence expectations. Implement the handler with the existing GhostConnector SDK. Keep provider credentials on the connector host; propagate cancellation; persist mutation receipts across restarts. Never expose an unrestricted shell, arbitrary URL fetching or raw movement commands as a generic substitute for a device adapter.

## Researched integrations (not implemented or hardware-tested in GHOST)

- Viam: https://docs.viam.com/reference/mcp/ — authenticated access to machines already available to the user's Viam organization. Add a typed connector per component and explicit machine selection before advertising it in GHOST.
- 3D printers: https://github.com/Villocity-Labs/mcp-printer — OctoPrint and Moonraker/Klipper tools. Begin with status/temperature/job observations; printing requires an owner-selected printer, reviewed job and device-specific verification. No universal printer execution adapter is included yet.

The network grows when owners connect devices. There is no general entitlement or automatic connection to all hardware on the internet.
