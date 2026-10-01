# Provider Quota Acquisition Inventory

**Status:** research input for implementation
**Date:** 2026-09-28
**Scope:** every Provider that the current Backend can register, plus the two Token-bundled Providers. This document describes how to obtain quota or balance information, what wire shape the information has, what conditions the upstream API requires, and whether the current Token credential can satisfy those conditions.

This document does not define the card UI and does not propose a shared quota executor. Acquisition is per Provider. The card is a separate projection that only renders bounded text.

## 1. Conclusions

1. The feature is feasible without modifying Pi or `pi-agent/`.
2. Every Provider must own its own `ProviderQuotaProbe`. The central authority may bind `providerId` to a probe, cache results, and contain failures, but it must not contain endpoint or response-shape policy.
3. `commandcode-private` and `commandcode-goat` are separate probes. They do not share a probe instance, credential binding, or Provider identity. Even if their upstream protocol looks similar, each module owns its own endpoint validation, credential use, parsing, and text generation.
4. The current Token credential can be used for most API-key Providers whose quota endpoint accepts a Bearer token. OAuth-only quota sources work when the resolved OAuth access token is sufficient. A few Providers need a narrow, Provider-owned auth fact or passive observation (notably `openai-codex` and `meta`).
5. Many Pi built-ins have no quota-reader evidence in opencodex. They must remain `unsupported` or `unavailable` until a Provider-specific endpoint is verified. The system must not fabricate a percentage for them.
6. The project API key in `CommandcodeAPIKey.txt` was live-probed on 2026-09-28. It returned a Goat-plan account and valid 5-hour, weekly, and credit data. The key itself is not recorded here.

## 2. Current Provider set

The Backend builds its Provider collection from:

1. 41 Pi built-ins returned by `builtinProviders()`.
2. Two Token-bundled Providers:
   - `commandcode-private`
   - `commandcode-goat`
3. User `models.json` Providers.
4. Loaded user Provider Packages.

The current built-in IDs are:

```text
amazon-bedrock
ant-ling
anthropic
azure-openai-responses
baseten
cerebras
cloudflare-ai-gateway
cloudflare-workers-ai
deepseek
fireworks
github-copilot
google
google-vertex
groq
huggingface
kimi-coding
meta
minimax
minimax-cn
mistral
moonshotai
moonshotai-cn
nvidia
openai
openai-codex
opencode
opencode-go
openrouter
qwen-token-plan
qwen-token-plan-cn
qwen-token-plan-individual
radius
together
vercel-ai-gateway
xai
xiaomi
xiaomi-token-plan-ams
xiaomi-token-plan-cn
xiaomi-token-plan-sgp
zai
zai-coding-cn
```

Custom `models.json` Providers and user Provider Packages are arbitrary. They have no generic quota method. A quota method for them requires either:

- a Provider-specific Token-owned probe; or
- a future optional quota capability in the Provider Package contract.

## 3. Acquisition architecture

### 3.1 Two modules

```text
Acquisition module
  ProviderQuotaAuthority
    providerId -> ProviderQuotaProbe

Display module
  ProviderCard
    providerId -> bounded text
```

The acquisition module owns:

- Provider-specific endpoint and request shape;
- credential use;
- response validation;
- normalized observation;
- failure classification;
- cache and in-flight de-duplication.

The display module owns only:

- when to query;
- the mapping `providerId -> text`;
- rendering the text.

### 3.2 Proposed observation shape

The first implementation can use bounded text because the card only renders text:

```ts
export type ProviderQuotaObservation =
  | {
      readonly state: "observed";
      readonly text: string;
      readonly source: string;
      readonly observedAt: number;
    }
  | { readonly state: "unsupported" }
  | {
      readonly state: "unavailable";
      readonly reason: "auth" | "network" | "upstream" | "schema";
    };
```

If the product later needs bars, colors, or multiple windows, this can be widened to a structured window list without changing the per-Provider probe ownership. The current design deliberately does not add that structure yet.

