import Link from "next/link";
import type { Metadata } from "next";
import { McpSetup } from "@/components/hardware/McpSetup";
import "../hardware.css";
export const metadata: Metadata = { title: "Connect your agent · GHOST" };
export default function ConnectPage() {
  return <main className="hardware-page"><div className="hardware-container"><header className="hardware-nav"><Link href="/" className="hardware-wordmark">GHOST<span aria-hidden>↗</span></Link><nav aria-label="Main"><Link href="/">Hardware catalog</Link><Link href="/devices">Add hardware</Link><Link href="/owner">Manage access</Link></nav></header><section className="hardware-connect-heading"><p className="hardware-eyebrow">Bring your own agent</p><h1>One connection.<br />Physical capabilities.</h1><p>Connect a compatible MCP client to this GHOST deployment. Hardware access stays subject to each owner’s permissions.</p></section><McpSetup /><footer className="hardware-footer"><Link href="/">← Back to hardware</Link><a href="https://github.com/MartinPuli/augment/blob/main/docs/mcp.md">MCP reference ↗</a></footer></div></main>;
}
