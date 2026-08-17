import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  decodeNormalizedTerminalUsage,
  normalizeTerminalUsage,
  type UsageSemanticsDeclaration,
  type TerminalUsageClass,
} from "@luckytoken/provider-contract/usage";
import {
  USAGE_SEMANTICS_DECLARATIONS,
  resolveUsageSemantics,
} from "../../src/providers/usage-declarations.js";

/**
 * Ticket 20 unit matrix: the pure normalizer against independent worked
 * examples (research report §5.2). Expected totals and rates are hand-computed
 * literals — the production formula is never reproduced inside an assertion.
 * Declarations are the real production table where the row concerns a real
 * api; synthetic declarations are used only where a scenario needs flags no
 * real api has today.
 */

function usage(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  options: { reasoning?: number; totalTokens?: number } = {},
): Usage {
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    totalTokens: options.totalTokens ?? input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const anthropic = resolveUsageSemantics("anthropic-messages")!;
const commandcode = resolveUsageSemantics("commandcode-private")!;
const google = resolveUsageSemantics("google-generative-ai")!;
const bedrock = resolveUsageSemantics("bedrock-converse-stream")!;
const openaiResponses = resolveUsageSemantics("openai-responses")!;

describe("normalizeTerminalUsage worked examples", () => {
  it("E1: complete uncached usage derives total 7 and rate 0", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 0, 0, 2),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      api: "anthropic-messages",
      completeness: "complete",
      input: 5,
      cacheRead: 0,
      cacheWrite: 0,
      output: 2,
      normalizedTotal: 7,
      cacheHitRate: 0,
    });
    expect(snapshot.reasoning).toBeUndefined();
    expect(snapshot.reason).toBeUndefined();
  });

  it("E2: complete with cache read and write derives total 12 and rate 0.3", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 3, 2, 2, { reasoning: 1 }),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 2,
      reasoning: 1,
      normalizedTotal: 12,
    });
    expect(snapshot.cacheHitRate).toBeCloseTo(0.3, 10);
  });

  it("E3: cache read only derives total 19 and rate 4/14", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(10, 4, 0, 5),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      normalizedTotal: 19,
    });
    expect(snapshot.cacheHitRate).toBeCloseTo(0.285714, 6);
  });

  it("E4: all-cache input derives total 13 and rate 0.6 with explicit zero reasoning", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(0, 6, 4, 3, { reasoning: 0 }),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      input: 0,
      cacheRead: 6,
      cacheWrite: 4,
      output: 3,
      reasoning: 0,
      normalizedTotal: 13,
      cacheHitRate: 0.6,
    });
  });

  it("E5: a wire total that agrees with the partition validates (commandcode)", () => {
    // Wire-shaped components already normalized: input 4 excludes the
    // cached 4 and written 2; the echoed wire total 13 must equal the
    // partition sum 4 + 4 + 2 + 3.
    const snapshot = normalizeTerminalUsage(
      "commandcode-private",
      usage(4, 4, 2, 3, { reasoning: 1, totalTokens: 13 }),
      "done",
      commandcode,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      normalizedTotal: 13,
      cacheHitRate: 0.4,
    });
  });

  it("E5b: a wire total disagreeing with the partition is invalid, never clamped", () => {
    const snapshot = normalizeTerminalUsage(
      "commandcode-private",
      usage(4, 4, 2, 3, { reasoning: 1, totalTokens: 14 }),
      "done",
      commandcode,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "invalid_components",
    });
    expect(snapshot.normalizedTotal).toBeUndefined();
  });

  it("E6: defaulted cacheWrite stays visible but blocks completeness (google)", () => {
    const snapshot = normalizeTerminalUsage(
      "google-generative-ai",
      usage(6, 4, 0, 5, { reasoning: 2 }),
      "done",
      google,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "component_unreported",
      input: 6,
      cacheRead: 4,
      cacheWrite: 0,
      output: 5,
      reasoning: 2,
    });
    expect(snapshot.normalizedTotal).toBeUndefined();
    expect(snapshot.cacheHitRate).toBeUndefined();
  });

  it("E7: all-zero on done is the IR absence encoding, never complete", () => {
    for (const declaration of [anthropic, commandcode, undefined]) {
      const snapshot = normalizeTerminalUsage(
        "commandcode-private",
        usage(0, 0, 0, 0),
        "done",
        declaration,
      );
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "usage_absent",
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      });
      expect(snapshot.normalizedTotal).toBeUndefined();
    }
  });

  it("E8: aborted terminal keeps the captured input snapshot, output unknown", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(7, 1, 0, 0),
      "aborted",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "aborted",
      input: 7,
      cacheRead: 1,
      cacheWrite: 0,
      output: 0,
    });
    expect(snapshot.normalizedTotal).toBeUndefined();
    expect(snapshot.cacheHitRate).toBeUndefined();
  });

  it("E9: zero denominator yields no rate but the total is still derived", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(0, 0, 0, 5),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      normalizedTotal: 5,
    });
    expect(snapshot.cacheHitRate).toBeUndefined();
  });

  it("E10: reasoning is a subset of output and is never added to the total", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 0, 0, 6, { reasoning: 3 }),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "complete",
      output: 6,
      reasoning: 3,
      normalizedTotal: 11,
    });
  });

  it("never fabricates reasoning 0 for unreported reasoning", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 0, 0, 6),
      "done",
      anthropic,
    );
    expect(snapshot.reasoning).toBeUndefined();
  });

  it("rejects reasoning exceeding output as invalid components", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 0, 0, 6, { reasoning: 7 }),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "invalid_components",
    });
  });

  it.each([
    { name: "negative input", input: -1 },
    { name: "fractional output", output: 1.5 },
    { name: "non-safe input", input: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects $name without repair", ({ input, output }) => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(
        input ?? 5,
        0,
        0,
        output ?? 2,
      ),
      "done",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "invalid_components",
    });
  });

  it.each<Usage | null | undefined>([
    null,
    undefined,
    ("hostile string" as unknown as Usage),
    ([] as unknown as Usage),
  ])(
    "fails open on a hostile non-object usage (%j) instead of crashing",
    (hostile) => {
      const snapshot = normalizeTerminalUsage(
        "anthropic-messages",
        hostile as unknown as Usage,
        "done",
        anthropic,
      );
      expect(snapshot).toMatchObject({
        completeness: "partial",
        reason: "invalid_components",
      });
      // The snapshot carries no trustworthy components, so the strict
      // decoder refuses it: it can never be persisted as Provider truth.
      expect(decodeNormalizedTerminalUsage(snapshot)).toBeUndefined();
    },
  );

  it("failed terminals are Partial failed regardless of values", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(7, 1, 0, 2),
      "failed",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "failed",
      input: 7,
      cacheRead: 1,
      output: 2,
    });
  });

  it("unsupported terminals are Unavailable with visible components", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(0, 0, 0, 0),
      "unsupported",
      anthropic,
    );
    expect(snapshot).toMatchObject({
      completeness: "unavailable",
      reason: "unsupported_terminal",
      input: 0,
      output: 0,
    });
  });

  it("undeclared semantics stay Partial whatever the values", () => {
    const snapshot = normalizeTerminalUsage(
      "custom-unknown",
      usage(5, 3, 2, 2),
      "done",
      undefined,
    );
    expect(snapshot).toMatchObject({
      api: "custom-unknown",
      completeness: "partial",
      reason: "undeclared_semantics",
      input: 5,
      cacheRead: 3,
      cacheWrite: 2,
      output: 2,
    });
    expect(snapshot.evidence).toBeUndefined();
  });

  it("an unproven input partition blocks completeness (bedrock)", () => {
    const snapshot = normalizeTerminalUsage(
      "bedrock-converse-stream",
      usage(10, 3, 1, 4),
      "done",
      bedrock,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "component_unreported",
    });
  });

  it("carries the declaration evidence anchor on declared snapshots", () => {
    const snapshot = normalizeTerminalUsage(
      "anthropic-messages",
      usage(5, 0, 0, 2),
      "done",
      anthropic,
    );
    expect(snapshot.evidence).toContain("anthropic-messages.ts");
  });

  it("openai-responses stays Partial (cache write presence unprovable)", () => {
    const snapshot = normalizeTerminalUsage(
      "openai-responses",
      usage(4, 4, 2, 3, { reasoning: 1, totalTokens: 13 }),
      "done",
      openaiResponses,
    );
    expect(snapshot).toMatchObject({
      completeness: "partial",
      reason: "component_unreported",
    });
  });
});

