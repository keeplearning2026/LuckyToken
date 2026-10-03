# Pi Native Anthropic Context Experiment

Status: isolated experiment on `codex/pi-native-context-experiment`, targeting
installed `@earendil-works/pi-ai@1.0.0`. Production Native uses its existing sender.
No installed Pi source, generated envelope or package version is changed.

## Flow and authority

```text
Client Anthropic Messages request
→ existing Token Native body projection (model / certified OAuth differential)
→ pure Anthropic max conversion: public Context/options, bounded notices
→ bound Context to the currently certified envelope consumers
→ public Pi Models.stream(): normalization, auth, adapter, SDK request
→ fetch seam substitutes the prepared Native JSON and verifies it
→ physical fetch, original Response captured unread
→ existing Native response coordinator
→ Client response
```

The prepared Native body is the sole request authority. Neither the max result
nor Pi's temporary payload can rebuild, repair or replace that body. Max is a
partial envelope query, not an executable Semantic invocation. Default and
explicit `semantic` parsing keep their original algorithm and failure behavior.
Auth, session, deadline and cancellation remain infrastructure inputs outside
Context. The experimental transport is in `test/support`; production has only
an optional sender injection seam, with the existing sender as its default.

`parseAnthropicTextInvocation(value, receivedAt, "max")` is synchronous and pure:
no IO, clock reads, credentials or mutable execution state. It reuses the
existing message, content, tools, tool-result, system, thinking and effort
parsers. Its surrounding partial conversion and envelope-presence markers are
new logic. Representable content is retained; Native-only content is omitted
with at most 32 notices. Missing image bytes are not fabricated as content:
empty query markers supply image presence only. Strict tool requirements are
softened for the discarded query; the real Native schema remains untouched.
Max alone expands string or mixed `document.source.content` into representable
text/image parts, including documents inside tool results. Tool-extension omissions and
serial tool-choice preferences are reported. Pending historical tool calls
use a request-local Map, so matching and removal do not scan or shift the
whole pending history. Default Semantic retains its original algorithms.

## Certified Pi envelope consumers

Source inspection covers installed `dist/models.js`,
`dist/api/anthropic-messages.js`, `dist/api/github-copilot-headers.js`, and
transcript helpers. The bounded Context excludes full text, historical tool
arguments and schema data so these cannot burden Pi's temporary body builder.

| Pi consumer | Query fact | Authority |
| --- | --- | --- |
| Copilot initiator | Last user versus non-user Pi role | Last Client message/block; a terminal tool result is agent initiated |
| Copilot vision | Image in user or tool-result content | Direct images or images inside `document.source.content`, including URL images; metadata is not scanned |
| Fine-grained tool beta | Initial top-level tool presence | Client tools array; Native server tools can contribute presence without a Pi tool representation |
| Interleaved thinking beta | Enabled/adaptive thinking | Representable Client thinking mapped to public options and `thinkingEnabled`; model compat and Pi decide the beta |
| Other beta selection | Explicit beta header, model compat, OAuth | Provider-owned Model/auth/options; Pi owns selection and precedence |
| Client/SDK envelope | Provider/baseURL, headers, session/cache retention, key | Resolved Model/auth and public request options, outside Context |

Initial top-level tools are retained as presence. No historical tool-state
updates are invented from unclaimed Client extensions. Mid-conversation tools,
federation, arbitrary future Context-dependent envelope behavior and every
Provider/auth combination are not certified. New Pi consumers require source
review and independent wire tests on upgrade.

## Request and authentication seams

Pi's Anthropic adapter always builds a streaming temporary request. The fetch
override runs after SDK beta/query/header preparation. It keeps that generated
URL/method/headers, removes a temporary content length, rejects unrecognized
content encoding, substitutes the prepared Native JSON, and compares decoded
JSON values before the real fetch. Unknown fields and array ordering are
preserved. JSON normalization such as `-0` to `0` is accepted; original source
JSON byte identity is not promised.

