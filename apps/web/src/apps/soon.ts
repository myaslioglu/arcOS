import { Hourglass, Lock } from "lucide-react";
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
      "Will lock tokens or liquidity until a date you choose. Until then nobody can take them out, not even the owner.",
      "For a project showing buyers its liquidity can't be pulled, or a team locking its own tokens.",
      "It comes here once its contracts are audited. Until then, you can try it with test tokens on testnet.4rcos.com.",
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
      "Will pay tokens out little by little on a schedule you set, with an optional cliff: a wait before anything unlocks.",
      "For paying a teammate or an investor over months or years. They collect each part as it unlocks.",
      "It comes here once its contracts are audited. Until then, you can try it with test tokens on testnet.4rcos.com.",
    ],
  }),
];
