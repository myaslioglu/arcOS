"use client";

/**
 * The wallpaper: the 56px grid under a soft mask, three glows in the signal hues, a film of noise, and whatever the
 * page draws over them (the live chart). Decorative, so hidden from assistive technology.
 */
export function Wallpaper({ children }: { children?: React.ReactNode }) {
  return (
    <div className="os-wallpaper" aria-hidden>
      <div className="os-wallpaper-grid" />
      <div className="os-wallpaper-glow" />
      <div className="os-wallpaper-noise" />
      {children}
    </div>
  );
}
