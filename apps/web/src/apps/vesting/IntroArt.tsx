/**
 * Vesting's picture beside its explainer: a schedule's release line, flat through the cliff, a step where the cliff
 * ends, then a steady climb to everything, with the beneficiary's coins gathering at the top. The same shape Curve.tsx
 * draws for a real schedule. In the current colour (the Trust group's hue, set by the explainer) over the theme's
 * surfaces, so it reads in both themes. Decorative: the explainer's words carry the meaning.
 */
export function VestingIntroArt() {
  return (
    <svg viewBox="0 0 96 76" className="h-auto w-full" aria-hidden focusable="false">
      <rect x="2" y="4" width="92" height="68" rx="8" className="fill-surface stroke-border-2" strokeWidth="1.5" />
      <line x1="12" y1="62" x2="86" y2="62" className="stroke-border-2" strokeWidth="1.5" />
      <line x1="12" y1="14" x2="12" y2="62" className="stroke-border-2" strokeWidth="1.5" />
      <line x1="34" y1="16" x2="34" y2="62" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
      <path d="M12 60H34V49L74 22H84" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M34 49L74 22V60H34Z" fill="currentColor" opacity="0.14" />
      <circle cx="84" cy="22" r="4.5" fill="currentColor" />
      <circle cx="78" cy="14.5" r="3.5" fill="currentColor" opacity="0.7" />
      <circle cx="87" cy="12" r="2.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
