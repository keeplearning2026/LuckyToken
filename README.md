# LuckyToken

LuckyToken requires Node.js 22.19 or newer. The root project pins the Pi public
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

The integration suite uses an injected fixture `fetch` implementation. It does
not call the real CommandCode service or read `CommandcodeAPIKey.txt`.

## Local service configuration, client tokens, and Pi login

LuckyToken keeps deployment configuration and Pi runtime state separate:

```text
.luckytoken/
├── config.json                         # listener, protocol auth-file paths, Pi directory, limits
├── client-auth/
│   ├── anthropic-messages.json         # Anthropic global/project local tokens
│   └── openai-responses.json           # OpenAI Responses global/project local tokens
├── state/
│   ├── openai-responses.json           # durable Responses session history snapshot
│   ├── diagnostics/                    # permanent Runtime Diagnostics SQLite/WAL store
│   └── deep-diagnostics/               # bounded Deep Diagnostics capture SQLite/WAL store
└── pi/
    └── auth.json                       # mutable Provider credentials written by Pi login
```

Each Client Protocol handler has its own Auth file and immutable startup Auth
snapshot. Runtime selects the handler by HTTP method/path; Auth files contain
only global/project token scopes and do not identify or inspect another Client
Protocol. Pi `Models`, through its injected `CredentialStore`, is the only
runtime owner of Pi `auth.json`. The complete `.luckytoken/` directory and
every `auth.json` are ignored by Git.

## Globally Controlled Deep Diagnostics Capture

LuckyToken can deliberately capture raw request/response artifacts for
future requests while a single global switch is on. The switch is the
registered hot-apply setting `diagnostics.deepCapture.enabled` (default
`false`, config default under `deepDiagnostics.enabled`), controllable through
the Control Plane settings command — the desktop Settings / Developer Lab
toggle and `control settings set diagnostics.deepCapture.enabled true`.

While enabled, every request accepted by a Client Protocol handler captures
its original request body, the exact response bytes the client receives
(including the `x-luckytoken-request-id` correlation header), safe header
maps, and ordered event timing. The acceptance-time enable snapshot is
immutable: enabling affects only subsequently accepted requests, and
disabling never erases already captured data or interrupts an in-flight
capture. Disabled capture costs nothing on the request path (no body clone
or read) and capture faults never alter model responses.

Every artifact passes the same Ticket 07 universal redaction choke point as
Runtime Diagnostics (structural redaction for JSON bodies, the universal
text/header sanitizers, and the credential-owner known-value scrubber; the
capture store fails closed until the scrubber is attached). The complete
persisted record is budgeted in UTF-8 bytes below the Control Plane frame
ceiling (`maxCaptureBytes` per record, never above it), so every committed
capture is retrievable through the framed Control Plane query
(`get_capture`) — raw bodies never reach disk, events, or the wire
unredacted.

Retention is bounded by configurable age (`retentionAgeMs`, measured from
the acceptance-time snapshot) and capacity (`maxCaptures`) under
`deepDiagnostics`; eviction deletes capture rows only, writes a tiny
tombstone, and never touches the permanent Request Ledger or diagnostics
records. A request detail can truthfully distinguish `no-capture`,
`captured`, `partial`, `failed`, and `expired` states. A capture write fault
never changes a model response; it retries once with a minimal failed-state
marker and otherwise reports only a sanitized critical diagnostic (request
id + fixed code).

## Permanent Runtime Diagnostics

LuckyToken keeps a permanent, ordered stream of application-level
info/warning/error/critical events in a diagnostics-owned versioned
SQLite/WAL database (`.luckytoken/state/diagnostics/diagnostics.sqlite3` by
default, configured under `runtimeDiagnostics.directory`). Records are never
automatically aged out and survive application restarts. An event may carry a
`requestId` for correlation only; it never becomes part of a Request Ledger.

Every untrusted producer value passes through one recursive credential-
redaction choke point before it is persisted, queried, or delivered: header
names/values (Authorization, Proxy-Authorization, x-api-key, Cookie,
Set-Cookie), Pi credential shapes (api_key/access/refresh), query/form
credential keys, nested Errors/causes, cycles, accessors/proxies, and
oversized values. Redacted records may preserve header names, authentication
scheme/type, and a non-reversible keyed fingerprint, but never the original
value. The same sanitized committed records are the only ones reachable
through the Control Plane diagnostics query/typed-event surface (`get
_diagnostics`, `diagnostics_subscribe`) and any fallback output.

The CommandCode Private Provider is installed as the private workspace package
`@luckytoken/provider-commandcode-private` and loaded from `node_modules`
through the standard Pi Provider contract. Configure it under
`providerPackages`; no `models.json` entry is needed. Users authenticate with
`login` (API key only) and are then ready to serve.

