/** Loopback-only simulated printer API for integration tests and agent demos. */
import http from "node:http";

export async function printerSimulator(type: "octoprint" | "moonraker") {
  const state = { phase: "printing", filename: "SIM-cube.gcode", commands: [] as Record<string, unknown>[], stalled: false, malformed: false, redirect: false, requests: 0, authenticated: true };
  const server = http.createServer(async (req, res) => {
    state.requests++;
    state.authenticated &&= req.headers["x-api-key"] === "SIM-printer-key";
    if (!state.authenticated) { res.writeHead(401).end(); return; }
    const route = new URL(req.url!, "http://localhost").pathname;
    if (state.redirect) { res.writeHead(302, { location: "http://127.0.0.1:1/should-not-follow" }).end(); return; }
    if (state.malformed) { res.writeHead(200, { "content-type": "application/json" }).end('{"error":"SIM-printer-key"}'); return; }
    const send = (value: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.method === "GET") {
      if (type === "octoprint" && route === "/api/job") { send({ state: { printing: "Printing", paused: "Paused", cancelled: "Operational" }[state.phase], job: { file: { name: state.filename } }, progress: { completion: 42 } }); return; }
      if (type === "octoprint" && route === "/api/printer") { send({ temperature: { tool0: { actual: 201.5, target: 205 }, bed: { actual: 59, target: 60 } } }); return; }
      if (type === "moonraker" && route === "/printer/objects/query") { send({ result: { eventtime: 123.45, status: { print_stats: { state: state.phase, filename: state.filename }, display_status: { progress: 0.42 }, extruder: { temperature: 201.5, target: 205 }, heater_bed: { temperature: 59, target: 60 } } } }); return; }
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      state.commands.push({ route, body });
      const action = type === "octoprint" ? body.command === "cancel" ? "cancel" : body.action : route.split("/").at(-1);
      if (!state.stalled) state.phase = action === "pause" ? "paused" : action === "resume" ? "printing" : "cancelled";
      if (type === "octoprint") res.writeHead(204).end(); else send({ result: "ok" });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return { state, url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
