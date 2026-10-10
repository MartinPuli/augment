/** Headless GHOST: MCP + device API + WebSockets, without Next.js or an agent model. */
import { config } from "dotenv";
import { startCoordinator } from "../src/lib/ghost/server";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
async function main() {
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const coordinator = await startCoordinator({ listenPort: port, hostname: process.env.HOST || "127.0.0.1" });
console.log(`GHOST hardware MCP: http://${process.env.HOST || "127.0.0.1"}:${port}/mcp`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref();
  await coordinator.stop();
  process.exit(0);
});

}
main().catch(error => { console.error(error); process.exitCode = 1; });
