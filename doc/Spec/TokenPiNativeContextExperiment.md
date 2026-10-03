# Pi Native Context Experiment

Status: experiment on `codex/pi-native-context-experiment`; production Native
senders and Semantic defaults remain unchanged. Evidence targets installed
`@earendil-works/pi-ai@1.0.0`, not arbitrary future versions.

## Goal and acceptance contract

`max` prepares the facts Pi needs to build a correct Provider HTTP envelope.
Conversion success alone is not acceptance. A valid Pi Context can still lose
image presence or the last initiator, and credentials/routing are outside Context.

The acceptance conditions are:

1. Default/explicit `semantic` conversion has the original results and failures.
2. `max` retains representable content using the existing pure parsers, reports
   omissions, and supplies the current envelope consumers even when native-only
   items cannot be translated. Its result is NOT a Semantic invocation.
3. Pi owns auth resolution, normalization, URL, headers, SDK identity/configuration
   and Codex compression. Token supplies request infrastructure outside Context.
4. Only the already-approved Native body is sent. An outbound decoded-body
   comparison happens before the physical fetch. Azure deployment substitution
   is the existing model rewrite, using the name Pi resolved in its payload.
   The pure Token preparation step completes before the snapshot used for this
   comparison; no field, including model, is exempt from the comparison afterward.
   Whitespace/key formatting is SDK serialization; JSON fields/values/order
   within arrays must be preserved. Raw original JSON byte identity is not claimed.
5. The actual upstream Response is returned by identity, unread, with original
   status/headers/bytes. Pi and its SDK see only a private synthetic response.
6. One physical request, no Pi retries/WS fallback; pre-response transport failures
   remain failures.

## What Pi actually reads

Source inspection covers the installed `dist/api/openai-responses.js`,
`azure-openai-responses.js`, `openai-codex-responses.js`,
`anthropic-messages.js`, `github-copilot-headers.js`, and transcript helpers.

| Consumer | Required Pi fact | Origin/ownership | Envelope consequence |
| --- | --- | --- | --- |
| OpenAI Responses Copilot | Last normalized message role | Native input's last initiator | `X-Initiator` |
| OpenAI Responses Copilot | Image in user/toolResult content | Native input image presence | `Copilot-Vision-Request` |
| OpenAI Responses session affinity | `sessionId`, `cacheRetention`, provider/compat/baseURL | Infrastructure options, public Model | OpenAI/OpenRouter session headers |
| OpenAI Responses client | provider, baseURL, model headers, resolved auth/options headers | Model/auth/options, NOT Context | Credentials, precedence, User-Agent, SDK defaults |
| Azure Responses | Model ID, deployment map, baseURL/resource/API version, headers/key | Model/auth/env/options, NOT Context | SDK routing/query/default headers |
| Codex Responses | BaseURL, token/account, headers, session ID, transport | Model/auth/options, NOT Context | URL, auth/identity/beta/session headers, SSE/WS selection |
| Codex Responses compression | Serialized final payload and runtime compression support | Replaced Native payload, Pi transport | zstd bytes and content-encoding |
| Anthropic Copilot (future separate experiment) | Last role, user/toolResult image presence | Anthropic-owned converter | Copilot dynamic headers |
| Anthropic beta selection (future separate experiment) | Current tools, initial tools, tool redefinitions/state | Pi Context tool state after normalization | Fine-grained streaming / mid-conversation tool-change beta |
| Anthropic beta selection (future separate experiment) | Thinking enabled, model compat, explicit beta headers, OAuth | Body-related options plus Model/auth | Interleaved/OAuth/feature beta selection |

For the three Responses APIs, tools/message text/reasoning/continuity are primarily
body-builder consumers, not current Context-dependent envelope consumers.
`max` preserves what it can to avoid an unnecessarily empty Context, but that
does not certify future added consumers. An upgrade must rerun wire tests and
review newly introduced outside-body consumers.

## Conversion ledger

`convertResponsesRequest(body, receivedAt, policy?, "max")` is synchronous and
pure: no authentication, fetch, clock reads, reference resolver or lifecycle state.
`receivedAt` is explicit. Omission notices are bounded at 32.

| Client fact | Default Semantic | Experimental max |
| --- | --- | --- |
| Model selector | Required and validated | Query selector; target Model still resolved outside IR |
| Instructions, user/assistant/system/developer text | Existing ordered conversion | Same message/content parsers; keep representable content |
| Refusal and inline data images | Existing parsers | Reuse those parsers |
| Remote/file-ID images | Require trusted resolver | No IO; report absence of bytes, retain envelope image-presence marker |
| Last opaque/history/system item | May reject or drop/normalize | Retain non-user initiator with an explicit query marker if needed |
| Function/custom/namespace tools | Strict grammar/identity checks | Reuse converters and flattening; report unrepresentable portions |
| Deferred function declarations | Reject discovery requirement | Keep known declaration; omit discovery control with notice |
| Explicit strict schema rejected by Semantic | Reject | Retain schema without claiming strict execution; notice |
| Calls/results | Validate complete history; configured missing-result policy | Reuse call/argument/result parsers, correlate real results, retain no synthetic results |
| Unknown/hosted lifecycle | Existing per-family policy | Preserve existing representable transcript portions; report omissions |
| Foreign encrypted compaction / item reference / tool-search lifecycle | Reject unsupported semantics | Report omission from Context; actual Native body remains complete |
| Additional tools | Existing conversion | Keep representable declarations; exact incremental lifecycle remains Native body-owned |
| Enabled reasoning | Client intent then resolved-model reasoning preparation | Public enabled options; Pi owns clamping when executing the query |
| Disable/summary/future unsupported reasoning control | Existing omission/policy | Report neutral-contract omission; Native payload retains original |
| Output limit / temperature / cache retention | Existing validation | Map accepted public values, report values outside the accepted contract |
| Tool choice auto/none | Existing mapping | Public option; retain declared tool catalog |
| Required/named/allowed/hosted choice, parallelism | Existing semantic behavior | Report unsupported neutral preference; preserve Native body |
| Previous response ID / store / stream | Client lifecycle/render consumers | Remain in Native body; never fabricate replay content |
| Unclaimed fields, including metadata | Existing bounded warnings | Do not read values; report omission by key |
| Credentials, headers, URL, timeout, retry, cancellation | Outside semantic state | Still outside Context |

