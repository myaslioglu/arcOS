import { ImageResponse } from "next/og";
import { FOUR_PATH, ICON_INK, ICON_TILE } from "@/lib/app-icon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The home-screen icon: the favicon's drawing on a full square, since iOS rounds the corners itself. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: ICON_TILE }}>
        <svg width={size.width} height={size.height} viewBox="0 0 32 32">
          <path d={FOUR_PATH} fill={ICON_INK} />
        </svg>
      </div>
    ),
    size,
  );
}
