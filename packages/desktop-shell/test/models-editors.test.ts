import { describe, expect, it } from "vitest";

import type {
  ModelsCommandResult,
  ModelsFileState,
} from "@luckytoken/application-control-plane/control-plane";

import {
  applySaveResult,
  createProvidersDraft,
  type ModelsDraft,
  type SaveIntent,
} from "../src/models-editors.js";

/**
 * Ticket 08 UI adapter seam: the structured editor must always be able to
 * save — creating an absent file or repairing an invalid one — while the raw
 * editor stays available over the same authoritative revision.
 */
describe("models workspace structured draft public seam", () => {
  const path = "C:\\models.json";

  it("initializes a valid empty draft for an absent file at revision 0", () => {
    const absent: ModelsFileState = {
      revision: 0,
      path,
      present: false,
      valid: false,
      raw: "",
    };
    expect(createProvidersDraft(absent)).toEqual({});
  });

  it("initializes a valid empty draft for an invalid existing file", () => {
    const invalid: ModelsFileState = {
      revision: 0,
      path,
      present: true,
      valid: false,
      raw: "{ broken",
      error: {
        kind: "parse",
        message: "Invalid JSON at position 2 (line 1, column 3)",
        location: { line: 1, column: 3, position: 2 },
      },
    };
    expect(createProvidersDraft(invalid)).toEqual({});
  });

  it("initializes the parsed providers for a valid file without aliasing them", () => {
    const providers = {
      ollama: { baseUrl: "http://x", vendorFlag: 1 },
    };
    const valid: ModelsFileState = {
      revision: 2,
      path,
      present: true,
      valid: true,
      raw: JSON.stringify({ providers }),
      providers,
    };
    const draft = createProvidersDraft(valid);
    expect(draft).toEqual(providers);
    // The draft is a working copy: mutating it never mutates the served state.
    if (draft === undefined) throw new Error("draft must be defined");
    draft.ollama = { baseUrl: "http://changed" };
    expect(providers.ollama.baseUrl).toBe("http://x");
  });

  it("stays undefined only while no file state has been observed yet", () => {
    expect(createProvidersDraft(undefined)).toBeUndefined();
  });
});

/**
 * Post-save re-base decision (repair turn 3): only the provably-local ok
 * outcome re-bases drafts; everything else leaves them bound to their old
 * revision so they keep conflicting instead of overwriting.
 */
describe("applySaveResult public seam", () => {
  const path = "C:\\models.json";

  function okState(
    revision: number,
    raw: string,
    providers: Record<string, unknown>,
  ): ModelsCommandResult {
    return { outcome: "ok", state: { revision, path, present: true, valid: true, raw, providers } };
  }

  const rawIntent: SaveIntent = {
    kind: "raw",
    raw: '{ "providers": {} }',
    providers: {},
    baseRevision: 0,
  };

  it("re-bases both drafts when the ok result provably matches a raw intent", () => {
    const providers = { ollama: { baseUrl: "http://x" } };
    const raw = '{ "providers": { "ollama": { "baseUrl": "http://x" } } }';
    const draft: ModelsDraft<string> = { value: raw, baseRevision: 0 };
    const structured: ModelsDraft<Record<string, unknown>> = {
      value: providers,
      baseRevision: 0,
    };

    const rebased = applySaveResult(
      { kind: "raw", raw, providers, baseRevision: 0 },
      structured,
      draft,
      okState(1, raw, providers),
    );

    expect(rebased).toEqual({
      providers: { value: providers, baseRevision: 1 },
      raw: { value: raw, baseRevision: 1 },
    });
  });

  it("re-bases both drafts when the ok result provably matches a structured intent, adopting the authoritative raw formatting", () => {
    const providers = { ollama: { baseUrl: "http://x" } };
    const normalized = `${JSON.stringify({ providers }, null, 2)}\n`;
    const structured: ModelsDraft<Record<string, unknown>> = {
      value: providers,
      baseRevision: 0,
    };
    // The raw draft was untouched at submit: it adopts the deterministic
    // normalized content of the structured write.
    const staleRaw: ModelsDraft<string> = { value: "old bytes", baseRevision: 0 };

    const rebased = applySaveResult(
      { kind: "structured", raw: "old bytes", providers, baseRevision: 0 },
      structured,
      staleRaw,
      okState(1, normalized, providers),
    );

    expect(rebased).toEqual({
      providers: { value: providers, baseRevision: 1 },
      raw: { value: normalized, baseRevision: 1 },
    });
  });

  it("keeps newer in-flight edits while still advancing the base revision", () => {
    const submittedRaw = '{ "providers": {} }';
    const continuedRaw = '{ "providers": { "ollama": { "baseUrl": "http://x" } } }';
    // The user typed after submitting: the draft value differs from the
    // intent's snapshot and must survive the re-base untouched.
    const draft: ModelsDraft<string> = {
      value: continuedRaw,
      baseRevision: 0,
    };

    const rebased = applySaveResult(
      rawIntent,
      { value: {}, baseRevision: 0 },
      draft,
      okState(1, submittedRaw, {}),
    );

    expect(rebased?.raw).toEqual({ value: continuedRaw, baseRevision: 1 });
  });

  it("never re-bases on a query result, a foreign write, a conflict, or any non-ok outcome", () => {
    const providers = { ollama: { baseUrl: "http://x" } };
    const raw = '{ "providers": { "ollama": { "baseUrl": "http://x" } } }';
    const draft: ModelsDraft<string> = { value: raw, baseRevision: 0 };
    const structured: ModelsDraft<Record<string, unknown>> = {
      value: providers,
      baseRevision: 0,
    };
    const intent: SaveIntent = { kind: "raw", raw, providers, baseRevision: 0 };

    // Query result at the same revision: not the save's outcome.
    expect(
      applySaveResult(intent, structured, draft, okState(0, raw, providers)),
    ).toBeUndefined();
    // Query result at the next revision but with foreign content.
    expect(
      applySaveResult(
        intent,
        structured,
        draft,
        okState(1, '{ "providers": { "external": {} } }', {
          external: {},
        }),
      ),
    ).toBeUndefined();
    // A later revision step that cannot be the single local write.
    expect(
      applySaveResult(intent, structured, draft, okState(2, raw, providers)),
    ).toBeUndefined();
    // Explicit conflict outcome.
    expect(
      applySaveResult(
        intent,
        structured,
        draft,
        { outcome: "conflict", state: { revision: 1, path, present: true, valid: true, raw, providers } },
      ),
    ).toBeUndefined();
    expect(
      applySaveResult(intent, structured, draft, undefined),
    ).toBeUndefined();
  });
});