### 3.3 Credential access

The only supported way to use a stored credential is inside the exact Provider credential binding:

```ts
const capture = await providerRuntime.providerAuthBindings.capture(providerId);
const auth = await providerRuntime.providerAuthBindings.runBound(
  capture,
  () => providerRuntime.models.getAuth(providerId),
);
```

`Models.getAuth(providerId)` resolves:

- a managed API-key credential;
- a managed OAuth credential, including the normal non-interactive refresh path;
- an ambient Provider auth source when the Provider has no managed Profile.

It returns only `AuthResult`:

```ts
{
  auth: {
    apiKey?: string;
    headers?: Record<string, string>;
    baseUrl?: string;
  };
  env?: Record<string, unknown>;
  source?: string;
}
```

The probe is run within the binding scope. Raw credentials are never put in the Control Plane projection, renderer, logs, or error text.

### 3.4 Credential facts that `AuthResult` does not carry

Some Provider quota endpoints need a Provider-specific non-secret fact that `AuthResult` does not expose:

| Provider | Missing fact | Why it is needed | Options |
|---|---|---|---|
| `openai-codex` | ChatGPT account id | WHAM requires the account header in addition to the OAuth bearer | Decode `chatgpt_account_id` from the OAuth access-token JWT, or expose a narrow Provider-owned quota credential fact |
| `meta` | Muse identity token | The key-mint endpoint accepts the identity token, while prebuilt `AuthResult` exposes only the minted Model API key | Read the stored OAuth `refresh` field through a narrow Provider-owned quota auth adapter, or rely on the in-stream `response.subscription_usage` observation |

These are Provider-specific extensions. They do not justify exposing the whole credential record to probes or to the Control Plane.

### 3.5 OAuth refresh policy

`Models.getAuth()` may perform a non-interactive OAuth refresh. That is acceptable for an explicit quota-refresh action, but it should not be triggered by an idle automatic card poll.

The first implementation should therefore distinguish:

- cached query: return the last observation and its age, no network;
- explicit refresh: resolve auth and probe upstream;
- optional background refresh: only with a bounded TTL and no interactive login.

## 4. Provider inventory

### 4.1 Token-bundled Providers

#### `commandcode-goat`

**Reference:** opencodex `fetchCommandCodeQuota` at `reference/opencodex/src/providers/quota/vendor-probes-key.ts:1186`.

**Information obtainable**

- 5-hour used percentage and reset time;
- weekly used percentage and reset time;
- current subscription-period spend;
- remaining monthly, purchased, and free credits;
- computed credit-used percentage;
- subscription plan id and period boundaries.

**How to obtain**

1. `GET https://api.commandcode.ai/alpha/whoami`
2. If `org.id` exists, use `?orgId=<id>` on subsequent calls.
3. `GET /alpha/billing/credits`
4. `GET /alpha/billing/subscriptions`
5. `GET /alpha/usage/summary?since=<currentPeriodStart>`

**Wire shape**

```json
{
  "credits": {
    "monthlyCredits": 48.83,
    "purchasedCredits": 0,
    "freeCredits": 0
  },
  "windowLimits": {
    "fiveHour": { "cap": 14, "used": 7.44, "resetAt": "..." },
    "weekly": { "cap": 35, "used": 21.16, "resetAt": "..." }
  }
}
```

```json
{
  "currentPeriodStart": "2026-09-23T07:06:33.000Z",
  "currentPeriodEnd": "2026-10-23T07:06:33.000Z",
  "planId": "individual-goat"
}
```

**Normalization**

