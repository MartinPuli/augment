"use client";

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowUp, ChevronDown, CircleCheck, CircleX, LoaderCircle, X } from "lucide";
import { Icon } from "@/components/ui/Icon";
import { useGhost, type UiMessage } from "@/lib/store";
import { cancelRun, displayText, sendToPolty } from "@/lib/agent/runtime";
import { TOOL_LABELS } from "@/lib/agent/tools";
import { PoltyGlyph } from "@/components/mascot/Polty";

/**
 * Secondary panel: the full conversation with every tool call (assistant-ui on top of our own
 * agent loop via the external-store runtime) plus a technical trace with receipts.
 */
export function ConversationDrawer() {
  const open = useGhost((s) => s.drawer);
  const [tab, setTab] = useState<"conversation" | "trace">("conversation");
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: "105%" }}
          animate={{ x: 0 }}
          exit={{ x: "105%" }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="ghost-glass fixed bottom-3 right-3 top-3 z-50 flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[28px]"
        >
          <header className="flex items-center gap-1 border-b border-line px-3 py-3">
            {(["conversation", "trace"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "rounded-full px-3 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] transition",
                  tab === t ? "bg-fg text-white shadow-[0_4px_12px_-4px_rgb(15_23_42/0.45)]" : "text-fg-2 hover:bg-white/70 hover:text-fg",
                )}
              >
                {t}
              </button>
            ))}
            <button onClick={() => useGhost.getState().set({ drawer: false })} className="ml-auto grid h-8 w-8 place-items-center rounded-full text-fg-2 transition hover:bg-white/70 hover:text-fg" aria-label="Close panel">
              <Icon icon={X} size={15} />
            </button>
          </header>
          {tab === "conversation" ? <Thread /> : <Trace />}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function convert(m: UiMessage): ThreadMessageLike {
  const text = displayText(m.text);
  return {
    id: m.id,
    role: m.role,
    createdAt: new Date(m.createdAt),
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...m.tools.map((t) => ({
        type: "tool-call" as const,
        toolCallId: t.id,
        toolName: t.name,
        args: (t.args ?? {}) as Record<string, never>,
        result: t.status === "running" ? undefined : (t.result ?? ""),
        isError: t.status === "error",
      })),
    ],
  };
}

