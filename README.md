# Token

Token is a local Provider and model gateway for AI agents. It gives users
one place to manage their Provider access: local Codex models and Codex-native
authentication, as well as Pi's built-in and user-configured Providers, model
catalogs, and credential profiles. Credentials remain owned by their respective
authorities and are never collapsed into shared global authentication.

Token publishes the selected models through loopback endpoints compatible
with the OpenAI Responses and Anthropic Messages protocols. Any Agent that
supports either protocol can connect to Token and directly use models from
the managed Providers without implementing a separate integration for every
upstream service.

Token requires Node.js 22.19 or newer. The root project pins the Pi public
runtime contract used by the production path; the checked-in `pi-agent/` tree
is reference material.

Install dependencies from a clean checkout without running dependency lifecycle
scripts:

```powershell
npm ci --ignore-scripts
```

Validation commands:

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run test:distribution
npm run build
```

## Windows release

Windows has one release authority: a per-user Squirrel.Windows
`Token-Setup.exe`. The portable ZIP is not a Windows release artifact.

Build and fully certify an unsigned local candidate:

```powershell
npm run release:candidate
```

This command runs the source gates, builds once, binds every packaged E2E to
that exact EXE, verifies an isolated blank first run shows the built-in
Provider catalog, and then writes the installer, update files, SHA-256 values,
build identity, and certification manifest under
`artifacts/release-candidates/`.

An official release additionally requires a clean worktree and Authenticode
signing. Supply the certificate through environment variables; never commit
the certificate or password:

```powershell
$env:TOKEN_WINDOWS_CERTIFICATE_FILE = "C:\secure\Token.pfx"
$env:TOKEN_WINDOWS_CERTIFICATE_PASSWORD = "<secret>"
npm run release:windows
```

The official command runs in a blank Windows user and fails closed unless the
installer and installed EXE have valid signatures and the complete real
install/automatic-first-run/uninstall certification succeeds.
See `doc/release/WindowsReleaseProcess.md` for the release contract.

The integration suite uses an injected fixture `fetch` implementation. It does
not call the real CommandCode service or read `CommandcodeAPIKey.txt`.

## Local service configuration, Backend lifecycle, and Provider login

Token keeps Backend lifecycle state, deployment configuration, and Provider
credentials as separate authorities:

```text
.Token/
├── config.json                         # listener, protocol conversion, Pi directory, limits
├── instance.sqlite                    # Backend singleton lock carrier only
├── control-plane.json                 # current Control Plane discovery publication
├── models.json                        # Token-owned Provider/model catalog configuration
├── public-models.json                 # persisted Public Model enable/rename/endpoint state
├── state/
│   ├── openai-responses.json           # durable Responses session history snapshot
│   └── request-diagnostics/            # unified Request Journey and Runtime Event SQLite/WAL store
└── pi/
    └── auth.json                       # mutable Provider credentials written by Pi login
