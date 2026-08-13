# Codex CLI Request Samples

Real `/v1/responses` request bodies captured from the official Codex CLI
(`codex -p luckytoken exec`, version 0.147.0) driving the LuckyToken local
bridge. Captured by `test/online/run-codex-cli.ts` (`createCapturingRuntime`),
then sanitized for repo hygiene.

## Sanitization

Each captured request is cleaned before being committed:

- `instructions`, `client_metadata`, `prompt_cache_key`, `include` are
  removed (non-protocol noise).
- Developer/system message bodies (skills instructions, permissions,
  recommended plugins, environment context) are replaced with a placeholder
  text; the item structure (`{type:"message", role, content:[...]}`) is kept.
- Local absolute paths inside content are replaced with `<sanitized-path>`.

Preserved protocol fields: `model`, `input` (message/reasoning/function_call/
function_call_output/custom_tool_call items), `tools` (function/custom/
namespace/tool_search/web_search shapes), `reasoning`, `stream`,
`tool_choice`, `parallel_tool_calls`, `store`, `text`.

## Replay

`test/integration/openai-responses-replay.test.ts` replays every sample
against an in-process LuckyToken composition (mocked upstream fetch), so the
unit/integration suite exercises the exact wire shapes the official client
produces — without needing the Codex CLI or network access.

To re-capture fresher samples: run `npm run test:online-codex`, then copy
`<tmp>/luckytoken-codex-cli-*/artifacts/requests/*.json` here (re-sanitized).
