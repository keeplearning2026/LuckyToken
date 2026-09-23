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
