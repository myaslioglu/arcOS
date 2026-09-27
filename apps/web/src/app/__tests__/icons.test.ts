import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { isMetadataRouteFile } from "next/dist/lib/metadata/is-metadata-route";
import AppleIcon, * as appleIcon from "@/app/apple-icon";
import Icon, * as icon from "@/app/icon";
import IconPng, * as iconPng from "@/app/icon1";
import { faviconSvg } from "@/lib/app-icon";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Just enough of a PNG decoder for what ImageResponse writes (8-bit RGBA): the size, then any pixel. */
function decodePng(bytes: Uint8Array) {
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([bytes[at + 16], bytes[at + 17]], "8-bit RGBA").toEqual([8, 6]);
    }
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 0xff;
    }
  }
  const hex = (x: number, y: number) => {
    const [r, g, b, alpha] = px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
    return alpha === 0 ? "transparent" : `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}${alpha === 255 ? "" : `/${alpha}`}`;
  };
  return { width, height, hex };
}

const png = async (res: Response) => decodePng(new Uint8Array(await res.arrayBuffer()));

describe("the app icons", () => {
  it("are named so Next links all three in <head>: the SVG favicon, its PNG twin and the Apple icon", () => {
    const files = readdirSync(APP_DIR).filter((f) => f.includes("icon")).sort();
    expect(files).toEqual(["apple-icon.tsx", "icon.ts", "icon1.tsx"]);
    for (const f of files) expect(isMetadataRouteFile(`/${f}`, ["tsx", "ts", "jsx", "js"], true), f).toBe(true);
  });

  it("serves the favicon as the SVG drawing", async () => {
    expect(icon.contentType).toBe("image/svg+xml");
    const res = Icon();
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toBe(faviconSvg());
  });

  // Safari 18 and older show no SVG favicon; this is the one they use.
  it("serves the same drawing as a 32px PNG, rounded like the SVG", async () => {
    expect(iconPng.size).toEqual({ width: 32, height: 32 });
    expect(iconPng.contentType).toBe("image/png");
    const image = await png(IconPng());
    expect([image.width, image.height]).toEqual([32, 32]);
    expect(image.hex(0, 0), "a rounded corner").toBe("transparent");
    expect(image.hex(0, 16), "the tile").toBe("#0e0e15");
    expect(image.hex(19, 16), "the 4's stem").toBe("#34e1ff");
    expect(image.hex(15, 16), "the 4's open counter").toBe("#0e0e15");
  });

  it("serves the Apple icon as a 180px PNG on a full square, for iOS to round", async () => {
    expect(appleIcon.size).toEqual({ width: 180, height: 180 });
    const image = await png(AppleIcon());
    expect([image.width, image.height]).toEqual([180, 180]);
    expect(image.hex(0, 0), "a square corner").toBe("#0e0e15");
    expect(image.hex(112, 90), "the 4's stem").toBe("#34e1ff");
  });
});
