import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);
const recordUrl = new URL(
  "../fixtures/certification/serving-conformance-v1.json",
  import.meta.url,
);
const certificationSourceUrl = new URL(
  "../../src/commandcode-serving-certification.ts",
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
  assert.equal(record.schemaVersion, "luckytoken-serving-conformance-v1");
  assert.equal(record.result, "CERTIFIED");
  assert.deepEqual(record.commands, [
    "npm test",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "git diff --check",
    "npm run test:online",
  ]);
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
      "per-client-protocol-auth-isolation",
    ],
  );

  const onlineCoverage = record.coverage.find(
    ({ dimension }) => dimension === "real-provider-online-conformance",
  );
  assert.deepEqual(onlineCoverage?.tests, [
    "test/online/plan.ts",
    "test/online/conformance.ts",
    "test/online/run-commandcode.ts",
  ]);

  await Promise.all(
    record.coverage.flatMap(({ tests }) =>
      tests.map((relativePath) => access(new URL(relativePath, repositoryRoot))),
    ),
  );
});

test("binds the installed Pi runtime and every governing specification revision", async () => {
  const [source, packageText, lockText, core, anthropicPi, piCommandCode] =
    await Promise.all([
      readFile(certificationSourceUrl, "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
      readFile(new URL("../../doc/Spec/LuckyTokenCoreSpec.md", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../doc/Protocols/Anthropic-Pi AI IR Conversion Method.md",
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

  assert.equal(packageJson.dependencies["@earendil-works/pi-ai"], "0.84.1");
  assert.equal(piLock.version, "0.84.1");
  assert.equal(
    piLock.integrity,
    "sha512-wMsAdJMxuNri08vLqTyYVI201DQQezGhPSTkzYsHdw5dYX3rCNwEmSvpaAwhi7ELKI/2tE/CEgSWg/6iRxSgdQ==",
  );
  assert.ok(source.includes(piLock.integrity));

  for (const [document, documentMarker, manifestMarker] of [
    [
      core,
      "# LuckyToken Core Architecture Specification v5.8",
      "LuckyToken Core Architecture Specification v5.8",
    ],
    [
      anthropicPi,
      "# Part I — Anthropic Request → Pi AI IR Conversion Method",
      "Anthropic-Pi AI IR Conversion Method (Part I/II/III)",
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
