"use client";

import { AnimatePresence, LayoutGroup, animate, motion, useMotionTemplate, useMotionValue, useMotionValueEvent, type AnimationPlaybackControls } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useShallow } from "zustand/react/shallow";
import { X } from "lucide";
import { useGhost, type UiMessage } from "@/lib/store";
import { displayText, sendToPolty } from "@/lib/agent/runtime";
import { Icon } from "@/components/ui/Icon";
import { duration, ease, haptic, spring } from "@/components/ui/motion";
import { WIDGETS } from "./registry";
import { WidgetFrame } from "./WidgetFrame";
import type { WidgetSpec } from "./types";
import { ErrorBoundary } from "./ErrorBoundary";

const SPAN: Record<string, string> = {
  sm: "col-span-12 sm:col-span-6 lg:col-span-3",
  md: "col-span-12 sm:col-span-6 lg:col-span-4",
  lg: "col-span-12 lg:col-span-6",
  xl: "col-span-12 lg:col-span-8",
};

/* Pan physics, after ThiingsGrid (thiings.co): recency-weighted velocity, inertia, wheel panning. */
const VELOCITY_HISTORY = 5;
const DRAG_THRESHOLD = 6;
const PROJECT_MS = 280; // how far a flick carries before it settles
const RUBBER = 0.32; // resistance past the edges
const NO_PAN = "button, a, input, textarea, select, label, iframe, video, canvas, [contenteditable='true'], [data-no-pan], [role='slider']";

interface Task {
  id: string;
  title: string;
  at: number;
  widgets: WidgetSpec[];
}

/** One board per prompt: widgets belong to the latest typed or spoken prompt before they appeared. */
function groupTasks(widgets: WidgetSpec[], turns: UiMessage[]): Task[] {
  const tasks = new Map<string, Task>();
  for (const w of widgets) {
    let turn: UiMessage | null = null;
    for (const t of turns) {
      if (t.createdAt <= w.createdAt + 50) turn = t;
      else break;
    }
    const id = turn?.id ?? "start";
    let task = tasks.get(id);
    if (!task) {
      task = { id, title: turn ? titleOf(turn.text) : "Getting started", at: turn?.createdAt ?? w.createdAt, widgets: [] };
      tasks.set(id, task);
    }
    task.widgets.push(w);
  }
  return [...tasks.values()].sort((a, b) => a.at - b.at).map((t) => ({ ...t, widgets: t.widgets.sort((a, b) => b.createdAt - a.createdAt) }));
}

function titleOf(text: string) {
  const t = displayText(text).replace(/\s+/g, " ").trim();
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return s.length > 72 ? `${s.slice(0, 70).trimEnd()}…` : s || "New task";
}

function geometry(vw: number) {
  const wide = vw >= 1024;
  const boardW = Math.min(1120, vw - (wide ? 288 : vw >= 640 ? 64 : 24));
  const gap = vw >= 640 ? 120 : 28;
  // phones: the task chips get their own row under the top bar
  return { boardW, cell: boardW + gap, top: vw >= 640 ? 84 : 112, shift: wide ? 40 : 0 };
}

const rubber = (v: number, min: number, max: number) => (v < min ? min - (min - v) * RUBBER : v > max ? max + (v - max) * RUBBER : v);
const dockH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dock-h")) || 180;

/**
 * The generative-UI canvas: an endless, draggable surface where every task gets its own board.
 * A new task glides in from the right; drag, flick, scroll or use the task chips (and ← →) to go
 * back. Boards snap horizontally; within a board you pan vertically. Polty still finds widgets by
 * `data-widget-id` — the surface brings focused or possessed widgets into view first.
 */
