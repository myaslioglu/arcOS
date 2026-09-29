import { Hourglass, Lock, Radar, ShieldCheck } from "lucide-react";
import type { AppManifest } from "@arcos/shell";

type Soon = Pick<AppManifest, "id" | "name" | "blurb" | "icon" | "category" | "release"> & {
  /** Two or three sentences on what it will do, in the future tense: the app isn't live yet. */
  details: string[];
};

/**
 * A grey app: listed everywhere, and opening a small "work in progress" window with its `details` and its stage (from
 * `release`) until it ships. When it ships it moves to its own folder and loses `comingSoon`; its window and its
 * Roadmap row go with it.
 */
const soon = (m: Soon): AppManifest => ({
  ...m,
  window: { w: 480, h: 420 },
  load: async () => ({ default: () => null }),
  requiresWallet: false,
  comingSoon: true,
});

export const SOON: AppManifest[] = [
  soon({
    id: "vault",
    name: "Vault",
    blurb: "Lock liquidity and team tokens",
    icon: Lock,
    category: "trust",
    release: "r2",
    details: [
      "Will lock liquidity pool tokens or team tokens until a date you choose.",
      "Inspector will count tokens held in it as locked.",
      "Needs its own contracts and an audit first.",
    ],
  }),
  soon({
    id: "vesting",
    name: "Vesting",
    blurb: "Release tokens on a schedule",
    icon: Hourglass,
    category: "trust",
    release: "r2",
    details: [
      "Will release tokens to each recipient on a schedule, with an optional cliff.",
      "Recipients will claim what has vested from their own wallets.",
      "Needs its own contracts and an audit first.",
    ],
  }),
  soon({
    id: "watchdog",
    name: "Watchdog",
    blurb: "Alerts when a token you hold changes",
    icon: ShieldCheck,
    category: "trust",
    release: "r1",
    details: [
      "Will watch the tokens you hold for changes to their owner, supply or code.",
      "Will alert you when one of them changes.",
      "Needs a server that watches the chain and sends the alerts.",
    ],
  }),
  soon({
    id: "radar",
    name: "Radar",
    blurb: "New tokens, each with Inspector's checks",
    icon: Radar,
    category: "trade",
    release: "r1",
    details: [
      "Will list new tokens and locks on Arc as they appear.",
      "Will run Inspector's checks on each new token: evidence, never a score.",
      "Needs an index of new tokens first.",
    ],
  }),
];
