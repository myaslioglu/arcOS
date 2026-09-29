import { DATABASE_ENV } from "../names";
import { assertEmulatorEnv } from "./emulator-env";

// vitest runs this before every emulator test file. Outside `firebase emulators:exec` it stops the run right here.
assertEmulatorEnv(process.env);

// The suite proves the default database name, so an override left in the shell must not change what it proves.
delete process.env[DATABASE_ENV];
