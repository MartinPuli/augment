"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ghostFetch } from "@/lib/ghost/client/api";

type Account = { username: string; principal_id: string };
type Permission = "public_read" | "hardware_read" | "hardware_control";
type Agent = { agent_id: string; name: string; permission: Permission; max_spend_cents: number; revoked_at: string | null };
type Call = { call_id: string; tool: string; agent_name: string; arguments: unknown; state: string; result: string | null; created_at: string };
type Invocation = { observation_id: string | null; invocation_id: string; agent_name: string; device_name: string; capability_id: string; state: string; created_at: string; observation: { kind?: string; media_url?: string; captured_at?: string; note?: string; value?: unknown; unit?: string } | null };
const labels: Record<Permission, string> = { public_read: "Public observations only", hardware_read: "Read hardware with permission", hardware_control: "Read and control hardware with permission" };

export function AgentDashboard() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [invocations, setInvocations] = useState<Invocation[]>([]);
  const [live, setLive] = useState(false);
  const [now, setNow] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [credential, setCredential] = useState<{ token: string; name: string } | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [permission, setPermission] = useState<Permission>("public_read");
  useEffect(() => {
    ghostFetch<{ account: Account | null }>("/account/session").then(r => { setEndpoint(`${location.origin}/mcp`); setAccount(r.account); }).catch(() => setMessage("Could not load your account. Reload to retry.")).finally(() => setLoading(false));
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [a, activity] = await Promise.all([ghostFetch<Agent[]>("/account/agents", { signal }), ghostFetch<{ calls: Call[]; invocations: Invocation[] }>("/account/activity", { signal })]);
    if (signal?.aborted) return;
    setNow(Date.now()); setAgents(a); setCalls(activity.calls); setInvocations(activity.invocations); setLive(true); setLastUpdate(new Date().toLocaleTimeString());
  }, []);
  useEffect(() => {
    if (!account) return;
    let stopped = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await refresh(abort.signal); } catch { if (!stopped) setLive(false); }
      if (!stopped) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [account, refresh]);
  async function authenticate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage("");
    const data = new FormData(e.currentTarget);
    try { const r = await ghostFetch<{ account: Account }>(`/account/${register ? "register" : "login"}`, { method: "POST", body: { username: data.get("username"), password: data.get("password") } }); setAccount(r.account); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Could not sign in."); }
    finally { setBusy(false); }
  }
  async function createAgent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMessage("");
    const form = e.currentTarget; const data = new FormData(form);
    try {
      const a = await ghostFetch<{ token: string; name: string }>("/account/agents", { method: "POST", body: { name: data.get("name"), permission, max_spend_cents: Math.round(Number(data.get("budget") || 0) * 100) } });
      setCredential(a); setShowToken(false); form.reset(); setPermission("public_read"); await refresh();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not connect agent."); }
    finally { setBusy(false); }
  }
  async function revoke(a: Agent) {
    setBusy(true); setMessage("");
    try { const r = await ghostFetch<{ leases_pending: number }>(`/account/agents/${a.agent_id}/revoke`, { method: "POST", body: {} }); setMessage(r.leases_pending ? `${a.name}'s token is revoked. Some leases could not be released; check Manage access.` : `${a.name}'s token is revoked and its active leases have been released. An action already sent may still complete.`); await refresh(); }
    catch { setMessage("Could not revoke access. Please retry."); }
    finally { setBusy(false); }
  }
  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setMessage(`${label} copied.`); } catch { setMessage("Clipboard unavailable. Select the field and copy manually."); }
  }
  async function logout() {
    setBusy(true);
    try { await ghostFetch("/account/logout", { method: "POST", body: {} }); setAccount(null); setCredential(null); setAgents([]); setCalls([]); setInvocations([]); setLive(false); }
    catch { setMessage("Could not sign out. Try again."); }
    finally { setBusy(false); }
  }
  if (loading) return <p className="hardware-empty">Loading your account…</p>;
  if (!account) return <section className="hardware-auth"><div><p className="hardware-eyebrow">Your hardware layer</p><h1>Your agent acts.<br />You stay in control.</h1><p>Create an account, give your personal agent access, and follow what it does with physical hardware.</p><p className="hardware-caption">No model selection. No AI API key. Your existing agent connects through MCP.</p></div><form onSubmit={authenticate} className="hardware-auth-form"><h2>{register ? "Create your account" : "Welcome back"}</h2><label htmlFor="username">Username</label><input id="username" name="username" required pattern="[A-Za-z0-9_]{3,32}" minLength={3} maxLength={32} autoComplete="username" placeholder="your_name" /><label htmlFor="password">Password</label><input id="password" name="password" type="password" required minLength={12} maxLength={256} autoComplete={register ? "new-password" : "current-password"} /><p className="hardware-caption">At least 12 characters. Save it securely; password recovery is not available yet.</p><button className="hardware-button" disabled={busy}>{busy ? "Please wait…" : register ? "Create account" : "Sign in"}</button><button type="button" className="hardware-button secondary" onClick={() => { setRegister(!register); setMessage(""); }}>{register ? "Already have an account?" : "Create an account instead"}</button><p role="status">{message}</p></form></section>;
  const running = calls.filter(c => c.state === "running" && now - Date.parse(c.created_at) < 130000).length;
  return <>
    <section className="hardware-dashboard-heading"><div><p className="hardware-eyebrow">{account.username} / control room</p><h1>Your agents,<br />in the physical world.</h1></div><div className="hardware-dashboard-status"><span className={live ? "hardware-status online" : "hardware-status"}>{live ? "Live · refreshes every 3s" : "Activity updates disconnected"}</span><p>{running ? `${running} ${running === 1 ? "action" : "actions"} in progress` : "No action currently in progress"}</p>{lastUpdate && <p className="hardware-caption">Last updated {lastUpdate}</p>}<button className="hardware-button secondary" disabled={busy} onClick={logout}>Sign out</button></div></section>
    <p className="hardware-notice" role="status" aria-live="polite">{message}</p>
    <section className="hardware-section"><div className="hardware-section-heading"><div><p className="hardware-eyebrow">Connected agents</p><h2>Give your agent access.</h2></div><p>Each agent has its own revocable token. Your account credentials stay with you.</p></div>
      <form className="hardware-agent-form" onSubmit={createAgent}><label>Agent name<input name="name" required maxLength={80} placeholder="Dot, Claude, my assistant…" /></label><label>Access<select value={permission} onChange={e => setPermission(e.target.value as Permission)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Test budget per lease ($)<input name="budget" type="number" min="0" max="100" step="0.01" defaultValue="0" /></label><button className="hardware-button" disabled={busy}>Connect agent</button></form>
      <p className="hardware-caption">Hardware access still follows the device owner’s terms and approval rules, including for devices you own. Budgets are test funds, not real payments.</p>
      {credential && <div className="hardware-credential"><h3>Connect {credential.name} through MCP</h3><p>Add an HTTP MCP server with this endpoint and an <code>Authorization: Bearer &lt;agent token&gt;</code> header.</p><label htmlFor="agent-url">MCP endpoint</label><div className="hardware-field"><input id="agent-url" readOnly value={endpoint} /><button className="hardware-button secondary" onClick={() => copy(endpoint, "Endpoint")}>Copy URL</button></div><label htmlFor="agent-token">Agent token · shown only in this session</label><div className="hardware-field"><input id="agent-token" type={showToken ? "text" : "password"} readOnly value={credential.token} autoComplete="off" /><button className="hardware-button secondary" onClick={() => setShowToken(!showToken)}>{showToken ? "Hide" : "Show"}</button><button className="hardware-button secondary" onClick={() => copy(credential.token, "Agent token")}>Copy token</button></div><p className="hardware-caption">Requires an MCP client supporting Streamable HTTP and custom headers. Store the token in your agent’s private settings.</p><details><summary>Configuration template</summary><pre>{JSON.stringify({ mcpServers: { ghost: { type: "http", url: endpoint, headers: { Authorization: "Bearer <AGENT_TOKEN>" } } } }, null, 2)}</pre></details><button className="hardware-button secondary" onClick={() => setCredential(null)}>Done · hide token</button></div>}
      <div className="hardware-agent-list">{agents.length === 0 ? <p className="hardware-empty">No agents connected yet.</p> : agents.map(a => <article key={a.agent_id}><div><h3>{a.name}</h3><p>{labels[a.permission]} · ${(a.max_spend_cents / 100).toFixed(2)} test budget per lease</p></div><span>{a.revoked_at ? "Revoked" : "Access enabled"}</span>{!a.revoked_at && <button className="hardware-button secondary" disabled={busy} onClick={() => revoke(a)}>Revoke access</button>}</article>)}</div>
    </section>
    <section className="hardware-section"><div className="hardware-section-heading"><div><p className="hardware-eyebrow">Saved activity</p><h2>What your agents are doing.</h2></div><p>Latest 50 MCP calls and physical invocations. Refreshing this page keeps the history.</p></div>
      {calls.length === 0 ? <div className="hardware-empty"><p>Your agent’s actions will appear here when it uses GHOST.</p><blockquote>“Use GHOST to find a public camera on the Bay Bridge and retrieve an observation.”</blockquote></div> : <ol className="hardware-timeline">{calls.map(c => <li key={c.call_id}><div className="hardware-result-top"><strong>{c.agent_name} <span className="hardware-caption">/ {c.tool.replaceAll("_", " ")}</span></strong><span className="hardware-status">{c.state === "running" && now - Date.parse(c.created_at) >= 130000 ? "Result not confirmed" : c.state}</span></div><time className="hardware-caption" dateTime={c.created_at}>{new Date(c.created_at).toLocaleString()}</time><details><summary>Request and result</summary><pre>{JSON.stringify(c.arguments, null, 2)}</pre><pre>{c.result || "Waiting for a result. A sent command is not proof of a physical outcome."}</pre></details></li>)}</ol>}
      {invocations.length > 0 && <div className="hardware-observations"><h3>Physical results</h3>{invocations.map(i => <article key={i.invocation_id}><strong>{i.agent_name} → {i.device_name || "Device"}</strong><p>{i.capability_id} · {i.state}</p>{i.observation && <><p>Observation: {i.observation.kind} · Captured {i.observation.captured_at ? new Date(i.observation.captured_at).toLocaleString() : "at an unknown time"}</p>{i.observation.media_url && <a href={`/api/v1/observations/${encodeURIComponent(i.observation_id || "")}/media`}>View observation ↗</a>}{i.observation.note && <p>{i.observation.note}</p>}</>}</article>)}</div>}
    </section>
    <section className="hardware-section hardware-owner"><div><p className="hardware-eyebrow">Your devices</p><h2>Connect once.<br />Let agents request access.</h2></div><div><p>Add hardware and manage its terms. Your agent uses the same access lifecycle as other agents on the network.</p><div className="hardware-actions"><Link className="hardware-button" href="/devices">Add hardware</Link><Link className="hardware-button secondary" href="/owner">Manage access</Link></div></div></section>
  </>;
}
