import { faviconSvg } from "@/lib/app-icon";

export const contentType = "image/svg+xml";

/** The favicon, as a vector so it stays crisp at 16px and at any screen density. */
export default function Icon() {
  return new Response(faviconSvg(), { headers: { "Content-Type": contentType } });
}