Query-only image/role markers are deliberately not full semantic content. The
`ResponsesMaxContext` result has no `invocation`, selector execution contract or
Client render state. It cannot stand in for `ResponsesInvocation`.

## Experimental transport

`test/support/pi-native-context-transport.ts` is a test-only prototype:

```text
already-rewritten Native body
  -> shared pure converter, mode=max
  -> installed Pi Models.streamSimple (normalization/auth/adapter)
  -> Token pure Azure deployment projection when applicable
  -> onPayload replaces generated body with a separate final Native snapshot
  -> Pi SDK / Codex compression
  -> fetch validates decoded Native body
  -> actual upstream Response kept unread
  -> private synthetic Response completes Pi's internal stream
  -> caller receives original Response
```

Context and substituted payload use separate snapshots, so Pi processing cannot
mutate the caller's body. The response is never cloned or teed. Provider parsing
is performed only on the private response. A real non-2xx is therefore not
consumed or translated into a Pi error.

Anthropic needs a separate source-protocol query and certification: its adapter
adds `stream: true` after onPayload and carries beta selection through SDK payload
`betas`. Neither fact is solved by declaring Responses max conversion successful.
Production Anthropic continues using its existing envelope.

Codex v2 compaction remains on `/responses`. When the existing capability claim
supports native compaction, max accepts that request (including opaque replay
items and the trailing compaction_trigger), while substituted body and raw
compaction Response remain complete. When unsupported, the existing Token1
expansion and routed-compaction helper first prepare an ordinary summarizer
request; max then receives that prepared request. The existing response helper
continues minting exactly one Token1 compaction item. Integration tests compose
these unchanged helpers in both stream modes.

Dedicated legacy `/responses/compact` is not an operation on Pi's public stream
API. Its body shape is accepted by max, but its dispatch remains outside this
transport experiment. Token1 replay, routed-compaction request and response
implementations, and every production rewrite switch are untouched.

## Evidence and reproduction

Offline integration tests compare full URL/method/headers against current Native
envelopes for OpenAI, OpenRouter SDK envelope, Copilot, Azure and Codex, plus an
independent real Pi image Context oracle. They cover private body fields,
unknown SSE/binary responses, non-2xx, one-attempt behavior, changed-body refusal,
transport failures, default conversion equality, maximum conversion boundaries,
header-owned authentication, and Azure deployment/API version.
Negative body tests change a known field, an unknown field, remove an unknown
field, reorder an array, and change a number: every change fails before network.

```powershell
npm run build:packages
node scripts/run-with-codex-test-sandbox.mjs -- npx vitest run test/integration/pi-native-context-experiment.test.ts test/unit/openai-responses-request.test.ts
node scripts/run-with-codex-test-sandbox.mjs -- npx tsx test/online/run-pi-native-context-experiment.ts
```

The online test uses the existing Codex local_oauth registration and an externally
owned read-only auth reference. A temporary CODEX_HOME is passed by the repository
guard. No auth document is copied/written/refreshed. Near-expiry credentials fail
before requests; the external document revision is checked afterward.

Observed on 2026-10-03:

- Ordinary installed Pi baseline: `openai-codex/gpt-6-luna`, low, passed.
- Experimental max/native body: same model, low text, HTTP 200, completed.
- Experimental max/native body: medium function call, HTTP 200, completed.
- Complete-history tool result replay: medium, HTTP 200, completed.
- Native supported v2 compaction: low, HTTP 200, completed, exactly one
  compaction item with nonempty encrypted content.
- Replay of that opaque compaction item with a new user turn: low, HTTP 200,
  completed. The item was forwarded without decoding its encrypted content.
- Raw Response was unread on receipt. Codex emitted completed items in
  `response.output_item.done`, not repeated in terminal output; only the test
  consumer reconstructs these for assertions.
- No encrypted reasoning item was returned in that run, so encrypted reasoning
  replay is not certified by this online evidence.

Offline verification passed: 48 Responses/Native test files with 958 tests before
the additional compaction cases; the final targeted converter/Native/compaction
run passed 173 tests across four files. Five semantic isolation certification
tests, TypeScript checks, targeted lint and diff whitespace checks passed.

This establishes feasibility for the tested Responses cases. It does not yet
authorize deleting production envelopes or declare all Native APIs/operations
certified.