export function Canvas() {
  const widgets = useGhost((s) => s.widgets);
  const turns = useGhost(useShallow((s) => s.ui.filter((m) => m.role === "user" && !m.event)));
  const focusId = useGhost((s) => s.focusId);
  const possessId = useGhost((s) => (s.possess && s.possess.until > Date.now() ? s.possess.widgetId : null));
  const tasks = useMemo(() => groupTasks(widgets, turns), [widgets, turns]);

  const [vw, setVw] = useState(1280);
  const [vh, setVh] = useState(800);
  useEffect(() => {
    const on = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const g = geometry(vw);

  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const boardRefs = useRef(new Map<string, HTMLDivElement>());
  const anims = useRef<AnimationPlaybackControls[]>([]);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const live = useRef({ tasks, g, vh, active });
  useEffect(() => {
    live.current = { tasks, g, vh, active };
  });

  const homeX = useCallback((i: number) => (window.innerWidth - live.current.g.boardW) / 2 + live.current.g.shift - i * live.current.g.cell, []);
  const xBounds = useCallback(() => ({ min: homeX(Math.max(0, live.current.tasks.length - 1)), max: homeX(0) }), [homeX]);
  const yBounds = useCallback((i: number) => {
    const { g: geo, tasks: ts } = live.current;
    const el = ts[i] ? boardRefs.current.get(ts[i].id) : undefined;
    const room = window.innerHeight - geo.top - dockH() - 24;
    const h = el?.offsetHeight ?? 0;
    return { min: geo.top - Math.max(0, h - room), max: geo.top };
  }, []);
  const indexAt = useCallback((px: number) => {
    const n = live.current.tasks.length;
    return Math.max(0, Math.min(n - 1, Math.round((homeX(0) - px) / live.current.g.cell)));
  }, [homeX]);

  const stop = () => {
    anims.current.forEach((a) => a.stop());
    anims.current = [];
  };

  /** Glide to a board (and optionally a y), carrying any flick velocity into the spring. */
  const glide = useCallback(
    (i: number, opts: { y?: number; vx?: number; vy?: number } = {}) => {
      stop();
      const b = yBounds(i);
      const ty = Math.max(b.min, Math.min(b.max, opts.y ?? (i === live.current.active ? y.get() : b.max)));
      anims.current = [
        animate(x, homeX(i), { type: "spring", stiffness: 170, damping: 26, velocity: opts.vx ?? 0 }),
        animate(y, ty, { type: "spring", stiffness: 170, damping: 28, velocity: opts.vy ?? 0 }),
      ];
    },
    [x, y, homeX, yBounds],
  );

  // Which board is in front.
  useMotionValueEvent(x, "change", (v) => {
    const i = indexAt(v);
    if (i !== live.current.active) setActive(i);
  });

  // Keep the camera on the active board when the window resizes.
  useEffect(() => {
    glide(live.current.active);
  }, [vw, vh, glide]);

  /** Bring a widget into view: its board in front, and its top below the top bar if it isn't visible. */
  const reveal = useCallback(
    (widgetId: string) => {
      const i = live.current.tasks.findIndex((t) => t.widgets.some((w) => w.id === widgetId));
      if (i < 0) return;
      const el = document.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`) as HTMLElement | null;
      const board = boardRefs.current.get(live.current.tasks[i].id);
      if (!el || !board) return glide(i);
      const offsetTop = el.getBoundingClientRect().top - board.getBoundingClientRect().top;
      const bottomLimit = window.innerHeight - dockH() - 16;
      const onScreenTop = y.get() + offsetTop;
      const fits = i === live.current.active && onScreenTop >= live.current.g.top - 4 && onScreenTop + el.offsetHeight <= bottomLimit;
      // Prefer the board's natural top (title visible) whenever the widget fits from there.
      const fitsFromTop = live.current.g.top + offsetTop + el.offsetHeight <= bottomLimit;
      glide(i, fits ? {} : { y: fitsFromTop ? live.current.g.top : live.current.g.top + 8 - offsetTop });
    },
    [glide, y],
  );

  // A new task glides in; a new widget in an existing task is brought into view.
  const seen = useRef<{ tasks: string[]; widgets: Set<string> }>({ tasks: [], widgets: new Set() });
  useEffect(() => {
    const prev = seen.current;
    const ids = tasks.map((t) => t.id);
    const fresh = widgets.filter((w) => !prev.widgets.has(w.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
    seen.current = { tasks: ids, widgets: new Set(widgets.map((w) => w.id)) };
    const newTask = ids.find((id) => !prev.tasks.includes(id));
    if (newTask) {
      const i = ids.indexOf(newTask);
      if (!prev.tasks.length) {
        // the very first board simply appears in place
        stop();
        x.jump(homeX(i));
        y.jump(live.current.g.top);
        return;
      }
      // let the board mount and measure before gliding
      requestAnimationFrame(() => glide(i, { y: live.current.g.top }));
      return;
    }
    if (fresh) requestAnimationFrame(() => reveal(fresh.id));
    if (ids.length < prev.tasks.length) requestAnimationFrame(() => glide(Math.min(live.current.active, Math.max(0, ids.length - 1))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, widgets]);

  useEffect(() => {
    const id = possessId ?? focusId;
    if (id) reveal(id);
  }, [focusId, possessId, reveal]);

  /* ---------- drag ---------- */
  const drag = useRef<{ id: number; sx: number; sy: number; x0: number; y0: number; last: { x: number; y: number; t: number }; hist: { x: number; y: number }[]; on: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !tasks.length || (e.target as HTMLElement).closest(NO_PAN)) return;
    stop();
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: x.get(), y0: y.get(), last: { x: e.clientX, y: e.clientY, t: performance.now() }, hist: [], on: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.on) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      d.on = true;
      rootRef.current?.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    const now = performance.now();
    const dt = now - d.last.t || 1;
    d.hist = [...d.hist, { x: (e.clientX - d.last.x) / dt, y: (e.clientY - d.last.y) / dt }].slice(-VELOCITY_HISTORY);
    d.last = { x: e.clientX, y: e.clientY, t: now };
    const xb = xBounds();
    const yb = yBounds(live.current.active);
    x.set(rubber(d.x0 + dx, xb.min, xb.max));
    y.set(rubber(d.y0 + dy, yb.min, yb.max));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId || !d.on) return;
    setDragging(false);
    // recency-weighted velocity (px/ms); a finger that rested before lifting carries nothing
    let w = 0;
    const v = d.hist.reduce((a, s, i) => ((w += 2 ** i), { x: a.x + s.x * 2 ** i, y: a.y + s.y * 2 ** i }), { x: 0, y: 0 });
    const rested = performance.now() - d.last.t > 100;
    const vx = rested || !w ? 0 : v.x / w;
    const vy = rested || !w ? 0 : v.y / w;
    const i = indexAt(x.get() + vx * PROJECT_MS);
    if (i !== live.current.active) haptic(6);
    stop();
    const yb = yBounds(i);
    anims.current = [
      animate(x, homeX(i), { type: "spring", stiffness: 190, damping: 28, velocity: vx * 1000 }),
      i === live.current.active
        ? animate(y, Math.max(yb.min, Math.min(yb.max, y.get() + vy * PROJECT_MS)), { type: "spring", stiffness: 160, damping: 30, velocity: vy * 1000 })
        : animate(y, yb.max, { type: "spring", stiffness: 170, damping: 28 }),
    ];
  };

  /* ---------- wheel / trackpad ---------- */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const scrollable = (t: EventTarget | null, dx: number, dy: number) => {
      for (let n = t as HTMLElement | null; n && n !== el; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (dy && /(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight && (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)) return true;
        if (dx && /(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth && (dx > 0 ? n.scrollLeft + n.clientWidth < n.scrollWidth - 1 : n.scrollLeft > 0)) return true;
      }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || !live.current.tasks.length || scrollable(e.target, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      stop();
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (horizontal) {
        const xb = xBounds();
        x.set(rubber(x.get() - (e.shiftKey ? e.deltaY : e.deltaX), xb.min, xb.max));
      } else {
        const yb = yBounds(live.current.active);
        y.set(Math.max(yb.min, Math.min(yb.max, y.get() - e.deltaY)));
      }
      clearTimeout(settle);
      settle = setTimeout(() => glide(indexAt(x.get())), 140);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(settle);
    };
  }, [x, y, xBounds, yBounds, glide, indexAt]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) ) return;
      if (document.querySelector("[role=dialog]") || live.current.tasks.length < 2) return;
      const next = Math.max(0, Math.min(live.current.tasks.length - 1, live.current.active + (e.key === "ArrowRight" ? 1 : -1)));
      if (next !== live.current.active) {
        e.preventDefault();
        glide(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [glide]);

  const dots = useMotionTemplate`${x}px ${y}px`;
  const closeTask = (t: Task) => {
    haptic();
    const st = useGhost.getState();
    t.widgets.forEach((w) => st.removeWidget(w.id));
  };

  return (
    <>
      <motion.div
        ref={rootRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-label="Task canvas"
        className={clsx(
          "fixed inset-0 z-10 touch-none overflow-hidden transition-opacity duration-500",
          tasks.length ? "opacity-100" : "pointer-events-none opacity-0",
          dragging ? "cursor-grabbing select-none" : tasks.length && "cursor-grab",
        )}
        style={{
          backgroundImage: "radial-gradient(rgb(20 20 18 / 0.075) 1px, transparent 1.2px)",
          backgroundSize: "28px 28px",
          backgroundPosition: dots,
        }}
      >
        <motion.div className="absolute left-0 top-0" style={{ x, y }}>
          <AnimatePresence>
            {tasks.map((t, i) => (
              <motion.div
                key={t.id}
                ref={(el) => {
                  if (el) boardRefs.current.set(t.id, el);
                  else boardRefs.current.delete(t.id);
                }}
                className="absolute left-0 top-0 cursor-auto"
                style={{ width: g.boardW }}
                initial={{ opacity: 0, x: i * g.cell + 80, scale: 0.98 }}
                animate={{ opacity: i === active ? 1 : 0.55, x: i * g.cell, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: duration.base, ease: ease.standard } }}
                transition={{ ...spring.gentle, opacity: { duration: duration.deliberate, ease: ease.standard } }}
              >
                <TaskBoard task={t} index={i} onClose={() => closeTask(t)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      </motion.div>

      <TaskChips tasks={tasks} active={active} onPick={(i) => glide(i)} />
    </>
  );
}

function TaskBoard({ task, index, onClose }: { task: Task; index: number; onClose: () => void }) {
  return (
    <section aria-label={task.title} className="pb-8">
      <header className="group/board mb-4 flex items-end gap-3 px-1 sm:mb-5">
        <div className="min-w-0 flex-1">
          <div className="text-caption text-fg-3">
            Task {index + 1} · {new Date(task.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </div>
          <h2 className="mt-0.5 truncate font-display text-title text-fg">{task.title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close task: ${task.title}`}
          title="Close task"
          className="ghost-chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-fg-3 transition-[opacity,color] duration-150 hover:text-fg sm:opacity-0 sm:group-hover/board:opacity-100 sm:focus-visible:opacity-100"
        >
          <Icon icon={X} size={15} />
        </button>
      </header>
      <LayoutGroup id={`task-${task.id}`}>
        <div className="grid grid-flow-dense grid-cols-12 items-start gap-3 sm:gap-4">
          <AnimatePresence mode="popLayout">
            {task.widgets.map((w) => (
              <WidgetSlot key={w.id} spec={w} />
            ))}
          </AnimatePresence>
        </div>
      </LayoutGroup>
    </section>
  );
}

/** Where am I: one chip per task; the active one wears the dark pill. Tap to glide there. */
function TaskChips({ tasks, active, onPick }: { tasks: Task[]; active: number; onPick: (i: number) => void }) {
  return (
    <AnimatePresence>
      {tasks.length > 1 && (
        <motion.nav
          aria-label="Tasks"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8, transition: { duration: duration.fast } }}
          transition={spring.gentle}
          className="ghost-chip ghost-scroll fixed left-3 top-[max(60px,calc(env(safe-area-inset-top)+52px))] z-40 flex h-10 max-w-[calc(100vw-24px)] items-center gap-0.5 overflow-x-auto rounded-full p-1 sm:left-5 sm:top-4 sm:max-w-[min(560px,calc(100vw-420px))]"
        >
          {tasks.map((t, i) => {
            const on = i === active;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  haptic();
                  onPick(i);
                }}
                aria-current={on ? "true" : undefined}
                title={t.title}
                className={clsx("relative h-8 max-w-[11rem] shrink-0 rounded-full px-3 text-caption font-medium transition-colors duration-150", on ? "text-fg-inverse" : "text-fg-2 hover:text-fg")}
              >
                {on && <motion.span layoutId="task-chip" className="absolute inset-0 rounded-full bg-fg shadow-pop" transition={spring.snappy} />}
                <span className="relative block truncate">
                  <span className={clsx("mr-1 tabular-nums", on ? "opacity-60" : "text-fg-3")}>{i + 1}</span>
                  {t.title}
                </span>
              </button>
            );
          })}
        </motion.nav>
      )}
    </AnimatePresence>
  );
}

