"use client";

import "@arcos/shell/styles/desktop.css";
import { DesktopShell } from "@arcos/shell";
import { APPS } from "@/apps/registry";

export default function Home() {
  return <DesktopShell apps={APPS} brand="ARC.os" aboutAppId="about" />;
}
