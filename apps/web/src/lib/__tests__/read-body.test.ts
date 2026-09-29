import { describe, expect, it } from "vitest";
import { readBodyCapped } from "../read-body";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://4rcos.test/api/x", { method: "POST", body, headers });

/**
 * A body that hands out `chunks` one at a time and counts how many were asked for. A high-water mark of 0 keeps the
 * stream from pulling ahead of its reader, so the count is what the reader asked for and nothing more.
 */
function chunkedRequest(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[pulled++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const req = new Request("https://4rcos.test/api/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { req, pulled: () => pulled };
}

describe("readBodyCapped", () => {
  it("returns the text of a body within the cap", async () => {
    expect(await readBodyCapped(post('{"a":1}'), 100)).toBe('{"a":1}');
  });

  it("returns an empty string when the request has no body", async () => {
    expect(await readBodyCapped(post(null), 100)).toBe("");
  });

  it("counts bytes, not characters: a body of exactly the cap passes and one byte more is refused", async () => {
    // "é" is two bytes, so 5 of them are 10 bytes in 5 characters.
    expect(await readBodyCapped(post("ééééé"), 10)).toBe("ééééé");
    expect(await readBodyCapped(post("ééééé!"), 10)).toBeNull();
  });

  it("refuses at once when content-length declares more than the cap, without reading the body", async () => {
    const { req, pulled } = chunkedRequest([new TextEncoder().encode("tiny")], { "content-length": "101" });
    expect(await readBodyCapped(req, 100)).toBeNull();
    expect(pulled()).toBe(0);
  });

  it("stops reading a body that has no content-length as soon as it passes the cap", async () => {
    const chunk = new Uint8Array(40).fill(97);
    const { req, pulled } = chunkedRequest([chunk, chunk, chunk, chunk, chunk, chunk]);
    expect(await readBodyCapped(req, 100)).toBeNull();
    // Two chunks are 80 bytes, the third makes 120: it stopped there, not after reading all six.
    expect(pulled()).toBe(3);
  });

  it("decodes a multi-byte character that arrives split across two chunks", async () => {
    const bytes = new TextEncoder().encode("a€b");
    const { req } = chunkedRequest([bytes.slice(0, 2), bytes.slice(2)]);
    expect(await readBodyCapped(req, 100)).toBe("a€b");
  });

  it("ignores a content-length that isn't a number, and still enforces the cap on the stream", async () => {
    expect(await readBodyCapped(post("ok", { "content-length": "abc" }), 100)).toBe("ok");
    expect(await readBodyCapped(post("x".repeat(101), { "content-length": "abc" }), 100)).toBeNull();
  });
});