```

`instance.sqlite` contains no product state. The Backend holds a long-lived
SQLite `BEGIN IMMEDIATE` transaction on that dedicated file for the entire
Backend lifetime; the file is never deleted to signal ownership. In contrast,
`control-plane.json` is only a discovery hint for the current management
endpoint and capability. Descriptor existence is not liveness and no descriptor
lock participates in singleton correctness.

The model Data Plane is loopback-only and Token does not maintain a
separate global/project client-token authority. Provider credentials remain
owned by Pi/Provider credential authorities, while Codex Direct Mode requests
preserve the caller credential envelope to their fixed upstream. The complete
`.Token/` directory and every `auth.json` are ignored by Git.

## Unified Request Diagnostics

Token records Request Journeys, bounded redacted artifacts, and Runtime
Events in one diagnostics-owned SQLite/WAL database under
`.Token/state/request-diagnostics/`. The Control Plane v3 exposes one
strict management surface for journey queries/details/artifacts, Runtime Event
queries, analytics, history, export, and backup. Records identify the exact
phase, step, lane, outcome, and primary failure when those facts were observed.

Diagnostics are fail-open observation only. Serving never awaits diagnostics
I/O, accepts diagnostics backpressure, or changes routing, credentials,
conversion, transport, response, or terminal outcome because observation
failed. Management clients receive an explicit unavailable/degraded result
instead of a false empty history. Artifacts are copied only at existing
ownership seams, redacted before persistence, and bounded by the `diagnostics`
configuration limits.

### Enable journey capture in the desktop

Open the management window and select **Settings → Data & privacy**. The
**Full journey capture** card shows the resolved capture folder and diagnostics
storage health. It has two independent controls:

- **Capture every request journey** retains available artifact bodies for both
  successful and unsuccessful requests. It is disabled by default.
- **Force capture when a request fails** retains available artifact bodies for
  failed, aborted, or interrupted requests. It is enabled by default.

The status reads **All requests**, **Failures only**, or **Off**. Changes are
hot-applied, but each request keeps the policy that was active when that
request was admitted. Timeline, outcome, failure location, and artifact
descriptors remain recorded even when body retention is off.

The body-retention switches are Settings values, not keys in `config.json`.
The `diagnostics` section of `config.json` controls only the storage directory
and limits. The shipped defaults allow one naturally streamed JSON, JSONL, or
SSE artifact up to 64 MiB, all artifacts for one journey up to 512 MiB, and
retained artifact bodies up to 5 GiB, seven days, or 1,000 journeys, whichever
retention limit is reached first.

### Diagnose a request in the desktop UI

1. Select **Overview** and find the request in the **Requests** table. The
   initial time range is the current local day. Use the filter button to change
   **From/To** or filter by Provider, Profile, Model, Protocol, Session, or
   Outcome; use refresh when needed.
2. Expand the row with its disclosure arrow. **Request result** separates the
   HTTP result, duration, and diagnostics completeness. **Request facts** shows
   the Request ID, session, selected Profile, requested model, and resolved
   Provider/model when those facts were observed.
3. For an unsuccessful request, start with **Why this request failed/ended**.
   Its classification and **Detected at** location identify the primary phase
   and lane step. Then read **What happened** from Accepted through Responded.
4. Expand **Technical timeline** for the ordered observations. A started step
   without a matching completion is useful evidence for interruption or a
   hang; timeline entries are observations, not inferred causes.
5. Expand **Diagnostic captures** to inspect request, intermediate, upstream,
   and response artifacts. **View JSON** reads the first 64 KiB page;
   **Next page** advances through a large artifact while keeping only one page
   in renderer memory.

Capture state is part of the evidence:

- `captured` means the displayed bytes were stored completely;
- `partial` means only a bounded prefix is available;
- `unavailable` means no body is available and the displayed reason explains
  why, such as capture policy, redaction failure, capacity, or retention expiry;
- `not_applicable` means that artifact does not belong to the selected lane.

Always check the **Redacted**, **Truncated**, byte-count, media-type, and reason
labels. **Diagnostics: Complete** means the required diagnostic record was
stored; it does not promise that an optional Provider fact existed or was
observable.

### Read the request, intermediate state, and response artifacts

Use the committed lane shown in the request detail before interpreting artifact
names. A practical reading order is:

| Lane | Request-side evidence | Response-side evidence |
|---|---|---|
| Direct Mode | `client_request_wire`, `direct_outbound_request_envelope`, `direct_outbound_request_wire` | `direct_upstream_response_envelope`, `direct_upstream_response_wire`, then `client_response_wire` |
| Provider Native Preservation | `client_request_wire`, `provider_native_outbound_request_envelope.<attempt>`, `provider_native_outbound_request_wire.<attempt>` | `provider_native_upstream_response_envelope.<attempt>`, `provider_native_upstream_response_wire.<attempt>`, `provider_native_preserved_response_wire`, then `client_response_wire` |
| Semantic Conversion | `client_request_wire`, `pi_invocation_snapshot`, `pi_provider_request_payload` | `pi_provider_response_metadata`, `pi_provider_response_ir`, `pi_terminal_summary`, then `client_response_wire` |

Envelope artifacts contain only safe HTTP metadata; wire/payload artifacts
contain the bounded, redacted body available at that ownership seam. Attempt
suffixes let retries or Profile transitions be compared in order.

For Semantic Conversion, Pi 0.84.2 exposes the final Provider request payload,
safe response status/headers, and decoded Pi `AssistantMessage`. Adapter- or
SDK-internal raw Provider response events are not an observable contract and
are therefore not guaranteed artifacts. Use `pi_provider_response_ir` to see
the decoded Provider result and `client_response_wire` to see what Token
returned to the client. Direct Mode and Provider Native instead preserve the actual upstream
response wire they own.

### Read the capture files directly

Prefer the UI because it queries the running diagnostics authority and reports
typed unavailability. For read-only offline inspection, the installed default
is:

```text
%USERPROFILE%\.Token\state\request-diagnostics\
├── diagnostics-v3.sqlite3
├── diagnostics-v3.sqlite3-wal / diagnostics-v3.sqlite3-shm   (when active)
└── full-journeys\
    ├── .inflight\                                            (unfinished; ignore)
    └── YYYY-MM-DD\
        └── request-<hash>\
            ├── manifest.json
            └── artifacts\
                └── artifact-<hash>.json | .jsonl | .sse
