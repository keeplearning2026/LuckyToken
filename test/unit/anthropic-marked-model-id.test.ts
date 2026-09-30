import { expect, it } from "vitest";

import {
  markAnthropicModelId,
  unmarkAnthropicModelId,
} from "../../src/protocols/anthropic/marked-model-id.js";

const PREFIX = "anthropic/token-";

const ALIASES = [
  "provider/favorite",
  "commandcode-goat/deepseek-v4.1-flash",
  "commandcode-goat/gpt-6-luna",
  "openai/gpt-5.4",
  "qwen/qwen3.8-max",
  "x/codex-mini",
  "anthropic/claude-sonnet-4-5",
  "模型/别名",
  "a".repeat(128),
];

it("keeps marked IDs free of vendor family tokens that clients filter on", () => {
  for (const alias of ALIASES) {
    const marked = markAnthropicModelId(alias);
    expect(marked.startsWith(PREFIX)).toBe(true);
    expect(marked.slice(PREFIX.length)).toMatch(/^[0-9]+$/);
    for (const token of ["deepseek", "gpt", "qwen", "codex", "openai", "abab"]) {
      expect(marked.toLowerCase()).not.toContain(token);
    }
  }
});

it("round-trips every alias through the reserved marker", () => {
  for (const alias of ALIASES) {
    expect(unmarkAnthropicModelId(markAnthropicModelId(alias))).toBe(alias);
  }
});

it("round-trips a code point corpus unit-for-unit", () => {
  const corpus: string[] = [];
  corpus.push("\ud800", "\udfff", "a\ud800b", "\ud83d\ude00", "\ufe0f", "\u0000", "\uffff");
  for (let code = 0x20; code <= 0x7e; code += 1) corpus.push(String.fromCodePoint(code));
  for (let code = 0x00; code <= 0x7f; code += 1) corpus.push(`a${String.fromCodePoint(code)}b`);
  for (let code = 0x80; code <= 0x7ff; code += 97) corpus.push(String.fromCodePoint(code));
  for (let code = 0x800; code <= 0xd7ff; code += 1013) corpus.push(String.fromCodePoint(code));
  for (let code = 0xd800; code <= 0xdfff; code += 211) corpus.push(String.fromCodePoint(code));
  for (let code = 0xe000; code <= 0xfffd; code += 1013) corpus.push(String.fromCodePoint(code));
  for (let code = 0x10000; code <= 0x10ffff; code += 61_441) corpus.push(String.fromCodePoint(code));
  for (const alias of ALIASES) corpus.push(alias, `${alias}/${alias}`, `${alias}[1m]`);

  let seed = 0x2f6e2b1;
  const nextCodePoint = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 0x110000;
  };
  for (let index = 0; index < 500; index += 1) {
    let alias = "";
    const length = 1 + (nextCodePoint() % 12);
    for (let unit = 0; unit < length; unit += 1) {
      const code = nextCodePoint();
      alias += code >= 0xd800 && code <= 0xdfff
        ? String.fromCharCode(code)
        : String.fromCodePoint(code);
    }
    corpus.push(alias);
  }

  for (const alias of corpus) {
    const marked = markAnthropicModelId(alias);
    const payload = marked.slice(PREFIX.length);
    expect(payload).toMatch(/^[0-9]+$/);
    expect(payload).toHaveLength(alias.length * 5);
    expect(unmarkAnthropicModelId(marked)).toBe(alias);
  }
});

it("treats ordinary IDs and unusable reserved IDs as unresolved", () => {
  expect(unmarkAnthropicModelId("provider/model")).toBeUndefined();
  expect(unmarkAnthropicModelId(markAnthropicModelId(""))).toBeNull();
  expect(unmarkAnthropicModelId("anthropic/token-1234")).toBeNull();
  expect(unmarkAnthropicModelId("anthropic/token-123456789")).toBeNull();
  expect(unmarkAnthropicModelId("anthropic/token-65536")).toBeNull();
  expect(unmarkAnthropicModelId("anthropic/token-99999")).toBeNull();
  expect(unmarkAnthropicModelId("anthropic/token-00097")).toBe("a");
  expect(unmarkAnthropicModelId("anthropic/token-0009700055")).toBe("a7");
  expect(unmarkAnthropicModelId("anthropic/token-55296")).toBe("\ud800");
  expect(unmarkAnthropicModelId("anthropic/token-65535")).toBe("\uffff");
});
