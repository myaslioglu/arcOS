"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

const noop = () => () => {};

/**
 * Renders children into <body>.
 *
 * Full-screen overlays must escape their parent chain: an ancestor carrying a
 * `filter`, `transform`, `perspective`, `backdrop-filter` or `will-change`
 * becomes the containing block for `position: fixed`, so `inset-0` would size
 * the overlay to that ancestor instead of the viewport. Several wrappers on
 * this site animate `filter` via framer-motion, which is exactly that case.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  // false while prerendering and during the hydration pass, true afterwards —
  // so the client's first render still matches the exported HTML.
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );

  if (!hydrated) return null;
  return createPortal(children, document.body);
}
