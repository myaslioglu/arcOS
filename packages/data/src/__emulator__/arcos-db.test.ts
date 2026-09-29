import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import {
  COLLECTIONS,
  DATABASE_ID,
  TTL_MS,
  isExpired,
  poolFromDoc,
  poolId,
  poolToDoc,
  type LinkCodeDoc,
  type PoolDoc,
  type PoolRecord,
} from "../index";
import { arcosDb } from "../server";

// The setup file (require-emulator.ts) has already refused to run outside the emulator, so both of these are set.
const host = process.env.FIRESTORE_EMULATOR_HOST as string;
const project = (process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT) as string;

/** The emulator's own admin token: a request carrying it skips the security rules, as the Admin SDK's requests do. */
const OWNER = { authorization: "Bearer owner" };

type RestDoc = { fields: Record<string, { stringValue: string }> };
const restUrl = (database: string, docPath: string) =>
  `http://${host}/v1/projects/${project}/databases/${encodeURIComponent(database)}/documents/${docPath}`;

let sequence = 0;
const unique = (label: string) => `${label}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

// A second Admin app, only to reach the (default) database, which arcosDb() must never touch.
const sideApp = initializeApp({ projectId: project }, "emulator-suite-default");
const defaultDb = getFirestore(sideApp);

afterAll(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe("arcosDb()", () => {
  it("is bound to the named database arcos, and is one handle for the whole process", () => {
    const db = arcosDb();
    expect(db.databaseId).toBe(DATABASE_ID);
    expect(arcosDb()).toBe(db);
    expect(defaultDb.databaseId).toBe("(default)");
  });

  it("writes and reads in arcos, and the same doc id in (default) stays untouched", async () => {
    const docPath = `${COLLECTIONS.users}/${unique("isolation")}`;
    await defaultDb.doc(docPath).set({ store: "default" });

    await arcosDb().doc(docPath).set({ store: "arcos" });

    expect((await arcosDb().doc(docPath).get()).data()).toEqual({ store: "arcos" });
    expect((await defaultDb.doc(docPath).get()).data()).toEqual({ store: "default" });

    // The same two facts through the emulator's REST API, which does not depend on how the SDK routes a request.
    const inArcos = await fetch(restUrl(DATABASE_ID, docPath), { headers: OWNER });
    const inDefault = await fetch(restUrl("(default)", docPath), { headers: OWNER });
    expect(((await inArcos.json()) as RestDoc).fields.store?.stringValue).toBe("arcos");
    expect(((await inDefault.json()) as RestDoc).fields.store?.stringValue).toBe("default");
  });

  it("leaves (default) without a doc that only arcos has", async () => {
    const docPath = `${COLLECTIONS.users}/${unique("only-arcos")}`;
    await arcosDb().doc(docPath).set({ only: "arcos" });

    expect((await defaultDb.doc(docPath).get()).exists).toBe(false);
    expect((await fetch(restUrl("(default)", docPath), { headers: OWNER })).status).toBe(404);
    expect((await fetch(restUrl(DATABASE_ID, docPath), { headers: OWNER })).status).toBe(200);
  });

  it("round-trips a TTL-shaped doc: expiresAt comes back a Timestamp, to the millisecond", async () => {
    const now = new Date("2026-09-29T12:00:00.123Z");
    const written: LinkCodeDoc = {
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      expiresAt: Timestamp.fromDate(new Date(now.getTime() + TTL_MS.linkCodes)),
    };
    const ref = arcosDb().collection(COLLECTIONS.linkCodes).doc(unique("ttl"));
    await ref.set(written);

    const read = (await ref.get()).data() as LinkCodeDoc;
    expect(read.expiresAt).toBeInstanceOf(Timestamp);
    expect((read.expiresAt as Timestamp).isEqual(written.expiresAt as Timestamp)).toBe(true);
    expect(read.expiresAt.toDate().toISOString()).toBe("2026-09-29T12:10:00.123Z");

    // The emulator runs no TTL sweep, and production deletes within about a day: code checks expiry itself.
    expect(isExpired(read.expiresAt, now)).toBe(false);
    expect(isExpired(read.expiresAt, new Date(now.getTime() + TTL_MS.linkCodes))).toBe(true);
  });

  it("stores amounts as decimal strings, so a value beyond 2^53 comes back exact", async () => {
    const pool: PoolRecord = {
      network: "mainnet",
      poolId: `0x${"ab".repeat(32)}`,
      version: "v4",
      token: "0xabcdef0123456789abcdef0123456789abcdef01",
      quote: "USDC-native",
      fee: 500,
      createdBlock: 23_400_000,
      key: {
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: "0x3600000000000000000000000000000000000000",
        fee: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
      },
      depthUsdc: 123_456_789_012_345_678_901_234n,
      sampledAt: Timestamp.fromDate(new Date("2026-09-29T12:00:00.500Z")),
    };
    const ref = arcosDb().collection(COLLECTIONS.pools).doc(poolId(pool.network, pool.poolId));
    await ref.set(poolToDoc(pool));

    const snap = await ref.get();
    expect(snap.get("depthUsdc")).toBe("123456789012345678901234");
    expect(poolFromDoc(snap.data() as PoolDoc)).toEqual(pool);
  });
});

describe("firestore/arcos.rules, as the emulator loaded them", () => {
  it("refuses a client's read and write in arcos, while the owner token gets through", async () => {
    const docPath = `${COLLECTIONS.users}/${unique("rules")}`;
    await arcosDb().doc(docPath).set({ note: "written by the Admin SDK" });

    expect((await fetch(restUrl(DATABASE_ID, docPath))).status).toBe(403);
    const write = await fetch(restUrl(DATABASE_ID, docPath), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { note: { stringValue: "written by a client" } } }),
    });
    expect(write.status).toBe(403);
    expect((await fetch(restUrl(DATABASE_ID, docPath), { headers: OWNER })).status).toBe(200);
    expect((await arcosDb().doc(docPath).get()).get("note")).toBe("written by the Admin SDK");
  });
});
