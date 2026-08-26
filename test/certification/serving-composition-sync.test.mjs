import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const recordUrl = new URL(
  "../fixtures/certification/serving-conformance-v2.json",
  import.meta.url,
);
const certificationSourceUrl = new URL(
  "../support/commandcode-serving-certification.ts",
  import.meta.url,
);

test("binds the serving manifest to the immutable conformance record", async () => {
  const [recordBytes, source] = await Promise.all([
    readFile(recordUrl),
    readFile(certificationSourceUrl, "utf8"),
  ]);
  const record = JSON.parse(recordBytes.toString("utf8"));
  const canonicalRecord = recordBytes.toString("utf8").replaceAll("\r\n", "\n");
  const actualRevision = `sha256:${createHash("sha256")
    .update(canonicalRecord)
    .digest("hex")}`;
  const boundRevision = source.match(
    /SERVING_CONFORMANCE_REVISION\s*=\s*\n?\s*"(sha256:[a-f0-9]{64})"/m,
  )?.[1];

  assert.equal(boundRevision, actualRevision);
  assert.equal(record.schemaVersion, "token-serving-conformance-v2");
  assert.equal(record.certificationBasis, "offline-and-online");
  assert.equal(record.result, "CERTIFIED");
  assert.deepEqual(record.commands, [
    "npm test",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "npm run test:distribution",
    "git diff --check",
  ]);
});

