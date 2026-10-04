# GHOST demo playbook

A three-minute live demo, plus setup and fallbacks. Everything shown is live; if a component fails,
show the failure — Polty is built to say "I can't verify that".

## Setup (10 minutes before)

1. **Laptop**: Chrome, `pnpm dev` (or `PORT=3000 pnpm exec tsx server.ts` for no auto-restart),
   open `http://localhost:3000`. Click anywhere once so audio is unlocked.
2. **HTTPS for phones**: `cloudflared tunnel --url http://localhost:3000` → put the
   `https://….trycloudflare.com` URL in `.env.local` as `NEXT_PUBLIC_PUBLIC_ORIGIN`, restart.
   (Or deploy to Fly.io — see [deploy.md](deploy.md).)
3. **Second owner (the "workshop")**: open a Chrome **Incognito** window at `http://localhost:3000`.
   It is a different principal. Connect the Arduino there ("Connect my Arduino") so the workshop
   owns it, then open `/owner` in that window and set its price (e.g. $0.50, floor $0.30, 60 s).
   Rename `DEVICE_NAME` in the sketch to `Workshop cover lifter` before flashing.
4. **Phone**: say "Pair my phone", scan the QR, confirm on the laptop, enable Camera, aim it at the
   workshop fixture (a light cover over the keys area), keep the page in the foreground.
5. **Voice**: `ELEVENLABS_API_KEY` for Polty's voice (browser voice otherwise). Hold Space to talk,
   or toggle **HF** for hands-free.

## Script

| Time | Say | What the audience sees |
| --- | --- | --- |
| 0:00 | *(problem)* "Did I leave my keys at the workshop? You can spend up to one dollar." | Budget appears in the top bar. Polty searches, finds the paired phone camera, takes a photo. The cover hides part of the table: Polty says it can't verify. |
| 0:40 | — | Polty discovers the workshop's **cover lifter** (another owner), asks for an offer, counteroffers, accepts. The lease card shows terms, a countdown and **Test payment**. |
| 1:20 | — | Polty possesses the Arduino (ectoplasm tether), the servo lifts the cover, the phone takes a **new observation**. Polty answers only if the photo supports it. |
| 1:50 | "Stop access" (owner window) | The owner revokes; the next command is rejected. Polty records the experience. |
| 2:10 | "Find a live camera on the Bay Bridge and track the trucks." | 756 public Caltrans cameras → live HLS on the canvas → in-browser detector locks on and auto-zooms. Public observation: free, no lease. |
| 2:40 | "How many cars right now?" | Polty reads the tracker widget's live counts. |
| 2:50 | Close | "One brain, many bodies. Open source, MCP-native." |

Rehearse the honest paths: keys absent ("I don't see keys"), phone offline, price above budget
(Polty refuses), lease expiry mid-task.

## Other showpieces

- "Pair my phone" → the phone becomes Polty's face while possessed; `display.show`, `speaker.say`,
  `haptics.vibrate`, live camera via WebRTC ("track me" uses `{kind:"webrtc"}` in a live view).
- "What's on my Wi-Fi?" → radar. Venue Wi-Fi isolates clients; use a phone hotspot with a WLED/Shelly
  device on it. Simulators for rehearsal: `pnpm exec tsx scripts/lan-fake-devices.ts`
  ([smart-home.md](smart-home.md)).
- "Find a webcam of the Golden Gate Bridge" → Exa discovers pages, Kernel screenshots one in a cloud
  browser, Polty looks at it.
- "Email me the evidence" → AgentMail report with photos (needs a valid key).
- "Run the inspection mission" → Mastra workflow on the canvas; open Mastra Studio
  (`pnpm mastra:dev`) to show the trace.
- External agents: `claude mcp add --transport http ghost http://localhost:3000/mcp --header "Authorization: Bearer <owner_token>"`,
  or through Executor ([partners.md](partners.md)).

## Fallbacks

| Failure | Do |
| --- | --- |
| Neon slow / unreachable | `GHOST_DB=pglite` in `.env.local` (local Postgres), restart |
| Tunnel down | restart `cloudflared`, update `NEXT_PUBLIC_PUBLIC_ORIGIN`, re-pair |
| Detector slow | first load downloads the model; open the live view once before the demo to warm the cache |
| No voice input | type in the dock (keyboard icon) |
