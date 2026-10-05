import { describe, expect, it } from "vitest";
import { proExplorerApi, proLogsApi } from "../explorer-api";

const PRO = { url: "https://api.blockscout.com/5042/api/v2", apiKey: "proapi_k" };

describe("proExplorerApi", () => {
  it("is off without a key", () => {
    expect(proExplorerApi(5042, undefined)).toBeUndefined();
    expect(proExplorerApi(5042, "")).toBeUndefined();
    expect(proExplorerApi(5042, "  \n")).toBeUndefined();
  });

  // App Hosting refuses an empty value, so apphosting.testnet.yaml replaces the mainnet secret with the word `none`.
  it("is off when the key is the word none, the testnet site's setting", () => {
    expect(proExplorerApi(5042002, "none")).toBeUndefined();
    expect(proExplorerApi(5042002, " none \n")).toBeUndefined();
  });

  it("points at the chain's Blockscout PRO API, with the key trimmed", () => {
    expect(proExplorerApi(5042, " proapi_k \n")).toEqual(PRO);
    expect(proExplorerApi(5042002, "proapi_k")?.url).toBe("https://api.blockscout.com/5042002/api/v2");
  });
});

describe("proLogsApi", () => {
  it("is off without a key", () => {
    expect(proLogsApi(5042, undefined)).toBeUndefined();
    expect(proLogsApi(5042, "  \n")).toBeUndefined();
    expect(proLogsApi(5042002, "none")).toBeUndefined();
  });

  it("points at the logs module of the chain's Blockscout PRO API, with the key trimmed", () => {
    expect(proLogsApi(5042, " proapi_k \n")).toEqual({ url: "https://api.blockscout.com/5042/api", apiKey: "proapi_k" });
  });
});
