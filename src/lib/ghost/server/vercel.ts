import { startCoordinator } from "./index";

/** Every Function instance shares durable records and routes to the instance holding a socket. */
export async function coordinatorRequest(request: Request): Promise<Response> {
  try {
    const coordinator = await startCoordinator();
    return await coordinator.app.fetch(request);
  } catch (error) {
    console.error("[ghost] coordinator unavailable", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "GHOST is temporarily unavailable" }, {status:503,headers:{"Cache-Control":"no-store"}});
  }
}
