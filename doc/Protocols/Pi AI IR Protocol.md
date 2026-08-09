# Pi AI IR Protocol v0.9.2 — Final Contract Closure Correction

Version: 0.9.2
Status: Frozen

This correction does not change the protocol architecture or chapter hierarchy.

It refines four final boundaries:

1. `onPayload` ownership and post-callback processing;
2. conditional deferred behavior in `lazyApi()`;
3. authority classification;
4. provenance ownership between `lazy.ts` and `event-stream.ts`.

---

## 1. §3.1.1 — `onPayload` Boundary

Replace the previous payload-boundary description with:

**Callback-visible payload replacement boundary**

`onPayload` receives an adapter-selected request-payload representation after that representation has been constructed for callback exposure and before the provider request is sent.

Conceptually:

```text id="6cdv13"
adapter constructs
callback-visible payload representation
        │
        ▼
onPayload(payload, model)
        │
        ├── returns undefined
        │   └── preserve current representation
        │
        └── returns non-undefined value
            └── replace current representation
        │
        ▼
subsequent adapter / SDK processing
        │
        ▼
provider request
```

The callback contract therefore establishes:

```text id="7ywqor"
onPayload
→ caller inspection boundary
→ optional replacement boundary
  for the callback-visible payload representation
```

It does **not** establish:

```text id="aadwgh"
onPayload output
=
final provider-wire payload
```

After `onPayload`, a concrete adapter or SDK may still perform:

```text id="a2bc5u"
field remapping
provider-specific conversion
serialization
SDK request construction
transport preparation
```

before the request is transmitted.

The exact callback-visible payload representation is adapter-specific.

For example, a native adapter may expose an intermediate provider-oriented object and later convert that object into its wire representation.

Thus:

```text id="rikmw0"
callback-visible payload
≠ necessarily provider-wire payload
```

`onPayload` is the last **caller replacement boundary** for the representation exposed to the callback, not a universal last transformation before network transmission.

---

## 2. §3.4.2 — `samplingParams` and Payload Lifecycle

Keep the existing Stage 1 and Stage 2 semantics, but replace the full lifecycle with:

### Pi-level sampling merge

```text id="qv5ofp"
Model.samplingParams
        │
        ▼
options.samplingParams
        │
        ▼
effective Pi samplingParams
```

Request-level values override model defaults per key.

This is shared helper / normalization behavior where `buildBaseOptions()` is used.

---

### Provider-payload precedence

For supporting OpenAI-compatible adapters, the effective Pi `samplingParams` object is applied after named request fields during that adapter's payload-construction phase.

```text id="88fat4"
named provider request fields
        │
        ▼
effective samplingParams
applied afterward
        │
        ▼
adapter-built
callback-visible payload
```

Within that construction phase:

```text id="314z90"
same key in samplingParams
→ overrides named field
```

This rule is not universal across all API families.

Other API families may ignore `samplingParams`.

---

### Caller callback boundary

Where the adapter subsequently invokes `onPayload`:

```text id="0lqnhc"
adapter-built
callback-visible payload
        │
        ▼
onPayload
        │
        ├── undefined
        │   └── preserve representation
        │
        └── non-undefined
            └── replace representation
        │
        ▼
post-callback adapter / SDK processing
        │
        ▼
provider request
```

Therefore the complete information lifecycle is:

```text id="np09nw"
Stage 1 — Pi sampling merge

Model.samplingParams
        ↓ overridden by
options.samplingParams
        ↓
effective Pi samplingParams
```

```text id="rny1se"
Stage 2 — supporting adapter construction

named request fields
        ↓ overridden by
effective samplingParams
        ↓
callback-visible payload representation
```

```text id="aw4bm6"
Stage 3 — caller callback boundary

callback-visible payload representation
        ↓ optionally replaced by
onPayload
        ↓
post-callback adapter / SDK processing
        ↓
provider request
```

Consequently:

```text id="wul582"
samplingParams
→ can win over named fields
  during supporting adapter construction
```

but:

```text id="85t7z0"
samplingParams result
≠ guaranteed final request representation
```

because a later `onPayload` replacement may replace the callback-visible payload.

Likewise:

```text id="b7k58g"
onPayload output
≠ guaranteed final wire representation
```