```

If `diagnostics.directory` is customized, use the exact **Capture folder**
shown in **Settings → Data & privacy** instead of assuming the default.

The folder and file names are deliberately opaque hashes. Open
`manifest.json` first: it contains the real Request ID, protocol, lane, outcome,
and every artifact descriptor, including `artifactId`, `artifactKind`, state,
redaction/truncation facts, and the relative `file` when a body exists. Follow
that relative file into `artifacts/`; JSON, JSONL, and SSE bodies are ordinary
UTF-8 text and can be opened in a text editor or JSON viewer. Ignore
`.inflight`, because an active or interrupted capture may still be finalized or
discarded.

Treat the tree and SQLite database as read-only and do not edit, rename, or
delete individual files while Token is running. Use **Delete history** in
**Settings → Data & privacy** for managed deletion. Use **Create a full backup**
for a consistent diagnostic-index backup; full-journey body files remain in
the capture folder, so copy only the finalized journey folders needed for a
support bundle. Although bodies are centrally redacted before persistence,
request content can still be sensitive; inspect a bundle before sharing it.

If a successful request has artifact descriptors but no bodies, enable
**Capture every request journey** and send a new request. If Semantic
Conversion lacks a raw Provider response body, use its response metadata and
Pi response IR as described above. If the UI reports degraded or unavailable
diagnostics, use the stored reason and diagnostics health rather than treating
missing evidence as proof that serving failed.

Two CommandCode Providers are shipped as bundled product packages and registered
automatically through the standard Pi Provider contract:

- `commandcode-private` uses CommandCode's private `/alpha/generate` protocol;
- `commandcode-goat` uses Pi's `openai-completions` adapter at
  `https://api.commandcode.ai/provider/v1`.

Users must **not** add either bundled package to `providerPackages`; that key is
reserved for explicit external/user Provider Packages. No `models.json` entry
is required. The Providers share one price-free model capability catalog but
own independent authentication, transport, and response lifecycles. Private
projects all 58 current facts; Goat exposes the 40 entries whose minimum plan
is Go or GOAT and keeps every model on Chat Completions.

Only npm root package names (including scoped root names) are accepted for
user `providerPackages`. Package import, contract/export validation, factory
construction, and Provider ID collision checks complete before external
Providers are registered. Product composition registers Pi built-ins,
`models.json` Providers, the bundled CommandCode Providers, and then explicit
external/user packages according to the owning runtime contract. The legacy
`providerAdapters.commandcode-private` key is an error. A missing Provider API
key does not block Backend startup; Provider auth state is managed through the
standard Pi/Control Plane credential path.

Create local files from the committed placeholders:

```powershell
New-Item -ItemType Directory -Force .Token\pi
Copy-Item Token.config.example.json .Token\config.json
```

The shipped configuration enables both Anthropic Messages and OpenAI Responses
on one listener. A custom configuration can omit `openai-responses`; when it is
listed, its `stateFile` (default `state/openai-responses.json` relative to the
config directory) persists bounded `previous_response_id` session state across
restarts. No Token client-token file or `client-token` CLI setup is
required.

Authenticate CommandCode through Pi. The CLI discovers the available methods
from `Provider.auth`; CommandCode currently advertises only API-key login, not
subscription/OAuth:

```powershell
npm start -- login commandcode-private --config .Token/config.json
npm start -- login commandcode-goat --config .Token/config.json
```

