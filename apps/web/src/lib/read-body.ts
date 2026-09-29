/**
 * A request's body as text, or null when it is longer than `maxBytes`. The two public POST routes that take a body
 * (/api/csp-report and /api/event) read it through this, so neither ever holds more than the cap in memory.
 *
 * A `content-length` over the cap is refused without reading a byte. A body with none, or with a false one, is read as
 * a stream and given up on as soon as it passes the cap, so the caller never waits for the rest of a large upload.
 * Bytes are counted, not characters. A request with no body reads as "".
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length")?.trim();
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxBytes) return null;

  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