because adapter/SDK processing may still occur afterward.

---

## 3. §3.6.2 — `DeferredFetchOptions.wait`

Keep the static definition:

```ts id="w92bdf"
interface DeferredFetchOptions
  extends ProviderRequestOptions<Model<Api>> {
  wait?: number
}
```

Then describe the default as a source declaration rather than generic runtime enforcement:

**Declared `wait` semantics**

The source declaration specifies:

```text id="23a5po"
wait
→ maximum provider long-poll duration
  in milliseconds
```

and:

```text id="odzf9v"
wait omitted
→ declared default: 0

wait = 0
→ declared behavior: one status check
```

These statements are **Source-Declared Producer Contract** facts.

The static TypeScript contract itself only guarantees:

```text id="lcu7uc"
wait?: number
```

This protocol does not promote the declared default to generic runtime enforcement unless a concrete implementation is separately observed to enforce it.

---

## 4. §6.7 — Deferred Runtime Failure Surfaces

### 6.7.1 Deferred Fetch

Keep:

```text id="kfy7n3"
ProviderStreams.fetchDeferred?()
→ AssistantMessageEventStream
```

and:

```text id="dmdr1s"
Provider.fetchDeferred?()
→ AssistantMessageEventStream
```

but replace any statement that current built-in APIs commonly use deferred lazy wrapping with the following conditional description.

**`lazyApi()` capability-gated behavior**

`lazyApi()` only exposes deferred fetch when created with:

```text id="6g5ihr"
capabilities.fetchDeferred = true
```

When that capability is enabled:

```text id="5qigfy"
lazyApi(..., {
  fetchDeferred: true
})
        │
        ▼
ProviderStreams.fetchDeferred()
        │
        ▼
lazyStream(...)
        │
        ▼
loaded implementation.fetchDeferred()
```

Therefore:

```text id="qgfl9x"
capability-enabled lazyApi fetch
→ stream-style lazy setup normalization
```

This is a conditional runtime mechanism.

It does **not** imply that the pinned built-in API wrappers currently enable deferred fetch.

---

**`createProvider()` behavior**

When the configured `ProviderStreams` set exposes at least one `fetchDeferred` implementation, `createProvider()` exposes:

```text id="yxttar"
Provider.fetchDeferred()
```

using a `lazyStream()` around API dispatch.

Conceptually:

```text id="agxvlu"
Provider.fetchDeferred()
        │
        ▼
lazyStream()
        │
        ▼
select ProviderStreams by model.api
        │
        ▼
implementation.fetchDeferred()
```

Thus createProvider-generated deferred fetch has a stream-style dispatch/setup boundary.

This statement concerns `createProvider()` behavior.

It is not a universal guarantee for arbitrary hand-written implementations of the `Provider` interface.

---

**Models deferred fetch**

`Models.fetchDeferred()` is unconditionally defined at the Models interface/runtime layer:

```text id="eg71az"
Models.fetchDeferred(...)
→ Promise<AssistantMessage>
```

Its implementation uses:

```text id="y6iuyc"
lazyStream(
  model,
  async () => {
    provider lookup
    provider capability check
    applyAuth()
    provider.fetchDeferred(...)
  }
).result()
```

Therefore:

```text id="ryzduj"
Models deferred-fetch setup/provider failure
        │
        ▼
outer lazyStream
        │
        ▼
error AssistantMessage
        │
        ▼
result()
        │
        ▼
fulfilled Promise<AssistantMessage>
with stopReason = "error"
```

is possible.

A caller of `Models.fetchDeferred()` must inspect the returned `AssistantMessage.stopReason`.

---

### 6.7.2 Deferred Cancellation

Keep:

```text id="k3kden"
ProviderStreams.cancelDeferred?()
→ Promise<void>

Provider.cancelDeferred?()
→ Promise<void>

Models.cancelDeferred()
→ Promise<void>
```

**`lazyApi()` capability-gated behavior**

`lazyApi()` only exposes cancellation when created with:

```text id="yvl0xr"
capabilities.cancelDeferred = true
```

When enabled:

```text id="rzkk8k"
lazyApi(..., {
  cancelDeferred: true
})
        │
        ▼
load implementation
        │
        ▼
await implementation.cancelDeferred(...)
```

