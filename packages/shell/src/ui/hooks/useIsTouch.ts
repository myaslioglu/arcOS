"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(hover: none)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True on devices without hover. False while prerendering, so markup matches. */
export function useIsTouch(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
