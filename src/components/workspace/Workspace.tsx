"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Target, X } from "lucide";
import type { CapabilityHit, Offer } from "@/lib/ghost/contracts";
import { WIDGETS } from "@/components/canvas/registry";
import { WidgetFrame } from "@/components/canvas/WidgetFrame";
import { ErrorBoundary } from "@/components/canvas/ErrorBoundary";
import { Icon } from "@/components/ui/Icon";
import { duration, ease, haptic, spring } from "@/components/ui/motion";

/**
 * The workspace: everything Polty can reach, composed into one calm board — weather, your day,
 * transit, news, a reading, devices, a lease, a map, a timer, research. It is a deliberate,
 * curated layout (not generated on the fly), filled with sample data and labelled as such.
 *
 * The top bar's target button toggles it: the board is revealed by a circle growing out of the
 * button (and collapses back into it), then the cards settle in, top to bottom.
 */
const noop = () => () => {};
const NO = () => {};

type Tile = { id: string; type: string; title: string; span: string; props: Record<string, unknown> };

function sampleTiles(now: number): Tile[] {
  const at = (h: number, m = 0) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const day = (n: number) => new Date(now + n * 864e5).toISOString().slice(0, 10);
  const hits = [
    { ref: "lights/power", device: { device_id: "lights", name: "Living room lights", device_class: "light", access_type: "own_device", online: true }, capability: { title: "Turn on/off, set colour" }, terms: { price_cents: 0 } },
    { ref: "workshop-cam/snapshot", device: { device_id: "workshop-cam", name: "Workshop camera", device_class: "camera", access_type: "owner_shared", online: true }, capability: { title: "Snapshot of the workbench" }, terms: { price_cents: 25 }, distance_km: 1.4 },
    { ref: "phone/camera", device: { device_id: "phone", name: "Your phone", device_class: "phone", access_type: "own_device", online: true }, capability: { title: "Camera, mic, location" }, terms: { price_cents: 0 } },
    { ref: "bay-bridge/stream", device: { device_id: "bay-bridge", name: "Bay Bridge camera", device_class: "camera", access_type: "public_observation", online: true }, capability: { title: "Live traffic view" }, terms: { price_cents: 0 } },
  ] as unknown as CapabilityHit[];
  const offer = {
    offer_id: "sample-offer",
    refs: [{ device_id: "workshop-cam", capability_id: "snapshot" }],
    price_cents: 25,
    currency: "USD",
    duration_s: 120,
    status: "open",
    round: 0,
  } as unknown as Offer;

  return [
    {
      id: "ws-brief",
      type: "note",
      title: "Your morning",
      span: "sm:col-span-6 lg:col-span-5",
      props: { markdown: "**Three meetings today**, the first at 9:30.\n\n- Light rain after 4 pm, so take a jacket\n- Yellow line BART is running on time\n- The workshop camera is free until noon" },
    },
    {
      id: "ws-weather",
      type: "weather",
      title: "San Francisco",
      span: "sm:col-span-6 lg:col-span-4",
      props: {
        place: { name: "San Francisco" },
        current: { temperature_c: 17, feels_like_c: 16, condition: "Partly cloudy", wind_kmh: 14, humidity_pct: 72 },
        daily: [
          { date: day(0), condition: "Partly cloudy", max_c: 18, min_c: 12, precip_prob_pct: 20 },
          { date: day(1), condition: "Light rain", max_c: 16, min_c: 11, precip_prob_pct: 70 },
          { date: day(2), condition: "Sunny", max_c: 20, min_c: 12, precip_prob_pct: 5 },
          { date: day(3), condition: "Fog", max_c: 17, min_c: 12, precip_prob_pct: 10 },
        ],
      },
    },
    {
      id: "ws-tide",
      type: "metric",
      title: "Tide",
      span: "sm:col-span-6 lg:col-span-3",
      props: { label: "Water level · Golden Gate", value: 4.2, unit: "ft", source: "NOAA", trend: [3.1, 3.4, 3.8, 4.4, 4.9, 5.1, 4.8, 4.2] },
    },
    {
      id: "ws-agenda",
      type: "agenda",
      title: "Today",
      span: "sm:col-span-6 lg:col-span-4",
      props: {
        events: [
          { title: "Design review", start: at(9, 30), end: at(10, 15), location: "Studio" },
          { title: "Lunch with Maya", start: at(12, 30), end: at(13, 30), location: "Ferry Building" },
          { title: "Ship the demo", start: at(15), end: at(16) },
          { title: "Climbing", start: at(18, 30), end: at(20), location: "Mission Cliffs" },
        ],
      },
    },
    {
      id: "ws-bart",
      type: "departures",
      title: "Montgomery St",
      span: "sm:col-span-6 lg:col-span-4",
      props: {
        station: "Montgomery St",
        departures: [
          { destination: "Antioch", minutes: 3, platform: "2", cars: 10, hexcolor: "#ffd600" },
          { destination: "Richmond", minutes: 7, platform: "2", cars: 8, hexcolor: "#ff9933" },
          { destination: "Dublin/Pleasanton", minutes: 11, platform: "2", cars: 9, hexcolor: "#0099cc" },
          { destination: "SF Airport", minutes: 14, platform: "1", cars: 10, hexcolor: "#ffd600" },
        ],
      },
    },
    {
      id: "ws-news",
      type: "news",
      title: "Headlines",
      span: "sm:col-span-6 lg:col-span-4",
      props: {
        items: [
          { title: "Your top stories appear here, from the sources you follow", source: "News", published: at(8) },
          { title: "Ask “what's new in climate tech?” for a topic briefing", source: "News", published: at(7, 30) },
          { title: "Polty can read any article aloud and summarise it", source: "Exa", published: at(7) },
        ],
      },
    },
    {
      id: "ws-devices",
      type: "device_list",
      title: "Within reach",
      span: "sm:col-span-6 lg:col-span-7",
      props: { hits },
    },
    {
      id: "ws-lease",
      type: "lease",
      title: "Workshop camera",
      span: "sm:col-span-6 lg:col-span-5",
      props: { offer, host_message: "Sure, the camera faces the workbench. Two minutes is fine." },
    },
    {
      id: "ws-map",
      type: "map",
      title: "Nearby",
      span: "sm:col-span-6 lg:col-span-6",
      props: { center: { lat: 37.7899, lon: -122.4014 }, zoom: 13, markers: [{ lat: 37.7899, lon: -122.4014, label: "Montgomery St" }, { lat: 37.7955, lon: -122.3937, label: "Ferry Building" }] },
    },
    {
      id: "ws-timer",
      type: "timer",
      title: "Tea",
      span: "sm:col-span-6 lg:col-span-3",
      props: { ends_at: now + 4 * 60_000 + 20_000, label: "Green tea, steeping" },
    },
    {
      id: "ws-results",
      type: "results",
      title: "Research",
      span: "sm:col-span-6 lg:col-span-3",
      props: {
        items: [
          { title: "Sourdough", url: "https://en.wikipedia.org/wiki/Sourdough", snippet: "Bread made by the fermentation of dough using wild lactobacilli and yeast." },
          { title: "Golden Gate Bridge", url: "https://en.wikipedia.org/wiki/Golden_Gate_Bridge", snippet: "Suspension bridge spanning the Golden Gate strait." },
        ],
      },
    },
  ];
}