function Thread() {
  const ui = useGhost((s) => s.ui);
  const running = useGhost((s) => s.running);
  const messages = useMemo(() => ui.filter((m) => m.text || m.tools.length), [ui]);
  const runtime = useExternalStoreRuntime<UiMessage>({
    messages,
    isRunning: running,
    convertMessage: convert,
    onNew: async (msg: AppendMessage) => {
      const text = msg.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
      void sendToPolty(text);
    },
    onCancel: async () => cancelRun(),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="ghost-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <ThreadPrimitive.Empty>
            <div className="m-auto flex flex-col items-center gap-3 py-16 text-center text-fg-2">
              <span className="grid h-14 w-14 place-items-center rounded-[18px] bg-gradient-to-b from-[#2a2f36] to-[#121418] shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_10px_24px_-10px_rgb(15_23_42/0.5)]">
                <PoltyGlyph size={30} />
              </span>
              <p className="max-w-[240px] text-[13px]">Everything Polty hears, says and touches shows up here.</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="m-3 flex items-end gap-2 rounded-[20px] border border-white/80 bg-white/70 p-2 shadow-[inset_0_1px_0_rgb(255_255_255),0_8px_24px_-14px_rgb(15_23_42/0.3)] focus-within:ring-2 focus-within:ring-mint/25">
          <ComposerPrimitive.Input
            placeholder="Type to Polty…"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[13.5px] text-fg outline-none placeholder:text-fg-3"
          />
          <ComposerPrimitive.Send className="grid h-9 w-9 place-items-center rounded-full bg-fg text-white shadow-[0_4px_12px_-4px_rgb(15_23_42/0.5)] transition hover:bg-fg/85 disabled:opacity-30 disabled:shadow-none">
            <Icon icon={ArrowUp} size={16} strokeWidth={2.2} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-10 self-end rounded-[18px] rounded-br-md bg-gradient-to-b from-[#2a2f36] to-[#16191e] px-3.5 py-2 text-[13.5px] text-white shadow-[0_8px_20px_-10px_rgb(15_23_42/0.5)]">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mr-6 flex gap-2.5">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#2a2f36] to-[#121418] shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]">
        <PoltyGlyph size={16} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13.5px] leading-relaxed text-fg">
        <MessagePrimitive.Parts components={{ tools: { by_name: { invoke_capability: EvidenceCard, observe_web_page: EvidenceCard, accept_quote: DealCard, quote_lease: DealCard }, Fallback: ToolCard } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

const ToolCard: ToolCallMessagePartComponent = ({ toolName, args, result, isError, status }) => {
  const [open, setOpen] = useState(false);
  const running = status?.type === "running" || result === undefined;
  return (
    <div className="rounded-xl border border-white/70 bg-white/55 shadow-[inset_0_1px_0_rgb(255_255_255)]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <Icon
          icon={running ? LoaderCircle : isError ? CircleX : CircleCheck}
          size={13}
          spring="snappy"
          className={clsx("shrink-0", running ? "animate-spin text-violet" : isError ? "text-coral" : "text-mint")}
        />
        <span className="truncate font-mono text-[11px] text-fg-2">{TOOL_LABELS[toolName] ?? toolName}</span>
        <Icon icon={ChevronDown} size={13} className={clsx("ml-auto text-fg-3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="ghost-scroll max-h-56 overflow-auto border-t border-line px-2.5 py-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all text-fg-3">
          {JSON.stringify(args, null, 1)}
          {result !== undefined ? `\n→ ${typeof result === "string" ? result.slice(0, 1500) : JSON.stringify(result).slice(0, 1500)}` : ""}
        </pre>
      )}
    </div>
  );
};

function parseResult(result: unknown): Record<string, unknown> | null {
  if (typeof result !== "string") return null;
  const first = result.trim().startsWith("{") ? result.slice(0, result.lastIndexOf("}") + 1) : null;
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch {
    return null;
  }
}

/** invoke_capability / observe_web_page: show the evidence itself in the thread. */
const EvidenceCard: ToolCallMessagePartComponent = (props) => {
  const r = parseResult(props.result);
  const obs = (r?.observation ?? null) as { observation_id?: string; kind?: string; value?: unknown; unit?: string; captured_at?: string | null } | null;
  const obsId = obs?.observation_id ?? (r?.observation_id as string | undefined);
  const state = r?.state as string | undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <ToolCard {...props} />
      {(obsId || state) && (
        <div className="flex items-center gap-2.5 rounded-xl border border-white/70 bg-white/55 p-2 shadow-[inset_0_1px_0_rgb(255_255_255)]">
          {obsId && (!obs?.kind || obs.kind === "image") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/v1/observations/${obsId}/media`} alt="Observation" className="h-14 w-20 rounded-lg object-cover" />
          )}
          <div className="min-w-0 font-mono text-[10.5px] leading-snug">
            {state && (
              <div className={clsx(state === "succeeded" ? "text-mint" : state === "unknown" ? "text-amber" : "text-coral")}>{state}</div>
            )}
            {obs?.value !== undefined && obs?.value !== null && (
              <div className="text-fg">
                {String(obs.value)} {obs.unit ?? ""}
              </div>
            )}
            <div className="text-fg-3">{obs?.captured_at ? `captured ${new Date(obs.captured_at).toLocaleTimeString()}` : obsId ? "capture time unknown" : ""}</div>
          </div>
        </div>
      )}
    </div>
  );
};

/** quote_lease / accept_quote: terms and the (test) payment at a glance. */
const DealCard: ToolCallMessagePartComponent = (props) => {
  const r = parseResult(props.result);
  const offer = r?.offer as { price_cents?: number; duration_s?: number; status?: string } | undefined;
  const lease = r?.lease as { price_cents?: number; state?: string; payment?: { label?: string } | null } | undefined;
  const price = lease?.price_cents ?? offer?.price_cents;
  return (
    <div className="flex flex-col gap-1.5">
      <ToolCard {...props} />
      {price !== undefined && (
        <div className="flex items-center gap-2 rounded-xl border border-dashed border-line-strong px-2.5 py-1.5 font-mono text-[10.5px]">
          <span className={lease?.state === "active" ? "text-mint" : "text-amber"}>{lease?.state ?? offer?.status ?? "offer"}</span>
          <span className="text-fg">${(price / 100).toFixed(2)}</span>
          {offer?.duration_s && <span className="text-fg-3">{offer.duration_s}s</span>}
          {lease?.payment && <span className="ml-auto truncate text-amber">test payment</span>}
        </div>
      )}
    </div>
  );
};

function Trace() {
  const trace = useGhost((s) => s.trace);
  const color = { tool: "text-violet", event: "text-mint", error: "text-coral", payment: "text-amber", model: "text-fg-2" } as const;
  return (
    <ol className="ghost-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
      {[...trace].reverse().map((e, i) => (
        <li key={`${e.at}-${i}`} className="rounded-xl border border-white/70 bg-white/50 px-3 py-2 shadow-[inset_0_1px_0_rgb(255_255_255)]">
          <div className="flex items-center gap-2">
            <span className={clsx("font-mono text-[10px] font-semibold uppercase tracking-[0.14em]", color[e.kind])}>{e.kind}</span>
            <span className="ml-auto font-mono text-[10px] text-fg-3">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-fg">{e.title}</div>
          {e.detail && <div className="mt-0.5 line-clamp-3 font-mono text-[10.5px] text-fg-3">{e.detail}</div>}
        </li>
      ))}
      {!trace.length && <li className="m-auto py-16 text-[13px] text-fg-3">No activity yet.</li>}
    </ol>
  );
}
