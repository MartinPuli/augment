# GHOST

**The hardware layer for personal agents.**

GHOST connects agents to physical devices people choose to share: cameras, microphones, sensors, lights, printers and supported controllers. An agent discovers a capability, requests access, uses it, inspects the actual result and releases it.

The agent brings the reasoning. GHOST supplies the hardware interface and enforces access.

## Connect an agent

Create an account in [your dashboard](https://ghost-personal-agents.vercel.app/dashboard), connect your personal agent and choose its permissions. Add the deployment's `/mcp` endpoint and its dedicated agent token to a compatible MCP client. Follow its requests and physical results in the dashboard; activity is persisted and refreshed every three seconds. No model selection or AI key is needed. See [the MCP guide](docs/mcp.md) for the access lifecycle and configuration requirements.

## Connect hardware

- `/dashboard`: account, revocable agent access, live activity and saved results.
- `/devices`: connect local hardware or pair a phone.
- `/join`: run a phone connector with browser permissions.
- `/owner`: approve pairing and access requests, edit terms, revoke leases.
- [LAN gateway](docs/hardware-framework.md): connect supported hardware from the owner's network to a hosted GHOST instance.
- [Connector protocol](docs/protocol.md): implement a driver for another physical device.

| Hardware path | Current coverage |
| --- | --- |
| Caltrans cameras and NOAA tide stations | Public operator observations; previously live-verified |
| Phone/laptop camera, microphone, speaker and supported phone sensors | Browser connectors implemented; HTTPS and user permissions required |
| Bluetooth devices and USB serial microcontrollers | Supported profiles and GHOST serial protocol; a compatible browser is required |
| Smart-home devices via an outbound LAN gateway | Supported device drivers; verified against labeled simulators |
| OctoPrint / Moonraker printers | Status and temperatures; opt-in pause/resume/cancel with expected-file checks; no print-start or arbitrary motion |
| Raspberry Pi camera / servo | Connector implemented; simulation mode is explicitly labeled |
| Remotely rented robots, cars and robotic arms | Not integrated; requires a hardware provider, authorization and a connector |

GHOST is not an unrestricted hardware pool. A supported connector and authorization are required for each device. Public observations are read-only. Priced leases use a **development ledger with test funds**; real payments and payouts are not implemented.

## Run

```sh
pnpm install
pnpm coordinator   # MCP + HTTP API + device WebSocket, no web UI or model key
```

The headless coordinator binds to `127.0.0.1:3000` by default; configure `HOST` and `PORT` for deployment. For the optional setup and owner web interface, use `pnpm dev` instead. With no `DATABASE_URL`, the coordinator uses embedded Postgres (PGlite). [Deploy on Vercel](docs/vercel.md) with Postgres for the hosted web, MCP and device channel.

## Architecture

```text
Personal agent → /mcp → catalog / permissions / leases / observations
                                  ↕
                       supported device connectors
                                  ↕
                    physical hardware + public sensors
```

The browser interface handles setup and permissions. It does not supply a chat agent. Email, calendars, news, crypto feeds and general cloud-browser tools are no longer registered or exposed. Old integration source remains for migration/reference; persisted software-device IDs are blocked from catalog access and invocation.

## Verify

```sh
pnpm accounts:test         # account isolation, delegated tokens, scopes, audit, revocation
pnpm hardware:focus-test   # MCP workflow + persisted software exclusion
pnpm coord:smoke           # permissions, leases, MCP, invocation and result lifecycle
pnpm hardware:test         # remote LAN gateway, simulated hardware
pnpm hardware:printer-test # bounded printer capabilities, simulated hardware
pnpm distributed:test     # cross-process routing; requires a test Postgres connection
```

The server distinguishes physical evidence, reported state, acknowledgment and unknown outcomes. Device memory does not grant permission. An online listing does not prove an action succeeded.

MIT for original code; public observations remain subject to their operators' terms. See [LICENSE](LICENSE).
