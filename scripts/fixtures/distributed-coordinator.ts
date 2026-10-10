import http from "node:http";
import { startCoordinator } from "../../src/lib/ghost/server";

async function main() {
  const coordinator = await startCoordinator({skipAdapters:true});
  const server = http.createServer((req,res) => { void coordinator.requestListener(req,res); });
  server.on("upgrade",(req,socket,head) => { if (!coordinator.handleUpgrade(req,socket,head)) socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address() as {port:number};
  process.send?.({port:address.port});
  process.on("SIGTERM",() => { server.closeAllConnections(); void coordinator.stop().finally(() => process.exit(0)); });
}
main().catch(error => {console.error(error);process.exit(1);});