Each key is saved under its own Provider ID in `.Token/pi/auth.json`. No
`models.json` configuration is required. Both Providers expose the canonical
model `deepseek/deepseek-v4-flash`; their default external names are
`commandcode-private/deepseek-v4-flash` and
`commandcode-goat/deepseek-v4-flash`.

Start the local Backend:

```powershell
npm start -- --config .Token/config.json
```

`serve` always participates in the current-user Backend instance domain. It
does not accept a custom Control Plane descriptor path: singleton authority is
fixed at `~/.Token/instance.sqlite`, and the matching discovery publication
is fixed at `~/.Token/control-plane.json`. This keeps singleton ownership
and discovery in the same domain.

While that Backend remains active, inspect or manage the model gateway through
the same versioned Control Plane used by Electron Main:

```powershell
npm start -- control status --descriptor .Token/control-plane.json
npm start -- control start --descriptor .Token/control-plane.json
npm start -- control stop --descriptor .Token/control-plane.json
npm start -- control restart --descriptor .Token/control-plane.json
npm start -- control settings query --descriptor .Token/control-plane.json
```

The canonical `models.json` is always Token-owned: it defaults to
`models.json` next to the config file, so the desktop layout places it at
`~/.Token/models.json` — never inside the Pi credential directory
(`<pi.directory>/models.json`) and never Pi Agent's own data directory
(`~/.pi/agent/models.json`). An explicit `pi.modelsJson` overrides the
default. Providers and Models & Aliases pages in the desktop edit the same
file through the Control Plane, and the CLI exposes the identical commands:

```powershell
npm start -- control models query --descriptor .Token/control-plane.json
npm start -- control models write-raw <revision> <content-file> --descriptor .Token/control-plane.json
npm start -- control models write-structured <revision> <providers-file> --descriptor .Token/control-plane.json
```

Every write validates the proposed content first, takes the file lock, and
replaces the file atomically; a write based on a stale revision returns an
explicit `conflict` and never overwrites newer content. An invalid existing
file is reported with its exact path and error and is never auto-overwritten.

Startup prints every served route, normally:

```text
Token POST http://127.0.0.1:3000/v1/messages
Token GET http://127.0.0.1:3000/v1/models
Token POST http://127.0.0.1:3000/v1/responses
```

Configure an Agent that supports a custom Anthropic base URL with
`http://127.0.0.1:3000`. Token does not require a separate local
client-token credential for the loopback Data Plane. Provider authentication is
managed independently through the Provider/Pi credential authority.

Remove the stored Provider credential with:

```powershell
npm start -- logout commandcode-private --config .Token/config.json
npm start -- logout commandcode-goat --config .Token/config.json
```

`SIGINT` and `SIGTERM` stop new connections, abort active requests, and wait for
the listener to close.

## Codex integration

Token now manages Codex integration as a Backend-owned capability rather
than asking the user to maintain a separate Codex provider/profile and a
Token client token. The Electron UI exposes Enable/Disable and Sync
operations through the Application Control Plane.

When enabled, the Backend owns the managed root routing keys in Codex
`config.toml`:

```text
model_provider
openai_base_url
model_catalog_json
```

The active target uses Codex's built-in `openai` Responses provider, points
`openai_base_url` at Token's loopback `/v1` endpoint, and writes a generated
model catalog under Token's Codex-integration state directory. Token
stores the previous root values as a preimage and restores them on disable or
Backend shutdown. If those root keys drift while integration is enabled, the
state is reported as drift/conflict instead of guessing or overwriting
silently.

The generated catalog combines Codex-native models with the currently published
Token Public Models. Codex-native requests use Direct Mode and preserve the
caller credential envelope; published external
models use the appropriate Provider Native or Semantic Conversion lane. There
is no `TOKEN_API_KEY` setup and no Token `client-token` command.

Typical desktop use is:

```text
start Token Desktop
→ Providers: authenticate/enable the Providers and Models you want
→ enable Codex integration
→ Sync Codex when the UI reports that the generated catalog is stale
→ use Codex normally with the published Token model names
```

Troubleshooting:

| Symptom | Meaning | Action |
|---|---|---|
| Codex integration says `native` | Token has not taken ownership of Codex root routing keys | Enable integration |
| state is `drifted` | Codex routing keys changed after Token applied them | Review the external change, then Sync or Disable |
| state is `conflict` | duplicate/invalid root routing keys prevent safe management | fix `config.toml`, then retry |
| published model missing | Public Model/Provider state is not currently publishable | authenticate/enable it in Providers and Sync Codex |