describe("decodeNormalizedTerminalUsage strictness", () => {
  const complete: ReturnType<typeof normalizeTerminalUsage> = normalizeTerminalUsage(
    "anthropic-messages",
    usage(5, 3, 2, 2),
    "done",
    anthropic,
  );

  it("round-trips a complete snapshot through JSON", () => {
    const decoded = decodeNormalizedTerminalUsage(
      JSON.parse(JSON.stringify(complete)),
    );
    expect(decoded).toEqual(complete);
  });

  it("round-trips a partial snapshot (aborted) through JSON", () => {
    const aborted = normalizeTerminalUsage(
      "anthropic-messages",
      usage(7, 1, 0, 0),
      "aborted",
      anthropic,
    );
    const decoded = decodeNormalizedTerminalUsage(
      JSON.parse(JSON.stringify(aborted)),
    );
    expect(decoded).toEqual(aborted);
  });

  it.each([
    { name: "unknown key", value: { ...complete, extra: 1 } },
    { name: "complete with a reason", value: { ...complete, reason: "failed" } },
    { name: "partial without a reason", value: { ...complete, completeness: "partial" } },
    { name: "rate on a partial", value: { ...complete, completeness: "partial", reason: "failed", cacheHitRate: 0.5 } },
    { name: "total on a partial", value: { ...complete, completeness: "partial", reason: "failed", normalizedTotal: 12 } },
    { name: "partition mismatch", value: { ...complete, normalizedTotal: 13 } },
    { name: "wrong rate", value: { ...complete, cacheHitRate: 0.25 } },
    { name: "rate out of range", value: { ...complete, cacheHitRate: 1.5 } },
    { name: "negative component", value: { ...complete, input: -1 } },
    { name: "reasoning above output", value: { ...complete, reasoning: 5 } },
    { name: "unknown completeness", value: { ...complete, completeness: "perfect" } },
    { name: "unknown reason", value: { ...complete, completeness: "partial", reason: "mystery" } },
    { name: "missing api", value: { ...complete, api: undefined } },
    { name: "overlong evidence", value: { ...complete, evidence: "x".repeat(300) } },
    { name: "array shape", value: [complete] },
  ])("rejects $name", ({ value }) => {
    expect(decodeNormalizedTerminalUsage(value)).toBeUndefined();
  });
});