This path does not use `lazyStream()`.

It therefore exposes ordinary Promise failure semantics.

Again, this is conditional `lazyApi()` behavior and does not imply that pinned built-in wrappers currently enable deferred cancellation.

---

**`createProvider()` behavior**

When configured ProviderStreams expose cancellation capability:

```text id="py0srg"
Provider.cancelDeferred()
        │
        ▼
select ProviderStreams
        │
        ▼
await implementation.cancelDeferred(...)
```

There is no assistant-stream normalization boundary.

---

**Models deferred cancellation**

`Models.cancelDeferred()` performs:

```text id="yx332z"
provider lookup
        │
        ▼
provider capability check
        │
        ▼
applyAuth()
        │
        ▼
await Provider.cancelDeferred()
```

without an outer `lazyStream()`.

Consequently ordinary failures can surface as:

```text id="ppdtkn"
Promise rejection
```

rather than:

```text id="x7c1fe"
AssistantMessage {
  stopReason: "error" | "aborted"
}
```

Thus:

```text id="fo1n93"
Models.fetchDeferred failure surface
≠
Models.cancelDeferred failure surface
```

---

## 5. §6.3.3 — Lazy Rejection Precision

Keep the existing distinction:

```text id="yaf6pl"
setup rejection
OR
forwarding-chain rejection
→ generic .catch()
```

but make visibility conditional.

### Pre-terminal rejection

If rejection occurs before the outer stream has received a semantic terminal:

```text id="t0ctt3"
setup / forwarding rejection
        │
        ▼
lazy catch
        │
        ▼
outer.push(error)
        │
        ▼
visible ordinary error terminal
```

---

### Post-terminal forwarding rejection

If the outer stream already received `done` or `error`:

```text id="66owmm"
outer.done = true
```

and a later forwarding-chain rejection reaches the lazy catch:

```text id="vq398o"
lazy catch
        │
        ▼
outer.push(error)
        │
        ▼
ignored by EventStream.push()
because stream is already done
```

Therefore:

```text id="rj6u83"
forwarding rejection
→ catch executes
```

does not imply:

```text id="3rpxl4"
→ visible error event
```

after a semantic terminal has already been observed.

---

### Malformed inner completion

`forwardStream()` does not classify iterator completion itself as success.

For a source exposing `result()`:

```text id="ndy5af"
for-await completes
        │
        ▼
await source.result()
        │
        ▼
target.end(result)
```

If an inner `AssistantMessageEventStream` performs:

```text id="s416ro"
end()
```

without a semantic terminal event or explicit result:

```text id="b2li0p"
async iteration
→ ends

result()
→ remains unresolved
```

so:

```text id="tlws6x"
forwardStream()
→ may remain pending
```

Therefore:

```text id="6hbl7b"
iterator EOF / bare end
≠ success
≠ error
```

and `lazyStream()` does not invent a semantic terminal to repair the malformed source.

---

## 6. §7 — Authority Corrections

Replace the affected index entries with the following.

| Contract / Behavior | Authority | Authoritative Section |
|---|---|---|
| `onPayload` callback shape | Static Type Contract | §3.1.1 |
| `onPayload` `undefined` / replacement semantics | Source-Declared Producer Contract + Observed Runtime Behavior | §3.1.1 |
| concrete `onPayload` ordering | Observed Runtime Behavior | §3.1.1 / §3.4.2 |
| `samplingParams` field shape | Static Type Contract | §3.1.2 |
| Model/request `samplingParams` merge | Shared Helper / Normalization Behavior | §3.4.2 |
| `samplingParams` applied after named fields by supporting OpenAI-compatible adapters | Source-Declared Producer Contract + Observed Runtime Behavior | §3.1.2 / §3.4.2 |
| `DeferredFetchOptions.wait` shape | Static Type Contract | §3.6.2 |
| `wait` default `0` / one-check semantics | Source-Declared Producer Contract | §3.6.2 |
| deferred fetch/cancel API return surfaces | Static Type Contract | §3.6.4 |
| capability-enabled `lazyApi.fetchDeferred` wrapping | Observed Runtime Behavior | §6.7.1 |
| capability-enabled `lazyApi.cancelDeferred` behavior | Observed Runtime Behavior | §6.7.2 |
| `createProvider()` deferred-fetch dispatch | Observed Runtime Behavior | §6.7.1 |
| `createProvider()` deferred-cancel dispatch | Observed Runtime Behavior | §6.7.2 |
| Models deferred-fetch normalization | Observed Runtime Behavior | §6.7.1 |
| Models deferred-cancel Promise failure surface | Observed Runtime Behavior | §6.7.2 |
| lazy pre-terminal rejection normalization | Observed Runtime Behavior + Runtime Enforcement | §6.3.3 |
| post-terminal error-push suppression | Runtime Enforcement + Observed Runtime Behavior | §5.8.1 / §6.3.3 |
| bare-end unresolved-result interaction | Runtime Enforcement + Observed Runtime Behavior | §5.8.3 / §6.3.3 |