This same seam preserves `stream:true`, `stream:false` and omitted stream.
There is no SSE-to-JSON adapter for nonstreaming Native responses. The real
request's stream control is authoritative; Pi's forced stream applies only to
the discarded temporary request and private synthetic response.

Pi 1.0 selects its OAuth client branch using a token-string heuristic. Token's
managed Profile kind remains authoritative. When the resolved key disagrees
with that heuristic, public `apiKey`/`headers` options use a query-only branch
marker and the real Provider-owned credential header overrides it. Explicit
empty `apiKey` means already-resolved header-owned auth; a nonempty owned auth
header is required, ambient resolution is bypassed, and SDK marker credentials
are suppressed with null headers. Any marker surviving into outbound headers
fails before physical dispatch. This is a local experimental adaptation, not
a claim that Pi publicly accepts Token's credential kind. Pi still owns client
construction, identity and beta generation. No Pi client function is copied.

The factory composes with the existing Native coordinator's captured Profile
and `getAuth` result, body projection mode, resolved model and headers. Retry
after final 429 remains coordinator-owned and rebuilds these facts for the next
Profile. Each Pi query has zero retries and one permitted physical dispatch.
The experimental factory does not reproduce the production transport's full
diagnostic artifact publication; production diagnostics certification is
outside this experiment.

## Response, timeout and failure ownership

The real Response is captured by identity, unread, retaining status, headers
and bytes, including non-2xx and unknown content. Pi receives only a private
minimal successful Anthropic SSE response. Private parser failures after
capture may be ignored; independently recorded Token preparation/dispatch
guard failures and caller cancellation cannot be swallowed by that success
path. The caller signal is checked again before handing the captured Response
back after private Pi parsing.

The caller signal governs the actual request and subsequent response reads.
An explicit positive `timeoutMs` creates a separate response-header deadline,
cleared when fetch settles. It cannot time out later body reads. Zero disables
this deadline. The temporary SDK signal is not used for the real response
lifetime. Failed attempts that have captured a response initiate body
cancellation without waiting on potentially pending cleanup; cancellation
exceptions cannot replace the original failure. Successful responses remain
unread and uncanceled at the sender boundary.

Existing Native composition owns safe response headers, atomic body-read
failure, OAuth response name repair and model alias projection. Pi never
parses the actual upstream response. Default Semantic execution has no Native
payload substitution callback.

## Evidence and limits

`test/integration/pi-native-anthropic-context-experiment.test.ts` covers pure
default/max behavior, partial content, bounded notices, independent Pi Context
URL/method/full-header parity, Copilot user/assistant/tool-result roles and
images, managed credential-kind disagreements, Cloudflare header-owned auth,
all stream controls, raw non-2xx bytes, deep unknown JSON and large history,
repeated-hook failure, abandoned-body cancellation, and a local HTTP server's
header deadline followed by later body reads. Isolated Native composition
tests cover API key/OAuth projection, safe headers, alias projection,
precommit body-read failure and final-429 Profile switching.
Additional independent tests cover header conflicts, session/cache retention,
explicit/null beta overrides, second-dispatch guards and original network
failures. Regressions cover 10000 historical tool pairs, declared document
images/text and string content in user/tool-result documents, omitted-control
notice paths and cancellation during private Pi parsing.

The final targeted suite passes 37 tests; the broader guarded Anthropic,
Responses and Native regression run passes 76 files / 1298 tests. Root
TypeScript checking, changed-file ESLint, `git diff --check` and all 5 lane
isolation checks pass. Two inherited-model/effort review agents independently
reviewed functional/spec and standards/quality boundaries. Their confirmed
findings received regressions and fixes; both final reviews report no remaining
confirmed issues. The functional review independently passed 3 files / 98 tests.
These are offline and local HTTP results. No Anthropic live credentials or real upstream
request were used. Production replacement and online certification remain
separate work. Passing these tests does not guarantee arbitrary Pi upgrades;
upgrades must rerun the consumer and wire certification.
