/**
 * 4rc.OS's icon, in the desktop's tile language: its dark surface as a rounded tile and a bold "4"
 * in the cyan accent. One drawing on a 32-unit grid serves the favicon (app/icon.ts), its PNG twin
 * (app/icon1.tsx) and the Apple touch icon (app/apple-icon.tsx). Browsers and home screens show it
 * outside the page, so it has one look and doesn't follow the theme.
 */
export const ICON_TILE = "#0e0e15";
export const ICON_INK = "#34e1ff";

/**
 * The "4": a stem, a bar, and a diagonal as thick as the stem joining their top-left corners. Every
 * edge of the stem and the bar sits on an even unit, so at 16px each lands on a whole pixel; only
 * the diagonal is anti-aliased.
 */
export const FOUR_PATH = "M18 6H22V26H18Z M6 18H24V22H6Z M18 6L6 18H11.66L18 11.66Z";

/** A quarter of the side, close to the desktop tiles' 12px on 44. Both favicons use it. */
export const TILE_RADIUS = 8;

export function faviconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="${TILE_RADIUS}" fill="${ICON_TILE}"/>` +
    `<path d="${FOUR_PATH}" fill="${ICON_INK}"/></svg>`
  );
}