- `fiveHourPercent = fiveHour.used / fiveHour.cap * 100`
- `weeklyPercent = weekly.used / weekly.cap * 100`
- `remainingCredits = max(0, monthlyCredits) + max(0, purchasedCredits) + max(0, freeCredits)`
- `usedCredits = totalCost ?? totalMonthlyCredits`
- `creditLimit = usedCredits + remainingCredits`
- `creditPercent = usedCredits / creditLimit * 100`
- A `resetAt` of `0` or a negative value is absent, not the Unix epoch.
- If `currentPeriodStart` is absent, omit the credit row but keep 5-hour and weekly.
- If `purchasedCredits > 0`, do not claim that the aggregate credit row expires at `currentPeriodEnd`.

**Conditions**

- Bearer API key only for the Token-bundled Goat Provider.
- Canonical host must be `https://api.commandcode.ai`; bundled Anthropic models use `/provider`, while bundled OpenAI models use `/provider/v1`. The quota endpoints are the `/alpha/...` routes on the same host.
- The key must be authorized for `whoami`, `billing/credits`, `billing/subscriptions`, and `usage/summary`.
- Personal accounts may have no `org.id`; the calls still work without `orgId`.

**Our credentials**

The Token-bundled Provider stores an API key in the Provider credential Profile. That key can be used directly as the Bearer token. The live probe in section 6 proves this path for an `individual-goat` key.

#### `commandcode-private`

**Reference:** the same upstream CommandCode protocol has been observed, but this Provider must not reuse the Goat probe, the Goat credential, or the Goat Provider identity.

**Information obtainable**

The same information as Goat only if the Private key is authorized for the same `/alpha/...` endpoints:

- 5-hour usage;
- weekly usage;
- current-period spend;
- credit pools.

**How to obtain**

Use a Private-owned probe with its own canonical-destination validation and its own credential binding:

```text
providerId = commandcode-private
credential = commandcode-private active API key
endpoint = the canonical CommandCode `/alpha/...` routes
```

The Private probe may produce the same text shape as Goat, but the module, tests, cache key, and credential access are separate.

**Conditions**

- Private has its own stored API key.
- The key must be valid for the CommandCode alpha accounting API.
- Private's request base URL may be `https://api.commandcode.ai`, but the probe still owns its own canonical-host check.
- Do not fall back to the Goat credential when Private has no key.
- Do not share observations between the two Providers: a key or plan can differ.

**Our credentials**

Potentially yes, but it must be proven with the Private key. The current `CommandcodeAPIKey.txt` probe returned `planId: individual-goat`; that result belongs to the Goat path and is not evidence for the Private Provider.

### 4.2 Pi built-ins with reusable opencodex readers

#### `openai-codex`

**Information obtainable**

- 5-hour usage when WHAM reports a sub-day primary window;
- weekly usage;
- monthly usage when WHAM reports a monthly primary or tertiary window;
- reset credits;
- plan type and additional rate-limit facts.

**How to obtain**

```text
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <OAuth access token>
chatgpt-account-id: <account id>
```