function WidgetSlot({ spec }: { spec: WidgetSpec }) {
  const focused = useGhost((s) => s.focusId === spec.id);
  const possessed = useGhost((s) => !!s.possess && s.possess.widgetId === spec.id && s.possess.until > Date.now());
  const entry = WIDGETS[spec.type];
  const size = spec.size ?? entry?.size ?? "md";

  const report = useCallback((data: Record<string, unknown>) => useGhost.getState().report(spec.id, data), [spec.id]);
  const emit = useCallback((text: string) => void sendToPolty(text, { event: true }), []);
  const update = useCallback((patch: Record<string, unknown>) => useGhost.getState().patchWidget(spec.id, patch), [spec.id]);
  const close = useCallback(() => useGhost.getState().removeWidget(spec.id), [spec.id]);

  const C = entry?.component;
  return (
    <WidgetFrame
      id={spec.id}
      title={spec.title ?? entry?.label ?? spec.type}
      icon={entry?.icon}
      focused={focused}
      possessed={possessed}
      onClose={close}
      className={clsx(SPAN[size])}
    >
      {C ? (
        <ErrorBoundary label={spec.type}>
          <C id={spec.id} props={spec.props} focused={focused} report={report} emit={emit} update={update} />
        </ErrorBoundary>
      ) : (
        <p className="text-body-sm text-coral">Unknown widget type “{spec.type}”.</p>
      )}
    </WidgetFrame>
  );
}
