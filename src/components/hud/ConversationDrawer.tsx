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
import { ArrowUp, CheckCircle2, ChevronDown, Loader2, X, XCircle } from "lucide-react";
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
          className="ghost-glass fixed bottom-3 right-3 top-3 z-40 flex w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[26px]"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            {(["conversation", "trace"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={clsx(
                  "rounded-full px-3 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] transition",
                  tab === t ? "bg-ivory text-ink" : "text-mute hover:text-ivory",
                )}
              >
                {t}
              </button>
            ))}
            <button onClick={() => useGhost.getState().set({ drawer: false })} className="ml-auto grid h-7 w-7 place-items-center rounded-full text-mute hover:bg-ink-4 hover:text-ivory" aria-label="Close panel">
              <X size={15} />
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
            <div className="m-auto flex flex-col items-center gap-3 py-16 text-center text-mute">
              <PoltyGlyph size={40} />
              <p className="max-w-[240px] text-[13px]">Everything Polty hears, says and touches shows up here.</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="m-3 flex items-end gap-2 rounded-2xl border border-line bg-ink-3/80 p-2">
          <ComposerPrimitive.Input
            placeholder="Type to Polty…"
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[13.5px] text-ivory outline-none placeholder:text-mute"
          />
          <ComposerPrimitive.Send className="grid h-9 w-9 place-items-center rounded-xl bg-ivory text-ink transition hover:bg-white disabled:opacity-30">
            <ArrowUp size={16} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="ml-10 self-end rounded-2xl rounded-br-md bg-ink-4 px-3.5 py-2 text-[13.5px] text-ivory">
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mr-6 flex gap-2.5">
      <div className="mt-0.5 shrink-0">
        <PoltyGlyph size={22} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13.5px] leading-relaxed text-ivory-dim">
        <MessagePrimitive.Parts components={{ tools: { Fallback: ToolCard } }} />
      </div>
    </MessagePrimitive.Root>
  );
}

const ToolCard: ToolCallMessagePartComponent = ({ toolName, args, result, isError, status }) => {
  const [open, setOpen] = useState(false);
  const running = status?.type === "running" || result === undefined;
  return (
    <div className="rounded-xl border border-line bg-ink-3/60">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        {running ? (
          <Loader2 size={13} className="animate-spin text-violet" />
        ) : isError ? (
          <XCircle size={13} className="text-coral" />
        ) : (
          <CheckCircle2 size={13} className="text-mint" />
        )}
        <span className="truncate font-mono text-[11px] text-ivory-dim">{TOOL_LABELS[toolName] ?? toolName}</span>
        <ChevronDown size={13} className={clsx("ml-auto text-mute transition", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="ghost-scroll max-h-56 overflow-auto border-t border-line px-2.5 py-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-all text-mute">
          {JSON.stringify(args, null, 1)}
          {result !== undefined ? `\n→ ${typeof result === "string" ? result.slice(0, 1500) : JSON.stringify(result).slice(0, 1500)}` : ""}
        </pre>
      )}
    </div>
  );
};

function Trace() {
  const trace = useGhost((s) => s.trace);
  const color = { tool: "text-violet", event: "text-mint", error: "text-coral", payment: "text-amber", model: "text-ivory-dim" } as const;
  return (
    <ol className="ghost-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-4">
      {[...trace].reverse().map((e, i) => (
        <li key={`${e.at}-${i}`} className="rounded-xl border border-line bg-ink-3/50 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={clsx("font-mono text-[10px] uppercase tracking-[0.14em]", color[e.kind])}>{e.kind}</span>
            <span className="ml-auto font-mono text-[10px] text-mute">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
          <div className="mt-0.5 text-[12.5px] text-ivory">{e.title}</div>
          {e.detail && <div className="mt-0.5 line-clamp-3 font-mono text-[10.5px] text-mute">{e.detail}</div>}
        </li>
      ))}
      {!trace.length && <li className="m-auto py-16 text-[13px] text-mute">No activity yet.</li>}
    </ol>
  );
}