**Wire shape**

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "primary_window": {
      "used_percent": 42,
      "reset_at": 1780000000,
      "limit_window_seconds": 18000
    },
    "secondary_window": {
      "used_percent": 17,
      "reset_at": 1780500000,
      "limit_window_seconds": 604800
    },
    "tertiary_window": null
  },
  "rate_limit_reset_credits": { "available_count": 2 },
  "additional_rate_limits": []
}
```

**Normalization**

- A primary window shorter than 24 hours is the 5-hour/burst window.
- A primary window of at least 28 days is the monthly window.
- Otherwise the primary window is the weekly candidate and the secondary window is the weekly fallback.
- Go/Free plans display the monthly window; other plans display weekly plus any monthly supplementary window.
- The retired Spark custom windows must not be re-created.

**Conditions**

- OAuth only. The built-in `openai-codex` Provider has no API-key auth.
- The access token must be valid for the ChatGPT backend.
- The `chatgpt-account-id` header is required by the WHAM route.

**Our credentials**

Yes, with one Provider-specific gap: the OAuth credential contains `accountId`, but `Models.getAuth()` returns only the access token. The probe must either decode `chatgpt_account_id` from the access-token JWT or receive a narrow Provider-owned account-id fact. It must not receive the refresh token.

#### `anthropic`

**Information obtainable**

- 5-hour usage and reset;
- 7-day weekly usage and reset;
- model-scoped weekly windows for Fable, Opus, and Sonnet when the upstream `limits[]` array contains a recognized `weekly_scoped` limit.

**How to obtain**

OAuth subscription:

```text
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <OAuth access token>
anthropic-beta: claude-code-... , oauth-...
User-Agent: Claude Code CLI identity
```

API key:

- no separate documented usage endpoint is used by opencodex;
- quota can be observed only from successful response headers:
  - `anthropic-ratelimit-unified-5h-utilization`
  - `anthropic-ratelimit-unified-7d-utilization`
  - matching reset headers.

**Wire shape**

```json
{
  "five_hour": { "utilization": 31.5, "resets_at": "..." },
  "seven_day": { "utilization": 22.0, "resets_at": "..." },
  "seven_day_opus": { "utilization": 10.0, "resets_at": "..." },
  "limits": [
    {
      "kind": "weekly_scoped",
      "percent": 10,
      "scope": { "model": { "display_name": "Opus" } },
      "resets_at": "..."
    }
  ]
}
```

**Conditions**

- OAuth usage endpoint requires an Anthropic OAuth access token.
- API-key quota is not a proactive endpoint in the reference implementation.
- The API-key path can only supplement the cache from in-band headers after a request.
- The model-scoped label must be structurally recognized; an arbitrary display name must not be published.

**Our credentials**

- OAuth: yes, the resolved access token can call `/api/oauth/usage`.
- API key: not as a proactive probe. Only in-band observation after a real Anthropic request.

#### `xai`

**Information obtainable**

- weekly credit usage and reset;
- legacy monthly dollar-pool usage when the weekly credit route is unavailable.

**How to obtain**

Weekly credit route:

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
Authorization: Bearer <OAuth access token>
x-userid: <user id>
xai client-version headers
```

Legacy route:

```text
GET https://cli-chat-proxy.grok.com/v1/billing
Authorization: Bearer <OAuth access token>
```

**Wire shape**

```json
{
  "config": {
    "creditUsagePercent": 12,
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "end": "2026-10-01T00:00:00Z"
    }
  }
}
```

Legacy monthly:

```json
{
  "config": {
    "monthlyLimit": { "val": 1500 },
    "used": { "val": 510 },
    "billingPeriodEnd": "..."
  }
}
```

**Conditions**

- OAuth only for the opencodex reader.
- The user id is required for the weekly credit route; opencodex takes it from the credential when present and otherwise decodes the JWT `sub`.
- API-key auth has no opencodex quota reader.

**Our credentials**

- OAuth: potentially yes. The access token is available through `Models.getAuth()`; the user id may need to be decoded from the JWT or exposed as a narrow Provider-owned fact.
- API key: no reference method. Keep unsupported until verified.

#### `kimi-coding`

**Information obtainable**

- 5-hour usage and reset;
- weekly usage and reset;
- total subscription credit usage when a `totalQuota` row exists.

**How to obtain**

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <Kimi API key or OAuth access token>
```

**Wire shape**

The parser accepts both direct and `data`-enveloped payloads:

```json
{
  "usage": { "limit": 100, "used": 25, "resetTime": "..." },
  "totalQuota": { "limit": 1000, "used": 200, "resetTime": "..." },
  "limits": [
    {
      "name": "5h",
      "detail": { "limit": 100, "used": 25, "resetTime": "..." }
    },
    {
      "name": "weekly",
      "detail": { "limit": 1000, "used": 200, "resetTime": "..." }
    }
  ]
}
```

**Normalization**

- A row identified as 300 minutes or 5 hours maps to `fiveHourPercent`.
- A row identified as 7 days or 168 hours maps to `weeklyPercent`.
- `totalQuota` maps to a custom `Total subscription credits` row.
- A row may provide `utilization`, `percent`, `usedPercent`, or `used_percent` directly when limit arithmetic is absent.

**Conditions**

- API key and OAuth are both supported by the reference reader.
- The base URL must be the canonical Kimi Code host. The Pi Provider base URL is `https://api.kimi.com/coding`; the usage route is fixed at `/coding/v1/usages`.

