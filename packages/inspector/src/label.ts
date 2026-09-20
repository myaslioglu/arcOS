/** Control, format (bidi overrides, zero-width), line and paragraph separator characters — used to spoof labels. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const WHITESPACE_RUN = /\s+/g;

/** Makes an on-chain name or symbol safe to display: no control, format (bidi, zero-width) or line characters; collapsed spaces; bounded length. */
export function cleanLabel(text: string | null | undefined, maxLength: number): string | null {
  if (typeof text !== "string") return null;
  const collapsed = text.replace(UNSAFE_CHARS, "").replace(WHITESPACE_RUN, " ").trim();
  if (collapsed.length === 0) return null;
  const truncated = [...collapsed].slice(0, maxLength).join("");
  return truncated.length === 0 ? null : truncated;
}
