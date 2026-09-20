"use client";

import "@arcos/shell/styles/desktop.css";
import { DesktopShell } from "@arcos/shell";
import { APPS } from "@/apps/registry";
import { Web3Provider } from "@/providers/Web3Provider";
import { StatusBar } from "@/components/StatusBar";
import { quickActions } from "@/lib/quick-actions";

export default function Home() {
  return (
    <Web3Provider>
      <DesktopShell apps={APPS} brand="ARC.os" aboutAppId="about" statusSlot={<StatusBar />} quickActions={quickActions} />
    </Web3Provider>
  );
}
