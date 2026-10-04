"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import ConnectorsGallery from "./ConnectorsGallery";

/** Right-side slide-over glass panel hosting the connectors gallery. */
export default function ConnectorsPanel({ open, onClose }: { open: boolean; onClose(): void }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            key="scrim"
            className="fixed inset-0 z-[60] bg-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={onClose}
          />
          <motion.aside
            key="panel"
            role="dialog"
            aria-label="Connectors"
            className="ghost-glass fixed top-3 right-3 bottom-3 z-[70] flex w-[min(640px,calc(100vw-24px))] flex-col overflow-hidden rounded-card"
            initial={{ x: "105%" }}
            animate={{ x: 0 }}
            exit={{ x: "105%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            <button
              onClick={onClose}
              aria-label="Close connectors"
              className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full text-fg-3 hover:bg-tint hover:text-fg"
            >
              <X size={18} />
            </button>
            <ConnectorsGallery compact />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
