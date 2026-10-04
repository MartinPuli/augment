"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import ConnectorsGallery from "./ConnectorsGallery";
import { duration, ease } from "@/components/ui/motion";

/**
 * The Connectors modal. Its surface shares `layoutId="connectors-surface"` with the top bar's
 * Connectors button, so opening grows the button down into the modal (a sheet hanging from the top
 * on phones) and closing shrinks it back up. The content fades in only once the surface has landed, so
 * nothing is seen stretched mid-morph.
 *
 * Rendered through a portal into <body>: callers like the top bar are `pointer-events-none`
 * containers with their own stacking context, and the modal must inherit neither.
 */
const noop = () => () => {};

export default function ConnectorsPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  const client = useSyncExternalStore(noop, () => true, () => false);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  // Hand focus back to the button that opened us (only after an actual close).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const t = setTimeout(() => (document.querySelector('button[aria-label="Connectors"]') as HTMLButtonElement | null)?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [open]);

  if (!client) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <div key="connectors" className="fixed inset-0 z-[70] flex items-start justify-center p-2 pt-[max(8px,env(safe-area-inset-top))] sm:items-center sm:p-6">
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-scrim backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: duration.fast } }}
            transition={{ duration: duration.base, ease: ease.standard }}
            onClick={onClose}
          />
          <motion.section
            layoutId="connectors-surface"
            role="dialog"
            aria-modal
            aria-label="Connectors"
            style={{ borderRadius: 28 }}
            transition={{ type: "spring", stiffness: 340, damping: 34, mass: 0.9 }}
            className="relative flex h-[min(86dvh,760px)] w-full flex-col overflow-hidden bg-[rgb(247_246_242/0.94)] shadow-[0_0_0_1px_rgb(20_20_18/0.06),0_30px_80px_-24px_rgb(20_20_18/0.45)] backdrop-blur-2xl sm:h-[min(720px,calc(100dvh-48px))] sm:max-w-[780px]"
          >
            <motion.div
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.16, duration: duration.base, ease: ease.standard } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
            >
              <ConnectorsGallery compact onClose={onClose} />
            </motion.div>
          </motion.section>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