```json
{
  "providerPackages": {
    "@luckytoken/provider-commandcode-private": {
      "conversion": {},
      "request": {},
      "response": {}
    }
  }
}
```

Only npm root package names (including scoped root names) are accepted. Package
import, contract/export validation, factory construction, and Provider ID
collision checks all complete before external Providers are registered. Pi
built-ins are registered first, then `models.json`, then external packages.
`serve`, `login`, and `logout` use this same loader; `client-token` only parses
configuration. The legacy `providerAdapters.commandcode-private` key is an
error. A missing Provider API key does not block `serve`; the standard Pi auth
path reports it when a model is invoked.

Create local files from the committed placeholders:

```powershell
New-Item -ItemType Directory -Force .luckytoken\pi
Copy-Item luckytoken.config.example.json .luckytoken\config.json
```

The shipped configuration enables both Anthropic Messages and OpenAI Responses
on one listener. A custom configuration can omit `openai-responses`; when it is
listed, its `stateFile`
(default `state/openai-responses.json` relative to the config directory)
persists the `previous_response_id` conversation history across restarts, so
Codex clients can continue an incremental session even after LuckyToken
restarts. Create its token file with the same `client-token` command:

```powershell
npm start -- client-token create openai-responses --global --config .luckytoken/config.json
```

Create an Anthropic protocol-global token, or bind one token to one project
directory. Omit `--token` to generate and print a new opaque token:

```powershell
npm start -- client-token create anthropic-messages --global --config .luckytoken/config.json
npm start -- client-token create anthropic-messages --project D:\project\Example --config .luckytoken/config.json
npm start -- client-token create anthropic-messages --project D:\project\Example --token chosen-token --config .luckytoken/config.json
```

A global token authorizes only the selected Client Protocol and produces no
project fact. A project token produces exactly its bound absolute `projectDir`,
which is mechanically projected to Pi `Options.metadata.projectDir`. Token file
mutation is a non-concurrent administrative operation. Use `client-token list`,
`rotate`, or `remove` with the same protocol and scope, then restart LuckyToken
to load the new Auth snapshot.

Authenticate CommandCode through Pi. The CLI discovers the available methods
from `Provider.auth`; CommandCode currently advertises only API-key login, not
subscription/OAuth:

```powershell
npm start -- login commandcode-private --config .luckytoken/config.json
```

The key is saved to `.luckytoken/pi/auth.json`. No `models.json` configuration
is required — the packaged model is selected as
`commandcode-private/deepseek/deepseek-v4-flash`.

Start the local listener:

```powershell
npm start -- --config .luckytoken/config.json
```

While that background application remains active, inspect or manage the model
gateway through the same Control Plane used by the desktop Dashboard:

```powershell
npm start -- control status --descriptor .luckytoken/control-plane.json
npm start -- control start --descriptor .luckytoken/control-plane.json
npm start -- control stop --descriptor .luckytoken/control-plane.json
npm start -- control restart --descriptor .luckytoken/control-plane.json
npm start -- control settings query --descriptor .luckytoken/control-plane.json
```

The canonical `models.json` is always LuckyToken-owned: it defaults to
`models.json` next to the config file, so the desktop layout places it at
`~/.luckytoken/models.json` — never inside the Pi credential directory
(`<pi.directory>/models.json`) and never Pi Agent's own data directory
(`~/.pi/agent/models.json`). An explicit `pi.modelsJson` overrides the
default. Providers and Models & Aliases pages in the desktop edit the same
file through the Control Plane, and the CLI exposes the identical commands:

```powershell
npm start -- control models query --descriptor .luckytoken/control-plane.json
npm start -- control models write-raw <revision> <content-file> --descriptor .luckytoken/control-plane.json
npm start -- control models write-structured <revision> <providers-file> --descriptor .luckytoken/control-plane.json
```

Every write validates the proposed content first, takes the file lock, and
replaces the file atomically; a write based on a stale revision returns an
explicit `conflict` and never overwrites newer content. An invalid existing
file is reported with its exact path and error and is never auto-overwritten.

Startup prints every served route, normally:

```text
LuckyToken POST http://127.0.0.1:3000/v1/messages
LuckyToken GET http://127.0.0.1:3000/v1/models
LuckyToken POST http://127.0.0.1:3000/v1/responses
```

Configure an Agent that supports a custom Anthropic base URL with
`http://127.0.0.1:3000` and the global/project token created for
`anthropic-messages`. That local token authenticates the Agent to LuckyToken;
it is unrelated to the CommandCode Provider credential.

Remove the stored Provider credential with:

```powershell
npm start -- logout commandcode-private --config .luckytoken/config.json
```

`SIGINT` and `SIGTERM` stop new connections, abort active requests, and wait for
the listener to close.

## Using the OpenAI Responses endpoint from the Codex CLI

