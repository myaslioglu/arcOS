"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { Tone } from "./desktop-context";

export type Toast = { id: number; text: string; tone: Tone };

/** The desktop's notifications: a small stack under the menu bar, newest last. */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="os-toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="os-toast"
            data-tone={toast.tone}
          >
            <span className="os-toast-led" aria-hidden />
            <span>{toast.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
