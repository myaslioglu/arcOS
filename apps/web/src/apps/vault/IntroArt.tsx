/**
 * Vault's picture beside its explainer: a calendar with one day ringed, and a padlock in front of it. Drawn in the
 * current colour (the Trust group's hue, set by the explainer) over the theme's surfaces, so it reads in both themes.
 * Decorative: the explainer's words carry the meaning.
 */
export function VaultIntroArt() {
  return (
    <svg viewBox="0 0 96 76" className="h-auto w-full" aria-hidden focusable="false">
      <rect x="4" y="10" width="58" height="54" rx="7" className="fill-surface stroke-border-2" strokeWidth="1.5" />
      <path d="M4 17a7 7 0 0 1 7-7h44a7 7 0 0 1 7 7v7H4Z" fill="currentColor" opacity="0.28" />
      <line x1="18" y1="5" x2="18" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <line x1="48" y1="5" x2="48" y2="15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      {[0, 1, 2, 3].map((col) =>
        [0, 1, 2].map((row) => (
          <rect key={`${col}-${row}`} x={12 + col * 12} y={31 + row * 10} width="6" height="5" rx="1.5" className="fill-border-2" />
        )),
      )}
      <circle cx="39" cy="43.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M62 44v-7a11 11 0 0 1 22 0v7" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <rect x="54" y="42" width="38" height="31" rx="7" fill="currentColor" />
      <circle cx="73" cy="54" r="4" className="fill-surface" />
      <rect x="71.5" y="55" width="3" height="9" rx="1.5" className="fill-surface" />
    </svg>
  );
}
