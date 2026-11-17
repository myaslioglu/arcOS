import type { LucideIcon } from "lucide-react";

/**
 * Help's pictures: a small desktop beside "What is ArcOS?", and an icon on a tile in a given hue for each step and tip.
 * Inline and drawn from the theme's tokens, so they need no image file and read in both themes. Decorative: the words
 * beside them carry the meaning.
 */

/** A small ArcOS desktop: the menu bar, three folders, an open window, a USDC coin and the dock. */
export function DesktopArt() {
  return (
    <svg viewBox="0 0 200 124" className="h-auto w-full" aria-hidden focusable="false">
      <rect x="1.5" y="1.5" width="197" height="121" rx="12" className="fill-bg-2 stroke-border-2" strokeWidth="1.5" />
      <path d="M13.5 1.5h173a12 12 0 0 1 12 12V15H1.5v-1.5a12 12 0 0 1 12-12Z" className="fill-surface-2" />
      <circle cx="12" cy="8.5" r="2.5" className="fill-accent" />
      <rect x="19" y="7" width="18" height="3" rx="1.5" className="fill-border-2" />
      <rect x="164" y="7" width="24" height="3" rx="1.5" className="fill-border-2" />
      {[
        { y: 24, hue: "fill-accent-2 stroke-accent-2" },
        { y: 50, hue: "fill-accent-3 stroke-accent-3" },
        { y: 76, hue: "fill-accent stroke-accent" },
      ].map(({ y, hue }) => (
        <g key={y} className={hue}>
          <path d={`M12 ${y + 3}a3 3 0 0 1 3-3h7l3 3h10a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3Z`} fillOpacity="0.3" strokeWidth="1.2" />
        </g>
      ))}
      <rect x="56" y="24" width="100" height="70" rx="8" className="fill-surface stroke-border-2" strokeWidth="1.5" />
      <line x1="56" y1="36" x2="156" y2="36" className="stroke-border" strokeWidth="1.2" />
      <circle cx="64" cy="30" r="2.5" className="fill-accent-2" />
      <rect x="70" y="28.5" width="30" height="3" rx="1.5" className="fill-border-2" />
      <rect x="64" y="44" width="62" height="4" rx="2" className="fill-border-2" />
      <rect x="64" y="53" width="80" height="4" rx="2" className="fill-border-2" />
      <rect x="64" y="62" width="48" height="4" rx="2" className="fill-border-2" />
      <rect x="64" y="74" width="34" height="12" rx="4" className="fill-accent" fillOpacity="0.85" />
      <circle cx="172" cy="68" r="15" className="fill-accent stroke-accent" fillOpacity="0.16" strokeWidth="1.8" />
      <text x="172" y="74" textAnchor="middle" fontSize="17" fontWeight="700" className="fill-accent">
        $
      </text>
      <rect x="64" y="102" width="72" height="14" rx="6" className="fill-surface-2 stroke-border" strokeWidth="1" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={70 + i * 16} y="105" width="10" height="8" rx="2.5" className={["fill-accent", "fill-accent-2", "fill-accent-3", "fill-border-2"][i]} />
      ))}
    </svg>
  );
}

/** An icon on the desktop's tile (desktop.css's .os-icon-tile) in `hue`, with a step number in its corner when given. */
export function IconTile({ icon: Icon, hue, step, small = false }: { icon: LucideIcon; hue: string; step?: number; small?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" aria-hidden>
      <span className={small ? "os-icon-tile os-icon-tile--sm" : "os-icon-tile"} style={{ "--os-hue": hue } as React.CSSProperties}>
        <Icon size={small ? 17 : 22} />
      </span>
      {step !== undefined && (
        <span className="absolute -top-1.5 -left-1.5 grid h-5 w-5 place-items-center rounded-full border border-surface bg-fg font-mono text-[11px] font-semibold text-bg">
          {step}
        </span>
      )}
    </span>
  );
}