test("binds the shared policy and all three conversion authorities by content", async () => {
  const record = JSON.parse(await readFile(recordUrl, "utf8"));
  const expected = [
    [
      "shared-architecture-policy",
      "doc/Protocols/Protocol Conversion Architecture and Policy.md",
    ],
    [
      "anthropic-pi-conversion",
      "doc/Protocols/Anthropic-Pi AI IR Conversion Method.md",
    ],
    [
      "responses-pi-conversion",
      "doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md",
    ],
    [
      "pi-commandcode-conversion",
      "doc/Protocols/PI AI IR-Commandcode Private Conversion.md",
    ],
  ];
  assert.deepEqual(
    record.authorities.map(({ id, path }) => [id, path]),
    expected,
  );
  for (const authority of record.authorities) {
    const bytes = await readFile(new URL(authority.path, repositoryRoot));
    const normalized = bytes.toString("utf8").replaceAll("\r\n", "\n");
    const actual = `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
    assert.equal(authority.sha256, actual, `stale authority: ${authority.id}`);
  }
});

test("certifies six named profiles and records complete online evidence", async () => {
  const record = JSON.parse(await readFile(recordUrl, "utf8"));
  assert.deepEqual(
    record.profiles.map(({ id, route, offlineResult }) => [id, route, offlineResult]),
    [
      ["anthropic-conversion", "POST /v1/messages conversion", "CERTIFIED"],
      ["anthropic-provider-native", "POST /v1/messages Provider Native Preservation", "CERTIFIED"],
      ["responses-conversion", "POST /v1/responses conversion", "CERTIFIED"],
      ["responses-direct-mode", "POST /v1/responses Direct Mode", "CERTIFIED"],
      ["responses-provider-native", "POST /v1/responses Provider Native Preservation", "CERTIFIED"],
      ["commandcode-provider", "Pi Provider commandcode-private", "CERTIFIED"],
    ],
  );
  for (const profile of record.profiles) {
    assert.ok(profile.tests.length > 0, `profile has no evidence: ${profile.id}`);
  }
  assert.equal(record.onlineEvidence.status, "ONLINE_PASSED");
  assert.equal(record.onlineEvidence.attempted, true);
  assert.equal(record.onlineEvidence.executedAt, "2026-08-21");
  assert.equal(record.onlineEvidence.repositoryState, "working-tree");
  assert.equal(record.onlineEvidence.runtime?.package, "@earendil-works/pi-ai");
  assert.equal(record.onlineEvidence.runtime?.version, "0.84.2");
  assert.match(record.onlineEvidence.implementationFingerprint, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(record.onlineEvidence.gaps, []);
  assert.deepEqual(
    record.onlineEvidence.runs.map(({ command, passed, attempted }) => [
      command,
      passed,
      attempted,
    ]),
    [
      ["npx tsx test/online/pi-commandcode-ir-probe.ts", 23, 23],
      ["npm run test:online", 60, 60],
      ["npm run test:online-responses", 60, 60],
      ["npm run test:online-codex -- 1", 60, 60],
      ["npm run test:online-claude -- 1", 51, 51],
    ],
  );
  const summary = JSON.parse(
    await readFile(new URL(record.onlineEvidence.summaryArtifact, repositoryRoot), "utf8"),
  );
  assert.equal(summary.result, "ONLINE_PASSED");
  assert.equal(summary.schemaVersion, "token-provider-distribution-online-evidence-v2");
  assert.equal(summary.runtime?.version, "0.84.2");
  assert.equal(summary.totals?.passed, 254);
  assert.equal(summary.totals?.attempted, 254);
  assert.equal(
    `sha256:${summary.implementationFingerprint?.sha256}`,
    record.onlineEvidence.implementationFingerprint,
  );
  assert.equal(record.onlineEvidence.runs[3]?.invocations, 3);
  assert.equal(record.onlineEvidence.runs[4]?.invocations, 3);
  assert.equal(summary.runs.length, 5);
});

test("the conformance record covers the complete serving route with real tests", async () => {
  const record = JSON.parse(await readFile(recordUrl, "utf8"));
  assert.deepEqual(
    record.coverage.map(({ dimension }) => dimension),
    [
      "inbound-grammar-and-semantics",
      "pi-invocation-integrity",
      "provider-request-and-response-conversion",
      "cancellation-and-terminal-consistency",
      "outbound-json-and-atomic-sse",
      "next-turn-round-trip",
      "serving-readiness-and-isolation",
      "local-loopback-http-boundary",
      "pi-configuration-credential-cli",
      "real-provider-online-conformance",
      "request-identity-credential-and-lane-isolation",
    ],
  );

  await Promise.all(
    [...record.coverage, ...record.profiles].flatMap(({ tests }) =>
      tests.map((relativePath) => access(new URL(relativePath, repositoryRoot))),
    ),
  );
});

test("binds the installed Pi runtime and every governing specification revision", async () => {
  const [source, packageText, lockText, core, policy, anthropicPi, responsesPi, piCommandCode] =
    await Promise.all([
      readFile(certificationSourceUrl, "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
      readFile(new URL("../../doc/Spec/TokenCoreSpec.md", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../doc/Protocols/Protocol Conversion Architecture and Policy.md",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../doc/Protocols/Anthropic-Pi AI IR Conversion Method.md",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../doc/Protocols/PI AI IR-Commandcode Private Conversion.md",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  const piLock = lock.packages["node_modules/@earendil-works/pi-ai"];

  assert.equal(packageJson.dependencies["@earendil-works/pi-ai"], "0.84.2");
  assert.equal(piLock.version, "0.84.2");
  assert.equal(
    piLock.integrity,
    "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
  );
  assert.ok(source.includes(piLock.integrity));

  for (const [document, documentMarker, manifestMarker] of [
    [
      core,
      "# Token Core Architecture Specification v6.0",
      "Token Core Architecture Specification v6.0",
    ],
    [
      policy,
      "# Protocol Conversion Architecture and Policy",
      "Protocol Conversion Architecture and Policy",
    ],
    [
      anthropicPi,
      "# Part I — Anthropic Request → Pi AI IR Conversion Method",
      "Anthropic-Pi AI IR Conversion Method (Part I/II/III)",
    ],
    [
      responsesPi,
      "# OpenAI Responses ↔ Pi AI IR Conversion Method",
      "OpenAI Responses-Pi AI IR Conversion Method",
    ],
    [
      piCommandCode,
      "# PART I: PI AI IR Request -> Commandcode Private Request",
      "PI AI IR-Commandcode Private Conversion (Part I/II)",
    ],
  ]) {
    assert.ok(
      document.includes(documentMarker),
      `missing governing revision: ${documentMarker}`,
    );
    assert.ok(source.includes(manifestMarker));
  }
});
