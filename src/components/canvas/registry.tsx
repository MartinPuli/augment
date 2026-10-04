"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
import {
  Boxes,
  Cctv,
  FileText,
  Gauge,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Plug,
  QrCode,
  Radar,
  Search,
  Workflow,
  Timer,
  type LucideIcon,
} from "lucide-react";
import type { WidgetComponentProps } from "./types";
import { DeviceListWidget, ImageWidget, LeaseWidget, MetricWidget, MissionWidget, NoteWidget, ResultsWidget, WebViewWidget } from "./widgets/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWidget = ComponentType<WidgetComponentProps<any>>;

function Loading() {
  return <div className="h-28 animate-pulse rounded-2xl bg-ink-3/70" />;
}

/** Widgets owned by other modules are code-split; they accept either a default or a named export. */
function lazy(loader: () => Promise<Record<string, unknown>>, name: string): AnyWidget {
  return dynamic(
    () =>
      loader().then((m) => {
        const C = (m.default ?? m[name]) as AnyWidget | undefined;
        if (!C) throw new Error(`${name} not found`);
        return C;
      }),
    { ssr: false, loading: Loading },
  ) as AnyWidget;
}

const LiveViewWidget = lazy(() => import("./widgets/LiveViewWidget"), "LiveViewWidget");
const PairPhoneWidget = lazy(() => import("./widgets/PairPhoneWidget"), "PairPhoneWidget");
const ConnectHardwareWidget = lazy(() => import("./widgets/ConnectHardwareWidget"), "ConnectHardwareWidget");
const TimerWidget = lazy(() => import("./widgets/TimerWidget"), "TimerWidget");
const NetworkScanWidget = lazy(() => import("./widgets/NetworkScanWidget"), "NetworkScanWidget");

export interface WidgetEntry {
  component: AnyWidget;
  icon: LucideIcon;
  size: "sm" | "md" | "lg" | "xl";
  label: string;
}

export const WIDGETS: Record<string, WidgetEntry> = {
  note: { component: NoteWidget, icon: FileText, size: "md", label: "Note" },
  image: { component: ImageWidget, icon: ImageIcon, size: "md", label: "Observation" },
  metric: { component: MetricWidget, icon: Gauge, size: "sm", label: "Reading" },
  device_list: { component: DeviceListWidget, icon: Boxes, size: "lg", label: "Capabilities" },
  lease: { component: LeaseWidget, icon: KeyRound, size: "md", label: "Lease" },
  live_view: { component: LiveViewWidget, icon: Cctv, size: "xl", label: "Live view" },
  pair_phone: { component: PairPhoneWidget, icon: QrCode, size: "md", label: "Pair a phone" },
  connect_hardware: { component: ConnectHardwareWidget, icon: Plug, size: "md", label: "Connect hardware" },
  network_scan: { component: NetworkScanWidget, icon: Radar, size: "lg", label: "Wi-Fi radar" },
  web_view: { component: WebViewWidget, icon: Globe, size: "lg", label: "Web view" },
  results: { component: ResultsWidget, icon: Search, size: "md", label: "Results" },
  mission: { component: MissionWidget, icon: Workflow, size: "lg", label: "Mission" },
  timer: { component: TimerWidget, icon: Timer, size: "sm", label: "Timer" },
};