**Our credentials**

Yes for both managed API key and managed OAuth. The resolved `AuthResult` is enough to create the Bearer header; no extra identity field is required.

#### `meta`

**Information obtainable**

- 5-hour subscription window when the stream or key-mint payload declares a 300-minute window;
- weekly subscription window;
- other declared window durations as custom windows.

**How to obtain**

There is no REST quota endpoint in opencodex. Two observed sources exist:

1. In-stream frame:

```json
{
  "type": "response.subscription_usage",
  "subscription": {
    "window": {
      "used_percent": 12,
      "resets_at": 1788431188,
      "window_duration_mins": 300
    },
    "weekly": {
      "used_percent": 4,
      "resets_at": 1788739200
    }
  }
}
```

2. Device-login/key-mint response carrying `subs_usage`, parsed by the same mapper.

**Normalization**

- `window.window_duration_mins === 300` maps to the 5-hour window.
- Any other declared duration becomes a custom label based on the duration; a ten-hour window must not be filed as five-hour.
- `weekly.used_percent` maps to the weekly window.

**Conditions**

- Muse subscription OAuth only. The Pi meta Provider stores the minted Model API key as `access` and the Muse identity token as `refresh`.
- A proactive key-mint probe needs the identity token, which `Models.getAuth()` does not expose.
- The passive stream path needs a real streaming Meta turn; it cannot refresh on demand.

**Our credentials**

Conditional:

- Passive: yes, if we observe the `response.subscription_usage` frame during a Meta turn.
- Proactive: requires a narrow Provider-owned quota auth adapter that can access the stored OAuth `refresh` identity token, or a future Pi public auth operation. `Models.getAuth()` alone is insufficient.

#### `openrouter`

**Information obtainable**

- per-key spending limit;
- lifetime key usage;
- remaining limit;
- computed used percentage;
- a balance-only row when no cap is configured.

**How to obtain**

```text
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <OpenRouter API key>
```

**Wire shape**

```json
{
  "data": {
    "limit": 100,
    "limit_remaining": 73.5,
    "usage": 26.5
  }
}
```

**Normalization**

- Prefer `limit_remaining` to derive used amount.
- If no positive `limit` is configured, there is no hard cap and no bar.
- The row label is `API credits ($<remaining> of $<limit> remaining)`.

**Conditions**

- The upstream key must have a positive per-key spending cap.
- A successful response with no cap is authoritative and must drop an old capped row.
- Canonical host must be `https://openrouter.ai`; Pi's OpenAI models use `/api/v1` and Anthropic models use `/api`. The quota endpoint stays `/api/v1/key`.

**Our credentials**

- API key: yes.
- OAuth: Pi uses the OAuth token as an API key for inference, but whether it is accepted by `/api/v1/key` is not proven by opencodex. Treat as conditional until probed.

#### `opencode-go`

**Information obtainable**

- rolling/short window percentage;
- weekly percentage;
- monthly percentage.

**How to obtain**

```text
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OpenCode API key>
```

**Wire shape**

```json
{
  "usage": {
    "rolling": { "percent": 12.5, "resetsAt": "..." },
    "weekly": { "percent": 8.0, "resetsAt": "..." },
    "monthly": { "percent": 3.0, "resetsAt": "..." }
  }
}
```

**Normalization**

- `rolling` maps to `fiveHourPercent`.
- `weekly` maps to `weeklyPercent`.
- `monthly` maps to `monthlyPercent`.
- `percent` is already in the 0..100 domain.

**Conditions**