describe("usage semantics declaration table", () => {
  it("declares every known pi api except the passthrough upstream", () => {
    const knownApis = [
      "openai-completions",
      "mistral-conversations",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-converse-stream",
      "google-generative-ai",
      "google-vertex",
      "pi-messages",
    ];
    for (const api of knownApis) {
      if (api === "pi-messages") {
        // Passthrough: upstream semantics are not declared by LuckyToken.
        expect(resolveUsageSemantics(api)).toBeUndefined();
      } else {
        expect(resolveUsageSemantics(api)).toBeDefined();
      }
    }
  });

  it("declares the deterministic faux provider and the CommandCode private api", () => {
    expect(resolveUsageSemantics("faux")).toBeDefined();
    expect(resolveUsageSemantics("commandcode-private")).toBeDefined();
  });

  it("resolves unknown and custom api ids to undeclared", () => {
    expect(resolveUsageSemantics("custom-unknown")).toBeUndefined();
    expect(resolveUsageSemantics("")).toBeUndefined();
  });

  it("keeps every declaration frozen with bounded evidence and matching api", () => {
    for (const [api, entry] of USAGE_SEMANTICS_DECLARATIONS) {
      expect(entry.api).toBe(api);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.components)).toBe(true);
      expect(Object.isFrozen(entry.openQuestions)).toBe(true);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeLessThanOrEqual(256);
      expect(
        entry.inputIncludesCache === true ||
          entry.inputIncludesCache === false ||
          entry.inputIncludesCache === "unproven",
      ).toBe(true);
    }
  });

  it("keeps the complete-capable declarations few and documented", () => {
    const completeCapable = [...USAGE_SEMANTICS_DECLARATIONS.entries()]
      .filter(([, entry]) => {
        const components = Object.values(entry.components);
        return (
          entry.inputIncludesCache !== "unproven" &&
          components.every((source) => source !== "defaulted")
        );
      })
      .map(([api]) => api)
      .sort();
    expect(completeCapable).toEqual([
      "anthropic-messages",
      "commandcode-private",
      "faux",
    ]);
  });
});

describe("normalizer declaration gating", () => {
  it("treats a synthetic defaulted component like the real google row", () => {
    const synthetic: UsageSemanticsDeclaration = {
      api: "synthetic",
      evidence: "synthetic.ts:1",
      inputIncludesCache: true,
      components: {
        input: "derived",
        cacheRead: "reported",
        cacheWrite: "defaulted",
        output: "reported",
      },
      reasoning: "unreported",
      totalTokens: "wire-or-derived",
      usagePresentOnDone: "optional",
      openQuestions: [],
    };
    const snapshot = normalizeTerminalUsage(
      "synthetic",
      usage(5, 1, 0, 2),
      "done",
      synthetic,
    );
    expect(snapshot.completeness).toBe("partial");
    expect(snapshot.reason).toBe("component_unreported");
  });

  it("classifies the terminal class independently of values", () => {
    const classes: TerminalUsageClass[] = ["done", "aborted", "failed", "unsupported"];
    for (const terminalClass of classes) {
      const snapshot = normalizeTerminalUsage(
        "anthropic-messages",
        usage(5, 0, 0, 2),
        terminalClass,
        anthropic,
      );
      expect(snapshot.completeness).toBe(
        terminalClass === "done" ? "complete" : terminalClass === "unsupported" ? "unavailable" : "partial",
      );
    }
  });
});
