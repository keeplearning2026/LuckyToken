import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeDiagnosticsStoreFactory,
  parseRuntimeDiagnosticsConfiguration,
  type RuntimeDiagnosticRecord,
} from "../../src/runtime-diagnostics/index.js";

/**
 * Ticket 07 public seam: the permanent diagnostics store. Every credential
 * literal below is an independent canary that must never appear in any
 * persisted byte (database or WAL) nor in any committed record.
 */
const CANARIES = [
  "canary-bearer-token-7f3a9c21",
  "Canary-Bearer-Token-9b2e4d80",
  "canary-x-api-key-4c8f1a62",
  "canary-cookie-value-6d1b7e93",
  "canary-proxy-auth-8a5c2f74",
  "canary-set-cookie-3e9d0b55",
  "canary-pi-api-key-2f7c4a18",
  "canary-oauth-access-token-5a8b3d96",
  "canary-oauth-refresh-token-c1e2f3a4",
  "canary-query-secret-b7d8e9f0",
  "canary-lt-client-token-1a2b3c4d",
  "canary-nested-form-password-9f8e7d6c",
  "canary-error-message-5c4b3a29",
  "canary-import-error-8d7c6b5a",
  "canary-oversize-value-1f2e3d4c",
] as const;

function allPersistedBytes(root: string): Promise<string> {
  return readdir(root, { recursive: true }).then((entries) =>
    Promise.all(
      entries
        .filter((entry) => typeof entry === "string")
        .map((entry) => join(root, entry))
        .map(async (path) => {
          try {
            return await readFile(path, "utf8");
          } catch {
            return "";
          }
        }),
    ).then((chunks) => chunks.join("\n")),
  );
}

