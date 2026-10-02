// The same guard as @arcos/data's emulator suite: outside `firebase emulators:exec`, on loopback and under a demo-
// project id, the run stops here, so the Admin SDK can never reach a live project with somebody's credentials.
import { assertEmulatorEnv } from "../../../packages/data/src/__emulator__/emulator-env";

assertEmulatorEnv(process.env);
// The suite runs against the named database arcos, whatever the shell says.
delete process.env.ARCOS_FIRESTORE_DATABASE;