export function WorkspaceToggle() {
  const client = useSyncExternalStore(noop, () => true, () => false);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);

  const toggle = () => {
    haptic();
    const r = btn.current?.getBoundingClientRect();
    if (r) setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    setOpen((o) => !o);
  };

  return (
    <>
      <motion.button
        ref={btn}
        type="button"
        onClick={toggle}
        aria-label={open ? "Close workspace" : "Workspace"}
        aria-pressed={open}
        title={open ? "Close workspace" : "Workspace — everything at a glance"}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.9 }}
        transition={spring.snappy}
        className={clsx(
          "ghost-chip pointer-events-auto grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors duration-200",
          open ? "!bg-fg text-fg-inverse" : "text-fg-2 hover:bg-white/90 hover:text-fg",
        )}
      >
        <Icon icon={open ? X : Target} size={17} strokeWidth={1.9} spring="snappy" />
      </motion.button>
      {client && createPortal(<AnimatePresence>{open && <WorkspaceBoard key="ws" origin={origin} />}</AnimatePresence>, document.body)}
    </>
  );
}

function WorkspaceBoard({ origin }: { origin: { x: number; y: number } }) {
  const [now] = useState(() => Date.now());
  const tiles = useMemo(() => sampleTiles(now), [now]);
  const at = `${origin.x}px ${origin.y}px`;
  return (
    <motion.section
      role="region"
      aria-label="Workspace"
      className="fixed inset-0 z-[35] overflow-hidden"
      initial={{ clipPath: `circle(0px at ${at})` }}
      animate={{ clipPath: `circle(150% at ${at})`, transition: { duration: duration.celebratory, ease: ease.standard } }}
      exit={{ clipPath: `circle(0px at ${at})`, transition: { duration: duration.deliberate, ease: ease.move } }}
    >
      {/* calm field with soft glows */}
      <div aria-hidden className="absolute inset-0 bg-[#f7f6f2]" />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(40% 35% at 85% 0%, rgb(45 212 191 / 0.16), transparent 70%), radial-gradient(40% 40% at 0% 30%, rgb(167 139 250 / 0.14), transparent 70%), radial-gradient(45% 40% at 60% 100%, rgb(251 191 146 / 0.14), transparent 70%)",
        }}
      />
      {/* one quiet scan as the board comes up */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 h-40 bg-gradient-to-b from-transparent via-mint-glow/12 to-transparent"
        initial={{ y: "-20vh", opacity: 0 }}
        animate={{ y: "110vh", opacity: [0, 1, 1, 0], transition: { duration: 1.1, ease: ease.move, delay: 0.15 } }}
      />

      <div className="ghost-scroll relative h-full overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-[1240px] px-3 pb-[calc(var(--dock-h,180px)+32px)] pt-[max(72px,calc(env(safe-area-inset-top)+64px))] sm:px-6 sm:pt-24">
          <motion.header
            className="mb-5 flex flex-wrap items-end justify-between gap-3 px-1 sm:mb-7"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.22, duration: duration.deliberate, ease: ease.standard } }}
          >
            <div>
              <h2 className="font-display text-display text-fg">Your workspace</h2>
              <p className="mt-2 text-body text-fg-2">Everything Polty can reach, at a glance. Ask about any of it.</p>
            </div>
            <span className="ghost-chip inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-caption font-medium text-fg-3">
              <span className="h-1.5 w-1.5 rounded-full bg-amber" /> Sample data
            </span>
          </motion.header>

          <motion.div
            className="grid grid-cols-1 items-start gap-3 sm:grid-cols-12 sm:gap-4"
            initial="hidden"
            animate="show"
            variants={{ show: { transition: { staggerChildren: 0.05, delayChildren: 0.3 } } }}
          >
            {tiles.map((t) => {
              const entry = WIDGETS[t.type];
              const C = entry?.component;
              if (!C) return null;
              return (
                <motion.div
                  key={t.id}
                  className={clsx("min-w-0", t.span)}
                  variants={{ hidden: { opacity: 0, y: 18, scale: 0.97 }, show: { opacity: 1, y: 0, scale: 1, transition: spring.gentle } }}
                >
                  <WidgetFrame id={t.id} title={t.title} icon={entry.icon} focused={false} possessed={false} className="h-full">
                    <ErrorBoundary label={t.type}>
                      <C id={t.id} props={t.props} focused={false} report={NO} emit={NO} update={NO} />
                    </ErrorBoundary>
                  </WidgetFrame>
                </motion.div>
              );
            })}
          </motion.div>
        </div>
      </div>
    </motion.section>
  );
}
