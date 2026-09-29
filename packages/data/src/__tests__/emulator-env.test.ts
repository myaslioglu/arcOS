import { describe, expect, it } from "vitest";
import { assertEmulatorEnv } from "../__emulator__/emulator-env";

const ok = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8181", GCLOUD_PROJECT: "demo-arcos" };

describe("assertEmulatorEnv", () => {
  it("passes for an emulator on this machine under a demo project", () => {
    expect(() => assertEmulatorEnv(ok)).not.toThrow();
  });

  it("accepts localhost and the IPv6 loopback, and reads GOOGLE_CLOUD_PROJECT when GCLOUD_PROJECT is unset or empty", () => {
    expect(() => assertEmulatorEnv({ ...ok, FIRESTORE_EMULATOR_HOST: "localhost:8080" })).not.toThrow();
    expect(() => assertEmulatorEnv({ ...ok, FIRESTORE_EMULATOR_HOST: "[::1]:8080" })).not.toThrow();
    expect(() => assertEmulatorEnv({ FIRESTORE_EMULATOR_HOST: ok.FIRESTORE_EMULATOR_HOST, GOOGLE_CLOUD_PROJECT: "demo-arcos" })).not.toThrow();
    expect(() => assertEmulatorEnv({ ...ok, GCLOUD_PROJECT: "", GOOGLE_CLOUD_PROJECT: "demo-arcos" })).not.toThrow();
  });

  it("refuses to run with no emulator, because the Admin SDK would then reach a live project", () => {
    expect(() => assertEmulatorEnv({ GCLOUD_PROJECT: "demo-arcos" })).toThrow(/FIRESTORE_EMULATOR_HOST/);
    expect(() => assertEmulatorEnv({ ...ok, FIRESTORE_EMULATOR_HOST: "" })).toThrow(/FIRESTORE_EMULATOR_HOST/);
  });

  it("refuses an emulator host that is not on this machine", () => {
    for (const host of ["example.com:8080", "10.0.0.5:8080", "firestore.googleapis.com:443", "127.0.0.1.example.com:8080"]) {
      expect(() => assertEmulatorEnv({ ...ok, FIRESTORE_EMULATOR_HOST: host }), host).toThrow(/on this machine/);
    }
  });

  it("refuses any project id that is not a demo project, the live one included", () => {
    for (const project of ["arcos-c80cf", "demo", "Demo-arcos", "my-demo-arcos"]) {
      expect(() => assertEmulatorEnv({ ...ok, GCLOUD_PROJECT: project }), project).toThrow(/demo project/);
    }
    expect(() => assertEmulatorEnv({ FIRESTORE_EMULATOR_HOST: ok.FIRESTORE_EMULATOR_HOST })).toThrow(/demo project/);
  });
});
