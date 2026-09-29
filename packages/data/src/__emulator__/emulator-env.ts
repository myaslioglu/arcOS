const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The emulator suite must never reach a live project. It runs under `firebase emulators:exec`, which sets the emulator's
 * host and a demo project id; anything else (vitest run by hand, a shell that holds credentials) is refused before a
 * test starts.
 */
export function assertEmulatorEnv(env: Readonly<Record<string, string | undefined>>): void {
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Run this suite with `npm run test:emulator -w @arcos/data`: without the emulator the Admin SDK would talk to a live project.",
    );
  }
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  if (!hostname || !LOOPBACK.has(hostname)) {
    throw new Error("FIRESTORE_EMULATOR_HOST must be on this machine (127.0.0.1, localhost or [::1]).");
  }
  const project = env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT;
  if (!project?.startsWith("demo-")) {
    throw new Error('The emulator suite needs a demo project id ("demo-..."): pass --project demo-arcos to firebase emulators:exec.');
  }
}
