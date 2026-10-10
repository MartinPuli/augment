import Link from "next/link";
import type { Metadata } from "next";
import { AgentDashboard } from "@/components/hardware/AgentDashboard";
import "../hardware.css";
export const metadata: Metadata = { title: "Your agents · GHOST", robots: { index: false } };
export default function DashboardPage() {
  return <main className="hardware-page"><div className="hardware-container"><header className="hardware-nav"><Link href="/" className="hardware-wordmark">GHOST<span aria-hidden>↗</span></Link><nav aria-label="Main"><Link href="/">Hardware network</Link><Link href="/devices">Add hardware</Link><Link href="/owner">Manage access</Link></nav></header><AgentDashboard /><footer className="hardware-footer"><span>GHOST · The hardware layer for personal agents</span><Link href="/connect">MCP guide</Link></footer></div></main>;
}