## Explicit online verification

The authorized online suite is deliberately excluded from `npm test`. It reads
the ignored `CommandcodeAPIKey.txt` only into memory, starts a real loopback
listener, and drives CommandCode through Pi with the official Anthropic SDK.
Its stress phase performs 60 Provider requests with concurrency 5: 36 JSON, 14
Atomic SSE, 5 observed upstream cancellations, and 5 same-session recovery
calls. A second conformance phase covers request controls, history, thinking
replay, tool call/result identity, terminal/usage mapping, concurrent isolation,
the complete Atomic SSE event lifecycle, and real global/project Auth scope
propagation.

```powershell
npm run test:online
```

The online harness defaults to the internal canonical selector
`commandcode-private/deepseek/deepseek-v4-flash`; this harness exercises a
direct composition test seam rather than the product's alias-only client
identity. Override only the model id explicitly when needed:

```powershell
npm run test:online -- --model provider/model-id
```

The command writes controlled real-wire evidence to the ignored
`.online-artifacts/commandcode-conformance-samples.json`: Anthropic SDK requests
and results, SDK stream events, Provider requests, and complete raw Provider
JSONL through physical EOF. Authorization values are replaced by a fixed marker
and both client and Provider keys are rejected if they occur anywhere in the
artifact. Use `--samples <path>` to select a different output. The terminal
summary contains counts, failure categories, and aggregate latency.

The OpenAI Responses online suite drives the same real CommandCode provider
through the `/v1/responses` endpoint with genuine Codex-style incremental
semantics: `previous_response_id` chaining with upstream history-expansion
evidence, durable snapshot recovery across a simulated process restart, atomic
SSE lifecycle, function_call → function_call_output tool round-trips,
the configured `store:false` policy (`honor` by default, or explicit `memory` /
`persist`), typed unknown/expired/evicted continuation failures, client
cancellation, per-protocol Auth isolation, and concurrent isolation.

```powershell
npm run test:online-responses
```

The full online distribution matrix also exercises the direct packaged Pi
factory and both real clients. Except for the direct IR characterization probe,
these runners load CommandCode through the generic loader from `node_modules`:

```powershell
npx tsx test/online/pi-commandcode-ir-probe.ts
npm run test:online
npm run test:online-responses
npm run test:online-codex -- 3
npm run test:online-claude -- 3
```

The 2026-08-14 distribution record is `online-passed`: direct IR 23/23,
Anthropic 60/60, Responses 60/60, Codex CLI 60/60 (20 scenarios × 3), and
Claude Code 51/51 (17 scenarios × 3). The sanitized record is
`test/fixtures/certification/online-validation-2026-08-14.json`; detailed wire
artifacts remain ignored under `.online-artifacts/`.

Malformed known events, unknown future events, terminal-less EOF, retry timing,
UTF-8/chunk splitting, and unsupported image capability gates remain
deterministic offline fault-injection cases because a healthy real service
cannot be instructed to produce those failures reliably.

## Programmatic local Anthropic server

Token exposes a Node HTTP adapter around the Provider-blind Web Runtime.
Startup code constructs Pi `Models`, registers any standard Pi Providers, and
passes only `Models` and inbound `Auth` into the Runtime:

```ts
import { createModels } from "@earendil-works/pi-ai";
import {
  createAuth,
  createTokenRuntime,
  startTokenHttpServer,
} from "Token";
import { createAnthropicMessagesHandler } from "Token/protocols/anthropic";

const models = createModels();
models.setProvider(yourPiProvider);

const auth = createAuth({
  authorizeToken: async (token) => token === localClientKey ? {} : undefined,
  createFallbackSessionId,
});
const anthropic = createAnthropicMessagesHandler({ models, auth });
const runtime = createTokenRuntime({ clientProtocols: [anthropic] });
const server = await startTokenHttpServer({ runtime });

console.log(`${server.origin}/v1/messages`);
```

The listener defaults to `127.0.0.1:3000`; port `0` selects an available test
port. `close()` is idempotent, stops new connections, and aborts active request
signals. Concrete Provider configuration remains inside its Provider factory
and Pi registration path.
