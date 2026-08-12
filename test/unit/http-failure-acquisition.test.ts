import { describe, expect, it } from "vitest";

import {
  httpFailureAcquisitionByApi,
  resolveHttpFailureAcquisition,
  supportsFetchObservation,
} from "../../src/http-failure-acquisition.js";

describe("httpFailureAcquisitionByApi", () => {
  it("maps every KnownApi to an explicit acquisition method", () => {
    expect(Object.keys(httpFailureAcquisitionByApi).sort()).toEqual(
      [
        "anthropic-messages",
        "openai-responses",
        "openai-completions",
        "azure-openai-responses",
        "mistral-conversations",
        "openai-codex-responses",
        "pi-messages",
        "bedrock-converse-stream",
        "google-generative-ai",
        "google-vertex",
      ].sort(),
    );
  });

  it("classifies fetch-observable adapters", () => {
    for (const api of [
      "anthropic-messages",
      "openai-responses",
      "openai-completions",
      "azure-openai-responses",
      "mistral-conversations",
      "openai-codex-responses",
      "pi-messages",
    ]) {
      expect(resolveHttpFailureAcquisition(api).kind, api).toBe(
        "fetch-observation",
      );
    }
  });

  it("classifies diagnostics-only adapters", () => {
    expect(resolveHttpFailureAcquisition("bedrock-converse-stream").kind).toBe(
      "diagnostics",
    );
  });

  it("classifies error-message-only adapters", () => {
    for (const api of ["google-generative-ai", "google-vertex"]) {
      expect(resolveHttpFailureAcquisition(api).kind, api).toBe(
        "error-message",
      );
    }
  });

  it("marks only pi-messages as having a diagnostic fallback", () => {
    for (const api of Object.keys(httpFailureAcquisitionByApi)) {
      const acquisition = resolveHttpFailureAcquisition(api);
      const hasFallback =
        acquisition.kind === "fetch-observation" &&
        acquisition.diagnosticFallback === true;
      expect(hasFallback, api).toBe(api === "pi-messages");
    }
  });

  it("rejects unknown api values explicitly", () => {
    expect(() => resolveHttpFailureAcquisition("my-custom-adapter")).toThrow(
      /No HTTP failure acquisition method mapped for Pi api: my-custom-adapter/,
    );
  });
});

describe("supportsFetchObservation", () => {
  it("is true for fetch-observable adapters", () => {
    expect(supportsFetchObservation("anthropic-messages")).toBe(true);
    expect(supportsFetchObservation("pi-messages")).toBe(true);
  });

  it("is false for diagnostics/error-message adapters", () => {
    expect(supportsFetchObservation("bedrock-converse-stream")).toBe(false);
    expect(supportsFetchObservation("google-generative-ai")).toBe(false);
    expect(supportsFetchObservation("google-vertex")).toBe(false);
  });
});
