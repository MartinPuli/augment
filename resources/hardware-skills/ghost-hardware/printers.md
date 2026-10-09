# 3D printers through GHOST

Use this guide for owner-connected OctoPrint or Moonraker/Klipper printers. These adapters are implemented and tested against simulated APIs through real MCP and the outbound gateway; physical printer validation remains pending.

## Owner setup

1. Copy `connectors/lan/printers.example.json` to `.ghost/printers.json` on the computer running the gateway. Keep only the printers the owner wants to connect and use their actual base URLs. Each stable `id` must be unique.
2. Put API keys in the environment variables named by `api_key_env`. The JSON file contains variable names, not keys. Omit that field only when the owner's local printer API legitimately needs no key. Keep configuration and keys on the gateway host.
3. Set `GHOST_PRINTERS_CONFIG` to the local JSON file's path. Run `pnpm hardware:gateway --discover --no-discovery`. A responsive printer appears as `printer:<id>`.
4. Pair with the hosted coordinator and select the printer explicitly with `--allow printer:<id>`. Confirm pairing in the owner interface. The coordinator receives capabilities; it does not need the printer's IP or API key.

`allow_job_control` defaults to false. The owner can set it true to publish pause, resume and cancel. Removing that permission takes effect on the next invocation, even before the next catalog refresh. These controls are not an emergency-stop system.

## Agent workflow

- Search for device class `printer` and semantic type `printer.status`.
- Obtain an active lease when using somebody else's printer. Owner approval and the task budget still apply.
- Invoke `printer.status` with `{}`. Inspect `state`, `filename`, `progress_percent` and `temperatures_c`.
- A status of `printing` does not prove that filament is extruding correctly. Use an owner-authorized camera to inspect the print if the task requires physical confirmation.
- For an authorized pause/resume/cancel, pass `{ "action": "pause", "expected_file": "exact name from status" }` to `printer.job.control`. Resume continues the existing physical print; cancel stops that job.
- GHOST checks the filename and current state before sending a fixed command, then reads status again. A filename check is not an atomic lock against other printer clients, nor a content hash. Coordinate with the owner if other operators may control the same machine.
- Reuse the same idempotency key after a transport retry. If the result is unknown, read status; do not manufacture a fresh action key to force a retry.
- Release borrowed access when finished.

## Coverage and limits

Both adapters normalize temperatures to Celsius and progress to 0–100 percent. Missing numbers remain null. `captured_at` remains null when the provider supplies no absolute sensor timestamp; Moonraker's monotonic event time is not UTC.

The adapters do not upload models, slice geometry, start new jobs, send arbitrary G-code, home axes or set heater temperatures. An agent asking to manufacture a part must not claim it printed anything using this integration alone.

API references:
- https://docs.octoprint.org/en/main/api/job.html
- https://docs.octoprint.org/en/main/api/printer.html
- https://moonraker.readthedocs.io/en/latest/external_api/printer/
- https://moonraker.readthedocs.io/en/latest/printer_objects/
