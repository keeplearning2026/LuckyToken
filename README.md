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
npm run build
```

The integration suite uses an injected fixture `fetch` implementation. It does
not call the real CommandCode service or read `CommandcodeAPIKey.txt`.

## Local service configuration and Pi login

LuckyToken keeps deployment configuration and Pi runtime state separate:

```text
luckytoken.config.json        # listener, inbound client auth, Pi directory, limits
.luckytoken/pi/
├── models.json               # static Pi Provider/model configuration
└── auth.json                 # mutable Provider credentials written by Pi login
```

`models.json` and `auth.json` share one Pi directory but have different owners.
The model-config loader never reads credentials. Pi `Models`, through its
injected `CredentialStore`, is the only runtime owner of `auth.json`.
`luckytoken.config.json`, `.luckytoken/`, and every `auth.json` are ignored by
Git.

Create local files from the committed placeholders:

```powershell
Copy-Item luckytoken.config.example.json luckytoken.config.json
New-Item -ItemType Directory -Force .luckytoken\pi
Copy-Item models.example.json .luckytoken\pi\models.json
```

Authenticate CommandCode through Pi. The CLI discovers the available methods
from `Provider.auth`; CommandCode currently advertises only API-key login, not
subscription/OAuth:

```powershell
npm start -- login commandcode-private --config luckytoken.config.json
```

The key is saved to `.luckytoken/pi/auth.json`. The CommandCode entry in
`models.json` contains only static Provider/model facts; it does not contain or
resolve the Provider credential.

Start the local listener:

```powershell
npm start -- --config luckytoken.config.json
```

Startup prints the actual endpoint, normally
`http://127.0.0.1:3000/v1/messages`. Configure an Agent that supports a custom
Anthropic base URL with `http://127.0.0.1:3000` and the local client key from
`luckytoken.config.json`. That local key authenticates the Agent to LuckyToken;
it is unrelated to the CommandCode Provider credential.

Remove the stored Provider credential with:

```powershell
npm start -- logout commandcode-private --config luckytoken.config.json
```

`SIGINT` and `SIGTERM` stop new connections, abort active requests, and wait for
the listener to close.

## Explicit online verification

The authorized online suite is deliberately excluded from `npm test`. It reads
the ignored `CommandcodeAPIKey.txt` only into memory, starts a real loopback
listener, and drives CommandCode through Pi with the official Anthropic SDK.
Its stress phase performs 60 Provider requests with concurrency 5: 36 JSON, 14
Atomic SSE, 5 observed upstream cancellations, and 5 same-session recovery
calls. A second conformance phase covers request controls, history, thinking
replay, tool call/result identity, terminal/usage mapping, concurrent isolation,
and the complete Atomic SSE event lifecycle.

```powershell
npm run test:online
```

The default model is `deepseek/deepseek-v4-flash`. Override only the model id
explicitly when needed:

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