describe("Runtime Diagnostics store public seam", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function fixture(overrides: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-diagnostics-store-"));
    roots.push(root);
    const configuration = parseRuntimeDiagnosticsConfiguration(
      { directory: "state/diagnostics", ...overrides },
      root,
    );
    return { root, configuration };
  }

  /**
   * Pattern-only store factory: an identity scrubber represents "no
   * credential owners". Known-value scrub behavior is covered by the
   * dedicated scrub/fail-closed tests.
   */
  function patternStoreFactory(options: {
    configuration: { directory: string };
    now?: () => number;
  }) {
    return createRuntimeDiagnosticsStoreFactory({
      ...options,
      scrub: (value: string) => value,
    });
  }

  it("persists ordered records across a simulated restart without aging", async () => {
    const { configuration } = await fixture();
    const factory = patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    });
    const first = await factory.open();
    const appended: RuntimeDiagnosticRecord[] = [];
    appended.push(
      first.append({
        level: "info",
        text: "gateway listening on 127.0.0.1:3000",
      }),
    );
    appended.push(
      first.append({
        level: "error",
        text: "upstream request failed",
        requestId: "correl-0001",
        details: { stage: "fetch" },
      }),
    );
    appended.push(
      first.append({
        level: "critical",
        text: "credential store lock compromised",
      }),
    );
    first.close();

    const second = await factory.open();
    const query = second.query(undefined);
    expect(query.records).toEqual(appended.map((record) => ({ ...record })));
    expect(query.records.map((record) => record.level)).toEqual([
      "info",
      "error",
      "critical",
    ]);
    expect(query.records.map((record) => record.time)).toEqual([
      1_700_000_000_000,
      1_700_000_000_000,
      1_700_000_000_000,
    ]);
    expect(query.hasMore).toBe(false);
    second.close();
  });

  it("applies one recursive redaction choke point to every credential class before commit", async () => {
    const { configuration } = await fixture();
    const factory = patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    });
    const store = await factory.open();
    const record = store.append({
      level: "warning",
      text: `request failed: Authorization: Bearer ${CANARIES[0]} and ${CANARIES[1]}`,
      requestId: "correl-0002",
      details: {
        headers: {
          authorization: `Bearer ${CANARIES[0]}`,
          "x-api-key": CANARIES[2],
          cookie: CANARIES[3],
          "proxy-authorization": `Basic ${CANARIES[4]}`,
          "set-cookie": [CANARIES[5]],
          "content-type": "application/json",
        },
        nested: {
          credential: { api_key: CANARIES[6], access: CANARIES[7], refresh: CANARIES[8] },
        },
        query: { apiKey: CANARIES[9], password: CANARIES[10] },
        forms: [{ name: "lt_client_token", value: CANARIES[11] }],
      },
      error: new Error(`${CANARIES[12]} cause ${CANARIES[0]}`),
    });

    const text = JSON.stringify(record);
    for (const canary of CANARIES) expect(text).not.toContain(canary);
    expect(record.text).toContain("[REDACTED]");
    expect(record.text).not.toContain("Bearer");
    expect(record.details).toBeDefined();
    const details = JSON.stringify(record.details);
    // Benign adjacent data must survive the redaction choke point.
    expect(details).toContain("application/json");
    expect(JSON.stringify(record.errors)).not.toContain(CANARIES[12]);

    // The WAL is checkpointed on close, so persisted bytes are scanned only
    // after the store is fully closed.
    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    for (const canary of CANARIES) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain("request failed");
    expect(persisted).toContain("correl-0002");
  });

  it("preserves benign adjacent data while redacting header names and schemes", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const record = store.append({
      level: "info",
      text: "provider responded ok",
      details: {
        headers: {
          "x-request-id": "req-12345",
          Authorization: "Bearer canary-bearer-header-77aa88bb",
          "X-Api-Key": "canary-mixed-header-11cc22dd",
        },
      },
    });

    expect(JSON.stringify(record)).not.toContain("canary-bearer-header-77aa88bb");
    expect(JSON.stringify(record)).not.toContain("canary-mixed-header-11cc22dd");
    expect(JSON.stringify(record)).toContain("req-12345");
    const details = record.details as Record<string, unknown>;
    const headers = details.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe("[REDACTED]");
    expect(headers["X-Api-Key"]).toBe("[REDACTED]");
    expect(headers["x-request-id"]).toBe("req-12345");
    store.close();
  });

  it("never lets a credential-shaped requestId reach records, CP, or persisted bytes", async () => {
    const { configuration } = await fixture();
    const factory = patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    });
    const store = await factory.open();
    const credentialRequestId = "canary-reqid-bearer-9f8e7d6c";
    const record = store.append({
      level: "error",
      text: "request failed",
      requestId: `Bearer ${credentialRequestId}`,
      details: { stage: "fetch" },
    });

    // The producer requestId is untrusted: a credential-shaped value must be
    // omitted (or sanitized), never persisted verbatim.
    expect(record.requestId).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(credentialRequestId);
    expect(JSON.stringify(record)).not.toContain("Bearer");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    expect(persisted).not.toContain(credentialRequestId);
    expect(persisted).not.toContain("Bearer");
  });

  it("recognizes header name/value records and tuples at any nesting, redacting secret values of any type", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const canaries = {
      cookieTuple: "canary-header-cookie-11aa22bb",
      setCookieArray: "canary-header-setcookie-33cc44dd",
      bareTuple: "canary-header-bare-55ee66ff",
      nestedRecord: "canary-header-nested-77aa88bb",
    };
    const record = store.append({
      level: "warning",
      text: "header structures",
      details: {
        http: {
          cookie: ["session", canaries.cookieTuple],
          "set-cookie": ["sid", [canaries.setCookieArray]],
          authorization: ["Bearer", "canary-header-authz-99001122"],
          "x-request-id": ["req-42"],
          nested: {
            inner: { name: "X-Api-Key", value: canaries.nestedRecord },
          },
          plain: { name: "x-session-id", value: "session-ok" },
        },
      },
    });

    const serialized = JSON.stringify(record);
    for (const canary of Object.values(canaries)) {
      expect(serialized).not.toContain(canary);
    }
    const details = record.details as Record<string, unknown>;
    const http = details.http as Record<string, unknown>;
    expect(JSON.stringify(http.cookie)).not.toContain(canaries.cookieTuple);
    expect(JSON.stringify(http["set-cookie"])).not.toContain(canaries.setCookieArray);
    expect(JSON.stringify(http.authorization)).not.toContain("canary-header-authz-99001122");
    expect(JSON.stringify(http["x-request-id"])).toContain("req-42");
    expect(JSON.stringify(http.plain)).toContain("session-ok");
    expect(JSON.stringify(http.nested)).not.toContain(canaries.nestedRecord);

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    for (const canary of Object.values(canaries)) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain("req-42");
  });

  it("redacts Headers.entries array-of-pairs shapes under any key at any nesting", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const secretCanaries = {
      cookiePair: "canary-pairs-cookie-aaaa1111",
      authorizationPair: "canary-pairs-authz-bbbb2222",
      setCookiePair: "canary-pairs-setcookie-cccc3333",
      mixedCase: "canary-pairs-mixed-dddd4444",
      objectValue: "canary-pairs-object-eeee5555",
      arrayValue: "canary-pairs-array-8888",
      bareTuple: "canary-header-bare-55ee66ff",
    };
    const benign = "req-benign-7777";
    const record = store.append({
      level: "warning",
      text: "headers array-of-pairs",
      details: {
        headers: [
          ["cookie", secretCanaries.cookiePair],
          ["Authorization", `Bearer ${secretCanaries.authorizationPair}`],
        ],
        requestHeaders: [
          ["set-cookie", secretCanaries.setCookiePair],
          ["Set-Cookie", { value: secretCanaries.objectValue }],
          ["X-Api-Key", ["nested", secretCanaries.arrayValue]],
          ["X-Request-Id", benign],
        ],
        nested: {
          deep: [
            ["cookie", secretCanaries.bareTuple],
            ["x-request-id", "keep-me-9999"],
          ],
        },
      },
    });

    const serialized = JSON.stringify(record);
    for (const canary of Object.values(secretCanaries)) {
      expect(serialized).not.toContain(canary);
    }
    const details = record.details as Record<string, unknown>;
    const headers = details.headers as unknown[];
    expect(JSON.stringify(headers)).toContain('"cookie"');
    expect(JSON.stringify(headers)).toContain("[REDACTED]");
    const requestHeaders = details.requestHeaders as unknown[];
    expect(JSON.stringify(requestHeaders)).toContain('"set-cookie"');
    expect(JSON.stringify(requestHeaders)).toContain("[REDACTED]");
    // Benign header pairs survive with their values.
    expect(JSON.stringify(details.nested)).toContain("keep-me-9999");
    expect(JSON.stringify(details.requestHeaders)).toContain("req-benign-7777");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    for (const canary of Object.values(secretCanaries)) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain("keep-me-9999");
    expect(persisted).toContain("req-benign-7777");
  });

  it("redacts secret pairs inside mixed header arrays without all-or-nothing classification", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const secretCanaries = {
      cookieJunk: "canary-mixed-cookie-aaa111",
      authzFirst: "canary-mixed-authz-bbb222",
      setCookieObj: "canary-mixed-setcookie-ccc333",
      nestedNull: "canary-mixed-nested-ddd444",
      nestedObj: "canary-mixed-nestedobj-eee555",
      mixedCaseObj: "canary-mixed-obj-fff666",
      arrayValue: "canary-mixed-array-ggg777",
      bareTuple: "canary-header-bare-55ee66ff",
    };
    const benign = "req-mixed-benign-8888";
    const record = store.append({
      level: "warning",
      text: "mixed header arrays",
      details: {
        headers: [
          ["cookie", secretCanaries.cookieJunk],
          "junk",
        ],
        headersFirstJunk: [
          "junk-first",
          ["Authorization", `Bearer ${secretCanaries.authzFirst}`],
        ],
        requestHeaders: [
          ["set-cookie", secretCanaries.setCookieObj],
          { name: "x" },
        ],
        nested: {
          deep: [
            ["cookie", secretCanaries.nestedNull],
            null,
            { name: "Cookie", value: secretCanaries.nestedObj },
            ["X-Api-Key", ["nested", secretCanaries.arrayValue]],
            ["x-request-id", benign],
          ],
        },
        coordinates: [
          [12.34, 56.78],
          [-1.5, 2.5],
        ],
      },
    });

    const serialized = JSON.stringify(record);
    for (const canary of Object.values(secretCanaries)) {
      expect(serialized).not.toContain(canary);
    }
    // Benign and ordinary semantic pairs survive.
    expect(serialized).toContain("req-mixed-benign-8888");
    expect(serialized).toContain("[12.34,56.78]");
    expect(serialized).toContain("junk");
    const details = record.details as Record<string, unknown>;
    const headers = details.headers as unknown[];
    expect(JSON.stringify(headers[0])).toContain('"cookie"');
    expect(JSON.stringify(headers[0])).toContain("[REDACTED]");
    const firstJunk = details.headersFirstJunk as unknown[];
    expect(JSON.stringify(firstJunk[1])).toContain('"Authorization"');
    expect(JSON.stringify(firstJunk[1])).toContain("[REDACTED]");
    const requestHeaders = details.requestHeaders as unknown[];
    expect(JSON.stringify(requestHeaders[0])).toContain('"set-cookie"');
    expect(JSON.stringify(requestHeaders[0])).toContain("[REDACTED]");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    for (const canary of Object.values(secretCanaries)) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain("req-mixed-benign-8888");
    expect(persisted).toContain("junk");
  });

  it("conservatively redacts cookie= password= and api_key= text forms", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const record = store.append({
      level: "error",
      text: "login failed cookie=canary-cookie-form-1122 password=canary-pass-form-3344 api_key=canary-apikey-form-5566",
    });

    expect(record.text).not.toContain("canary-cookie-form-1122");
    expect(record.text).not.toContain("canary-pass-form-3344");
    expect(record.text).not.toContain("canary-apikey-form-5566");
    store.close();
  });

  it("never invokes attacker getters on Error name/message/code/cause", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    let reads = 0;
    const hostileError = Object.defineProperties(new Error("base"), {
      name: {
        get() {
          reads += 1;
          return "canary-error-name-9988";
        },
      },
      message: {
        get() {
          reads += 1;
          return "canary-error-message-7766";
        },
      },
      code: {
        get() {
          reads += 1;
          return "canary-error-code-5544";
        },
      },
      cause: {
        get() {
          reads += 1;
          return "canary-error-cause-3322";
        },
      },
    });

    const record = store.append({
      level: "critical",
      text: "hostile error",
      error: hostileError,
    });

    expect(reads).toBe(0);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("canary-error-name-9988");
    expect(serialized).not.toContain("canary-error-message-7766");
    expect(serialized).not.toContain("canary-error-code-5544");
    expect(serialized).not.toContain("canary-error-cause-3322");
    store.close();
  });

  it("never re-emits dangerous prototype keys in sanitized JSON", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"canary-proto-polluted-1234"},"prototype":{"x":"canary-proto-xy-5678"},"constructor":{"y":"canary-proto-ctor-9012"},"ok":"fine"}',
    ) as Record<string, unknown>;
    const record = store.append({
      level: "warning",
      text: "proto keys",
      details: { hostile },
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("__proto__");
    expect(serialized).not.toContain("prototype");
    expect(serialized).not.toContain("constructor");
    expect(serialized).not.toContain("canary-proto-polluted-1234");
    expect(serialized).not.toContain("canary-proto-xy-5678");
    expect(serialized).not.toContain("canary-proto-ctor-9012");
    expect(serialized).toContain("fine");
    store.close();
  });

  it("is adversarial-safe: never invokes attacker getters or toJSON", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    let getterCalls = 0;
    let toJsonCalls = 0;
    let toStringCalls = 0;
    const hostile = {
      get secret() {
        getterCalls += 1;
        return "canary-getter-value-123";
      },
      toJSON() {
        toJsonCalls += 1;
        return { secret: "canary-tojson-value-456" };
      },
      toString() {
        toStringCalls += 1;
        return "canary-tostring-value-789";
      },
    };
    const cyclic: Record<string, unknown> = { self: null as unknown };
    cyclic.self = cyclic;

    const record = store.append({
      level: "error",
      text: "hostile producer",
      details: { hostile, cyclic },
    });

    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(toStringCalls).toBe(0);
    expect(JSON.stringify(record)).not.toContain("canary-getter-value-123");
    expect(JSON.stringify(record)).not.toContain("canary-tojson-value-456");
    expect(JSON.stringify(record)).not.toContain("canary-tostring-value-789");
    store.close();
  });

  it("binds queries and pages through ordered ids with severity filters", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    for (let index = 0; index < 12; index += 1) {
      store.append({
        level: index % 3 === 0 ? "error" : index % 3 === 1 ? "warning" : "info",
        text: `event-${index}`,
      });
    }

    const firstPage = store.query({ limit: 5 });
    expect(firstPage.records.map((record) => record.id)).toEqual([1, 2, 3, 4, 5]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = store.query({ afterId: firstPage.records[4]!.id, limit: 5 });
    expect(secondPage.records.map((record) => record.id)).toEqual([6, 7, 8, 9, 10]);
    expect(secondPage.hasMore).toBe(true);
    const thirdPage = store.query({ afterId: secondPage.records[4]!.id, limit: 5 });
    expect(thirdPage.records.map((record) => record.id)).toEqual([11, 12]);
    expect(thirdPage.hasMore).toBe(false);

    const errors = store.query({ minimumLevel: "error", limit: 100 });
    expect(errors.records.map((record) => record.id)).toEqual([1, 4, 7, 10]);
    const warnings = store.query({ minimumLevel: "warning", limit: 100 });
    expect(warnings.records.map((record) => record.id)).toEqual([1, 2, 4, 5, 7, 8, 10, 11]);
    expect(store.query({ afterId: 100 }).records).toEqual([]);
    store.close();
  });

  it("pages severity-filtered queries over eligible rows without empty-page hasMore", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    // Interleave: 6 infos (ids 1,3,5,7,9,11) and 6 errors (ids 2,4,6,8,10,12).
    for (let index = 1; index <= 12; index += 1) {
      store.append({
        level: index % 2 === 0 ? "error" : "info",
        text: `event-${index}`,
      });
    }

    // Error-only pagination: 6 eligible rows, page size 4.
    const page1 = store.query({ minimumLevel: "error", limit: 4 });
    expect(page1.records.map((record) => record.id)).toEqual([2, 4, 6, 8]);
    expect(page1.hasMore).toBe(true);
    const page2 = store.query({
      minimumLevel: "error",
      afterId: page1.records[3]!.id,
      limit: 4,
    });
    expect(page2.records.map((record) => record.id)).toEqual([10, 12]);
    expect(page2.hasMore).toBe(false);
    // Cursor strictly beyond the last eligible row: empty page, no hasMore.
    const exhausted = store.query({
      minimumLevel: "error",
      afterId: page2.records[1]!.id,
      limit: 4,
    });
    expect(exhausted.records).toEqual([]);
    expect(exhausted.hasMore).toBe(false);
    // An eligible row exists but is strictly before the cursor: still no hasMore.
    const afterLast = store.query({
      minimumLevel: "error",
      afterId: 11,
      limit: 4,
    });
    expect(afterLast.records).toEqual([expect.objectContaining({ id: 12 })]);
    expect(afterLast.hasMore).toBe(false);
    store.close();
  });

  it("fails closed on append before the definitive scrubber is installed", async () => {
    const { configuration } = await fixture();
    const factory = createRuntimeDiagnosticsStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    });
    const store = await factory.open();

    // No scrubber at construction: append-before-ready must throw and never
    // persist a known-value secret.
    expect(() =>
      store.append({
        level: "error",
        text: "raw canary-before-ready-store-6655",
        details: { benign: "canary-before-ready-store-6655" },
      }),
    ).toThrow(/not ready/iu);

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    expect(persisted).not.toContain("canary-before-ready-store-6655");

    // After attachment the store accepts appends and scrubs known values.
    const ready = await factory.open();
    ready.attachScrub((value) =>
      value.replaceAll("canary-before-ready-store-6655", "[REDACTED]"),
    );
    const record = ready.append({
      level: "info",
      text: "raw canary-before-ready-store-6655 after ready",
    });
    expect(JSON.stringify(record)).not.toContain("canary-before-ready-store-6655");
    ready.close();
  });

  it("fails closed when the attached scrubber throws a secret-bearing error", async () => {
    const { configuration } = await fixture();
    const store = await createRuntimeDiagnosticsStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
      scrub: () => {
        throw new Error("scrubber exploded canary-thrown-store-2211");
      },
    }).open();
    const record = store.append({
      level: "critical",
      text: "raw canary-raw-store-3344",
      details: { prompt: "raw canary-raw-store-5566" },
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("canary-raw-store-3344");
    expect(serialized).not.toContain("canary-raw-store-5566");
    expect(serialized).not.toContain("canary-thrown-store-2211");
    expect(serialized).toContain("[SCRUB_FAILED]");

    store.close();
    const persisted = await allPersistedBytes(configuration.directory);
    expect(persisted).not.toContain("canary-raw-store-3344");
    expect(persisted).not.toContain("canary-raw-store-5566");
    expect(persisted).not.toContain("canary-thrown-store-2211");
  });

  it("refuses unknown or foreign schema without mutating the original file", async () => {
    const { root } = await fixture();
    const foreign = join(root, "foreign.sqlite3");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    const before = await readFile(foreign, "utf8");
    const factory = createRuntimeDiagnosticsStoreFactory({
      configuration: { directory: join(root, "foreign") },
      databaseFactory: { open: () => new DatabaseSync(foreign) },
    });
    await expect(factory.open()).rejects.toThrow();
    const after = await readFile(foreign, "utf8");
    expect(after).toBe(before);
    expect(await readdir(join(root, "foreign"))).toEqual([]);
  });

  it("returns only sanitized records after close and refuses further appends", async () => {
    const { configuration } = await fixture();
    const store = await patternStoreFactory({
      configuration,
      now: () => 1_700_000_000_000,
    }).open();
    store.append({ level: "info", text: "before close" });
    store.close();
    expect(() => store.append({ level: "info", text: "after close" })).toThrow(
      /closed/iu,
    );
    expect(() => store.query(undefined)).toThrow(/closed/iu);
  });
});
