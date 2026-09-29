import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EMBEDDED_FRAME_MESSAGE } from "@/lib/wallet-frame";
import { ConnectError } from "../ConnectError";

const TRUST_WALLET_TEXT =
  "Request blocked: embedded frames are not allowed for this origin. For your security, 4rcos.com can't make this request from an embedded frame.";

// renderToStaticMarkup escapes the apostrophe in "couldn't".
const render = (error: unknown) => renderToStaticMarkup(createElement(ConnectError, { error })).replaceAll("&#x27;", "'");

describe("the Wallet window's connect error", () => {
  it("offers a reload when the wallet took the page for an embedded frame", () => {
    const html = render({ code: 4100, message: TRUST_WALLET_TEXT });
    expect(html).toContain(EMBEDDED_FRAME_MESSAGE);
    expect(html).toMatch(/<button[^>]*>Reload page<\/button>/);
    expect(html).not.toContain("For your security");
  });

  it("offers no reload for any other failure", () => {
    const html = render({ code: -32603, message: "Internal error" });
    expect(html).toContain("Your wallet couldn't connect. Try again.");
    expect(html).not.toContain("Reload page");
  });

  it("gives the reload button a comfortable target", () => {
    const html = render({ code: 4100, message: TRUST_WALLET_TEXT });
    expect(html).toMatch(/<button[^>]*class="[^"]*min-h-8[^"]*pointer-coarse:min-h-11/);
  });
});
