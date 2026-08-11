import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const protocolUrl = new URL(
  "../../doc/Protocols/Anthropic Message Protocol.md",
  import.meta.url,
);
const conversionUrl = new URL(
  "../../doc/Protocols/Anthropic-Pi AI IR Conversion Method.md",
  import.meta.url,
);
const fixtureUrl = new URL(
  "../fixtures/certification/anthropic-protocol-source-validity.json",
  import.meta.url,
);

async function loadAuthorities() {
  const [protocol, conversion, fixtureText] = await Promise.all([
    readFile(protocolUrl, "utf8"),
    readFile(conversionUrl, "utf8"),
    readFile(fixtureUrl, "utf8"),
  ]);

  return {
    protocol,
    conversion,
    fixture: JSON.parse(fixtureText),
  };
}

test("binds the conversion method to the synchronized immutable protocol artifact", async () => {
  const { protocol, conversion } = await loadAuthorities();

  assert.match(
    protocol,
    /^# Anthropic Messages API Protocol Specification v0\.4$/m,
  );
  assert.match(
    conversion,
    /^# Part I — Anthropic Request → Pi AI IR Conversion Method$/m,
  );
});

test("owns model-dependent prefill and strict limits in the protocol", async () => {
  const { protocol } = await loadAuthorities();

  for (const marker of [
    "allowed | forbidden | unknown",
    "forbidden → source-invalid",
    "allowed → source-valid",
    "unknown → validity is not guessed",
    "strict:true tools per request <= 20",
    "optional parameters total     <= 24",
    "union-type parameters total   <= 16",
    "These are request-wide source-validity constraints",
  ]) {
    assert.ok(protocol.includes(marker), `missing protocol authority: ${marker}`);
  }
});

test("freezes the ticket classifications without widening ToolResult evidence", async () => {
  const { fixture } = await loadAuthorities();
  const actual = Object.fromEntries(
    fixture.cases.map(({ id, expected }) => [id, expected]),
  );

  assert.equal(fixture.protocolVersion, "v0.4");
  assert.equal(fixture.capabilityBaseline, "v1");
  assert.deepEqual(actual, {
    "final-assistant-prefill-forbidden": "InvalidRequest",
    "final-assistant-prefill-allowed": "UnsupportedFeature",
    "final-assistant-prefill-unknown": "UnsupportedFeature",
    "strict-tool-count-21": "InvalidRequest",
    "strict-optional-parameter-count-25": "InvalidRequest",
    "strict-union-parameter-count-17": "InvalidRequest",
    "tool-result-string-no-equivalence-claim": "UnsupportedFeature",
    "tool-result-explicit-empty-array-no-equivalence-claim":
      "UnsupportedFeature",
  });
});
