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
   and Codex compression. Token supplies request infrastructure outside Context,
   including the real header deadline and caller cancellation lifetime.
4. Only the already-approved Native body is sent. An outbound decoded-body
   comparison happens before the physical fetch. Azure deployment substitution
   is the existing model rewrite, using the name Pi resolved in its payload.
   Semantic body overlays in Model/options samplingParams are excluded from the
   envelope query. For installed Pi 1.0, the resulting initial Azure model field
   is deployment resolution, not a semantic override. Certify this on upgrade.
   The pure Token preparation step completes before the snapshot used for this
   comparison; no field, including model, is exempt from the comparison afterward.
   Comparison uses the accepted SDK JSON value normalization, including -0 to 0.
   JSON fields/values/order within arrays must otherwise be preserved. Raw
   original JSON byte identity is not claimed.
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
`max` retains representable content for its conversion contract. The sender
uses a separate bounded Context from the existing pure envelope extractor:
only initiator and image-presence markers. Full text/tool/history conversion
must not burden Pi's discarded temporary body. This projection is certified
only for the listed current consumers. An upgrade must rerun wire tests and
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
| Explicit strict schema | Require Client-valid strict schema | Retain schema; use prefer, never require, for the temporary query; report relaxation even when Client-valid |
| Calls/results | Validate complete history; configured missing-result policy | Reuse call/argument/result parsers, correlate real results, retain no synthetic results; keep supported named unpaired function-output notifications as user text |
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

Image-presence extraction inspects only user message content and declared tool
output image parts (input_image/output_image/computer_screenshot). It does not
recurse into metadata, schemas, assistant/system image fields or arbitrary data.
Query-only image/role markers are deliberately not full semantic content. The
`ResponsesMaxContext` result has no `invocation`, selector execution contract or
Client render state. It cannot stand in for `ResponsesInvocation`.

## Experimental transport

`test/support/pi-native-context-transport.ts` is a test-only prototype:

```text
already-rewritten Native body
  -> shared pure converter, mode=max
  -> bounded envelope Context (initiator/image presence), plus max public options
  -> installed Pi Models.streamSimple (normalization/auth/adapter), excluding
     semantic Model/options samplingParams overlays
  -> Token pure Azure deployment projection when applicable
  -> onPayload replaces generated body with a separate final Native snapshot
  -> Pi SDK / Codex compression
  -> fetch validates decoded Native body
  -> actual upstream Response kept unread
  -> Pi consumes only a private synthetic Response
  -> drain private Pi events; private parser errors after capture are irrelevant
  -> caller receives original Response
```

Substituted payloads use separate JSON snapshots with the permitted SDK value
normalization, so Pi processing cannot mutate the caller's body. Decoded-body
comparison is iterative: nested unknown fields do not encounter the lower
recursion limits of structuredClone or recursive deep comparison. The response
is never cloned or teed. Provider parsing
is performed only on the private response. A real non-2xx is therefore not
consumed or translated into a Pi error.

The temporary query may still be rejected by Pi before onPayload. Its bounded
Context carries no full message text, tool schemas or call history, avoiding
the installed Pi builder's array-spread overflow on large assistant content
and strict-tool capability rejection. Independently, strict tools carry only
prefer in the pure max result; strict:true remains in the actual Native body.
This does not prove all future Pi validators or added envelope consumers will
permit all Native requests without renewed certification.

For stream=false, the SDK returns private JSON and Pi currently emits an
"openaiStream is not async iterable" error. The helper intentionally returns the
real Response after exactly one validated fetch has captured it. It does not
require Pi semantic completion. Without capture, Pi errors fail the call; body
validation, physical fetch failures, and attempted extra dispatch always fail,
including after an earlier Response was captured.

Token records failures from its fetch and payload hooks independently of Pi
error events. A repeated onPayload after capture still rejects the call, even
if an adapter reports it as a private parser error or swallows the exception.
Before Response handoff, any rejecting attempt initiates cancellation of an already-captured body,
including late timeout, extra dispatch and thrown iteration. Cancellation errors
are contained, including late rejection. Cleanup is not awaited: a pending
cancel promise must not indefinitely delay the original timeout/guard failure.
A successful handoff
keeps the same Response identity, unread/unlocked body, and caller ownership.