- API key only.
- Canonical host must be `https://opencode.ai`; Pi's OpenAI models use `/zen/go/v1` and Anthropic models use `/zen/go`. The usage endpoint stays `/zen/go/v1/usage`.
- The response must contain a `usage` object.

**Our credentials**

Yes. The built-in `opencode-go` Provider stores an API key; `Models.getAuth()` resolves it directly.

#### `deepseek`

**Information obtainable**

- one account balance per returned currency (`CNY`, `USD`);
- granted balance component when present;
- topped-up balance component when present.

There is no consumed percentage and no time-window quota. The display is balance rows, not a usage bar.

**How to obtain**

```text
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DeepSeek API key>
```

**Wire shape**

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "9.39",
      "granted_balance": "0.00",
      "topped_up_balance": "9.39"
    },
    {
      "currency": "USD",
      "total_balance": "0.00",
      "granted_balance": "0.00",
      "topped_up_balance": "0.00"
    }
  ]
}
```

Live observation (2026-10-01): both rows are returned for a CNY-funded account, and the upstream array order changed between calls.

**Normalization**

- Emit one `{ kind: "balance", amount, currency }` per valid currency row instead of collapsing to a single currency.
- Deterministic fact order: funded (`amount > 0`) rows first, then USD, then CNY, then other currencies by code. The upstream array order is never trusted.
- `total_balance` wins; otherwise `granted_balance`, then `topped_up_balance`. A negative or unparseable amount skips that row; a response with no valid row is `unavailable/schema`.
- A row whose `total_balance` is 0 is a real observation and stays visible; the card renders all balances under one label, e.g. `Balance CN¥9.39 · $0.00`.
- Missing or empty `balance_infos` is `unavailable/schema`, not an authoritative zero.

**Conditions**

- API key only.
- Canonical host `https://api.deepseek.com`; accepted model base paths are `/` and `/v1` (Pi built-in `deepseek`, `deepseek-response`) and `/anthropic` (`deepseek-anthropic`).

**Our credentials**

Yes. All three DeepSeek Providers store an API key: the Pi built-in `deepseek`, `deepseek-anthropic`, and `deepseek-response`.

#### `minimax` and `minimax-cn`

**Information obtainable**

- Coding Plan 5-hour usage derived from remaining percentage;
- Coding Plan weekly usage derived from remaining percentage.

**How to obtain**

```text
GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains
GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
Authorization: Bearer <MiniMax API key>
```

**Wire shape**

```json
{
  "base_resp": { "status_code": 0 },
  "model_remains": [
    {
      "model_name": "general",
      "current_interval_remaining_percent": 63.5,
      "end_time": "...",
      "current_weekly_status": 1,
      "current_weekly_remaining_percent": 81.2,
      "weekly_end_time": "..."
    }
  ]
}
```

**Normalization**

- Select the `general` model row only.
- 5-hour used = `100 - current_interval_remaining_percent`.
- Weekly used = `100 - current_weekly_remaining_percent` only when `current_weekly_status === 1`.
- Rows are custom windows labeled `Coding Plan 5-hour` and `Coding Plan weekly`.

**Conditions**

- Coding Plan keys only. Video remains rows are unrelated.
- The Pi Minimax base URL is `/anthropic`, while the quota host is `/v1`; the Provider module must hard-code the fixed quota host and validate the built-in Provider destination.

**Our credentials**

Yes for API keys that belong to a Coding Plan. Without an active Coding Plan, the endpoint may return no usable rows.

#### `moonshotai` and `moonshotai-cn`

**Information obtainable**

- available balance;
- voucher component;
- cash component.

There is no usage window or percentage.

**How to obtain**

```text
GET https://api.moonshot.ai/v1/users/me/balance
GET https://api.moonshot.cn/v1/users/me/balance
Authorization: Bearer <Moonshot API key>
```

**Wire shape**

```json
{
  "data": {
    "available_balance": 120.5,
    "voucher_balance": 20.5,
    "cash_balance": 100.0
  }
}
```

**Normalization**

