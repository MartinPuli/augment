"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";
// Icon *data* from "lucide" (drawn by the morphing <Icon />), not lucide-react components.
import {
  Boxes,
  CalendarDays,
  Cctv,
  FileText,
  Gauge,
  Globe,
  Image as ImageIcon,
  KeyRound,
  List,
  Map as MapIcon,
  Newspaper,
  Plug,
  QrCode,
  Radar,
  Search,
  SquarePlay,
  Sun,
  Timer,
  TrainFront,
  Workflow,
} from "lucide";
import type { IconNode } from "@/components/ui/Icon";
import type { WidgetComponentProps } from "./types";
import { DeviceListWidget, ImageWidget, LeaseWidget, MetricWidget, MissionWidget, NoteWidget, ResultsWidget, WebViewWidget } from "./widgets/core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWidget = ComponentType<WidgetComponentProps<any>>;

function Loading() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true">
      <div className="ghost-skeleton h-24 rounded-tile" />
      <div className="ghost-skeleton h-3 w-2/3 rounded-full" />
      <div className="ghost-skeleton h-3 w-1/2 rounded-full" />
    </div>
  );
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
const WeatherWidget = lazy(() => import("./widgets/services/WeatherWidget"), "WeatherWidget");
const NewsWidget = lazy(() => import("./widgets/services/NewsWidget"), "NewsWidget");
const YouTubeWidget = lazy(() => import("./widgets/services/YouTubeWidget"), "YouTubeWidget");
const AgendaWidget = lazy(() => import("./widgets/services/AgendaWidget"), "AgendaWidget");
const DeparturesWidget = lazy(() => import("./widgets/services/DeparturesWidget"), "DeparturesWidget");
const MapWidget = lazy(() => import("./widgets/services/MapWidget"), "MapWidget");
const ListWidget = lazy(() => import("./widgets/services/ListWidget"), "ListWidget");
const TimerWidget = lazy(() => import("./widgets/TimerWidget"), "TimerWidget");
const NetworkScanWidget = lazy(() => import("./widgets/NetworkScanWidget"), "NetworkScanWidget");

export interface WidgetEntry {
  component: AnyWidget;
  icon: IconNode;
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
  weather: { component: WeatherWidget, icon: Sun, size: "md", label: "Weather" },
  news: { component: NewsWidget, icon: Newspaper, size: "md", label: "News" },
  youtube: { component: YouTubeWidget, icon: SquarePlay, size: "lg", label: "YouTube" },
  agenda: { component: AgendaWidget, icon: CalendarDays, size: "md", label: "Agenda" },
  departures: { component: DeparturesWidget, icon: TrainFront, size: "md", label: "Departures" },
  map: { component: MapWidget, icon: MapIcon, size: "lg", label: "Map" },
  list: { component: ListWidget, icon: List, size: "md", label: "Results" },
};
