"use client";

import { createContext, useContext } from "react";
import type { Registry } from "../core";

const RegistryContext = createContext<Registry | null>(null);

export const RegistryProvider = RegistryContext.Provider;

export function useRegistry(): Registry {
  const r = useContext(RegistryContext);
  if (!r) throw new Error("useRegistry must be used inside <DesktopShell>");
  return r;
}
