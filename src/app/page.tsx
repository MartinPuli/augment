import Link from "next/link";
import { HardwareCatalog } from "@/components/hardware/HardwareCatalog";
import "./hardware.css";

export default function Home() {
  return (
    <main className="hardware-page">
      <div className="hardware-container">
        <header className="hardware-nav"><Link href="/" className="hardware-wordmark" aria-label="GHOST home">GHOST<span aria-hidden>↗</span></Link><nav aria-label="Main"><Link href="/dashboard">Your agents</Link><Link href="/devices">Add hardware</Link><Link href="/owner">Manage access</Link></nav></header>
        <section className="hardware-hero">
          <p className="hardware-eyebrow">The hardware layer for personal agents</p>
          <h1>Your agent.<br />Real hardware.</h1>
          <p className="hardware-intro">Your personal agent finds and uses physical hardware through GHOST. Create an account, give it access, and follow its actions as they happen.</p>
          <div className="hardware-actions"><Link className="hardware-button" href="/dashboard">Connect your agent <span aria-hidden>↗</span></Link><Link className="hardware-button secondary" href="/devices">Share your hardware</Link></div>
          <div className="hardware-flow" aria-label="How GHOST works"><span>Your agent</span><span aria-hidden>→</span><strong>GHOST MCP</strong><span aria-hidden>→</span><span>Connected hardware</span></div>
        </section>
        <HardwareCatalog />
        <section className="hardware-section hardware-owner">
          <div><p className="hardware-eyebrow">For device owners</p><h2>Put your hardware<br />within reach.</h2></div>
          <div><p>Connect a phone, select a supported device, or run a gateway on your own network. Set access terms, approve requests and stop access from one place.</p><div className="hardware-actions"><Link className="hardware-button secondary" href="/devices">Connect a device</Link><Link href="/owner">Manage permissions ↗</Link></div><p className="hardware-caption">Hardware needs a supported connector. Phones, public cameras, smart-home devices and printer connectors are implemented. Robot fleet access is not yet integrated. Priced leases currently use test funds.</p></div>
        </section>
        <footer className="hardware-footer"><span>GHOST · Hardware for personal agents</span><Link href="/connect">MCP setup</Link><a href="https://github.com/MartinPuli/augment/blob/main/docs/hardware-framework.md">Connector documentation ↗</a></footer>
      </div>
    </main>
  );
}
