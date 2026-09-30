"use client";

import "@arcos/shell/styles/desktop.css";
import "@arcos/shell/styles/desk.css";
import { activeNetwork } from "@arcos/chain";
import { DesktopShell } from "@arcos/shell";
import { APPS } from "@/apps/registry";
import { Web3Provider } from "@/providers/Web3Provider";
import { PulseChart } from "@/components/PulseChart";
import { StatusBar } from "@/components/StatusBar";
import { DESK_ITEMS } from "@/lib/desk-items";
import { quickActions } from "@/lib/quick-actions";
import { REPO_URL, networkBadge } from "@/lib/site";

export default function Home() {
  return (
    <Web3Provider>
      <DesktopShell
        apps={APPS}
        brand="4rc.OS"
        badge={networkBadge(activeNetwork())}
        aboutAppId="about"
        repoUrl={REPO_URL}
        deskItems={DESK_ITEMS}
        wallpaperSlot={<PulseChart />}
        statusSlot={<StatusBar />}
        quickActions={quickActions}
      />
    </Web3Provider>
  );
}