No new authority vocabulary is introduced.

---

## 7. §8 — Provenance Ownership Corrections

Do not add new numbered subsections.

### §8.6 EventStream Runtime

Expand the existing ownership list to include:

```text id="x0qlzn"
EventStream.push()

post-terminal push suppression

EventStream.end(result?)

bare end() without result

result() resolution behavior

AssistantMessageEventStream
terminal predicate / result extraction
```

`event-stream.ts` is the authoritative owner of:

```text id="8z1bsp"
if (done) return
```

and therefore of the primitive post-terminal push-suppression behavior.

It is also the authoritative owner of:

```text id="otqzpu"
end()
without result
→ does not resolve an unresolved result()
```

---

### §8.9 Lazy Runtime

Keep `api/lazy.ts` responsible for:

```text id="zph58c"
lazyStream()

lazyApi()

setup Promise chain

forwardStream()

catch mechanics

capability-gated deferred fetch wrapping

capability-gated deferred cancellation loading/dispatch
```

Do **not** attribute post-terminal suppression itself to `lazy.ts`.

Instead document the composite fact as:

```text id="1g7rgx"
lazy.ts
→ catch attempts outer.push(error)

event-stream.ts
→ ignores push after done
```

Together these establish the observed post-terminal lazy-rejection interaction.

Likewise:

```text id="r19x9e"
lazy.ts
→ forwardStream awaits source.result()

event-stream.ts
→ bare end() can leave result unresolved
```

Together these establish the malformed bare-end forwarding behavior.

---

### §8.11 Concrete Producer Behavior

Retain the existing OpenAI sources.

Also treat:

```text id="aep7oy"
pi-agent/packages/ai/src/api/mistral-conversations.ts
```

as source evidence for the `onPayload` representation boundary.

It establishes this sequence:

```text id="wwh7vk"
buildChatPayload()
        │
        ▼
onPayload()
        │
        ▼
toMistralWirePayload()
        │
        ▼
JSON.stringify()
        │
        ▼
HTTP request
```

Therefore it is direct evidence that:

```text id="4v43ti"
onPayload output
≠ universally final wire representation
```

---

## 8. Final Lifecycle

After these corrections, the protocol's complete information lifecycle is:

```text id="stjn8j"
Core Data
        │
        ▼
Invocation Controls
        │
        ▼
Shared Helpers / Adapter Conversion
        │
        ▼
Callback-Visible Payload Representation
        │
        ▼
onPayload
        │
        ▼
Optional Adapter / SDK
Post-Callback Processing
        │
        ▼
Provider Request
        │
        ▼
Assistant Stream
        │
        ▼
Terminal
        │
        ├── ordinary terminal
        │
        └── deferred
                │
                ▼
          DeferredHandle
                │
                ├── fetch
                │   ├── Provider surface: stream
                │   └── Models surface: result Promise
                │
                └── cancel
                    └── Promise<void>
```

The Frozen protocol preserves the following boundaries:

```text id="qg9jsv"
callback-visible payload
≠ provider-wire payload

onPayload
≠ universal final transformation

shared helper behavior
≠ mandatory adapter behavior

capability-gated lazy deferred behavior
≠ evidence that built-in wrappers enable it

deferred fetch
≠ deferred cancel failure surface

iterator EOF
≠ success

provider-native terminology
≠ canonical Pi terminal classification
```