- Display a custom balance-only window with `percent: 0`.
- Currency follows the host: USD for `.ai`, CNY for `.cn`.
- Do not fabricate a consumed percentage from the balance.

**Conditions**

- API key only.
- Canonical host check.

**Our credentials**

Yes. Both built-in Providers store API keys.

#### `zai` and `zai-coding-cn`

**Information obtainable**

- 5-hour model-token quota usage;
- weekly model-token quota usage.

The modern reference reader deliberately ignores the monthly `TIME_LIMIT` rows. Those rows represent shared monthly MCP tool calls, not model-token capacity. A plan that reports only `TIME_LIMIT` should report no model quota rather than a fabricated monthly bar.

**How to obtain**

```text
GET https://api.z.ai/api/monitor/usage/quota/limit
GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
```

- `api.z.ai`: `Authorization: Bearer <Z.AI API key>`
- `open.bigmodel.cn`: `Authorization: <Z.AI API key>` without `Bearer`

**Wire shape**

```json
{
  "success": true,
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "percentage": 31.5,
        "nextResetTime": "..."
      },
      {
        "type": "CREDIT_LIMIT",
        "unit": 6,
        "number": 1,
        "currentValue": 120,
        "usage": 1000,
        "nextResetTime": "..."
      }
    ]
  }
}
```

**Normalization**

- `unit: 3, number: 5` maps to the 5-hour window.
- `unit: 6, number: 1` maps to the weekly window.
- Use `percentage` first; otherwise `currentValue / usage * 100`.
- Ignore every row that is not `TOKENS_LIMIT` or `CREDIT_LIMIT`.

**Our credentials**

Yes, both built-in Providers use API keys. The CN host needs the bare Authorization scheme rather than Bearer.

### 4.3 Pi built-ins with no reusable opencodex reader

For these Providers the current reference gives no reliable quota or balance acquisition method. They should be `unsupported` until a Provider-specific endpoint is verified. A missing reader is not evidence that the Provider has no quota product; it means we have no source contract to implement safely.

| Provider | Current information obtainable | Reason |
|---|---|---|
| `amazon-bedrock` | none | No quota reader in opencodex |
| `ant-ling` | none | No quota reader in opencodex |
| `azure-openai-responses` | none | No quota reader in opencodex |
| `baseten` | none | No quota reader in opencodex |
| `cerebras` | none | No quota reader in opencodex |
| `cloudflare-ai-gateway` | none | No quota reader in opencodex |
| `cloudflare-workers-ai` | none | No quota reader in opencodex |
| `fireworks` | none | No quota reader in opencodex |
| `github-copilot` | none | opencodex explicitly marks it unsupported |
| `google` | none | No quota reader in opencodex |
| `google-vertex` | none | No quota reader in opencodex |
| `groq` | none | No quota reader in opencodex |
| `huggingface` | none | No quota reader in opencodex |
| `mistral` | none | No quota reader in opencodex |
| `nvidia` | none | No quota reader in opencodex |
| `openai` | none | API-key OpenAI has no reader; the Codex OAuth Provider is separate |
| `opencode` | none | Only 429 pacing guidance exists, not a quota API |
| `qwen-token-plan` | none | No quota reader in opencodex |
| `qwen-token-plan-cn` | none | No quota reader in opencodex |
| `qwen-token-plan-individual` | none | No quota reader in opencodex |
| `radius` | none | No quota reader in opencodex |
| `together` | none | No quota reader in opencodex |
| `vercel-ai-gateway` | none | No quota reader in opencodex |
| `xiaomi` | none | No quota reader in opencodex |
| `xiaomi-token-plan-ams` | none | No quota reader in opencodex |
| `xiaomi-token-plan-cn` | none | No quota reader in opencodex |
| `xiaomi-token-plan-sgp` | none | No quota reader in opencodex |

### 4.4 Reference readers for Providers not currently in this repository

