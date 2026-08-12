import { describe, expect, it } from "vitest";

import {
  COMMANDCODE_BASE_URL,
  COMMANDCODE_DEFAULT_MODEL_ID,
  createCommandCodeDefaultModel,
} from "../../src/providers/commandcode-private/model.js";

describe("CommandCode built-in default model", () => {
  it("uses the fixed CommandCode base URL", () => {
    const model = createCommandCodeDefaultModel();
    expect(model.baseUrl).toBe(COMMANDCODE_BASE_URL);
    expect(model.baseUrl).toBe("https://api.commandcode.ai");
  });

  it("ships the built-in default model id with real capability facts", () => {
    const model = createCommandCodeDefaultModel();
    expect(model.id).toBe(COMMANDCODE_DEFAULT_MODEL_ID);
    expect(model.api).toBe("commandcode-private");
    expect(model.provider).toBe("commandcode-private");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text"]);
    expect(model.contextWindow).toBe(1_000_000);
    expect(model.maxTokens).toBe(64_000);
  });

  it("freezes the returned model and its nested state", () => {
    const model = createCommandCodeDefaultModel();
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.cost)).toBe(true);
    expect(Object.isFrozen(model.input)).toBe(true);
  });

  it("uses the DeepSeek V4 Flash per-1M-token pricing", () => {
    const model = createCommandCodeDefaultModel();
    expect(model.cost).toEqual({
      input: 0.14,
      output: 0.28,
      cacheRead: 0.0028,
      cacheWrite: 0,
    });
  });
});
