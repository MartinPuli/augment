import Link from "next/link";

export function McpSetup() {
  return <div className="hardware-setup">
    <section><h2>1. Create your GHOST account</h2><p>Your account keeps your hardware, connected agents and saved activity together.</p><Link className="hardware-button" href="/dashboard">Open your dashboard</Link></section>
    <section><h2>2. Give your personal agent access</h2><p>Name the agent, choose whether it can read public observations, request hardware reads, or request physical actions. The dashboard creates a separate token that you can revoke.</p><p>In your agent’s MCP settings, add the endpoint shown in the dashboard and an Authorization header containing its bearer token. The client must support Streamable HTTP and custom headers.</p></section>
    <section><h2>3. Let the agent work</h2><blockquote>Use GHOST to find a public camera on the Bay Bridge, retrieve an observation, and tell me what it shows.</blockquote><p>The agent discovers hardware, requests access and invokes capabilities through MCP. Follow its requests and results in your dashboard. Device owners retain their own permission controls.</p><p>No model selection, AI key or separate GHOST assistant is needed.</p></section>
  </div>;
}