These readers exist in opencodex but do not map to a current built-in Provider. They are useful if the corresponding Provider is added later as a built-in or bundled package:

| Reference Provider | Information | Endpoint | Conditions |
|---|---|---|---|
| `cursor` | monthly allowance, first-party usage, API usage | `api2.cursor.sh` Dashboard/usage routes | OAuth, unofficial API |
| `kiro` | monthly plan credits and free trial | AWS JSON-RPC `GetUsageLimits` | OAuth, account profile ARN |
| `google-antigravity` | Gem/Cla 5-hour and weekly windows | `v1internal:retrieveUserQuotaSummary` | OAuth, Google project id |
| `a6api` | API credit balance and USD cap | `api.a6api.com` billing and token-usage routes | API key |
| `cline-pass` | 5-hour, weekly, monthly | `api.cline.bot/api/v1/users/me/plan/usage-limits` | API key, active plan |
| `ollama-cloud` | session, weekly, monthly usage | `ollama.com/api/usage` | API key, plan-dependent |
| `venice` | DIEM/USD balance and epoch usage | `api.venice.ai/api/v1/billing/balance` | API key |
| `synthetic` | 5-hour, weekly, search hourly | `api.synthetic.new/v2/quotas` | API key |
| `deepinfra` | billing-cycle spend or prepaid balance | `api.deepinfra.com/payment/checklist` | API key |
| `neuralwatt` | subscription kWh usage and prepaid credits | `api.neuralwatt.com/v1/quota` | API key |

## 5. Implementation order

The first slice should implement only Providers whose endpoint and credential path are already proven:

1. `commandcode-goat` — separate probe; live-probed successfully.
2. `commandcode-private` — separate probe; same protocol shape is only a hypothesis until the Private key is probed.
3. `opencode-go` — API key and usage route are proven.
4. `kimi-coding` — API key and OAuth paths are both covered by the reference.
5. `deepseek`, `openrouter`, `minimax`, `minimax-cn`, `moonshotai`, `moonshotai-cn`, `zai`, `zai-coding-cn`.
6. `anthropic`, `xai`, `openai-codex`, `meta` — after the narrow OAuth credential-fact design is accepted.
7. Remaining built-ins remain `unsupported`.

Each provider module must have:

- a fixture-based response-parser test;
- a canonical-destination rejection test;
- a missing-auth test;
- an upstream-error test;
- a text-format test.

## 6. Live probe evidence for the current project key

**Input:** `CommandcodeAPIKey.txt`

**Result date:** 2026-09-28

**Endpoints:** the four canonical CommandCode `/alpha/...` routes listed in section 4.1.

**Observed result:**

```text
whoami:                 HTTP 200
billing/credits:        HTTP 200
billing/subscriptions:  HTTP 200
usage/summary:          HTTP 200

planId:                 individual-goat
period:                 2026-09-23T07:06:33.000Z .. 2026-10-23T07:06:33.000Z

5-hour:                 used 7.4418019214 / cap 14  = 53.16% used
  reset at:             2026-09-28T10:17:37.992Z

weekly:                 used 21.1616918396 / cap 35 = 60.46% used
  reset at:             2026-09-30T07:12:37.832Z

remaining credits:      monthly 48.8383081604
purchased credits:      0
free credits:           0

period spend:           19.3569331027
computed credit limit: 68.1952412631
computed credit used:  28.38%
```

This proves that the current project API key can acquire Goat-plan quota with the CommandCode endpoints. It does not prove that the same key belongs to `commandcode-private`. The two Providers must still be probed independently.

## 7. Open questions

1. Which exact narrow Provider-owned quota credential fact is acceptable for `openai-codex` and `meta` without widening the common credential contract?
2. Should the first card refresh be explicit only, or should a short TTL background refresh be added?
3. Do we want to extend the Provider Package contract with an optional quota capability for user packages, or keep v1 as Token-owned sidecar modules only?
4. Should the Control Plane projection expose only text, or should it expose structured windows now for future bars?