Explicit pi.timeoutMs is enforced by a Token header deadline around the physical
fetch (zero disables it). That timer is cleared when headers arrive or fetch
fails. Caller cancellation remains connected to the returned body; Pi/SDK timer
signals are not connected to it. Unspecified timeout leaves deadline ownership
with the caller, rather than claiming Pi's implicit SDK default is enforced.

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

The review regression group covers Model/request/both samplingParams overrides
for Azure against an independent real Pi oracle; valid strict tools with strict
compat=false for all three APIs; metadata/non-content false vision facts against
independently authored Pi contexts; actual tool image paths; N1 negative zero;
and private-parser versus extra-dispatch failure. Local HTTP tests for all three
APIs prove header timeout and successful later body reads. They also prove caller
cancellation before headers/after capture, refusal of a late custom-fetch Response
that ignored its signal, and actual Codex zstd payload/non-2xx response behavior.

```powershell
npm run build:packages
node scripts/run-with-codex-test-sandbox.mjs -- npx vitest run responses native --maxWorkers=2
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
- The post-review medium tool call/replay deliberately sets Pi query
  supportsStrictMode=false, while the actual Native tool retains strict:true.
  Both requests passed with local_oauth and gpt-6-luna. Explicit header timeout
  was 30 seconds; the requests completed within it.
- Native supported v2 compaction: low, HTTP 200, completed, exactly one
  compaction item with nonempty encrypted content.
- Replay of that opaque compaction item with a new user turn: low, HTTP 200,
  completed. The item was forwarded without decoding its encrypted content.
- Raw Response was unread on receipt. Codex emitted completed items in
  `response.output_item.done`, not repeated in terminal output; only the test
  consumer reconstructs these for assertions.
- No encrypted reasoning item was returned in that run, so encrypted reasoning
  replay is not certified by this online evidence.

Post-review offline verification passed: 26 dedicated regression/HTTP tests
were added to the experiment file (72 tests total). The Responses/Native run
passed 994 tests across 48 files. Five semantic isolation certification tests,
TypeScript checks, targeted lint and diff whitespace checks passed.

The follow-up cleanup review adds eight tests (80 experiment tests total),
including red-before-green reproductions of abandoned late-body cancellation
and repeated payload preparation after capture. Tests cover swallowed guard
exceptions, extra dispatch cleanup, throwing/rejecting cancellation, iteration
failure cleanup, and successful open-body handoff in both stream modes. The
four related converter/Native/compaction files passed 207 tests; TypeScript,
targeted lint and diff checks passed. This follow-up did not rerun the earlier
994-test suite or the online requests.

The final review regressions add deep unknown JSON (2,000 levels) for all three
APIs, rejection of a changed deep leaf, accepted object-key reordering, pending
body cancellation with later resolve/reject, named unpaired notification text
and orphan-output negatives, and 140,000 assistant text blocks for all three
APIs. Each of the four confirmed defects had a failing test before its fix.
The large-history tests verify max retains the content while the actual Native
body reaches fetch unchanged through the bounded temporary Context.
After these fixes, the four related files passed 221 tests; the broader
Responses/Native selection passed 48 files / 1,016 tests. The five lane-isolation
checks, root TypeScript, targeted lint and diff checks passed. The authorized
read-only local_oauth online suite was rerun with openai-codex/gpt-6-luna:
ordinary Pi low baseline, Native low text, medium strict-tool call/replay,
supported v2 compaction and opaque compaction replay all passed. Native turns
returned HTTP 200 with completed terminals. The external credential revision
remained unchanged. No encrypted reasoning item was returned, so that replay
remains uncertified.

This establishes feasibility for the tested Responses cases. It does not yet
authorize deleting production envelopes or declare all Native APIs/operations
certified.
