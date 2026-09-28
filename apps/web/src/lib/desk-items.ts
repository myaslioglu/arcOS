import { Code, FileText, Globe } from "lucide-react";
import { activeChain } from "@arcos/chain";
import { ROADMAP_APP_ID, type DeskItem } from "@arcos/shell/core";
import { REPO_URL } from "./site";

/**
 * The desktop's items, down the desk's last column: two text files that open windows, and two links out. A link with
 * an empty URL is left off rather than pointing nowhere (site.ts's rule for REPO_URL).
 */
export function deskItems(
  repoUrl: string = REPO_URL,
  explorer: string = activeChain().blockExplorers?.default.url ?? "",
): DeskItem[] {
  const items: DeskItem[] = [
    {
      id: "readme",
      label: "readme.txt",
      blurb: "What 4rc.OS is",
      art: "file",
      ext: "TXT",
      icon: FileText,
      hue: "var(--muted)",
      action: { kind: "app", appId: "about" },
    },
    {
      id: "roadmap",
      label: "roadmap.txt",
      blurb: "The apps on the way",
      art: "file",
      ext: "TXT",
      icon: FileText,
      hue: "var(--accent-3)",
      action: { kind: "app", appId: ROADMAP_APP_ID },
    },
  ];
  if (repoUrl) {
    items.push({
      id: "github",
      label: "GitHub",
      blurb: "The source code",
      art: "link",
      icon: Code,
      hue: "var(--muted)",
      action: { kind: "href", href: repoUrl },
    });
  }
  if (explorer) {
    items.push({
      id: "explorer",
      label: "Explorer",
      blurb: "The network's block explorer",
      art: "link",
      icon: Globe,
      hue: "var(--accent)",
      action: { kind: "href", href: explorer },
    });
  }
  return items;
}

/** This deployment's desk: its repository, and its network's explorer. */
export const DESK_ITEMS: DeskItem[] = deskItems();
