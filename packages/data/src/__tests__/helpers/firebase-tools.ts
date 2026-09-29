import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/**
 * Loads a module from inside the pinned firebase-tools, so a test runs the very code `firebase deploy` runs. One of its
 * dependencies still loads Node's deprecated built-in punycode; that warning is theirs, so it is muted for the load only.
 */
function load<T>(id: string): T {
  const before = process.noDeprecation;
  process.noDeprecation = true;
  try {
    return nodeRequire(id) as T;
  } finally {
    process.noDeprecation = before;
  }
}

type FirestoreApiCtor = new () => { upgradeOldSpec(spec: unknown): unknown; validateSpec(spec: unknown): void };
type Validator = ((config: unknown) => boolean) & { errors?: unknown[] | null };

/** Throws firebase-tools' own error when the file is not a spec `firebase deploy` accepts (api.js deploy(): upgrade, then validate, before any request). */
export function validateIndexesSpec(spec: unknown): void {
  const { FirestoreApi } = load<{ FirestoreApi: FirestoreApiCtor }>("firebase-tools/lib/firestore/api");
  const api = new FirestoreApi();
  api.validateSpec(api.upgradeOldSpec(structuredClone(spec)));
}

/** The databases `firebase deploy --only <only>` reaches with this `firestore` block (fsConfig.js). */
export function databasesDeployedBy(firestore: unknown, only?: string): string[] {
  const { getFirestoreConfig } = load<{ getFirestoreConfig(projectId: string, options: unknown): { database: string }[] }>(
    "firebase-tools/lib/firestore/fsConfig",
  );
  return getFirestoreConfig("demo-arcos", { config: { src: { firestore } }, rc: {}, only }).map((entry) => entry.database);
}

/** What firebase-tools' own schema for firebase.json objects to; empty when it accepts the file. */
export function firebaseJsonProblems(config: unknown): string[] {
  const { getValidator, getErrorMessage } = load<{ getValidator(): Validator; getErrorMessage(error: unknown): string }>(
    "firebase-tools/lib/firebaseConfigValidate",
  );
  const validate = getValidator();
  return validate(config) ? [] : (validate.errors ?? []).map(getErrorMessage);
}
