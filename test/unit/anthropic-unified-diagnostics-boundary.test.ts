import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const HANDLER_PATH = new URL(
  "../../src/protocols/anthropic/handler.ts",
  import.meta.url,
);

describe("Anthropic unified diagnostics boundary", () => {
  it("depends only on Request Journey observation and has no legacy diagnostic seam", async () => {
    const source = await readFile(HANDLER_PATH, "utf8");

    expect(source).toContain("../../diagnostics/contract.js");
    for (const forbidden of [
      "invocation-diagnostics",
      "request-ledger",
      "deep-diagnostics",
      "invocationDiagnostics",
      "requestLedger",
      "deepCapture",
      "InvocationDiagnostics",
      "RequestLedger",
      "DeepCapture",
    ]) {
      expect(source, `forbidden legacy Anthropic seam: ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });
});
