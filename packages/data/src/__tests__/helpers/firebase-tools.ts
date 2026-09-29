import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** tools/firebase: the Firebase CLI at one exact version, locked apart from the workspaces (see its package.json). */
const TOOLS = path.resolve(import.meta.dirname, "../../../../../tools/firebase");
const nodeRequire = createRequire(path.join(TOOLS, "package.json"));

/** Where the pinned firebase-tools is installed; throws with the install command when it is not. */
export function firebaseToolsDir(): string {
  const dir = path.join(TOOLS, "node_modules/firebase-tools");
  if (!existsSync(path.join(dir, "package.json"))) {
    throw new Error("firebase-tools is not installed in tools/firebase: run npm ci --ignore-scripts --prefix tools/firebase");
  }
  return dir;
}

/**
 * Loads a module from inside the pinned firebase-tools, so a test runs the very code `firebase deploy` runs. One of its
 * dependencies still loads Node's deprecated built-in punycode; that warning is theirs, so it is muted for the load only.
 */
function load<T>(id: string): T {
  firebaseToolsDir();
  const before = process.noDeprecation;
  process.noDeprecation = true;
  try {
    return nodeRequire(id) as T;
  } finally {
    process.noDeprecation = before;
  }
}

type ApiClient = {
  get(url: string): Promise<{ body: unknown }>;
  post(url: string, body: unknown): Promise<{ body: unknown }>;
  patch(url: string, body: unknown, options?: { queryParams?: Record<string, string> }): Promise<{ body: unknown }>;
  delete(url: string): Promise<{ body: unknown }>;
};
type FirestoreApiCtor = new () => {
  apiClient: ApiClient;
  upgradeOldSpec(spec: unknown): unknown;
  validateSpec(spec: unknown): void;
  deploy(options: unknown, indexes: unknown, fieldOverrides: unknown, databaseId: string): Promise<void>;
};

/** One request `firebase deploy` would send to the Firestore Admin API. */
export type DeployRequest = { method: string; url: string; body?: unknown; queryParams?: Record<string, string> };
type Validator = ((config: unknown) => boolean) & { errors?: unknown[] | null };

/** Throws firebase-tools' own error when the file is not a spec `firebase deploy` accepts (api.js deploy(): upgrade, then validate, before any request). */
export function validateIndexesSpec(spec: unknown): void {
  const { FirestoreApi } = load<{ FirestoreApi: FirestoreApiCtor }>("firebase-tools/lib/firestore/api");
  const api = new FirestoreApi();
  api.validateSpec(api.upgradeOldSpec(structuredClone(spec)));
}

/**
 * The requests firebase-tools' own index deploy (api.js deploy()) sends for `spec`, run offline against a recording
 * client standing in for a fresh database: no indexes and no field overrides yet, Standard edition. Nothing leaves the
 * process. `force` is on, so any delete it would make shows up here instead of waiting on a prompt.
 */
export async function deployRequests(spec: { indexes: unknown; fieldOverrides: unknown }, databaseId: string): Promise<DeployRequest[]> {
  const { FirestoreApi } = load<{ FirestoreApi: FirestoreApiCtor }>("firebase-tools/lib/firestore/api");
  const api = new FirestoreApi();
  const requests: DeployRequest[] = [];
  const record = (request: DeployRequest) => {
    requests.push(request);
    return Promise.resolve({ body: {} });
  };
  api.apiClient = {
    get: (url) => {
      requests.push({ method: "GET", url });
      return Promise.resolve({ body: url.endsWith(`/databases/${databaseId}`) ? { databaseEdition: "STANDARD" } : {} });
    },
    post: (url, body) => record({ method: "POST", url, body }),
    patch: (url, body, options) => record({ method: "PATCH", url, body, ...(options?.queryParams ? { queryParams: options.queryParams } : {}) }),
    delete: (url) => record({ method: "DELETE", url }),
  };
  const copy = structuredClone(spec);
  await api.deploy({ project: "demo-arcos", nonInteractive: true, force: true }, copy.indexes, copy.fieldOverrides, databaseId);
  return requests;
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