Codex CLI can route through LuckyToken's `POST /v1/responses` endpoint
(`wire_api = "responses"`) so the local CommandCode provider serves the Codex
client. The integration is a Codex-side configuration that coexists with any
existing provider (e.g. opencodex): default `codex` runs unchanged, and
`codex -p luckytoken` switches to the local bridge.

### One-time Codex setup (user home, not this repo)

Three files under `~/.codex/`:

1. `config.toml` — defines the provider (the `[model_providers.luckytoken]`
   table). It points at the local base URL, selects the Responses wire API,
   and reads the client token from an environment variable so the existing
   `auth.json` is untouched:

   ```toml
   [model_providers.luckytoken]
   name = "LuckyToken"
   base_url = "http://127.0.0.1:3000/v1"
   wire_api = "responses"
   requires_openai_auth = true
   env_key = "LUCKYTOKEN_API_KEY"
   ```

2. `luckytoken.config.toml` — an isolated Codex profile that selects the
   provider and pins the model, so the default config stays unchanged:

   ```toml
   model_provider = "luckytoken"
   model = "commandcode-private/deepseek/deepseek-v4-flash"
   model_catalog_json = "C:\\Users\\huich\\.codex\\luckytoken-catalog.json"
   ```

3. `luckytoken-catalog.json` — model metadata (context window, reasoning
   levels, tool capabilities). Without a catalog entry Codex falls back to
   generic metadata and warns; the catalog makes the model fully usable.

   Note: `model_catalog_json` is a root-level Codex field, not a per-provider
   field (`--strict-config` rejects it inside `[model_providers]`), which is
   why the profile carries it instead of the provider table.

### Daily use

```powershell
# 1. Start the local service (port 3000)
cd D:\project\LuckyToken
npm start -- --config .luckytoken/config.json

# 2. Provide the client token for this terminal (or persist with setx)
$env:LUCKYTOKEN_API_KEY = "<your openai-responses global token>"

# 3. Run Codex through LuckyToken (interactive)
codex -p luckytoken

# or one-shot
codex exec -p luckytoken "your prompt"
```

The session header shows `provider: luckytoken` and
`model: commandcode-private/deepseek/deepseek-v4-flash` when the profile is
active. Plain `codex` (no `-p`) keeps using the default provider.

### How it works

```text
Codex CLI
   │  Responses wire (incremental + previous_response_id, store:false)
   ▼
LuckyToken POST /v1/responses   (Bearer: LUCKYTOKEN_API_KEY)
   │  expand previous_response_id from the durable snapshot
   │  convert wire → Pi IR
   ▼
CommandCode Private Provider Package (real upstream)
```

- Codex sends incremental turns with `previous_response_id`; LuckyToken
  expands them from the on-disk session snapshot and the Provider sees the
  full history.
- Codex's tool shapes are normalized by the adapter: OpenAI-hosted tools
  (`web_search`, `image_generation`) are skipped, freeform `custom` tools are
  exposed as single-input functions, `namespace` groups are flattened, and
  non-object tool `parameters` are wrapped in a JSON Schema object.
- Persist the token with `setx LUCKYTOKEN_API_KEY "<token>"` so every new
  terminal is ready; otherwise set it per terminal as shown above.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Connection refused` | local service not running | `npm start -- --config .luckytoken/config.json` |
| `401 authentication_error` | token env var missing | `$env:LUCKYTOKEN_API_KEY = "<token>"` |
| header shows `provider: openai` | profile not selected | add `-p luckytoken` |
| `Unknown model ... fallback metadata` | catalog not loaded | check `luckytoken-catalog.json` path in the profile |

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

The default model is `commandcode-private/deepseek/deepseek-v4-flash`. Override
only the model id explicitly when needed:

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

LuckyToken exposes a Node HTTP adapter around the Provider-blind Web Runtime.
Startup code constructs Pi `Models`, registers any standard Pi Providers, and
passes only `Models` and inbound `Auth` into the Runtime:

```ts
import { createModels } from "@earendil-works/pi-ai";
import {
  createAuth,
  createLuckyTokenRuntime,
  startLuckyTokenHttpServer,
} from "luckytoken";
import { createAnthropicMessagesHandler } from "luckytoken/protocols/anthropic";

const models = createModels();
models.setProvider(yourPiProvider);

const auth = createAuth({
  authorizeToken: async (token) => token === localClientKey ? {} : undefined,
  createFallbackSessionId,
});
const anthropic = createAnthropicMessagesHandler({ models, auth });
const runtime = createLuckyTokenRuntime({ clientProtocols: [anthropic] });
const server = await startLuckyTokenHttpServer({ runtime });

console.log(`${server.origin}/v1/messages`);
```

The listener defaults to `127.0.0.1:3000`; port `0` selects an available test
port. `close()` is idempotent, stops new connections, and aborts active request
signals. Concrete Provider configuration remains inside its Provider factory
and Pi registration path.
