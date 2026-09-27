import { ImageResponse } from "next/og";
import { FOUR_PATH, ICON_INK, ICON_TILE, TILE_RADIUS } from "@/lib/app-icon";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** The favicon as a PNG, for browsers that show no SVG favicon (Safari 18 and older). */
export default function IconPng() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: ICON_TILE, borderRadius: TILE_RADIUS }}>
        <svg width={size.width} height={size.height} viewBox="0 0 32 32">
          <path d={FOUR_PATH} fill={ICON_INK} />
        </svg>
      </div>
    ),
    size,
  );
}
