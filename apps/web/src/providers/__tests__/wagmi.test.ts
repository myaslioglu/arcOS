import { describe, expect, it } from "vitest";
import { visibleConnectors } from "../wagmi";

type FakeConnector = { id: string; name: string };

const generic: FakeConnector = { id: "injected", name: "Injected" };
const metamask: FakeConnector = { id: "io.metamask", name: "MetaMask" };
const rabby: FakeConnector = { id: "io.rabby", name: "Rabby Wallet" };

describe("visibleConnectors", () => {
  it("hides the generic injected() connector once a real wallet is discovered", () => {
    expect(visibleConnectors([generic, metamask], true)).toEqual([metamask]);
  });

  it("hides the generic connector even when no window.ethereum flag is passed, as long as a wallet was discovered", () => {
    expect(visibleConnectors([generic, metamask], false)).toEqual([metamask]);
  });

  it("keeps every discovered wallet when more than one is installed", () => {
    expect(visibleConnectors([generic, metamask, rabby], true)).toEqual([metamask, rabby]);
  });

  it("falls back to the generic connector when nothing was discovered but a provider exists", () => {
    expect(visibleConnectors([generic], true)).toEqual([generic]);
  });

  it("returns an empty list when nothing was discovered and there is no injected provider", () => {
    expect(visibleConnectors([generic], false)).toEqual([]);
  });

  it("returns an empty list for an empty connector list regardless of the provider flag", () => {
    expect(visibleConnectors([], true)).toEqual([]);
    expect(visibleConnectors([], false)).toEqual([]);
  });
});
