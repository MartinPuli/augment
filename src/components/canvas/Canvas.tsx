"use client";

import { AnimatePresence, LayoutGroup } from "motion/react";
import { useCallback, useMemo } from "react";
import clsx from "clsx";
import { useGhost } from "@/lib/store";
import { sendToPolty } from "@/lib/agent/runtime";
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

/** The generative-UI canvas: Polty places widgets here; newest first, animated reflow. */
export function Canvas() {
  const widgets = useGhost((s) => s.widgets);
  const ordered = useMemo(() => [...widgets].sort((a, b) => b.createdAt - a.createdAt), [widgets]);

  return (
    <LayoutGroup>
      <div className="mx-auto grid w-full max-w-[1400px] grid-flow-dense grid-cols-12 items-start gap-3 px-3 pb-[calc(var(--dock-h,232px)+40px)] pt-20 sm:gap-4 sm:px-6 lg:pl-40">
        <AnimatePresence mode="popLayout">
          {ordered.map((w) => (
            <WidgetSlot key={w.id} spec={w} />
          ))}
        </AnimatePresence>
      </div>
    </LayoutGroup>
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
