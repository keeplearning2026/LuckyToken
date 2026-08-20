import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFailureLoggingConfiguration } from "../../src/invocation-diagnostics/configuration.js";
import { createInvocationDiagnosticsFactory } from "../../src/invocation-diagnostics/index.js";

/**
 * Ticket 07 F3/F4: the legacy failure journal must route every persistent
 * value through the universal sanitizer plus the credential-owner known-value
 * scrubber — no second ad-hoc redactor.
 */
describe("failure journal universal redaction seam", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function readJournal(root: string): Promise<string> {
    const days = await readdir(root);
    const files = await readdir(join(root, days[0]!));
    return readFile(join(root, days[0]!, files[0]!), "utf8");
  }

  it("removes credential-owner known values and cookie/password/api_key forms from the journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-journal-scrub-"));
    roots.push(root);
    const configuration = parseFailureLoggingConfiguration(
      { directory: root, detail: "full" },
      root,
    );
    // Credential owners contribute their known-value scrubbers without any
    // LuckyToken Client Auth/token authority.
    const localCredential = "hunter2";
    const providerSecret = "mydogspot";
    const scrub = (value: string) =>
      value
        .replaceAll(localCredential, "[REDACTED]")
        .replaceAll(providerSecret, "[REDACTED]");

    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000041",
      scrub,
    }).begin("anthropic-messages");
    await invocation.fail({
      classification: "full",
      clientStatus: 500,
      fullSnapshot: {
        prompt: `token=${"hunter2"} provider=${providerSecret} cookie=canary-journal-cookie-9911 password=canary-journal-pass-2233 api_key=canary-journal-apikey-4455`,
      },
    });

    const text = await readJournal(root);
    for (const secret of [
      "hunter2",
      providerSecret,
      "canary-journal-cookie-9911",
      "canary-journal-pass-2233",
      "canary-journal-apikey-4455",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("token=[REDACTED]");
  });

  it("scrubs known values from exception messages and error chains", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-journal-scrub-"));
    roots.push(root);
    const configuration = parseFailureLoggingConfiguration(
      { directory: root, detail: "full" },
      root,
    );
    const scrub = (value: string) =>
      value.replaceAll("canary-journal-error-secret-7788", "[REDACTED]");

    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000042",
      scrub,
    }).begin("openai-responses");
    await invocation.fail({
      classification: "error",
      clientStatus: 500,
      error: new Error("upstream said canary-journal-error-secret-7788"),
    });

    const text = await readJournal(root);
    expect(text).not.toContain("canary-journal-error-secret-7788");
    expect(text).toContain("upstream said [REDACTED]");
  });

  it("scrubs known values from checkpoint selector and notice jsonPath", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-journal-scrub-"));
    roots.push(root);
    const configuration = parseFailureLoggingConfiguration(
      { directory: root, detail: "full" },
      root,
    );
    const scrub = (value: string) =>
      value
        .replaceAll("canary-selector-secret-aabb", "[REDACTED]")
        .replaceAll("canary-jsonpath-secret-ccdd", "[REDACTED]");

    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000043",
      scrub,
    }).begin("anthropic-messages");
    invocation.checkpoint({
      stage: "pi-execution",
      selector: "provider/model-canary-selector-secret-aabb",
    });
    invocation.notice({
      adapter: "anthropic-messages",
      direction: "request",
      code: "repair",
      jsonPath: "$.input[0].canary-jsonpath-secret-ccdd",
      action: "xrepair",
    });
    await invocation.fail({ classification: "selector-jsonpath", clientStatus: 500 });

    const text = await readJournal(root);
    expect(text).not.toContain("canary-selector-secret-aabb");
    expect(text).not.toContain("canary-jsonpath-secret-ccdd");
    // Benign surrounding content must survive.
    expect(text).toContain("provider/model-canary-selector-secret-aabb".replace("canary-selector-secret-aabb", "[REDACTED]"));
    expect(text).toContain("$.input[0].");
  });

  it("fails closed when the owner scrubber throws a secret-bearing error", async () => {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-journal-scrub-"));
    roots.push(root);
    const warnings: string[] = [];
    const configuration = parseFailureLoggingConfiguration(
      { directory: root, detail: "full" },
      root,
    );
    const scrub = () => {
      throw new Error("scrubber exploded with canary-thrown-secret-1122");
    };

    const invocation = createInvocationDiagnosticsFactory({
      configuration,
      createRequestId: () => "00000000-0000-4000-8000-000000000044",
      scrub,
      stderr: (message) => warnings.push(message),
    }).begin("anthropic-messages");
    await invocation.fail({
      classification: "thrown",
      clientStatus: 500,
      fullSnapshot: {
        prompt: "raw canary-raw-input-3344",
        authorization: "Bearer canary-raw-input-5566",
      },
    });

    const text = await readJournal(root);
    // Neither the raw input nor the thrown error message may reach the journal.
    expect(text).not.toContain("canary-raw-input-3344");
    expect(text).not.toContain("canary-raw-input-5566");
    expect(text).not.toContain("canary-thrown-secret-1122");
    // The fixed safe marker replaces the unsafe value.
    expect(text).toContain("[REDACTED]");
    for (const warning of warnings) {
      expect(warning).not.toContain("canary-thrown-secret-1122");
      expect(warning).not.toContain("canary-raw-input-3344");
    }
  });

});
