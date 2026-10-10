/** GHOST delegates reasoning to the connected personal agent. */
function retired() {
  return Response.json({ error: "GHOST is a hardware layer. Connect your personal agent through /mcp.", setup: "/dashboard" }, { status: 410 });
}
export const GET = retired;
export const POST = retired;
