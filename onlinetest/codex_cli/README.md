# Codex CLI online test

The repository-level entrypoint certifies both bundled CommandCode Providers
with the real Codex CLI:

```powershell
npm run test:online-codex
```

It builds the shared packages once, then runs the same 22-scenario matrix
serially against:

```text
commandcode-private/deepseek/deepseek-v4.1-flash
commandcode-goat/deepseek/deepseek-v4.1-flash
```

Run either Provider independently when isolating a failure:

```powershell
npm run test:online-codex:private
npm run test:online-codex:goat
```

The Private run exercises the Codex/OpenAI Responses client contract through
Semantic Conversion. The Goat run exercises the same real client through
Provider Native Preservation.

For both Providers, a scenario fails if Codex stderr contains any of the known
active-item lifecycle diagnostics:

```text
OutputTextDelta without active item
ReasoningSummaryDelta without active item
ReasoningSummaryPartAdded without active item
ReasoningRawContentDelta without active item
```

Provider Native lifecycle normalization is also certified locally with the real
Codex CLI while routing the synthetic upstream SSE through the production
Provider Native handler/normalizer:

```powershell
node scripts/run-with-codex-test-sandbox.mjs -- npx tsx test/online/run-provider-native-item-chain-replay.ts
```

That replay preserves the original `response.output_item.done` commit order,
keeps independent global events in the global+done skeleton, and verifies
reverse-index done order, reasoning/message overlap, structured multi-tool
history, and the real single-slot custom-tool argument diff consumer through
Codex app-server `item/fileChange/patchUpdated` notifications. The raw
interleaved custom-tool control must lose one consumer attribution, while the
production-normalized treatment must preserve both call-id-attributed patch
diffs. All certified cases require zero lifecycle warnings.

The matrix includes `tool_schema_model_property`. The isolated Codex home
starts a test-only stdio MCP server whose advertised tool schema contains:

```json
{
  "properties": {
    "model": {
      "type": "string"
    }
  }
}
```

The runner captures the actual `/v1/responses` request and fails unless that
schema was really advertised by Codex. This protects the Provider Native SSE
alias-projection regression where a tool-schema property named `model` was
previously mistaken for response model identity.

From this directory, `npm test` still runs the generic runner with its default
Provider. Pass runner arguments after `--` for targeted development, for
example:

```powershell
npm test -- --provider commandcode-goat --model commandcode-goat/deepseek/deepseek-v4.1-flash --scenario tool_schema_model_property
```

To certify the exact three-field Codex injection instead of the profile
overrides, supply a Codex-safe public alias and one scenario:

```powershell
npm test -- --injected-config --alias commandcode-private/deepseek-v4-flash --scenario chain_basic
```

The runner starts a fresh Token server, reads the git-ignored
`../../CommandcodeAPIKey.txt`, creates an isolated temporary `CODEX_HOME`,
and runs the real Codex CLI against `/v1/responses`. User MCPs, credentials,
sessions, skills, and default settings are not inherited; the schema-probe MCP
is injected explicitly so the regression trigger stays deterministic.
