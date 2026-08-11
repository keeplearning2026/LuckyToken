# Anthropic ↔ Pi AI IR Conversion Method v1.2

**Specification:** FROZEN — Combined Conversion Contract  
**Capability Baseline:** v2
**Protocol Dependency:** Anthropic Messages API Protocol Specification v0.4
**Reviewed Protocol Document SHA-256:** `efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918`
**Pi Contract Evidence:** Pi AI IR Protocol v0.9.2  
**Pi Reference Commit:** `eb3c46d6ce28cb87147bb0d05645ebae28524713`  
**Pi Reference Package:** `@earendil-works/pi-ai 0.84.1`  
**Pi Protocol Blob SHA:** `a3dc09b846f2e49f73480d5e33c63aa009ff9a51`  
**Runtime Certification:** PENDING

## 1. Status, Scope, and Dependencies

### 1.1. Purpose and Conversion Directions


本文定义 LuckyToken 的 Anthropic Messages client-facing protocol 与 Pi runtime contracts 之间的完整转换方法，以及它们经过 Core Execution / semantic COMMIT 的生命周期边界。

端到端方向：

```text
Anthropic Request
        ↓
Client Protocol
parse / validate / canonicalize
        ↓
Model<Api>
+
Context
+
effectiveOptions
        ↓
Core Execution
        ↓
AssistantMessageEventStream
        ↓
authoritative terminal
+
AbortSignal live at commit
        ↓
COMMIT
        ↓
committed AssistantMessage
        ↓
Anthropic Message
        ↓
JSON or Atomic SSE
        ↓
HTTP
```

本文同时覆盖：

```text
Anthropic Request → Pi Invocation
Core Execution / Atomic Commit
Pi AssistantMessage → Anthropic Message
Anthropic JSON / Atomic SSE Rendering
Cross-Direction Continuity
Runtime Certification
Failure Authority
```

Request-side conversion owns Client Wire → Pi-compatible invocation semantics。

Core Execution owns Pi stream consumption、cancellation、terminal consistency 与 semantic COMMIT。

Response-side conversion/rendering only receives a committed `AssistantMessage` and never translates unfinished Pi execution state into client-visible Anthropic semantic state。

Failure path：

```text
Client Authorization Failure
InvalidRequest
UnsupportedFeature
Model Resolution Failure
Runtime Failure
Pi error
Pi aborted
unexpected EOF
Outbound Response Fidelity Failure
```

不通过 successful Anthropic `Message` 表达；它们进入 LuckyToken failure → Anthropic `ErrorResponse` / HTTP failure rendering path。

### 1.2. Specification Status and Version Lifecycle

#### Combined Specification Status


Anthropic ↔ Pi AI IR Conversion Method v1.2 是合并后的双向 conversion contract。它继承 v1 capability baseline，并以 capability baseline v2 增加 ordinary thinking 的双向 round-trip 支持。

它继承：

```text
Request conversion lineage:
Anthropic Request → Pi AI IR Conversion Method v0.4.9

Response conversion lineage:
Pi AI IR → Anthropic Response Conversion Method v0.3
```

从 v1 开始，认证与发布身份使用一个统一的 combined Method version；v1.2 是一个严格、窄范围的 capability extension：

```text
Method Version:
v1.2

Capability Baseline:
v2

Specification:
FROZEN — Combined Conversion Contract

Anthropic Protocol Dependency:
Anthropic Messages API Protocol Specification v0.4

Reviewed Anthropic Protocol SHA-256:
efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918

Pi Contract Evidence Basis:
Pi AI IR Protocol v0.9.2
Reference Commit = eb3c46d6ce28cb87147bb0d05645ebae28524713
Reference Package = @earendil-works/pi-ai 0.84.1
Protocol Blob SHA = a3dc09b846f2e49f73480d5e33c63aa009ff9a51

Protocol Dependency Synchronization:
SYNCHRONIZED

Runtime Certification:
PENDING | FAILED | CERTIFIED
```

这些状态彼此独立：

```text
Specification FROZEN
≠
Protocol Dependency synchronized
≠
Runtime Certification CERTIFIED
```

当前 reviewed local Protocol v0.4 已包含 request/response wire structures、semantic-header surface、ToolResult representation evidence boundaries、response Message/Usage/SSE shapes，以及本 Method 所需的两个 request-side source-validity facts：

```text
model-dependent final-assistant prefill rejection
+
strict:true request-wide 20 / 24 / 16 hard limits
```

因此当前 v0.4 artifact 是 synchronized reviewed dependency identity，可以由 certification manifest 绑定；Protocol dependency 本身不改变 capability baseline，也不提前把 Runtime Certification 标记为 `CERTIFIED`。

Pi runtime certification failure does not automatically modify this specification。只有证据证明本 Method 的 semantic mapping / ownership contract 本身错误时，才需要重新打开对应 contract。

#### Version Lifecycle


```text
Anthropic ↔ Pi AI IR
Conversion Method v1.2
│
├── Specification
│   └── FROZEN — Combined Conversion Contract
│
├── Request Contract Lineage
│   └── v0.4.9
│
├── Response Contract Lineage
│   └── v0.3
│
├── Protocol Dependency
│   ├── Anthropic Messages API Protocol Specification v0.4
│   ├── reviewed document SHA-256
│   │   └── efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918
│   └── synchronized immutable revision available
│       for Runtime Certification binding
│
└── Runtime Certifications
    ├── runtime A
    │   └── FAILED
    ├── runtime B
    │   └── FAILED
    └── runtime C
        └── CERTIFIED
```

#### Request-Side Protocol Synchronization Detail


```text
Method Version:
v1.2

Capability Baseline:
v2

Specification:
FROZEN — Combined Conversion Contract

Protocol Dependency:
Anthropic Messages API Protocol Specification v0.4

Reviewed Protocol Document SHA-256:
efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918

Protocol Dependency Synchronization:
SYNCHRONIZED

Runtime Certification:
PENDING
```

The reviewed local Anthropic Protocol v0.4 covers the semantic-header surface used here, including `anthropic-user-profile-id`, and preserves two ToolResult evidence boundaries：

```text
1. tool_result.content = string
   is source syntax,
   but string ↔ single TextBlock equivalence
   is not normatively established;

2. tool_result.content = []
   is evidenced in at least one official beta-path example,
   but universal validity for the supported no-beta v1 profile
   and omission-equivalence are not established.
```

v1 therefore continues not to guess either semantic.

Current v1 freezes：

```text
tool_result.content = string
→ Source Valid
→ UnsupportedFeature
  at static semantic support
```

```text
tool_result.content = []
→ unresolved Source Grammar Coverage
  for the supported no-beta profile
→ UnsupportedFeature
```

```text
ordinary message.content = []
→ unresolved Source Grammar Coverage
→ UnsupportedFeature
```

The synchronized Protocol v0.4 now owns：

```text
model-dependent final-assistant prefill rejection
+
documented strict:true request-wide 20 / 24 / 16 hard limits
```

The reviewed local Protocol v0.4 document SHA-256：

```text
efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918
```

is the synchronized immutable dependency eligible for binding by Runtime Certification.

The previous reviewed Protocol v0.3 artifact with SHA-256
`0179347575d9be388d5ca2258f447a2351990c554c67d172e078ab8cd017a992`
MUST NOT be used for `CERTIFIED` status because it omits those owning facts.

Normal next work：

```text
Protocol Spec targeted synchronization
        ↓
conformance implementation
        ↓
Pi patch set
        ↓
certification manifest
        ↓
Runtime Certification:
CERTIFIED
```

A future Provider/runtime bug does not reopen this conversion specification unless it demonstrates that the frozen Anthropic ↔ Pi semantic mapping itself is incorrect. A future Protocol change reopens only the directly affected source-validity / target-rendering mapping, not the architecture by default。

### 1.3. Protocol and Runtime Dependencies

#### Protocol Spec Synchronization Requirement


The conversion specification depends on an authoritative Anthropic Protocol Spec that describes the complete supported source semantic surface.

If current external protocol evidence establishes a protocol-defined semantic rule absent from the project Protocol Spec：

```text
update Protocol Spec
↓
classify/validate it in this conversion contract / implementation
↓
update conformance fixtures
↓
bind the synchronized immutable Protocol revision
in Runtime Certification
```

The converter MUST NOT use an outdated Protocol Spec omission as permission to ignore an actual source semantic.

#### Reviewed Local Protocol Dependency


At the synchronized v1.2 review point, the local Protocol document is：

```text
Anthropic Messages API Protocol Specification v0.4

document SHA-256:
efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918
```

That revision covers the semantic-header surface, including `anthropic-user-profile-id`; records the ToolResult string / explicit-`[]` evidence boundaries; and defines the current response Message、Usage、Content Block 与 SSE structures used by the response-side Method。

The synchronized Protocol v0.4 additionally owns the two request-side source-validity facts required by this Method：

```text
1. model-dependent final-assistant prefill rejection;

2. strict:true / structured-schema request-wide hard limits:
   strict tools        <= 20
   optional parameters <= 24
   union parameters    <= 16.
```

Therefore：

> **The reviewed v0.4 document SHA above identifies the synchronized immutable Protocol artifact eligible for certification binding. Protocol v0.3 / SHA-256 `0179347575d9be388d5ca2258f447a2351990c554c67d172e078ab8cd017a992` remains ineligible for `CERTIFIED` status.**

Protocol drift detection is a specification/conformance responsibility, not a claim that runtime code can discover arbitrary future semantics automatically。

#### Pi Contract Evidence Dependency

本 Method 的 Pi-side static/runtime-contract evidence basis 固定为：

```text
Pi AI IR Protocol:
v0.9.2

Reference Commit:
eb3c46d6ce28cb87147bb0d05645ebae28524713

Reference Package:
@earendil-works/pi-ai 0.84.1

Pi Protocol Blob SHA:
a3dc09b846f2e49f73480d5e33c63aa009ff9a51
```

这组 evidence identity 回答：

```text
本 Method 的 Pi contract assertions
是基于哪一个被冻结的 Pi contract/source snapshot 审查的？
```

它与 Runtime Certification 中的：

```text
Pi Revision:
<immutable revision>
```

不是同一个事实。

```text
Pi Contract Evidence Basis
→ specification review provenance

Runtime Certification Pi Revision
→ concrete runtime being certified
```

一个未来 Pi runtime revision 只有在重新证明与本 Method 所依赖的 Pi contracts 等价、或重新完成相应 source review 后，才可以被新的 certification manifest 绑定。

### 1.4. Structural Authority and Non-Goals

#### Final Principles


> **Anthropic source closed-world covers body semantics and protocol-defined request-semantic headers.**

> **v1 implements one minimal source grammar: `anthropic-version=2023-06-01` with no beta. Beta-activated grammars fail closed unless a later specification explicitly adds them.**

> **Profile-envelope validity and LuckyToken profile/grammar support are different questions. Known invalid profile state is `InvalidRequest`; unimplemented grammar is `UnsupportedFeature`.**

> **Profile-independent malformed JSON remains `InvalidRequest` before profile-support capability rejection.**

> **Within a supported profile/grammar, Source Validity completes before feature-level v1 capability rejection.**

> **Header names are classified case-insensitively; unclassified `anthropic-*` extensions fail closed, while unrelated unknown HTTP headers are not automatically Anthropic semantics.**

> **Client authorization remains separate from Anthropic source validity.**

> **Model Resolution failure belongs to the Router / Model Resolution contract; conversion does not relabel it.**

> **Explicit ordinary `message.content:[]` is never silently collapsed into no message; current v1 rejects it at Source Grammar Coverage until source authority resolves the semantics.**

> **Final assistant input is model-dependent Anthropic prefill semantics: evidence-bound `forbidden` yields `InvalidRequest`; evidence-bound `allowed` remains `UnsupportedFeature` in generic v1; `unknown` validity is `UnsupportedFeature` and is never guessed.**

> **Deterministic conversion consumes already-valid, already-supported semantics and owns no normative client failure classification.**

> **Every Pi-required message field has an explicit deterministic construction rule; synthetic required-shape data never fabricates historical authority.**

> **Historical provenance is synthetic Client-owned identity; certification reserves that namespace away from real target identities.**

> **ToolResult string→single-text-block canonicalization requires source-protocol authority; the converter does not invent semantic equivalence.**

> **Current Protocol Spec evidence does not establish explicit ToolResult `[]` validity/equivalence; current v1 rejects that source grammar as `UnsupportedFeature` rather than guessing.**

> **Documented `strict:true` request-wide limits are Source Validity rules; the v1 schema subset remains a separate later capability check.**

> **Tool mapping is complete and allowlisted; truthful strict/schema semantics are constructed before runtime capability checks.**

> **The v1 schema subset is exact, recursive, and distinct from source-schema validity.**

> **Deterministic conversion preserves field presence/omission, including `metadata.user_id`; arbitrary source objects are never spread into Pi options.**

> **When conversion needs source-profile authority, `sourceProfile` travels through an explicit information edge rather than global/ambient lookup or duplicate request state.**

> **Runtime Certification binds an immutable synchronized Protocol Spec revision; a stale mutable protocol document cannot certify source-validity behavior.**

> **Invocation immutability freezes structure, semantic values, and capability identity—not the owner-defined lifecycle of an explicitly live capability.**

> **The AbortSignal reference cannot change after Gate C, but its HTTP-owned cancellation lifecycle remains live and authoritative until success commit.**

> **Serving through `Models` removes Provider-registration mutation authority; other serving-time Models operations may exist but cannot silently invalidate certification-bound facts.**

> **If Pi runtime behavior violates the frozen mapping, fix Pi or fail runtime certification rather than expanding the Anthropic converter.**

## 2. End-to-End Conversion Model

### 2.1. End-to-End Request / Execution / Response Flow

#### Core Execution Formula


Client capability：

```text
Accepted Request Capability
=
Source Valid
AND
Static v1 Semantic Support
AND
Static Pi Representability
AND
Request-Specific Execution Fidelity
```

Source Profile / Grammar Coverage is a prerequisite for claiming `Source Valid`; it is not a separate accepted semantic representation.

Execution prerequisite：

```text
Execution Allowed
=
Client Authorized
AND
Runtime Certified & Ready
AND
Models-Facing Invocation Integrity
AND
Accepted Request Capability
```

#### Final Request Pipeline


```text
Anthropic HTTP Request
        │
        ▼
HTTP Boundary
├── route / method
├── raw headers/body
├── content type
├── AbortSignal
└── lifecycle
        │
        ├──────────────────────────────┐
        │                              │
        ▼                              ▼
Client Authorization        Anthropic Source Processing
        │                    │
        │                    ├── Resolve profile envelope
        │                    │      known invalid ─► InvalidRequest
        │                    │
        │                    ├── Inspect/classify Anthropic-owned headers
        │                    │
        │                    ├── Parse profile-independent JSON syntax
        │                    │      malformed ─► InvalidRequest
        │                    │
        │                    ├── Source Profile / Grammar Coverage
        │                    │      unsupported/unclassified grammar
        │                    │      ─► UnsupportedFeature
        │                    │
        │                    └── Parse supported-profile request value
        │                              │
        │                              ▼
        │                    Canonicalization
        │                              │
        │                              ▼
        │              Model-Independent Source Validation
        │                              │
        │                              ▼
        │                     Model Resolution
        │                    fail ─────┴──► Router / Model Resolution Failure
        │                              │
        │                              ▼
        │                          Model<Api>
        │                              │
        │                              ▼
        │               Model-Dependent Source Validation
        │                    ├── known invalid ─► InvalidRequest
        │                    ├── unknown validity ─► UnsupportedFeature
        │                    └── known valid
        │                              │
        │                              ▼
        │                 ValidatedAnthropicRequest
        │                              │
        │                              ▼
        │                   Static v1 Semantic Support
        │                    fail ─────┴──► UnsupportedFeature
        │                              │
        │                              ▼
        │                 Static Pi Representability
        │                    fail ─────┴──► UnsupportedFeature
        │                              │
        │                              ▼
        │                 Deterministic Conversion
        │                 inputs include sourceProfile
        │                    ┌─────────┼──────────┐
        │                    ▼         ▼          ▼
        │                 Context protocolOptions renderState
        │                    │         │
        │                    └────┬────┘
        │                         │
Auth-owned facts ─────────────────┤
AbortSignal ──────────────────────┤
Router defaults ──────────────────┘
                                  │
                                  ▼
                           composeOptions
                                  │
                                  ▼
                     Models-Facing Invocation
                     ├── Model<Api>
                     ├── Context
                     └── effectiveOptions
                                  │
                                  ▼
                       Runtime Readiness
                            fail ─┴─► Runtime Failure
                                  │
                                  ▼
                       Invocation Integrity
                            fail ─┴─► Runtime Failure
                                  │
                                  ▼
                  Request-Specific Fidelity Gate
                            fail ─┴─► UnsupportedFeature
                                  │
                                  ▼
                        Ownership Transfer
                                  │
                                  ▼
                   Immutable Invocation Structure
                   + Live Lifecycle Capabilities
                                  │
                                  ▼
                      Models.streamSimple
                                  │
                                  ▼
                    Certified Execution Path
                                  │
                                  ▼
                              Upstream
```

Frozen ordering rules：

> **Profile-independent JSON syntax errors are `InvalidRequest` even when the selected profile grammar is unsupported.**

> **Within an implemented source profile/grammar, full Source Validity precedes feature-level v1 `UnsupportedFeature` rejection. Source-profile/grammar support itself is a prior capability precondition.**

Model Resolution failure is owned by the Router / Model Resolution contract and is not silently reclassified by this conversion specification.

#### Core Architectural Decision


本方向的 conversion boundary 是：

```text
committed Pi AssistantMessage
→ Anthropic Message
```

不是：

```text
Pi AssistantMessageEvent
→ Anthropic SSE Event
```

因此：

```text
Pi streaming protocol
=
Execution lifecycle
```

```text
Pi AssistantMessage
=
successful response conversion input
```

```text
Anthropic JSON / SSE
=
target wire representations
```

---

#### Complete Response Flow


```text
Anthropic Request
        │
        ▼
AnthropicRenderState
├── stream
└── clientModel
        │
        │ survives execution
        ▼

Models.streamSimple(...)
        │
        ▼
AssistantMessageEventStream
        │
        ▼
Core Execution
        │
        ├── error
        │     └── failure path
        │
        ├── aborted
        │     └── cancellation path
        │
        ├── EOF without terminal
        │     └── runtime failure
        │
        └── supported consistent done
                +
              signal live
                    │
                    ▼
                 COMMIT
                    │
                    ▼
            AssistantMessage
                    │
                    ▼
       Outbound Response Fidelity
                    │
                    ▼
          Anthropic Message
                    │
            ┌───────┴───────┐
            │               │
      stream=false      stream=true
            │               │
            ▼               ▼
         JSON           Atomic SSE
            │               │
            └───────┬───────┘
                    ▼
               HTTP Boundary
```

---

### 2.2. Boundary Ownership

#### HTTP Boundary, Authorization, and Anthropic Source Semantics


```text
HTTP Request
│
▼
HTTP Boundary
├── route / method
├── raw headers
├── content type
├── raw body
├── AbortSignal
└── HTTP lifecycle
        │
        ├───────────────────────────┐
        │                           │
        ▼                           ▼
Client Authorization       Anthropic Client Protocol
├── authorized?            ├── Source Profile Resolution
├── sessionId?             ├── Semantic Header Classification
└── projectDir?            └── Body Parse / Validation
```

Client Authorization and Anthropic source validity remain separate authorities.

---

#### Client Authorization Is Not Source Validity


Frozen：

> **Client authentication MUST NOT participate in `ResolvedAnthropicSourceProtocolProfile`, `CanonicalAnthropicRequest`, or `ValidatedAnthropicRequest` source-validity authority.**

```text
invalid client credential
→ Client Authorization Failure
```

not：

```text
InvalidRequest
UnsupportedFeature
```

---

#### Final Information Ownership


```text
HTTP Boundary
owns:
route
method
raw headers/body
content type
AbortSignal
HTTP lifecycle

Client Authorization
owns:
authorized?
sessionId?
projectDir?

Anthropic Source Profile
owns:
anthropic-version
anthropic-beta
active protocol grammar identity
exact v1 profile-support policy

Source Profile / Grammar Coverage
owns:
can LuckyToken validate this selected source grammar?
known/unclassified profile extension support
ordinary message content:[] unresolved policy
current unresolved explicit ToolResult [] policy

Anthropic Client Protocol
owns:
known semantic-header classification
conservative unclassified anthropic-* detection
body semantics

Parser / Canonicalizer / Validator
owns:
profile-independent JSON syntax
profile-relative source validity
documented strict request-wide source limits

Model Resolver
owns:
selector → Model<Api>
or Model Resolution failure

Anthropic Model-Validity Policy
owns:
model-dependent Anthropic source restrictions
not represented directly by Pi Model<Api>
final-assistant prefill allowed | forbidden | unknown
evidence identity for that classification

Static v1 Semantic Support
owns:
source-valid feature subset accepted by this specification

Static Pi Representability
owns:
accepted semantic → truthful Pi public-contract representation

Converter
owns:
deterministic Context/protocolOptions/renderState construction
complete Pi required-shape projections
turn-scoped temporary mapping state
and receives sourceProfile explicitly only where profile-owned mapping authority is needed

Option Composition
owns:
execution controls + approved auxiliary facts

Serving Readiness
owns:
runtime composition/certification match
synchronized Protocol Spec revision
reserved synthetic-history identity disjointness
changes caused by serving-time Models operations

Invocation Integrity
owns:
correct Models-facing invocation construction
impossible states that escaped earlier normative gates

Request Fidelity Gate
owns:
request-specific certified capability

Execution
owns:
Model/Context/options invocation structure
after Gate C

HTTP Boundary
continues to own:
live AbortSignal cancellation state
through success commit

Runtime Certification
owns:
post-Gate execution-path fidelity
and immutable dependency identity binding

Provider
owns:
Pi → upstream adaptation
```

Semantic Header Policy remains Protocol/Conversion specification authority; Runtime Certification binds the synchronized dependency revision instead of duplicating the policy as a second owner.

### 2.3. No Parallel LuckyToken IR


禁止：

```text
LuckyToken Universal Request
LuckyToken General Message IR
Universal LLM IR
Provider Compatibility IR
Runtime Compatibility IR
```

Principal Anthropic-private short-lived request representations include：

```text
ResolvedAnthropicSourceProtocolProfile
ParsedAnthropicRequest
CanonicalAnthropicRequest
ValidatedAnthropicRequest
AnthropicRenderState
```

This list is not an exhaustive ban on ordinary request-local operation state such as：

```text
sourceSemanticHeaders classification
UnclassifiedAnthropicOwnedHeader marker
turn-scoped PendingToolCall map
```

Such state is allowed only when it has one local responsibility, a short lifecycle, and does not become a parallel universal semantic model.

#### No Generic Response IR


禁止：

```text
LuckyTokenResponse
UniversalResponse
GenericLLMResponse
ResponseCompatibilityIR
```

正确：

```text
Pi AssistantMessage
        ↓
Anthropic Message
```

`Anthropic Message` 是 target protocol representation。

它不是跨协议 universal IR。

---

## 3. Anthropic Request → Pi Invocation

### 3.1. Anthropic Source Request

#### Complete Anthropic Source Request Surface


Anthropic source semantics can arrive through more than the JSON body.

Frozen hierarchy：

```text
Anthropic Source Request
│
├── Protocol-Profile Headers
│   ├── anthropic-version
│   └── anthropic-beta
│
├── Request-Semantic Headers
│   ├── currently classified protocol headers
│   └── future source-valid semantic headers
│
└── MessageRequest Body
    ├── model
    ├── messages
    ├── tools
    ├── system
    └── other request semantics
```

Source closed-world applies to the entire hierarchy.

---

#### 3.1.1. HTTP and Protocol Inputs

##### Request-Semantic Header Classification Boundary


A protocol-defined header is a **request-semantic header** when its value can change the semantic meaning, attribution, enabled protocol behavior, or model-visible/upstream request semantics of the Anthropic request rather than merely carrying generic HTTP transport or LuckyToken authorization infrastructure.

HTTP header names are case-insensitive. Classification therefore operates on a normalized lower-case header name while preserving the original header value semantics.

v0.4.9 freezes the following ingress distinction：

```text
Normalized Header Name
│
├── explicitly known Anthropic protocol/profile header
│   └── classify by this specification
│
├── unclassified anthropic-* header
│   └── preserve as an Anthropic-owned extension marker
│       for later fail-closed capability rejection
│
└── other unknown HTTP header
    └── not automatically Anthropic semantic input
```

The header classifier MUST NOT silently drop an unclassified `anthropic-*` name.

##### 3.1.1.1. Protocol-Profile Headers

###### `user-profiles` Beta


The current source protocol defines `anthropic-user-profile-id` behind the `user-profiles` beta family.

v1 may recognize the documented beta/header relationship for failure classification, but the beta-activated profile itself is not in the implemented source grammar：

```text
2023-06-01
+
user-profiles beta active
→ known beta-activated profile
→ UnsupportedFeature at Source Profile / Grammar Coverage
```

Without the required beta, a present `anthropic-user-profile-id` is source-invalid：

```text
2023-06-01 baseline
+
anthropic-user-profile-id
+
required beta absent
→ InvalidRequest
```

A future specification revision may explicitly add selected beta profiles. No runtime registry is implied.

##### 3.1.1.2. Request-Semantic Headers

###### Known Semantic Header Classification


For the exact implemented v1 baseline：

```text
anthropic-version
→ Source Profile authority
→ required implemented value: 2023-06-01

anthropic-beta
→ Source Profile authority
→ any beta-activated grammar is outside v1 profile support
```

`anthropic-user-profile-id` is a known request-semantic header with a known beta dependency, but current v1 does not implement the beta-activated source profile required to make that semantic source-valid.

Therefore failure authority is exact：

```text
baseline profile
+
anthropic-user-profile-id present
+
required user-profiles beta absent
→ InvalidRequest
```

```text
user-profiles beta active
→ beta-activated source profile
→ UnsupportedFeature at Source Profile / Grammar Coverage
```

If a future specification explicitly implements the required beta profile, then the source-valid `anthropic-user-profile-id` semantic remains a separate v1 support question and MUST still be explicitly mapped or rejected; it may never be silently ignored.

Known source legality is a Source Validity concern. LuckyToken profile support and source-valid semantic support are separate later capabilities.

###### Semantic Header Policy Is Specification-Owned


Anthropic semantic-header classification belongs to：

```text
Anthropic Protocol Spec
+
this Conversion Specification
+
Client Protocol conformance tests
```

Runtime certification binds：

```text
Specification Version
+
immutable synchronized Anthropic Protocol Spec Revision
+
Supported Anthropic Source Profile
```

and therefore does not duplicate the same header support matrix as an independently authoritative manifest field.

A certification artifact MAY expose a derived informational summary such as：

```text
Anthropic Semantic Headers:
<derived from bound Specification + Protocol revision>
```

for diagnostics, but that summary MUST NOT override or diverge from the frozen specification/protocol dependency.

##### 3.1.1.3. Anthropic-Owned Unknown Extensions

###### Executable Fail-Closed Policy for Anthropic-Owned Headers


The converter cannot infer future protocol semantics from arbitrary HTTP header names. v0.4.9 therefore freezes a concrete conservative ingress rule instead of relying on impossible runtime clairvoyance.

```text
normalize header name to lower-case
        │
        ├── known classified Anthropic header
        │   └── use its frozen classification
        │
        ├── name starts with "anthropic-"
        │   └── UnclassifiedAnthropicOwnedHeader
        │
        └── otherwise
            └── ordinary HTTP/Auth ownership
                unless the authoritative source protocol
                explicitly classifies it as Anthropic semantic
```

`UnclassifiedAnthropicOwnedHeader` is an ingress classification fact, not a new universal IR type requirement.

It MUST be retained until source validity for the known profile/body has completed. Only then：

```text
unclassified anthropic-* extension present
→ UnsupportedFeature
```

This ordering prevents an unsupported extension from masking a malformed/invalid source request.

The conservative rejection does **not** claim that LuckyToken knows the unknown header is source-valid. It only refuses to execute an unclassified Anthropic-owned protocol extension.

Never：

```text
unclassified anthropic-* header
→ silently ignore
```

###### Parser / Header Classification Must Preserve Unknown Semantics


Forbidden：

```text
wire semantic / Anthropic-owned extension
→ parser/header layer drops it
→ downstream unknowingly accepts
```

Body parsing must retain or explicitly detect unknown body semantics.

Header processing must retain：

```text
known semantic-header classification
+
unclassified anthropic-* extension markers
```

until the appropriate source-validity / representability stage consumes them.

No generic HTTP-header bag needs to enter the converter.

##### 3.1.1.4. Non-Semantic / Unrelated HTTP Headers

###### Non-Semantic and Unrelated HTTP Headers


The semantic-header rule does not turn every HTTP header into Client Protocol semantics.

For example：

```text
connection lifecycle headers
generic proxy / tracing headers
generic HTTP transport headers
LuckyToken client authorization headers
```

remain under their existing HTTP/Auth ownership unless the authoritative Anthropic source protocol explicitly gives them request semantics.

Therefore an unknown header outside the classified Anthropic-owned namespace is **not** rejected merely for being unknown.

If future authoritative protocol evidence introduces an Anthropic semantic header outside the current conservative namespace, the Protocol Spec and classifier MUST be updated before that semantic is supported. Runtime code is not expected to infer that meaning from an arbitrary header name.

### 3.2. Source Processing and Acceptance

#### Two-Phase Source Validation


The prior Source Profile / Grammar Coverage gate establishes that LuckyToken understands the grammar being validated.

Then Source Validation has two phases.

#### 3.2.1. Source Profile Resolution

##### Source Protocol Profile and Exact v1 Profile-Support Authority


`ResolvedAnthropicSourceProtocolProfile` is determined by protocol-profile semantics such as：

```text
anthropic-version
anthropic-beta
```

Conceptually：

```ts
interface ResolvedAnthropicSourceProtocolProfile {
  version: string;
  betas: ReadonlySet<string>;
}
```

No particular runtime type is required.

The profile lifecycle has two distinct questions：

```text
A. Is the profile envelope / known profile combination source-valid?
B. Does LuckyToken implement enough grammar/semantics for that profile?
```

They are not the same authority.

##### Profile Failure Classification


```text
malformed known profile header/value
or known source-invalid version/beta token/combination
→ InvalidRequest / Protocol Failure
```

Anthropic's current beta contract requires exact documented beta identifiers; an invalid or unavailable beta produces HTTP 400 `invalid_request_error`.

```text
known source-valid beta/profile
but beta-activated grammar is not implemented by LuckyToken v1
→ UnsupportedFeature
```

For a syntactically plausible but locally unclassified beta/profile extension whose source validity cannot be established from the synchronized Protocol Spec：

```text
→ conservative UnsupportedFeature
  at Source Profile / Grammar Coverage
```

Never call an unknown extension `InvalidRequest` merely because LuckyToken does not understand it.

##### Source Validation Is Profile-Relative


Full source validity is evaluated only after LuckyToken has selected a source profile/grammar it actually understands.

For a supported profile：

```text
ResolvedAnthropicSourceProtocolProfile
+
selected model semantics
+
request-semantic headers
+
MessageRequest body
→ Source Validity
```

This section does not authorize LuckyToken to validate an unknown profile grammar by guessing.

If the profile/grammar itself is not implemented：

```text
→ UnsupportedFeature
```

before a claim of complete Source Validity is made.

#### 3.2.2. Source Grammar Coverage and Closed World

##### Exact v1 Implemented Source Grammar


v0.4.9 intentionally chooses the smallest implemented source grammar：

```text
anthropic-version = "2023-06-01"
anthropic-beta    = absent / empty set
```

This baseline grammar is the only v1 profile for which LuckyToken claims complete local profile-relative Source Validity.

No beta-activated grammar is part of the v1 implemented profile.

This is a simplicity and correctness rule, not a statement that Anthropic betas are invalid.

##### Source Closed-World Rule


The closed world has two levels.

##### Supported Source Grammar


If the current Protocol Spec/profile does not provide enough authority for LuckyToken to validate a recognized source representation correctly：

```text
unsupported / unresolved source grammar branch
→ UnsupportedFeature
```

This is a profile/grammar-coverage limitation, not `InvalidRequest`.

#### 3.2.3. Canonicalization

##### Canonical Message Representation and Explicit Empty-Array Boundary


Raw：

```ts
content:
  | string
  | ContentBlockParam[]
```

Canonical：

```ts
interface CanonicalAnthropicMessage {
  role: "user" | "assistant" | "system";
  content: AnthropicContentBlockParam[];
}
```

Normal message string shorthand dies during canonicalization.

#### 3.2.4. Model-Independent Source Validation

##### Model-Independent


```text
semantic-header legality
body required fields
field shapes
tagged unions
conversation structure
tool identity/lifecycle
source schema validity
profile-enabled feature legality
strict:true documented request-wide hard limits
```

For accepted `strict:true` client-tool grammar, deterministic documented limits include：

```text
strict tools per request        <= 20
optional parameters total       <= 24
union-type parameters total     <= 16
```

The parameter totals apply across all strict schemas participating in the request. A documented hard-limit violation is source-invalid：

```text
→ InvalidRequest
```

Anthropic also documents additional internal grammar-compilation complexity limits that are not reducible to a complete public deterministic predicate. LuckyToken MUST NOT invent its own approximation and call a request invalid on that basis. Such upstream-only compiler limits are handled by the normal upstream error path unless a later Protocol Spec exposes a deterministic rule.

#### 3.2.5. Model-Dependent Source Validation

##### Model-Dependent


```text
thinking validity
temperature validity
image validity
final-assistant prefill validity
mid-conversation system validity
other selected-model restrictions
```

A feature being outside LuckyToken's frozen v1 subset is not by itself evidence that the source is invalid.

##### Source-Validity Authority Rule

`Model<Api>` is authoritative only for model facts that Pi actually represents, such as：

```text
model.input
model.reasoning
explicitly modeled compat facts
```

LuckyToken MUST NOT infer an Anthropic source-validity fact merely from：

```text
model.id substring
model age guess
provider-name heuristic
marketing/model-family naming
unknown custom-model convention
```

when the relevant source restriction is not represented by Pi `Model<Api>` or the synchronized Anthropic Protocol dependency.

For a model-dependent Anthropic source restriction not represented by Pi, the Anthropic Client Protocol owns a narrow evidence-bound policy.

For final-assistant prefill, the minimal contract is：

```ts
type FinalAssistantPrefillValidity =
  | "allowed"
  | "forbidden"
  | "unknown";

function classifyFinalAssistantPrefillValidity(
  model: Model<Api>,
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
): FinalAssistantPrefillValidity;
```

This classifier：

```text
belongs to Anthropic Client Protocol
is request-independent and deterministic for a bound evidence revision
its immutable policy revision is bound by Runtime Certification
uses resolved model identity + source profile
does not create a second Model IR
does not mutate Model<Api>
does not read unrelated ambient state
```

Its result is consumed only by model-dependent source validation：

```text
forbidden
→ source-invalid
→ InvalidRequest

allowed
→ source-validity may proceed
→ current v1 final-assistant prefill still reaches
  Static v1 Semantic Support
→ UnsupportedFeature

unknown
→ LuckyToken cannot establish source validity
→ UnsupportedFeature
→ MUST NOT guess InvalidRequest
→ MUST NOT guess allowed
```

Unknown/custom models default to：

```text
unknown
```

unless the bound Anthropic model-validity evidence explicitly classifies them.

A future model-dependent restriction that is not represented in Pi MUST receive its own equally narrow evidence-bound classifier or remain `unknown`; do not introduce a generic capability registry merely to avoid explicit ownership.

##### Model-Validity Information Flow

```text
Synchronized Anthropic protocol/model evidence
        │
        ▼
Anthropic Client Protocol model-validity policy
        │
        ├── resolved Model<Api>
        └── sourceProfile
        │
        ▼
allowed | forbidden | unknown
        │
        ▼
Model-Dependent Source Validation
        │
        ├── forbidden → InvalidRequest
        ├── unknown   → UnsupportedFeature
        └── allowed   → continue
        │
        ▼
ValidatedAnthropicRequest
```

Death point：

```text
once model-dependent source validation succeeds
→ classifier result does not enter Context
→ classifier result does not enter effectiveOptions
→ classifier result does not enter renderState
```

##### Image Capability Preflight


Required：

```text
model.input.includes("image")
AND
certified path image fidelity
```

Model declaration is necessary but not sufficient.

---

#### 3.2.6. Static v1 Semantic Support

##### Source-Valid Semantic Surface


Once source validity can be established under the supported profile, any source-valid but v1-unclassified：

```text
body field
content variant
tool field
schema semantic
enum-like value
request-semantic header
protocol extension
```

→

```text
UnsupportedFeature
```

Known source-invalid：

```text
→ InvalidRequest
```

Additionally, an unclassified `anthropic-*` header is conservatively retained as an unsupported Anthropic-owned extension marker. After all known source validity that LuckyToken can establish succeeds：

```text
unclassified anthropic-* header
→ UnsupportedFeature
```

The converter never upgrades “LuckyToken does not understand this source grammar” into a claim that the client sent an invalid Anthropic request.

#### 3.2.7. Accepted / Validated Request State

##### `ValidatedAnthropicRequest`


Meaning：

> The Anthropic body and request-semantic inputs relevant to this conversion are valid under the resolved source profile and selected model.

It does not imply：

```text
client authorized
Pi representable
runtime certified
```

`ValidatedAnthropicRequest` does not need to embed the source profile or semantic-header classification as duplicate state.

The authoritative request-local facts remain adjacent：

```text
ValidatedAnthropicRequest
+
ResolvedAnthropicSourceProtocolProfile
+
sourceSemanticHeaders classification
```

They are passed explicitly to the later operation that actually needs each fact.

In particular, deterministic conversion receives `sourceProfile` explicitly because ToolResult string shorthand authorization is profile-owned.

### 3.3. Conversation and Message Conversion

#### Complete Deterministic Request Conversion


Conversion consumes only already-validated and already-supported semantics.

```ts
interface AnthropicRequestConversion {
  context: Context;
  options: ModelsSimpleStreamOptions;
  renderState: AnthropicRenderState;
}

interface AnthropicRenderState {
  stream: boolean;
  clientModel: string;
}
```

Frozen operation contract：

```ts
function convertAnthropicRequestToPi(
  request: ValidatedAnthropicRequest,
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
  receivedAt: number,
): AnthropicRequestConversion
```

`sourceProfile` is an adjacent read-only authority, not duplicate state inside `ValidatedAnthropicRequest`.

The resolved `Model<Api>` is intentionally not a deterministic-converter input. Model-dependent source validity and representability have already completed before this operation; conversion must not regain target-capability authority indirectly.

Frozen deterministic construction：

```ts
function convertAnthropicRequestToPi(
  request: ValidatedAnthropicRequest,
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
  receivedAt: number,
): AnthropicRequestConversion {
  const messages = convertMessages(
    request.messages,
    sourceProfile,
    receivedAt,
    request.model,
  );

  const context: Context = { messages };

  const systemPrompt = convertSystem(request.system);
  if (systemPrompt !== undefined) {
    context.systemPrompt = systemPrompt;
  }

  const tools = convertTools(request.tools);
  if (tools !== undefined) {
    context.tools = tools;
  }

  // max_tokens=0 has already failed static v1 support.
  assert(request.max_tokens > 0);

  const options: ModelsSimpleStreamOptions = {
    maxTokens: request.max_tokens,
  };

  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }

  // thinking omitted means reasoning remains absent.
  // Explicit thinking/output controls are rejected before here.

  if (request.metadata?.user_id !== undefined) {
    options.metadata = {
      user_id: request.metadata.user_id,
    };
  }

  return {
    context,
    options,
    renderState: {
      stream: request.stream ?? false,
      clientModel: request.model,
    },
  };
}
```

Frozen presence rules：

```text
system omitted
→ context.systemPrompt absent

tools omitted
→ context.tools absent

temperature omitted
→ options.temperature absent

metadata.user_id omitted
→ options.metadata absent

stream
→ renderState only
→ never Provider execution control
```

Forbidden：

```ts
options.metadata = request.metadata as any;
```

Forbidden：

```text
copy arbitrary source fields into options
materialize omitted controls
read sourceProfile from global/ambient state
re-run client failure classification inside conversion
```

The source-profile information dies from the conversion path once all profile-dependent conversion authority is consumed; it never enters Pi `Context` or `ModelsSimpleStreamOptions`.

#### Content Acceptance Hierarchy


```text
Content
├── Variant allowed?
└── if yes:
    └── Fields allowed?
```

Variant and field allowlists remain separate.

---

#### Field Allowlists


Text：

```text
type
text
```

Image：

```text
type
source.type
source.media_type
source.data
```

ToolResult：

```text
type
tool_use_id
content?
is_error?
```

ToolUse：

```text
type
id
name
input
```

Unrepresented behavioral extensions fail as `UnsupportedFeature`.

---

#### Text Fidelity


Preserve：

```text
exact parsed string value
```

No：

```text
trim
whitespace filtering
newline normalization
invented separators
```

---

#### Complete Message Conversion and User-Turn Expansion


Anthropic message conversion is not 1:1.

```text
Canonical User
├── tool_result*
└── text/image*
        ↓
Pi
├── ToolResultMessage*
└── UserMessage?
```

Tool-result-only user turns MUST NOT create an empty `UserMessage`.

Explicit ordinary `message.content: []` has already failed Source Grammar Coverage before conversion, so a zero-ordinary-content user turn reaching this function is legal only when it consists of tool results.

#### 3.3.1. Conversation Structure

##### 3.3.1.1. Normal Message String Shorthand


```text
message.content = "A"
```

canonicalizes to：

```text
[
  Text("A")
]
```

because the source protocol explicitly defines that shorthand.

Preserve exact parsed string value.

---

##### 3.3.1.2. Explicit Empty Content Boundaries

###### Ordinary `message.content: []`


The reviewed Protocol v0.4 / current evidence establishes the array branch but does not establish a normative validity/equivalence rule for an explicit empty ordinary message-content array.

Therefore current v1 MUST detect this wire representation before ordinary canonical conversion can erase its presence：

```text
user.content = []
assistant.content = []
→ unresolved Source Grammar Coverage
→ UnsupportedFeature
```

Never：

```text
explicit []
→ silently remove the source turn
```

and never guess：

```text
[] → InvalidRequest
[] → omission-equivalent message
```

A future synchronized Protocol revision may replace this policy only with explicit source authority.

##### 3.3.1.3. Same-Role Coalescing


Only：

```text
user + user
assistant + assistant
```

No generic：

```text
system + system
```

Merge：

```ts
[...a.content, ...b.content]
```

No separator insertion.

---

#### 3.3.2. System → Context.systemPrompt

##### System


Supported：

```text
system:string
```

or one plain text block.

Mapping：

```ts
context.systemPrompt = sourceText;
```

Exact parsed value preserved.

Multiple system blocks：

```text
UnsupportedFeature
```

---

#### 3.3.3. User Message

##### 3.3.3.1. User Content

###### User Content Variants


Supported / Conditional：

```text
text
base64 image
tool_result supported subset
```

Unsupported：

```text
URL image
document
search_result
server-tool families
known unsupported extensions
future source-valid variant
```

---

###### 3.3.3.1.1. Image

**Images**


Supported MIME：

```text
image/jpeg
image/png
image/gif
image/webp
```

Mapping：

```ts
{
  type: "image",
  mimeType: source.media_type,
  data: source.data,
}
```

URL images unsupported.

---

###### 3.3.3.1.2. ToolResult

**3.3.3.1.2.1. Content Representations**

**ToolResult Content Conversion Death Points**


When the resolved source profile authorizes string shorthand：

```text
source string
→ exactly one Pi TextContent
```

and the original string-vs-single-text-block encoding form dies at this conversion boundary.

All support decisions are completed before conversion; assertions below are defensive preconditions.

```ts
function convertToolResultContent(
  source:
    | string
    | SupportedToolResultBlock[]
    | undefined,
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
): (TextContent | ImageContent)[] {
  if (source === undefined) {
    return [];
  }

  if (typeof source === "string") {
    assertToolResultStringShorthandAuthorized(
      sourceProfile,
    );

    return [{
      type: "text",
      text: source,
    }];
  }

  if (source.length === 0) {
    // Current v0.4-backed no-beta v1 profile rejects this before conversion.
    // A future profile may authorize it explicitly.
    assertToolResultEmptyArrayAuthorized(
      sourceProfile,
    );
    return [];
  }

  return source.map(
    convertSupportedToolResultBlock,
  );
}
```

No conversion helper may independently upgrade an unresolved source representation into a supported one.

**Revised ToolResult Presence Invariant**


Frozen wording：

> **ToolResult content omission and semantically distinct explicit values MUST NOT be collapsed. Source-defined shorthand or equivalent representations MAY canonicalize only at their explicitly specified death point.**

Therefore it is legal for：

```text
string "A"
and
[TextBlock("A")]
```

to collapse only when the source profile defines them as equivalent.

It is not legal to collapse：

```text
omitted
and
""
```

without a separate source equivalence rule.

---

**3.3.3.1.2.1.1. Omitted Content**

**ToolResult Omission Remains Distinct**


Even when string shorthand is authorized：

```text
content omitted
→ []
```

remains distinct from：

```text
content: ""
→ [Text("")]
```

and：

```text
content: " "
→ [Text(" ")]
```

Therefore：

```text
omitted
≠
explicit empty textual result
≠
explicit whitespace textual result
```

---

**3.3.3.1.2.1.2. String Representation**

**ToolResult String Shorthand Authority — Current v1 Policy**


The converter MUST NOT independently decide that：

```text
string S
≡
[TextBlock(S)]
```

This equivalence belongs to the resolved source protocol profile.

The current project Anthropic Protocol Spec v0.4 establishes that ToolResult string syntax is accepted by the source protocol, but explicitly does **not** establish normative string→single-TextBlock equivalence.

Therefore current v1 behavior is frozen：

```text
tool_result.content = string
→ source-valid representation
→ equivalence to Pi one-TextContent representation not established
→ UnsupportedFeature
```

This rejection occurs after Source Validity, at static v1 semantic support/representability.

A future source profile may enable string support only if its authoritative Protocol Spec explicitly establishes：

```text
tool_result.content = string S

is textual shorthand / semantic equivalent of

tool_result.content = [
  {
    type: "text",
    text: S
  }
]
```

Only then may the `ToolResult Content Conversion Death Points` canonicalization execute.

**If String Equivalence Is Not Established**


If source syntax permits string, but the authoritative source profile has not established string→single-text-block semantic equivalence：

```text
→ UnsupportedFeature
```

The converter MUST NOT infer equivalence merely because Pi can represent both as one `TextContent`.

---

**ToolResult Representation Equivalence**


Once source-authorized shorthand is established：

```text
content: "A"
```

and：

```text
content: [
  {
    type: "text",
    text: "A"
  }
]
```

may intentionally canonicalize to the same Pi representation：

```text
[
  Text("A")
]
```

This is not silent semantic collapse.

It is source-authorized shorthand canonicalization.

---

**3.3.3.1.2.1.3. Explicit Empty Array**

**Explicit `tool_result.content: []` — Current v1 Policy**


The project Anthropic Protocol Spec v0.4 establishes that：

```text
content is optional
content can be string
content can be an array
```

and records explicit：

```json
"content": []
```

as an evidenced representation in at least one official beta-path example.

However, v0.4 does **not** establish universal validity for explicit `[]` under the supported no-beta v1 profile, and does not establish omission-equivalence.

Therefore v1 freezes one executable policy for the current supported profile：

```text
explicit tool_result.content: []
→ Source Profile / Grammar Coverage = unsupported
→ UnsupportedFeature
```

This is intentionally **not**：

```text
InvalidRequest
```

because current source authority does not prove the representation source-invalid for the supported profile.

It is also intentionally **not**：

```text
Pi content=[]
```

because Pi structural convenience does not prove omission equivalence.

A future Protocol Spec/profile revision may replace this current rule only after establishing one of the following：

```text
A. [] is source-invalid
   → InvalidRequest

B. [] is source-valid and omission-equivalent
   → Pi [] with runtime equivalence proof

C. [] is source-valid but semantically distinct / equivalence unknown
   → UnsupportedFeature
```

Until then, current v1 behavior is deterministic：

```text
[] → UnsupportedFeature
```

**3.3.3.1.2.2. is_error**


Anthropic `is_error:true` marks the tool result as an error. Omission means the source result is not marked as an error.

Pi requires a boolean, so the required-shape projection is：

```text
omitted → false
false   → false
true    → true
```

The source presence bit dies at this explicit projection point. No other ToolResult semantic is inferred from the boolean.

**3.3.3.1.2.3. Pi ToolResultMessage Required Shape**

**ToolResultMessage Mapping**


`sourceProfile` arrives through the explicit deterministic-conversion call chain described under `Complete Deterministic Request Conversion`.

```ts
{
  role: "toolResult",
  toolCallId: source.tool_use_id,
  toolName: pending.name,
  content: convertToolResultContent(
    source.content,
    sourceProfile,
  ),
  isError: source.is_error ?? false,
  timestamp: receivedAt,
}
```

No module may obtain the active source profile through global mutable state, ambient request context, or hidden singleton lookup.

##### 3.3.3.2. User-Turn Expansion to Pi Message[]

###### User Turn Conversion


```ts
function convertUserTurn(
  source: CanonicalAnthropicUserMessage,
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
  pending: Map<string, PendingToolCall> | undefined,
  receivedAt: number,
): Message[] {
  const result: Message[] = [];
  const ordinary: (TextContent | ImageContent)[] = [];

  for (const block of source.content) {
    if (block.type === "tool_result") {
      // Source validation has already proven correlation/order.
      // Missing state here is an internal invariant failure.
      const call = requirePendingToolCallInvariant(
        pending,
        block.tool_use_id,
      );

      result.push(
        convertToolResult(
          block,
          call,
          sourceProfile,
          receivedAt,
        ),
      );

      consumePendingToolCallInvariant(
        pending,
        block.tool_use_id,
      );

      continue;
    }

    ordinary.push(
      convertPortableUserBlock(block),
    );
  }

  if (ordinary.length > 0) {
    result.push({
      role: "user",
      content: ordinary,
      timestamp: receivedAt,
    });
  }

  return result;
}
```

Source validation guarantees `tool_result` blocks precede ordinary user content; conversion never repairs invalid ordering.

#### 3.3.4. Historical Assistant Message

##### Historical Assistant Variants and Model-Dependent Final Prefill


Portable **historical** assistant content in capability baseline v2：

```text
text
thinking
tool_use
```

Unsupported historical content：

```text
redacted_thinking
opaque continuation
server-tool families
future extensions
```

An ordinary source `thinking` block is valid only on an assistant turn and has the exact known shape：

```ts
{
  type: "thinking";
  thinking: string;
  signature: string;
}
```

It maps to Pi without textification or Provider knowledge：

```ts
{
  type: "thinking";
  thinking: source.thinking;
  ...(source.signature.length > 0
    ? { thinkingSignature: source.signature }
    : {});
}
```

The signature is opaque. Client Protocol code may validate, preserve, and replay it, but MUST NOT interpret it. An empty Anthropic signature is the canonical projection for absent Pi signature state and maps back to absence. `redacted_thinking` remains a separate unsupported source feature after its known source shape has been validated.

A separate turn-level rule applies before ordinary historical conversion.

A canonical final assistant message is Anthropic response-prefill / continuation semantics, not an ordinary completed history turn.

Current source-validity authority is model-dependent：

```text
final assistant
        │
        ▼
Model-Dependent Source Validation
        │
        ├── selected source model forbids assistant prefill
        │      → InvalidRequest
        ├── source model/profile permits assistant prefill
               ↓
        Static v1 Semantic Support
               → UnsupportedFeature
        │
        └── source validity is unknown
               → UnsupportedFeature
               → never guessed valid or invalid
```

Current official Anthropic source evidence explicitly places Claude 4.6 and later models and Claude Mythos Preview in the first branch: these models reject prefill with HTTP 400 `invalid_request_error`.

For a source model/profile where assistant prefill remains source-valid, generic Pi history still does not prove continuation equivalence; LuckyToken v1 therefore rejects it as `UnsupportedFeature`.

The final assistant is never treated as an ordinary portable historical turn merely because its blocks are `text` / `tool_use`.

##### Historical Assistant Complete Pi Mapping


Portable content blocks map exactly.

Text：

```ts
{
  type: "text",
  text: source.text,
}
```

When a prior LuckyToken response is replayed, its historical assistant TextBlock also carries the deterministic required-shape projection `citations:null`. Capability baseline v2 accepts that exact value on an assistant turn and discards only the projection while constructing Pi. Non-null citation semantics, user-turn citations, and additional citation state remain unsupported; they are never guessed or passed through Pi as unrelated metadata.

ToolUse：

```ts
{
  type: "toolCall",
  id: source.id,
  name: source.name,
  arguments: source.input,
}
```

No Client-side Provider normalization.

Pi `AssistantMessage` additionally requires provenance, usage, stopReason, and timestamp that Anthropic request history does not provide.

Frozen synthetic provenance concept：

```ts
const SYNTHETIC_CLIENT_HISTORY_API =
  "luckytoken-client-history";

const SYNTHETIC_CLIENT_HISTORY_PROVIDER =
  "luckytoken-client";
```

Exact strings may only change with a specification revision. Correctness requires the resulting `(provider, api, model)` identity to be deterministic, clearly synthetic, Client-Protocol-owned, and disjoint from all certified target identities.

```ts
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
```

Historical conversion：

```ts
function convertAssistantHistory(
  source: CanonicalAnthropicAssistantMessage,
  receivedAt: number,
  clientModel: string,
): AssistantMessage {
  assertNoOpaqueContinuation(source);

  const content = source.content.map(
    convertPortableAssistantBlock,
  );

  return {
    role: "assistant",
    api: SYNTHETIC_CLIENT_HISTORY_API,
    provider: SYNTHETIC_CLIENT_HISTORY_PROVIDER,
    model: clientModel,
    content,
    usage: emptyUsage(),
    stopReason: content.some(
      block => block.type === "toolCall",
    )
      ? "toolUse"
      : "stop",
    timestamp: receivedAt,
  };
}
```

These values are required-shape projections, not recovered historical telemetry.

```text
usage absent in source
→ zero Usage

stop reason absent in source
→ toolUse if ToolCall exists, otherwise stop

timestamp absent in source
→ receivedAt

historical ordering
→ Message array order, not fabricated timestamps
```

Forbidden：

```text
unknown historical provenance
→ pretend resolved target provenance
```

Synthetic-identity disjointness belongs to Runtime Readiness / certification, not deterministic conversion：

```text
certified target identity
must never equal
reserved synthetic history identity
```

If that invariant is violated：

```text
→ Runtime / Serving Readiness Failure
```

A defensive post-readiness assertion may classify a later impossible collision as Runtime / Invocation Integrity Failure. The converter never invents a request-specific random identity to repair it.

Opaque continuation remains `UnsupportedFeature`; synthetic provenance never creates replay authority.

#### 3.3.5. Tool Interaction Lifecycle

##### Main Turn-Scoped Algorithm


```ts
function convertMessages(
  canonicalMessages: CanonicalAnthropicMessage[],
  sourceProfile: ResolvedAnthropicSourceProtocolProfile,
  receivedAt: number,
  clientModel: string,
): Message[] {
  // Canonicalization/validation already established this.
  assertConversionInvariantNoAdjacentSameRole(
    canonicalMessages,
  );

  const result: Message[] = [];
  let pending: Map<string, PendingToolCall> | undefined;

  for (let i = 0; i < canonicalMessages.length; i++) {
    const source = canonicalMessages[i];
    const isFinal = i === canonicalMessages.length - 1;

    if (source.role === "assistant") {
      // Model-dependent validity + v1 semantic support
      // already handled every final-assistant branch.
      if (isFinal) {
        failInternalConversionInvariant(
          "Final assistant reached deterministic conversion.",
        );
      }

      if (pending?.size) {
        failInternalConversionInvariant(
          "Unresolved tool_use reached deterministic conversion.",
        );
      }

      const assistant = convertAssistantHistory(
        source,
        receivedAt,
        clientModel,
      );

      result.push(assistant);

      const calls = assistant.content
        .filter((x): x is ToolCall => x.type === "toolCall");

      if (calls.length > 0) {
        pending = new Map();

        for (const call of calls) {
          if (pending.has(call.id)) {
            failInternalConversionInvariant(
              "Duplicate validated tool_use id.",
            );
          }

          pending.set(call.id, {
            id: call.id,
            name: call.name,
          });
        }
      } else {
        pending = undefined;
      }

      continue;
    }

    if (source.role === "user") {
      result.push(...convertUserTurn(
        source,
        sourceProfile,
        pending,
        receivedAt,
      ));

      if (pending?.size) {
        failInternalConversionInvariant(
          "Validated user turn left pending tool_use state.",
        );
      }

      pending = undefined;
      continue;
    }

    // Mid-conversation system/source-unsupported roles
    // must have failed before deterministic conversion.
    failInternalConversionInvariant(
      "Unsupported role reached deterministic conversion.",
    );
  }

  if (pending?.size) {
    failInternalConversionInvariant(
      "Validated conversation ended with pending tool_use.",
    );
  }

  return result;
}
```

Normative failure authority is upstream of this operation：

```text
malformed tool lifecycle
→ Source Validation
→ InvalidRequest

source-valid final assistant prefill
or unsupported message semantic
→ Static v1 Semantic Support
→ UnsupportedFeature

impossible state reaches converter
→ internal Runtime / Invocation Integrity failure
```

The converter does not rely on Pi synthetic orphan-result repair to make an invalid Anthropic conversation executable.

##### Tool Identity and Pending State


Identity authority：

```text
tool_use.id
=
tool_result.tool_use_id
```

Pi additionally requires `ToolResultMessage.toolName`; it is recovered only from the pending preceding `tool_use` state.

```ts
interface PendingToolCall {
  id: string;
  name: string;
}
```

Lifecycle：

```text
assistant tool_use A/B
→ pending {A,B}

immediately following canonical user tool_result A/B
→ consume by ID

all resolved
→ clear
```

No whole-history registry.

No position-based or name-based correlation.

No guessing.

##### Tool Lifecycle Errors


```text
duplicate tool_use ID
unknown tool_result ID
duplicate tool_result
unresolved tool call
invalid result ordering
```

→ `InvalidRequest`.

---

### 3.4. Tool Definition Conversion

#### Tool Definition Complete Mapping


Pi Tool contract：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

Frozen converter shape：

```ts
function convertTool(
  source: ValidatedAnthropicTool,
): Tool {
  return {
    name: source.name,
    description: source.description ?? "",
    parameters: convertToolSchema(
      source.input_schema,
    ),
    ...(source.strict === true
      ? {
          constrainedSampling: {
            type: "json_schema",
            strict: "require",
          },
        }
      : {}),
  };
}
```

Frozen field matrix：

| Source Tool Field                     | v1 Mapping                                    |
| ------------------------------------- | --------------------------------------------- |
| `name`                                | exact                                         |
| `description` present                 | exact                                         |
| `description` omitted                 | `""`, synthetic required-shape projection     |
| `input_schema`                        | recursive validated conversion → `parameters` |
| `strict=true`                         | `{type:"json_schema", strict:"require"}`      |
| `strict=false` / omitted              | `constrainedSampling` absent                  |
| `cache_control`                       | `UnsupportedFeature`                          |
| `allowed_callers`                     | `UnsupportedFeature`                          |
| `defer_loading`                       | `UnsupportedFeature`                          |
| `eager_input_streaming`               | `UnsupportedFeature`                          |
| `input_examples`                      | `UnsupportedFeature`                          |
| server/versioned `type`               | `UnsupportedFeature`                          |
| future behaviorally significant field | `UnsupportedFeature`                          |

Tool field handling is an explicit allowlist. Never spread unknown source fields into Pi `Tool`.

`description:""` is not a source fact. Runtime certification must prove that the required-shape projection is model-visible/upstream equivalent to source omission; otherwise requests using omitted descriptions are unsupported.

#### 3.4.1. Input Schema

##### Tool Schema Source Validity vs v1 Subset


Source-schema validity belongs exclusively to the selected Anthropic source profile.

For the supported baseline client-tool grammar, `input_schema` must describe object-shaped tool input.

Known source-invalid examples：

```text
root type != object
malformed properties
malformed required
invalid keyword value shape
structurally invalid schema
```

→

```text
InvalidRequest
```

##### 3.4.1.1. Strict Request-Wide Source Limits

###### `strict:true` Request-Wide Source Limits


Current official source authority states that strict tool use shares the structured-schema grammar-compilation pipeline and documents these deterministic request-wide limits：

```text
strict:true tools per request <= 20
optional parameters total     <= 24
union-type parameters total   <= 16
```

Counts are across all strict schemas participating in the request, not independently per tool.

Exceeding a documented deterministic hard limit：

```text
→ InvalidRequest
```

These checks belong to Source Validation, before the LuckyToken v1 subset check.

Anthropic also documents additional internal compiled-grammar complexity limits and a compilation timeout whose full predicate is not publicly reducible to the three counters above. LuckyToken MUST NOT invent a local approximation and label requests invalid because of it. Upstream-only compiler rejections follow the normal upstream error path unless a future synchronized Protocol Spec makes the boundary deterministic.

##### 3.4.1.2. Frozen v1 Schema Subset

###### v1 Subset


Only after source validity succeeds：

```text
source-valid schema
→ frozen LuckyToken v1 subset check
```

If a valid source schema is outside the frozen subset：

```text
UnsupportedFeature
```

Never implement：

```ts
if (!isFrozenV1Schema(x)) {
  throw InvalidRequest;
}
```

The two authorities must remain separate.

###### Exact Recursive v1 Schema Subset


v0.4.9 preserves the exact frozen subset. Implementation does not choose its own schema surface.

###### Supported Keywords


```text
type
properties
required
additionalProperties
items
enum
const
description
title
default
examples

minimum
maximum
exclusiveMinimum
exclusiveMaximum
multipleOf

minLength
maxLength
pattern

minItems
maxItems
uniqueItems

minProperties
maxProperties
```

Supported single `type` values：

```text
object
array
string
number
integer
boolean
null
```

`type` MUST be one supported string value. Type arrays are unsupported.

##### 3.4.1.3. Recursive Schema-Valued Positions


The same allowlist applies recursively through every schema-valued position：

```text
properties.*
→ SchemaNode

items
→ SchemaNode

additionalProperties
→ boolean
  OR SchemaNode
```

At every nested `SchemaNode` the same frozen keyword allowlist applies.

##### 3.4.1.4. Non-Schema JSON Values


These are value data, not recursive schema positions：

```text
enum
const
default
examples
```

Their object/array values are not interpreted as nested schemas merely because they contain JSON objects.

##### 3.4.1.5. Unsupported Source-Valid Schema Features

###### Explicitly Unsupported Valid Features


At any nesting depth：

```text
$ref
$defs
definitions
oneOf
anyOf
allOf
not
if
then
else
dependentRequired
dependentSchemas
patternProperties
propertyNames
contains
minContains
maxContains
unevaluatedProperties
unevaluatedItems
prefixItems
format
type arrays
remote references
cycles
unknown semantic keyword
```

If source-valid：

```text
→ UnsupportedFeature
```

Unknown semantic keywords are never dropped.

#### 3.4.2. strict → constrainedSampling

##### Tool Strict Mapping Is Target-Capability-Free


Exact static mapping：

```text
strict=true
→ constrainedSampling = {
    type: "json_schema",
    strict: "require"
  }
```

```text
strict=false / omitted
→ constrainedSampling absent
```

No capability-dependent downgrade is allowed during conversion.

Conceptual signature：

```ts
function convertTools(
  source: ValidatedAnthropicTool[] | undefined,
): Tool[] | undefined
```

Do not pass `Model<Api>` merely to decide whether to preserve source strictness or schema semantics.

```text
source/model validity
→ validation

truthful Pi construction
→ conversion

selected runtime ability
→ Gate C / certification
```

If the certified path cannot execute the truthful Pi Tool semantics：

```text
→ UnsupportedFeature
```

Never：

```text
strict=true
→ silently remove constrainedSampling
```

#### 3.4.3. Tool Runtime Fidelity Requirements

##### Runtime Fidelity


Static acceptance is only the first gate.

```text
Tool.parameters
= schema semantics

Tool.constrainedSampling
= enforcement requirement
```

Therefore `strict=false` only means constrained decoding is not required; it does not authorize removing schema constraints.

The certified execution path must preserve every accepted `Tool.parameters` semantic keyword.

### 3.5. Request Controls and Render State

#### 3.5.1. max_tokens


Positive：

```text
protocolOptions.maxTokens
=
source.max_tokens
```

Internal rewrite before Models：

```text
Runtime Failure
```

Post-Gate clamp：

```text
Runtime Certification Failure
```

Path fundamentally incapable of accepted semantic：

```text
UnsupportedFeature
```

---

#### 3.5.2. temperature


Present：

```text
source
→ protocolOptions.temperature
→ effectiveOptions.temperature exact
```

Omitted：

```text
effectiveOptions.temperature absent
```

Internal injection：

```text
Runtime / Invocation Integrity Failure
```

Correct invocation but path incapable：

```text
UnsupportedFeature
```

---

#### 3.5.3. Thinking / Output Controls


v1：

```text
thinking omitted
→ reasoning absent / Conditional

explicit thinking
→ UnsupportedFeature

output_config.effort
→ UnsupportedFeature

output_config.format
→ UnsupportedFeature

tool_choice
stop_sequences
top_p
top_k
→ UnsupportedFeature
```

---

#### 3.5.4. stream → AnthropicRenderState

##### `stream`


Client rendering only：

```text
false / omitted
→ JSON

true
→ Atomic SSE
```

It is not Provider streaming control.

---

#### 3.5.5. Must-Remain-Absent Pi Controls

##### Must Remain Absent


v1：

```text
reasoning
deferred
thinkingBudgets
samplingParams
cacheRetention
onPayload
```

Unexpected internal presence：

```text
Invocation Integrity Failure
```

---

##### Other Live Capabilities


v0.4.9 does not create a generic live-capability framework.

If a future Pi option introduces another intentionally stateful capability：

```text
it is not automatically live
```

It must be explicitly classified by the frozen effective-options contract.

Unclassified future options remain absent.

#### 3.5.6. Infrastructure / Auxiliary Controls

##### Infrastructure and Auxiliary Controls


Potential infrastructure：

```text
signal
telemetryContext
timeoutMs
websocketConnectTimeoutMs
maxRetries
maxRetryDelayMs
onResponse
transport
```

Certification-bound hooks/facts：

```text
fetch
sessionId
apiKey
headers
env
transformHeaders
projectDir
auth-derived baseUrl
```

---

### 3.6. Pi Invocation Construction

#### 3.6.1. composeOptions → effectiveOptions

##### Effective Options Closed World


Unclassified Pi invocation option：

```text
MUST remain absent
```

Classes：

```text
Client-Semantic Controls
Must Remain Absent
Certified Infrastructure Controls
Certification-Bound Transport Hooks
Certified Auxiliary/Auth Facts
```

---
##### Metadata Merge and Reserved-Key Ownership

Deterministic Anthropic conversion owns only：

```text
protocolOptions.metadata.user_id
```

when source `metadata.user_id` is present.

Client Authorization owns：

```text
projectDir
```

and Core carries it as：

```text
effectiveOptions.metadata.projectDir
```

The two facts share the Pi `metadata` container but do **not** share semantic ownership.

`composeOptions()` MUST merge `metadata` per key rather than replace the whole object.

Normative construction：

```ts
const metadata = {
  ...(protocolOptions.metadata ?? {}),
  ...(auth.projectDir !== undefined
    ? { projectDir: auth.projectDir }
    : {}),
};

effectiveOptions.metadata =
  Object.keys(metadata).length === 0
    ? undefined
    : metadata;
```

Required cases：

```text
user_id absent
projectDir absent
→ effectiveOptions.metadata absent

user_id = U
projectDir absent
→ effectiveOptions.metadata = { user_id: U }

user_id absent
projectDir = P
→ effectiveOptions.metadata = { projectDir: P }

user_id = U
projectDir = P
→ effectiveOptions.metadata = {
     user_id: U,
     projectDir: P
   }
```

Reserved-key ownership：

```text
metadata.user_id
→ Anthropic Client Protocol

metadata.projectDir
→ Client Authorization
```

Router defaults or any unrelated source MUST NOT silently write or override either reserved key.

A non-owner collision on `user_id` or `projectDir` is a runtime/composition configuration failure and MUST fail before `Models.streamSimple()` rather than resolve by last-write-wins.

Any other `metadata` key remains subject to the Effective Options Closed World：

```text
explicitly classified/certified
→ may be present

unclassified
→ MUST remain absent
```

This preserves the Core fact-flow contract：

```text
projectDir
Producer          = Client Authorization
Carrier           = Options.metadata.projectDir
Semantic Consumer = owning Provider path
Models            = transparent transit for this fact
```


#### 3.6.2. Models-Facing Invocation


```text
Models-Facing Invocation
├── Model<Api>
├── Context
└── effectiveOptions
```

No new runtime type required.

---

## 4. Execution and Atomic Commit

### 4.1. Execution Inputs and Admission

#### Adjacent Execution Preconditions


本 Conversion Method **不 owns Pi stream consumption**。

Ownership：

```text
AssistantMessageEventStream
        ↓
Core Execution
        ↓
committed AssistantMessage | failure
        ↓
Anthropic Client Protocol renderer
```

因此：

```text
anthropic/response.ts
```

不应：

```text
iterate AssistantMessageEventStream
race Provider events
own AbortSignal lifecycle
decide Pi terminal completion
```

它只接收已经由 Core Execution 建立的：

```text
committed AssistantMessage
```

本章只记录 response conversion 依赖的 adjacent Execution invariants。

---

### 4.2. Ownership Transfer to Execution

#### Request Invocation Immutability


After Gate C succeeds：

```text
Model semantic/config state
→ immutable

Context semantic state
→ immutable

effectiveOptions structure
→ immutable

ordinary effectiveOptions values
→ immutable
```

But this rule requires one explicit exception category：

```text
live lifecycle capabilities
```

---

### 4.3. AssistantMessageEventStream

#### Why Pi Events Are Not Anthropic Rendering Input


Pi event stream 可以包含：

```text
start

text_start
text_delta*
text_end

thinking_start
thinking_delta*
thinking_end

toolcall_start
toolcall_delta*
toolcall_end

done | error
```

但：

```text
event.partial
```

可以引用同一个被持续 mutation 的累计 `AssistantMessage`。

而：

```text
ToolCall present in partial
≠
completed ToolCall
```

ToolCall streaming arguments 也可能只是 temporary best-effort parsed state。

因此禁止：

```text
Pi text_delta
→ immediately write Anthropic text_delta
```

以及：

```text
Pi toolcall_delta
→ immediately write Anthropic input_json_delta
```

当前 Core v1 不允许 unfinished execution state 跨 Client Protocol boundary。

---

### 4.4. AbortSignal Lifecycle

#### Live Lifecycle Capabilities


Some invocation values are capability objects whose **identity/reference** is stable while their owner-defined lifecycle state intentionally changes.

Frozen rule：

> **Invocation immutability freezes invocation structure, semantic values, and capability identity. It does not freeze owner-defined state transitions of an explicitly live lifecycle capability.**

---

#### 4.4.1. Stable Signal Identity

##### Live Capability Identity vs State


For `AbortSignal`：

```text
immutable:
effectiveOptions.signal reference
```

```text
live:
effectiveOptions.signal.aborted lifecycle
```

Forbidden：

```text
effectiveOptions.signal = anotherSignal
```

after Gate C.

Required：

```text
existing signal may later abort
```

---

#### 4.4.2. Live Cancellation State

##### `AbortSignal` Live Lifecycle


`effectiveOptions.signal` is such a live capability.

After Gate C：

```text
signal reference
→ immutable / cannot be replaced
```

but：

```text
signal.aborted
→ remains live
```

and can transition：

```text
false
→ true
```

because HTTP Boundary continues to own request cancellation lifecycle.

---

##### AbortSignal Authority


Frozen：

```text
HTTP Boundary owns AbortSignal lifecycle
```

Execution owns only the stable invocation reference to that signal.

Therefore：

```text
Gate C sees signal.aborted=false
↓
client disconnects
↓
signal.aborted=true
↓
Execution MUST observe cancellation
```

No Gate-C-time snapshot may erase later cancellation.

---

#### 4.4.3. Abort-Aware Stream Wait

##### Abort-Aware Execution Wait


Request `AbortSignal` 在 semantic success COMMIT 前持续 authoritative。

因此 Core Execution 的每一次 blocking wait for Pi progress 必须保持 abort-aware：

```text
wait next Pi event
        RACE
request AbortSignal
```

不能仅：

```text
await next event
↓
after event arrives
check signal.aborted
```

否则 upstream stall 时 cancellation 无法及时生效。

Abort before COMMIT：

```text
→ aborted
→ no committed AssistantMessage
→ no Anthropic success rendering
```

Execution 在可能时应取消 upstream/stream consumption。

---

### 4.5. Atomic Semantic Commit

#### Success Commit Rule


The request signal remains independently authoritative until success commit.

Therefore successful execution requires：

```text
supported Pi done.message
AND
request signal not aborted at commit
```

If cancellation becomes authoritative before commit：

```text
outcome = Aborted
```

even though the invocation structure itself was frozen after Gate C.

---

#### Atomic Downstream Principle


Core v5.5 的 downstream semantic model：

```text
AssistantMessageEventStream
        ↓
Execution private consume
        ↓
supported done.message
+
request AbortSignal not aborted
        ↓
COMMIT
        ↓
complete AssistantMessage
        ↓
Client Protocol renderer
```

Client Protocol 看不到：

```text
partial Pi stream
partial ToolCall
mutable event.partial
provider SSE lifecycle
```

只看到：

```text
committed AssistantMessage
```

或：

```text
preserved failure
```

---

#### 4.5.1. Supported Successful Terminals

##### Successful Semantic Commit Contract


Current Core v1 successful result：

```text
Pi done(stop | length | toolUse)
+
request AbortSignal not aborted
at success commit point
```

只有满足：

```text
supported done
+
terminal/message consistency
+
signal live
```

才产生：

```text
committed AssistantMessage
```

---

#### 4.5.2. done.reason / message.stopReason Consistency

##### Terminal / Message Consistency


Pi terminal event 与 terminal message 是两个独立结构：

```text
done.reason
done.message.stopReason
```

成功 COMMIT 前必须满足：

```text
done.reason
===
done.message.stopReason
```

对于 current supported success：

```text
stop     ↔ stop
length   ↔ length
toolUse  ↔ toolUse
```

例如：

```text
done.reason = "stop"
message.stopReason = "toolUse"
```

属于：

```text
Runtime / Pi Contract Failure
```

不得 COMMIT。

---

#### 4.5.3. Pre-Commit Failure / Abort

##### Abort Before Commit


```text
Pi done observed
+
request signal aborted
before commit
```

→

```text
Aborted
```

No successful Anthropic Message.

---

## 5. Pi AssistantMessage → Anthropic Message

### 5.1. Response Conversion Boundary

#### Conversion Inputs


Success renderer 需要：

```text
committed AssistantMessage
+
AnthropicRenderState
```

Conceptually：

```ts
interface AnthropicRenderState {
  stream: boolean;
  clientModel: string;
}
```

它只保存 Anthropic response rendering 真正需要的 request-local facts。

---

#### 5.1.1. Pure Conversion Boundary

##### Response Conversion Is Pure


Conceptual：

```ts
convertAssistantMessageToAnthropic(
  message,
  renderState,
)
```

MUST NOT：

```text
read credentials
read process.env
query Models
perform network I/O
inspect Provider implementation
read upstream wire
modify AssistantMessage
inspect HTTP socket state
consume AssistantMessageEventStream
```

---

### 5.2. Source AssistantMessage Structure

#### AssistantMessage Complete Field Matrix


Pi：

```text
AssistantMessage
├── role
├── content
├── api
├── provider
├── model
├── responseModel?
├── responseId?
├── diagnostics?
├── usage
├── stopReason
├── deferred?
├── errorMessage?
├── rawStopReason?
├── endTurn?
└── timestamp
```

v1 disposition：

| Pi field         | Anthropic v1 disposition                                     |
| ---------------- | ------------------------------------------------------------ |
| `role`           | Exact → `"assistant"`                                        |
| `content`        | Converted under supported content contract                   |
| `api`            | Internal / provenance; not rendered                          |
| `provider`       | Internal / provenance; not rendered                          |
| `model`          | Internal Pi model identity; response identity policy handled separately |
| `responseModel?` | Internal/provenance unless future policy explicitly promotes it |
| `responseId?`    | Internal Provider identity; not automatically exposed        |
| `diagnostics?`   | Internal observability                                       |
| `usage`          | Converted                                                    |
| `stopReason`     | Converted under certified termination contract               |
| `deferred?`      | MUST be absent on current v1 committed success               |
| `errorMessage?`  | MUST NOT define successful Anthropic semantics               |
| `rawStopReason?` | Certification evidence only; not generic target authority    |
| `endTurn?`       | Certification-bound consistency fact; not generic target authority |
| `timestamp`      | Internal; not rendered                                       |

Every Pi field therefore has an explicit disposition.

---

### 5.3. Target Field Disposition

#### Field Disposition Taxonomy


Pi → Anthropic fields use four categories：

```text
Pi → Anthropic Field Disposition
│
├── Exact Mapping
├── Required-Shape Projection
├── Internal / Dies Here
└── Certification-Dependent
```

#### Renderer Must Not Guess


Forbidden：

```text
rawStopReason
→ guess target stop_reason
```

```text
errorMessage
→ guess refusal
```

```text
ThinkingContent
→ TextContent
```

```text
invalid tool arguments
→ {}
```

```text
Provider responseId
→ use because it looks Anthropic-like
```

```text
opaque signature present
→ stringify into text
```

```text
target required field missing in Pi
→ blindly emit null
```

Required-shape projection always needs an established deterministic semantic basis.

---

#### 5.3.1. Exact Mapping


The same semantic fact exists in Pi and Anthropic.

Examples：

```text
TextContent.text
ToolCall.id
ToolCall.name
ToolCall.arguments
usage.input
usage.output
```

#### 5.3.2. Required-Shape Projection


Anthropic target requires a field/value but Pi has no identical field.

Allowed only when the value is deterministic under the current supported/certified surface.

Examples：

```text
Message.container = null

ordinary non-refusal:
Message.stop_details = null

TextBlock.citations = null

direct client tool:
ToolUseBlock.caller = { type: "direct" }

no server tools:
Usage.server_tool_use = null
```

Required-shape projection MUST NOT be used to hide a reachable semantic distinction.

#### 5.3.3. Internal / Dies Here


Examples：

```text
api
provider
responseId
diagnostics
timestamp
cost
totalTokens
```

Their architectural lifetime ends at or before the Client response boundary unless a future protocol contract explicitly promotes them.

#### 5.3.4. Certification-Dependent


Examples：

```text
textSignature
thoughtSignature
namespace
responseModel
rawStopReason
endTurn
```

Their omission is allowed only when route conformance establishes that the state is replay-inert, reconstructible, or otherwise not required for the supported client contract.

---

#### 5.3.5. Required-Nullable Presence Rule

##### Required-Nullable Is Not Optional


Target protocol distinguishes：

```text
field?: T
```

from：

```text
field: T | null
```

Therefore：

```text
field absent
≠
field present with null
```

Current response structures affected include：

```text
Message.container
Message.stop_details
TextBlock.citations
Usage nullable fields
RawMessageDeltaEvent.delta nullable fields
MessageDeltaUsage nullable fields
```

Renderer MUST emit required nullable fields explicitly.

---

### 5.4. Identity

#### 5.4.1. type / role

##### `type`


Synthetic protocol literal：

```text
type = "message"
```

Required-Shape Projection / target literal.

---

##### `role`


Pi：

```text
role = "assistant"
```

→ Anthropic：

```text
role = "assistant"
```

Exact.

Any committed response with another role violates Pi successful assistant contract.

---

#### 5.4.2. Client-Visible model

##### Client-Visible Model Identity Is Policy


Pi contains：

```text
message.model
responseModel?
```

These represent Pi/runtime identities.

Anthropic response requires a client-visible：

```text
model
```

v1 LuckyToken policy：

> **The original external Anthropic request model selector is the stable Anthropic-client-visible model identity for the corresponding response.**

Therefore：

```text
Anthropic Message.model
=
renderState.clientModel
```

This is Client Protocol / Router policy.

It is not a claim that：

```text
renderState.clientModel
=
Pi message.model
```

or：

```text
renderState.clientModel
=
upstream responseModel
```

The same policy must be used consistently by request-side `AnthropicRenderState` creation and response rendering.

---

#### 5.4.3. Client Message ID

##### Response Message ID


Pi：

```text
responseId?
```

is Provider-owned opaque state.

It may come from any Provider/API family.

Therefore：

```text
responseId
≠ automatically Anthropic Message.id
```

v1 policy：

```text
Anthropic Client Protocol
generates one opaque Message.id
after semantic COMMIT
```

Exact format is implementation policy.

No specific prefix/length is a semantic invariant.

---

#### 5.4.4. Internal Pi / Provider Identity

##### Internal Model Identity Must Not Leak


Do not expose automatically：

```text
message.api
message.provider
message.model
message.responseModel
```

as the Anthropic client-visible model field.

This prevents internal routing/provider configuration from leaking into the Client Protocol.

---

### 5.5. Content

#### Content Contract


Pi assistant content：

```text
AssistantMessage.content[]
├── TextContent
├── ThinkingContent
└── ToolCall
```

Current Anthropic capability baseline v2 response path supports：

```text
TextContent
ThinkingContent (ordinary, non-redacted)
ToolCall
```

The selected model MUST truthfully advertise `reasoning: true` before historical or produced `ThinkingContent` is representable on the route. Model capability is checked outside the deterministic converter.

---

#### 5.5.1. Content Ordering


Pi：

```text
content[0]
content[1]
content[2]
```

→ Anthropic：

```text
content[0]
content[1]
content[2]
```

No reordering by content type.

---

#### 5.5.2. TextContent


Pi：

```ts
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

Anthropic v0.4 output：

```ts
{
  citations: TextCitation[] | null;
  text: string;
  type: "text";
}
```

Baseline v1 mapping：

```ts
{
  citations: null,
  text: pi.text,
  type: "text",
}
```

Classification：

```text
text
→ Exact Mapping

citations:null
→ Required-Shape Projection
```

The certified v1 route must establish that citation-bearing output cannot occur.

Forbidden：

```text
trim
drop whitespace
newline normalization
merge adjacent blocks
invent separators
```

---

##### 5.5.2.1. textSignature


`textSignature` has no generic Anthropic TextBlock target field.

Its mere presence does not automatically mean failure.

Correct rule：

```text
selected certified path proves
textSignature is replay-inert /
reconstructible for supported round-trip
        ↓
may omit from target
```

Otherwise：

```text
path is not outbound/round-trip certified
```

The renderer MUST NOT：

```text
parse
reinterpret
recreate
or expose
```

opaque `textSignature` through unrelated target fields.

---

#### 5.5.3. ToolCall


Pi：

```text
ToolCall
├── id
├── name
├── arguments
├── thoughtSignature?
└── namespace?
```

Anthropic v0.4 direct client tool result block：

```text
ToolUseBlock
├── id
├── caller
│   └── type = "direct"
├── input
├── name
└── type = "tool_use"
```

Baseline mapping：

```ts
{
  id: tool.id,
  caller: {
    type: "direct",
  },
  input: tool.arguments,
  name: tool.name,
  type: "tool_use",
}
```

Classification：

```text
id / name / input
→ Exact Mapping

caller:{type:"direct"}
→ Required-Shape Projection
```

The projection is valid only while server-tool caller semantics remain unsupported/unreachable on the certified v1 path.

---

##### 5.5.3.1. id / name

###### ToolCall Identity


Preserve：

```text
id
name
ordering
```

exactly.

Forbidden：

```text
normalize ID
replace ID
normalize name
case-fold name
generate target-specific replacement identity
```

---

##### 5.5.3.2. arguments → input

###### ToolCall Input Is a JSON Object Tree


Static Pi declares：

```ts
arguments: Record<string, any>
```

but runtime producers can violate static shape.

For Anthropic response output, v1 requires：

```text
arguments
=
JSON object tree
```

Conceptually：

```ts
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

type ToolInput =
  Record<string, JsonValue>;
```

---

##### 5.5.3.3. JSON Object-Tree Validation

###### ToolCall Runtime Validation


Root MUST be：

```text
non-null semantic object
```

Nested values must be JSON values.

Reject：

```text
undefined
BigInt
NaN
Infinity
function
symbol
cycle
non-semantic toJSON coercion
```

Also reject root：

```text
null
array
number
boolean
string
```

No coercion.

---

###### JSON Encoding Is Not Repair


Only after runtime validation：

```text
ToolInput
↓
JSON.stringify
```

`JSON.stringify()` is encoding.

It MUST NOT be used as：

```text
semantic validator
repair mechanism
or coercion mechanism
```

---

##### 5.5.3.4. thoughtSignature / namespace


These fields have no baseline Anthropic `tool_use` representation.

Presence does not automatically mean failure.

Certification determines relevance：

```text
opaque state replay-inert / reconstructible
→ may omit
```

```text
opaque state required for continuation
→ path not round-trip certified
```

Renderer does not guess.

---

#### 5.5.4. ThinkingContent

##### 5.5.4.1. Ordinary Thinking Mapping

Capability baseline v2 supports only ordinary, non-redacted Pi thinking：

```ts
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

The deterministic response mapping is：

```ts
{
  type: "thinking",
  thinking: pi.thinking,
  signature: pi.thinkingSignature ?? "",
}
```

`thinking` and a present `thinkingSignature` MUST be strings. `redacted:true` is not silently treated as ordinary thinking; it reaches Outbound Response Fidelity Failure. The empty target signature is the single canonical representation of absent Pi signature state. Non-empty signatures remain opaque and exact.

Do not render thinking as text and do not silently drop it.

---

##### 5.5.4.2. Redacted Thinking Boundary

`redacted_thinking` and `ThinkingContent(redacted:true)` remain outside capability baseline v2. Supporting them requires an independently specified Pi representation and exact response plus next-request replay mapping. Their exclusion MUST NOT weaken ordinary thinking support.

---

### 5.6. Usage

#### Usage Mapping


Pi：

```text
usage
├── input
├── output
├── cacheRead
├── cacheWrite
├── cacheWrite1h?
├── reasoning?
├── totalTokens
└── cost
```

Anthropic Message Protocol v0.4 final `Usage`：

```text
Usage
├── cache_creation
├── cache_creation_input_tokens
├── cache_read_input_tokens
├── inference_geo
├── input_tokens
├── output_tokens
├── output_tokens_details
├── server_tool_use
└── service_tier
```

The converter must construct one schema-complete target `Usage` object.

---

#### Baseline Usage Construction


Conceptually：

```ts
{
  cache_creation:
    cacheBreakdownOrNull,

  cache_creation_input_tokens:
    pi.cacheWrite,

  cache_read_input_tokens:
    pi.cacheRead,

  inference_geo:
    null,

  input_tokens:
    pi.input,

  output_tokens:
    pi.output,

  output_tokens_details:
    outputDetailsOrNull,

  server_tool_use:
    null,

  service_tier:
    null,
}
```

Each nullable projection requires corresponding certification evidence.

Do not use `null` merely because Pi lacks a field.

---

#### 5.6.1. Exact Core Mappings

##### Core Usage Exact Mappings


```text
Pi input
→ Anthropic input_tokens

Pi output
→ Anthropic output_tokens

Pi cacheRead
→ Anthropic cache_read_input_tokens

Pi cacheWrite
→ Anthropic cache_creation_input_tokens
```

No recomputation from：

```text
totalTokens
cost
```

---

#### 5.6.2. Reasoning Breakdown

##### Reasoning Usage


Pi invariant：

```text
reasoning ⊆ output
```

If a certified target path establishes exact correspondence：

```text
usage.reasoning
→ output_tokens_details.thinking_tokens
```

then:

```ts
output_tokens_details: {
  thinking_tokens: pi.reasoning,
}
```

Otherwise：

```text
output_tokens_details = null
```

Never：

```text
output_tokens
=
output + reasoning
```

---

#### 5.6.3. Cache Creation Breakdown

##### Cache Write Breakdown


Pi invariant：

```text
cacheWrite1h ⊆ cacheWrite
```

If certification establishes exact Anthropic cache breakdown semantics：

```text
ephemeral_1h_input_tokens
=
cacheWrite1h

ephemeral_5m_input_tokens
=
cacheWrite - cacheWrite1h
```

then `cache_creation` may be constructed.

Require：

```text
0 <= cacheWrite1h <= cacheWrite
```

Otherwise：

```text
cache_creation = null
```

Do not guess all cache writes are 5m.

---

#### 5.6.4. Required-Nullable Projections

##### Other Required-Nullable Usage Fields


Current v1 may project：

```text
server_tool_use = null
inference_geo = null
service_tier = null
```

only when the certified accepted surface guarantees the corresponding target-visible semantics cannot occur or are intentionally absent under the current route contract.

If a selected Provider/path can produce a meaningful value that Pi does not preserve：

```text
path is not fully outbound-certified
```

---

#### 5.6.5. Internal Pi Usage Fields

##### Internal Usage Fields


Do not render：

```text
totalTokens
cost
```

as Anthropic Message fields.

They remain Pi/runtime accounting.

---

#### 5.6.6. Usage Validation


Before target construction：

```text
input
output
cacheRead
cacheWrite
reasoning?
cacheWrite1h?
```

must satisfy the target semantic numeric contract.

At minimum：

```text
finite
integer
non-negative
```

Malformed committed usage：

```text
→ Runtime / Outbound Fidelity Failure
```

No clamp or rounding.

---

### 5.7. Termination

#### 5.7.1. Target Termination Structure

##### Target Termination Is Structured State


Target termination is not just one enum.

Conceptually：

```text
Anthropic Termination
├── stop_reason
├── stop_sequence
└── stop_details
```

Every reachable successful target termination state, including any required structured companion fields, must remain reconstructible at the committed Pi boundary.

---

#### 5.7.2. stop / length / toolUse Core Mapping

##### StopReason Core Mapping


Current Core successful Pi terminals：

```text
stop
length
toolUse
```

Candidate ordinary Anthropic mapping：

```text
stop
→ end_turn

length
→ max_tokens

toolUse
→ tool_use
```

This is valid only when the certified execution path proves no distinct reachable Anthropic termination state was collapsed into those Pi values.

---

#### 5.7.3. Reachability Matrix

##### v1 Termination Reachability Matrix


| Anthropic semantic              | Current v1 status                                            |
| ------------------------------- | ------------------------------------------------------------ |
| `end_turn`                      | Supported → Pi `stop`                                        |
| `max_tokens`                    | Supported → Pi `length`                                      |
| `tool_use`                      | Supported → Pi `toolUse`                                     |
| `stop_sequence`                 | Request-side feature unsupported; certification must prove unreachable |
| `pause_turn`                    | Server-tool-oriented path unsupported; certification must prove unreachable |
| `refusal`                       | Reachable; current Pi semantic-loss blocker                  |
| `model_context_window_exceeded` | Potentially reachable; current Pi semantic-loss blocker      |
| future target stop semantic     | Fail certification until classified                          |

---

#### 5.7.4. refusal + stop_details

##### `refusal` Is a Complete Termination-Fidelity Blocker


Current Anthropic refusal is successful target state：

```text
stop_reason = "refusal"
+
stop_details = RefusalStopDetails
```

Current Pi Anthropic adapter can collapse refusal into Pi failure.

Additionally, current generic `AssistantMessage` has no frozen target-equivalent `stop_details` field.

Therefore the current blocker is not merely：

```text
missing refusal enum
```

but：

```text
complete successful refusal termination state
is not reconstructible at committed Pi boundary
```

The renderer MUST NOT infer refusal from：

```text
errorMessage
raw exception text
string matching
```

Fix Pi / preserve required semantics or fail Runtime Certification.

---

#### 5.7.5. model_context_window_exceeded


If this semantic can occur on an otherwise accepted v1 request, it must remain distinguishable at the Pi boundary.

If current Pi does not preserve it：

```text
current Anthropic path
cannot be fully outbound-certified
```

until patched or proven unreachable for the certified model/profile.

---

#### 5.7.6. stop_sequence / pause_turn / Unreachable Semantics

##### Unreachable Semantics Do Not Require New Pi IR


For a target semantic that current accepted v1 request surface cannot produce：

```text
certification may prove unreachable
```

rather than extending generic Pi immediately.

This applies to current examples such as：

```text
stop_sequence
pause_turn
```

when their enabling request features are already unsupported.

---

##### `stop_sequence`


Current v1 request conversion does not accept source stop sequence semantics.

Therefore ordinary successful baseline target：

```text
stop_sequence = null
```

Certification must prove：

```text
non-null stop_sequence
cannot occur on accepted v1 route
```

---

#### 5.7.7. rawStopReason / endTurn / errorMessage / deferred

##### `rawStopReason`


Pi：

```text
rawStopReason?
```

is provider-specific metadata.

It is not generic Anthropic response authority.

Forbidden：

```text
rawStopReason string
→ guess Anthropic stop_reason
```

It may be used in：

```text
provider-specific conformance/certification evidence
```

but not generic response rendering logic.

---

##### `endTurn`, `errorMessage`, `deferred`



##### `endTurn`


Current Anthropic renderer does not directly expose it.

Certification must prove its omission does not hide a reachable client-visible termination distinction.

It is not a second stop-reason input.

##### `errorMessage`


MUST NOT be used to construct successful Anthropic semantics.

##### `deferred`


Current Core v1 ordinary success accepts：

```text
stop
length
toolUse
```

not：

```text
deferred
```

Therefore ordinary committed v1 response requires：

```text
message.deferred absent
```

---

### 5.8. Target Anthropic Message Construction

#### 5.8.1. Schema-Complete Message

##### Target Message Baseline


Anthropic Message Protocol v0.4 defines the current target Message shape：

```text
Anthropic Message
├── id
├── container
├── content[]
├── model
├── role
├── stop_details
├── stop_reason
├── stop_sequence
├── type
└── usage
```

Required-nullable fields must be present.

For the baseline ordinary v1 success path：

```text
container = null
stop_details = null
stop_sequence = null
```

only when corresponding non-null semantics are proven unreachable for that path.

---

##### Schema-Complete Anthropic Message Construction


Conceptually：

```ts
function convertAssistantMessageToAnthropic(
  message: AssistantMessage,
  state: AnthropicRenderState,
): AnthropicResponseMessage {
  assertOutboundResponseFidelity(message);

  return {
    id:
      createAnthropicMessageId(),

    container:
      null,

    content:
      message.content.map(
        convertSupportedAssistantContent,
      ),

    model:
      state.clientModel,

    role:
      "assistant",

    stop_details:
      null,

    stop_reason:
      convertCertifiedStopReason(
        message,
      ),

    stop_sequence:
      null,

    type:
      "message",

    usage:
      convertUsage(
        message.usage,
      ),
  };
}
```

For future supported refusal/container semantics, the corresponding fields must be populated from faithfully preserved state rather than left `null`.

---

#### 5.8.2. Construct Once

##### Target Message Is Constructed Once


After commit：

```text
AssistantMessage
↓
convert once
↓
Anthropic Message M
```

Then the same target object is used for：

```text
JSON serialization
```

or：

```text
Atomic SSE serialization
```

Do not independently reconvert for each wire format.

---

#### 5.8.3. Target Identity Lifetime

##### Message ID Lifetime


```text
COMMIT
↓
generate client-visible message ID
↓
construct target Anthropic Message
↓
JSON/SSE serialization
↓
rendering complete
```

For one target Message：

```text
same ID
```

must be used by JSON and all Atomic SSE frames.

---

##### Do Not Generate Separate IDs Per Renderer


Forbidden：

```text
AssistantMessage
→ JSON conversion
→ id A

AssistantMessage
→ SSE conversion
→ id B
```

Target construction happens once.

Wire serialization does not own Message identity.

---

## 6. Anthropic Response Rendering

### 6.1. Rendering Boundary

#### 6.1.1. Serialization Preconditions

##### SSE Serialization Preconditions


Before any HTTP write：

```text
target Message schema-valid
+
all target content representable
+
all SSE frames schema-valid
+
all SSE frames serializable
```

must already hold.

Current simplest v1 implementation may build：

```text
string[]
```

or one complete response body string.

That state is serialization-only temporary state, not a semantic IR.

---

#### 6.1.2. Content Type Selection

##### Content Types


```text
stream=false
→ application/json
```

```text
stream=true
→ text/event-stream
```

Actual header write belongs to HTTP Boundary.

---

### 6.2. Non-Streaming JSON

#### `stream=false`


```text
committed AssistantMessage
        ↓
Anthropic Message
        ↓
complete JSON serialization
        ↓
HTTP Boundary
        ↓
application/json
```

No partial HTTP write before target serialization succeeds.

---

### 6.3. Atomic SSE

#### `stream=true` Is Atomic SSE


`stream=true` means：

```text
committed AssistantMessage
        ↓
Anthropic Message
        ↓
synthetic legal Anthropic SSE lifecycle
```

not：

```text
live Pi delta forwarding
```

---

#### Atomic SSE Is Target Serialization


Atomic SSE does not attempt to reconstruct：

```text
original provider chunk sizes
original token boundaries
original event timing
```

It only needs to construct：

```text
a legal Anthropic SSE representation
whose accumulated semantic result
equals the target Anthropic Message
```

---

#### 6.3.1. SSE Message Lifecycle

##### Core Atomic SSE Lifecycle


```text
message_start
        ↓
content block 0
        ↓
content block 1
        ↓
...
        ↓
message_delta
        ↓
message_stop
```

No：

```text
[DONE]
```

---

##### 6.3.1.1. message_start


`message_start.message` uses the current `Message` output contract with streaming initial values.

Baseline：

```ts
{
  type: "message_start",

  message: {
    id: target.id,

    container: null,

    content: [],

    model: target.model,

    role: "assistant",

    stop_details: null,
    stop_reason: null,
    stop_sequence: null,

    type: "message",

    usage: initialUsage,
  },
}
```

Required-nullable fields remain present.

`initialUsage` must satisfy the full current `Usage` schema.

---

##### 6.3.1.2. ContentBlock[]

###### 6.3.1.2.1. Text Block Lifecycle

**Text Atomic SSE**


For：

```ts
{
  citations: null,
  text: T,
  type: "text",
}
```

emit：

```text
content_block_start(index)
```

with：

```json
{
  "citations": null,
  "text": "",
  "type": "text"
}
```

then exactly one：

```text
text_delta(T)
```

including when：

```text
T = ""
```

then：

```text
content_block_stop(index)
```

---

**Why Empty Text Emits an Empty Delta**


This gives one uniform lifecycle：

```text
start
→ exactly one atomic delta
→ stop
```

for every supported TextContent.

It avoids relying on ambiguity about zero-delta ordinary content blocks.

It does not change text semantics.

---

###### 6.3.1.2.2. ToolUse Block Lifecycle

**ToolCall Atomic SSE**


Given validated direct ToolCall：

```text
ToolCall
├── id
├── name
└── ToolInput
```

emit：

```text
content_block_start(index)
```

with：

```ts
{
  id,
  caller: {
    type: "direct",
  },
  input: {},
  name,
  type: "tool_use",
}
```

then exactly one：

```text
input_json_delta
{
  partial_json:
    JSON.stringify(finalInput)
}
```

then：

```text
content_block_stop(index)
```

---

**Full JSON Is One Valid Atomic Tool Delta**


Atomic renderer is not reconstructing provider delta granularity.

The single：

```text
partial_json
=
complete JSON serialization
```

is used as one incremental piece whose accumulation yields the exact final `input` object.

Conformance test must validate this against the protocol reference accumulator and supported SDK consumers.

---

###### 6.3.1.2.3. Atomic Thinking Block Lifecycle

For every ordinary target `thinking` block, Atomic SSE emits in order：

```text
content_block_start
  content_block = { type:"thinking", thinking:"", signature:"" }

content_block_delta
  delta = { type:"thinking_delta", thinking:<complete thinking string> }

content_block_delta
  delta = { type:"signature_delta", signature:<complete opaque signature> }

content_block_stop
```

Both deltas are emitted even when their value is empty. Accumulating the lifecycle MUST yield the exact JSON target block. `redacted_thinking` has no certified SSE lifecycle in capability baseline v2.

---

##### 6.3.1.3. message_delta


Anthropic Message Protocol v0.4 requires the delta object to carry the full required-nullable shape：

```text
delta
├── container
├── stop_details
├── stop_reason
└── stop_sequence
```

Baseline ordinary success：

```ts
{
  type: "message_delta",

  delta: {
    container: null,
    stop_details: null,
    stop_reason:
      target.stop_reason,
    stop_sequence:
      target.stop_sequence,
  },

  usage:
    terminalDeltaUsage,
}
```

For a future supported refusal：

```text
stop_details
```

must carry the structured refusal state, not `null`.

---

##### 6.3.1.4. message_stop


Final semantic target frame：

```text
event: message_stop
data: {
  "type": "message_stop"
}
```

No target semantic frames follow.

---

#### 6.3.2. MessageDeltaUsage and Usage Trajectory

##### Atomic SSE Usage Contract


v0.4 does **not** freeze an unverified synthetic algorithm such as：

```text
message_start.output_tokens = 0
```

The normative contract is：

```text
every emitted usage object
→ target-schema-valid

message_delta.usage
→ cumulative

whole synthetic lifecycle
→ accumulates to target final Message usage
```

Exact synthetic initial values require conformance evidence.

---

##### `MessageDeltaUsage`


Current streaming usage shape is distinct from final `Usage`：

```text
MessageDeltaUsage
├── cache_creation_input_tokens
├── cache_read_input_tokens
├── input_tokens
├── output_tokens
├── output_tokens_details
└── server_tool_use
```

All required nullable fields must be present.

`message_delta.usage` is cumulative.

It does not carry final-only fields such as：

```text
inference_geo
service_tier
```

The synthetic usage trajectory must be chosen through conformance so that final accumulated `Usage` equals the target Message usage.

---

#### 6.3.3. SSE Encoding

##### SSE Helper


```ts
function encodeSse(
  event: string,
  data: unknown,
): string {
  return (
    `event: ${event}\n` +
    `data: ${JSON.stringify(data)}\n\n`
  );
}
```

---

#### 6.3.4. Protocol Reference Accumulator


Semantic correctness should be tested against a small protocol-owned reference accumulator derived from Anthropic Message Protocol v0.4：

```text
Atomic SSE
↓
Protocol Reference Accumulator
↓
Reconstructed Message
```

Official Anthropic SDK accumulators are compatibility consumers, not the sole semantic authority.

Therefore testing has two layers：

```text
Protocol reference accumulation
→ semantic correctness

Official Anthropic SDK(s)
→ ecosystem compatibility
```

No manager/framework is required; the reference accumulator can be a test-local pure function.

---

#### 6.3.5. Per-Frame Validity

##### Per-Frame Validity + Final Equality


Atomic SSE conformance requires both：

```text
every emitted event
is individually valid
under target protocol schema
```

and：

```text
final reconstructed Message
==
target Message
```

Testing only the final reconstruction is insufficient if intermediate frames violate required target shape.

---

#### 6.3.6. JSON / SSE Semantic Equality


Both encodings originate from：

```text
the same Anthropic Message object
```

Correct test：

```text
Committed AssistantMessage
        ↓
convert once
        ↓
Anthropic Message M
        │
        ├── JSON(M)
        │
        └── SSE(M)
               ↓
        protocol reference accumulator
               ↓
        Message M'
```

Require：

```text
M'
=
M
```

for all target semantic fields represented by the streaming protocol.

---

### 6.4. HTTP Atomicity and Delivery

#### 6.4.1. No Write Before Complete Serialization

##### HTTP Atomicity


Wrong：

```text
convert block 0
→ write HTTP
→ later block conversion fails
```

Correct：

```text
committed AssistantMessage
↓
outbound fidelity check
↓
complete target Message
↓
complete serialization
↓
HTTP write
```

---

#### 6.4.2. Execution Failure Before Commit

##### `stream=true` Failure Before Commit


Since no SSE response is opened before semantic success：

```text
stream=true
+
execution failure
```

can still use normal Anthropic HTTP error rendering.

No partial successful SSE has been emitted.

---

#### 6.4.3. Rendering Failure After Commit

##### Failure After Commit but Before HTTP Write


Possible state：

```text
model execution = success
target rendering = failure
```

If response still writable：

```text
HTTP/server error response
```

may be produced.

This state should be unreachable under a certified path.

---

#### 6.4.4. Disconnect After Commit

##### Abort After Commit


```text
COMMIT
↓
client disconnect
```

does not retroactively change semantic success.

It becomes：

```text
delivery lifecycle
```

HTTP Boundary owns closed-response behavior.

---

#### 6.4.5. HTTP Boundary Ownership


Client Protocol renderer owns：

```text
target Message
JSON body
SSE body
content-type selection
```

HTTP Boundary owns：

```text
HTTP status
header emission
connection state
final write
closed-response handling
```

---

## 7. Cross-Direction Continuity

### Opaque and Provenance Continuity


Round-trip fidelity must consider more than signatures.

Relevant Pi state includes：

```text
Opaque / Provenance Continuity
├── textSignature
├── thoughtSignature
├── namespace
├── api
├── provider
├── model
├── responseModel
└── responseId
```

Client Anthropic response does not expose generic Pi provenance fields.

That is intentional.

Certification must instead prove omitted state is：

```text
replay-inert
or
deterministically reconstructible
```

for the next supported Anthropic request → Pi history conversion.

If not：

```text
route is not round-trip certified
```

Do not leak Provider metadata into Anthropic response as a workaround.

---

### 7.1. Round-Trip Lifecycle

#### Round-Trip Fidelity


A proxy response frequently becomes future request history.

Therefore supported path must consider：

```text
Pi AssistantMessage
↓
Anthropic Response
↓
client stores history
↓
next Anthropic Request
↓
Pi history
```

Required continuation semantics must survive.

---

### 7.2. Current v2 Round-Trip Surface

#### Current Round-Trip Supported Content


Current capability baseline v2：

```text
TextContent
ThinkingContent (ordinary, non-redacted)
ToolCall
```

subject to opaque/provenance-state certification.

Current v2 excludes：

```text
redacted ThinkingContent
```

Ordinary thinking is certified only as one complete chain：

```text
Pi ThinkingContent
→ Anthropic JSON / Atomic SSE thinking
→ next Anthropic request history
→ Pi ThinkingContent
```

The Client Protocol and Provider adapters meet only through Pi; the round trip does not authorize either side to consume the other side's wire types.

---

## 8. Runtime Certification and Serving Constraints

### 8.1. One Runtime Certification System

#### Certification Composition


Certification identity includes：

```text
Specification Version
Anthropic Protocol Spec Revision
Pi Revision
Provider Construction
API Implementation
Relevant Model Configuration
Anthropic Model-Validity Policy Revision
Supported Anthropic Source Profile
Auth / Endpoint Policy
Tool-ID Adaptation Policy
transformHeaders Policy
fetch Policy
onPayload Policy
Auxiliary Option Policy
Ambient Semantic Configuration Policy
Conformance Revision
```

`Anthropic Protocol Spec Revision` means an immutable synchronized protocol dependency identity, preferably：

```text
Protocol version
+
repository blob/commit SHA
```

The Method's Pi contract evidence basis is：

```text
Pi AI IR Protocol:
v0.9.2

Reference Commit:
eb3c46d6ce28cb87147bb0d05645ebae28524713

Reference Package:
@earendil-works/pi-ai 0.84.1

Protocol Blob SHA:
a3dc09b846f2e49f73480d5e33c63aa009ff9a51
```

This evidence basis is specification provenance and is **not** a substitute for the concrete certification field：

```text
Pi Revision:
<immutable runtime revision>
```

A certification using a different Pi runtime revision MUST either prove the relevant Pi contracts/behavior remain equivalent or repeat the affected source/conformance review before that runtime can be `CERTIFIED`.

A Protocol revision known to omit v1-required request source-validity facts inherited from the v0.4.9 request contract MUST NOT be used for `CERTIFIED` status.

The converter's semantic-header support policy is frozen by the Specification Version + synchronized Protocol dependency + Client Protocol contract; it is not a second independent runtime-certification authority.


LuckyToken 只维护一个：

```text
Certified Execution Composition
```

它同时证明：

```text
Certified Execution Composition
│
├── Inbound Request Fidelity
├── Pi Execution Fidelity
└── Outbound Response Fidelity
    ├── Terminal Fidelity
    ├── Content Fidelity
    ├── Usage Fidelity
    ├── Client Identity Fidelity
    ├── Atomic SSE Conformance
    └── Round-Trip Fidelity
```

禁止引入：

```text
RequestCertification
ResponseCertification
CertificationManager
```

等第二套 runtime concept。

---

#### Generic v1 Auth-Path Semantic Integrity

For the generic Anthropic Client Protocol v1 capability baseline, authentication / endpoint selection is infrastructure and MUST NOT change model-visible request semantics.

Therefore a runtime path is **not certifiable for the generic v1 route** when auth selection causes provider adaptation to inject or rewrite semantic content, including：

```text
auth-dependent system instruction injection
auth-dependent tool-name rewriting
auth-dependent conversation-content rewriting
```

Current Claude-Code/OAuth-specific Anthropic behavior, where selected by the runtime composition, is subject to this rule.

Certification rule：

```text
auth path leaves accepted Context/tools semantics unchanged
→ may proceed to the remaining fidelity checks

auth path injects or rewrites model-visible semantics
→ generic Anthropic v1 route MUST NOT be CERTIFIED
```

This does not require LuckyToken to modify Pi or to create an auth-aware semantic IR.

A future dedicated Client Protocol/profile that intentionally models Claude-Code-specific semantics would require its own explicit protocol/conversion contract and is outside this generic v1 baseline.

---

### 8.2. Runtime Readiness


Checks actual：

```text
Pi revision
Provider/API composition
Model configuration
source-profile compatibility
model-validity policy revision
synchronized Protocol Spec revision
semantic hooks
transport policy
ambient semantic configuration
reserved synthetic-history identity disjointness
```

In particular：

```text
certified target (provider, api, model)
!=
reserved synthetic historical identity
```

Mismatch：

```text
Runtime / Server Failure
```

### 8.3. Invocation Integrity


Verifies LuckyToken correctly assembled the Models-facing invocation：

```text
explicit values preserved
omissions preserved
closed-world obeyed
must-absent fields absent
auth auxiliary policy obeyed
transport hook policy obeyed
```

Failure：

```text
Runtime / Server Failure
```

---

### 8.4. Request-Specific Execution Fidelity

#### ToolResult Runtime Fidelity


Preserve：

```text
semantic text content
block ordering
block multiplicity where source-significant
image MIME/payload
empty textual value
whitespace textual value
```

No：

```text
multi-block join("\n")
image placeholder injection
whitespace dropping
```

---

#### Request-Specific Fidelity


Only after runtime readiness + invocation integrity.

Failure means：

```text
valid request exceeds certified capability
```

→

```text
UnsupportedFeature
```

---

### 8.5. Outbound Response Fidelity


在 target conversion 前检查：

```text
committed AssistantMessage
→ representable under
the frozen Anthropic v1 response contract
```

这是 request-local structural/semantic assertion。

它不是新的 runtime certification system。

Serving/runtime qualification仍属于现有：

```text
Certified Execution Composition
```

Client Protocol renderer不需要接收 Provider/certification object才能转换 response。

---

#### Runtime Certification — Outbound Dimension


Existing Runtime Certification must bind a concrete path that preserves：

```text
upstream
↓
Provider
↓
Pi AssistantMessage
↓
Anthropic target response
```

for all accepted v1 semantics.

No separate response certification object exists.

---

#### Outbound Fidelity Dimensions


```text
Runtime Certification
└── Outbound Response Fidelity
    ├── AssistantMessage shape fidelity
    ├── content fidelity
    ├── termination fidelity
    ├── usage fidelity
    ├── identity isolation
    ├── Atomic SSE conformance
    └── round-trip fidelity
```

---

#### 8.5.1. Content Fidelity


Certification establishes：

```text
TextContent
→ exact text

ToolCall
→ exact client-visible tool_use semantics

ThinkingContent
→ exact ordinary thinking and opaque-signature semantics
```

It must additionally establish：

```text
citation-bearing output
→ unreachable

server-tool caller output
→ unreachable
```

for baseline required-shape projections：

```text
citations:null
caller:{type:"direct"}
```

to remain truthful.

---

#### 8.5.2. Usage Fidelity


Certification must establish trustworthy meaning of：

```text
input
output
cacheRead
cacheWrite
reasoning?
cacheWrite1h?
```

and exact target projection.

It must also prove that current required-nullable projections：

```text
server_tool_use:null
inference_geo:null
service_tier:null
```

do not hide reachable semantics.

No guessed accounting.

---

#### 8.5.3. Termination Fidelity


For every target-visible termination semantic reachable under accepted v1：

```text
complete target termination state
must remain reconstructible
at committed Pi boundary
```

This includes companion fields such as：

```text
stop_details
```

when the target protocol requires them.

If not：

```text
path cannot be Runtime CERTIFIED
```

---

##### Reachability Is Part of Certification


A target semantic does not require Pi support merely because the Anthropic protocol defines it.

Certification may prove：

```text
semantic cannot occur
under this accepted request/profile/model path
```

This keeps runtime patches minimal.

---

#### 8.5.4. Atomic SSE Conformance

##### Atomic SSE Conformance Fidelity


Certification/conformance must prove：

```text
schema-complete target Message
→ Atomic SSE
→ protocol reference accumulator
→ same semantic Message
```

and separately verify supported official Anthropic SDK clients can consume the emitted stream.

---

### 8.6. Provider Tool-ID Adaptation


Client mapping preserves source IDs exactly.

Provider-side adaptation MUST：

```text
preserve call/result correlation
preserve distinct relevant identities
be injective OR collision-detecting
preserve order
never guess correlation
```

Violation is runtime certification failure.

---

### 8.7. Ambient Semantic Configuration


Any non-request-local runtime state capable of changing upstream/model-visible semantics is certification-owned.

Examples：

```text
process.env
/proc environment fallback
Provider-global config
compat switches
global endpoint policy
global transport policy
```

Such state must be：

```text
inert
OR prohibited
OR fixed and immutable
OR certification-bound
```

---

### 8.8. Serving-Time Models / Provider Composition

#### Provider Composition Ownership


Startup/composition code may own：

```text
MutableModels
```

Serving runtime receives：

```text
Models
```

The intended restriction is specifically：

```text
serving runtime has no Provider-registration mutation authority
```

through：

```text
setProvider
deleteProvider
clearProviders
```

---

#### 8.8.1. MutableModels vs Models Ownership

##### `Models` Is Not a Purely Immutable API


The specification MUST NOT claim：

```text
Models has no mutation authority
```

as a general Pi fact.

`Models` may expose operations such as：

```text
refresh
login
logout
```

under Pi's public contract.

The architecture restriction concerns certified Provider registration/composition.

---

#### 8.8.2. Serving-Time Models Operations

##### Serving-Time `Models` Operations and Certification-Bound Facts


Pi `Models` may legitimately expose serving-time operations such as：

```text
refresh
login
logout
```

and future runtime/auth/catalog operations.

The general rule is not operation-name-specific：

> **Any serving-time `Models` operation that can change a certification-bound runtime fact MUST either preserve the active certification contract or invalidate serving readiness before an affected future request executes.**

Examples：

```text
refresh
→ model catalog / Model configuration may change

login / logout / auth refresh
→ credential/auth/endpoint facts may change
```

If the changed fact no longer matches the certified execution composition：

```text
future affected request
→ Runtime / Serving Failure
  until readiness is re-established
```

No operation may silently continue under a stale certification identity.

#### 8.8.3. In-Flight Request Isolation

##### In-Flight Request Isolation From Serving-Time Mutations


A serving-time `Models` operation MUST NOT silently alter the certification-bound semantics of an already accepted in-flight request after Gate C.

For the current request：

```text
resolved Model reference/config
Context
Models-facing option structure/values
certified execution assumptions
```

remain protected by the post-Gate invocation/certification contract.

If a serving-time operation can affect a certification-bound fact that the in-flight lazy dispatch may still read, the implementation MUST provide one of：

```text
semantic invariance under the certified policy
OR
request isolation / serialization sufficient
for the in-flight request to keep its certified facts
OR
failure before dispatch rather than semantic drift
```

A future request may observe updated catalog/auth/runtime state only after runtime readiness is evaluated again.

This rule does not require a new manager or snapshot type.

## 9. Failure Model

### 9.1. Outbound Response Fidelity / Rendering Failure

#### Outbound Fidelity Failure Authority


如果：

```text
request accepted
execution succeeded
AssistantMessage committed
```

但 committed result 违反当前 frozen outbound contract：

```text
→ Runtime / Response Rendering Failure
```

不是：

```text
UnsupportedFeature
```

因为 request execution 已经发生。

在 certified serving composition 中，此状态应被 conformance证明不可达。

---

### 9.2. End-to-End Failure Tree

#### Final Failure Tree


```text
HTTP Request
   │
   ├── Client authorized?
   │      no
   │      └──► Client Authorization Failure
   │
   ▼
Source profile envelope / known profile token valid?
   │
  no
   └──► InvalidRequest / Protocol Failure
   │
  yes
   ▼
Profile-independent JSON syntax valid?
   │
  no
   └──► InvalidRequest / Protocol Failure
   │
  yes
   ▼
Source profile / grammar implemented enough to validate?
   │
  no
   └──► UnsupportedFeature
   │
  yes
   ▼
Model-independent source semantics valid?
   │
  no
   └──► InvalidRequest / Protocol Failure
   │
  yes
   ▼
Model Resolution succeeds?
   │
  no
   └──► Router / Model Resolution Failure
   │
  yes
   ▼
Model-dependent source semantics valid?
   │
  no
   └──► InvalidRequest / Protocol Failure
   │
  yes
   ▼
Any source-valid but unsupported v1 semantic?
(including source-valid prefill on a model that permits it)
   │
  yes
   └──► UnsupportedFeature
   │
  no
   ▼
Static Pi representable?
   │
  no
   └──► UnsupportedFeature
   │
  yes
   ▼
Deterministic Conversion
   │
   ├── impossible prevalidated state observed?
   │      yes
   │      └──► Runtime / Invocation Integrity Failure
   │
   ▼
Runtime composition + synchronized Protocol revision certified?
   │
  no
   └──► Runtime / Server Failure
   │
  yes
   ▼
Models-facing invocation intact?
   │
  no
   └──► Runtime / Server Failure
   │
  yes
   ▼
Request inside certified capability?
   │
  no
   └──► UnsupportedFeature
   │
  yes
   ▼
Gate C PASS
   │
   ▼
Immutable invocation structure
+
live AbortSignal lifecycle
   │
   ▼
Execution
```

Critical scope rules：

```text
malformed JSON
→ InvalidRequest before profile-support rejection
```

```text
implemented profile grammar
→ Source Validity before feature-level UnsupportedFeature
```

```text
unimplemented profile/grammar
→ UnsupportedFeature before claiming full Source Validity
```

```text
model resolution failure
→ Router / Model Resolution contract
→ not conversion-layer reclassification
```

## 10. Implementation Structure

### 10.1. Request-Side Anthropic Modules

#### Recommended Module Structure


```text
anthropic/
├── profile.ts
├── parse.ts
├── conversation.ts
├── validate.ts
├── representability.ts
├── request.ts
├── messages.ts
├── tools.ts
├── schema.ts
├── fidelity.ts
└── types.ts
```

No new header manager is required.

---

#### `profile.ts`


Owns：

```text
anthropic-version
anthropic-beta
source-profile envelope resolution
exact v1 profile-support / grammar-coverage policy
protocol semantic-header classification rules
```

Frozen v1 support：

```text
2023-06-01 + no beta
→ implemented source grammar

known source-invalid version/beta
→ InvalidRequest

known-valid beta-activated profile
→ UnsupportedFeature

plausible but unclassified profile extension
→ conservative UnsupportedFeature
```

No runtime beta registry is required.

It does not own Client authorization.

#### `parse.ts`


Owns：

```text
body parsing
unknown body semantic detection
```

Header semantics remain visible through the Client Protocol source processing path rather than being hidden inside body parsing.

---

#### `messages.ts`


Owns only already-accepted canonical-message conversion：

```text
Canonical messages
→ Pi Message[]
```

including：

```text
turn-scoped pending tool state used to recover toolName
UserMessage timestamp = receivedAt
ToolResultMessage complete mapping
historical AssistantMessage synthetic provenance
zero Usage / structural stopReason / receivedAt
```

It does **not** own normative client rejection for：

```text
final assistant prefill
invalid tool lifecycle
mid-conversation system semantics
unsupported content grammar
```

Those failures belong to Source Validation / Static v1 Semantic Support before deterministic conversion. `messages.ts` may keep defensive internal invariant assertions only.

`tool_result` string shorthand converts to `TextContent` only after source-profile shorthand authorization.

`sourceProfile` arrives through the explicit conversion call chain; no ambient current-profile lookup is permitted.

#### `fidelity.ts`


Owns：

```text
Invocation Integrity
Request-Specific Fidelity
```

It does not own：

```text
Client authorization
AbortSignal lifecycle
ambient env resolution
Provider payload simulation
```

---

### 10.2. Response-Side Anthropic Modules

#### Minimal Module Structure


Start：

```text
anthropic/
└── response.ts
```

Functions：

```ts
assertOutboundResponseFidelity()

convertAssistantMessageToAnthropic()

serializeAnthropicJson()

serializeAnthropicAtomicSse()
```

Only split：

```text
response.ts
sse.ts
```

if SSE code becomes independently complex.

---

### 10.3. Recommended APIs


```ts
function assertOutboundResponseFidelity(
  message: AssistantMessage,
): void;
```

```ts
function convertAssistantMessageToAnthropic(
  message: AssistantMessage,
  state: AnthropicRenderState,
): AnthropicResponseMessage;
```

```ts
function serializeAnthropicJson(
  message: AnthropicResponseMessage,
): string;
```

```ts
function serializeAnthropicAtomicSse(
  message: AnthropicResponseMessage,
): string;
```

Runtime certification remains serving/readiness infrastructure and does not become an argument to the Client Protocol converter.

---

### 10.4. End-to-End Orchestration

#### Final Execution Pseudocode


```ts
const {
  body,
  headers,
  signal,
} = httpRequest;

// Independent authority.
const auth = authorizeClientRequest(httpRequest);

if (!auth.authorized) {
  throwClientAuthorizationFailure();
}

// Known profile-envelope grammar only.
const sourceProfile = resolveAnthropicSourceProfile({
  anthropicVersion: headers["anthropic-version"],
  anthropicBeta: headers["anthropic-beta"],
});
// known malformed/source-invalid envelope → InvalidRequest

// Inspection/classification only.
const sourceSemanticHeaders = classifyAnthropicSemanticHeaders({
  headers,
  sourceProfile,
});

// Profile-independent syntax has independent failure authority.
const jsonBody = parseJsonRequestBody(body);
// malformed JSON → InvalidRequest

// Exact v1 implemented profile:
// version=2023-06-01, no beta.
requireSupportedAnthropicSourceProfile({
  sourceProfile,
  sourceSemanticHeaders,
});
// known-valid beta/unimplemented profile or unclassified grammar
// → UnsupportedFeature

const parsed = parseAnthropicMessageRequestValue(
  jsonBody,
  sourceProfile,
);

// Detect recognized wire forms for which current source authority
// does not establish enough validity/equivalence semantics.
assertSupportedSourceGrammarCoverage({
  parsed,
  sourceProfile,
});
// ordinary message.content: [] → UnsupportedFeature
// tool_result.content: []      → UnsupportedFeature

const canonical = canonicalizeAnthropicRequest(parsed);

assertModelIndependentSourceValidity({
  canonical,
  sourceProfile,
  sourceSemanticHeaders,
});
// includes tool lifecycle/schema validity and documented strict limits
// fail → InvalidRequest / Protocol Failure

const modelResolution = resolveModel(
  models,
  canonical.model,
);

if (!modelResolution.ok) {
  throwModelResolutionFailure(
    modelResolution.error,
  );
  // Router / Model Resolution contract owns client rendering/classification.
}

const model = modelResolution.model;

assertModelDependentSourceValidity(
  canonical,
  sourceProfile,
  model,
);
// includes model-dependent final-assistant prefill validity
// fail → InvalidRequest / Protocol Failure

const request = asValidatedAnthropicRequest(
  canonical,
);

assertStaticV1SemanticSupport({
  request,
  sourceProfile,
  sourceSemanticHeaders,
  model,
});
// source-valid final prefill on a model/profile that permits it
// → UnsupportedFeature
// other source-valid unsupported v1 semantic → UnsupportedFeature

assertStaticPiRepresentability({
  request,
  sourceProfile,
  model,
});
// source-valid semantic not truthfully expressible in Pi → UnsupportedFeature

const conversion = convertAnthropicRequestToPi(
  request,
  sourceProfile,
  receivedAt,
);

const effectiveOptions = composeOptions(
  conversion.options,
  {
    signal,
    sessionId: auth.sessionId,
    projectDir: auth.projectDir,
  },
  routerDefaults,
);

const certifiedPath = requireCertifiedExecutionPath({
  model,
  sourceProfile,
  protocolSpecRevision,
  runtimeComposition,
  ambientSemanticConfiguration,
});
// fail → Runtime / Serving Failure

assertModelsFacingInvocationIntegrity({
  source: request,
  model,
  context: conversion.context,
  protocolOptions: conversion.options,
  effectiveOptions,
  certifiedPath,
});
// fail → Runtime / Server Failure

assertSelectedExecutionPathFidelity({
  source: request,
  model,
  context: conversion.context,
  effectiveOptions,
  certifiedPath,
});
// fail → UnsupportedFeature

// Ownership transfer:
// Model/Context/effectiveOptions structure is immutable.
// effectiveOptions.signal identity is immutable,
// while its HTTP-owned abort lifecycle remains live.

const stream = models.streamSimple(
  model,
  conversion.context,
  effectiveOptions,
);
```

Frozen failure-order rules：

> **Profile-independent malformed JSON is `InvalidRequest` before profile-support capability rejection.**

> **Within an implemented source profile/grammar, full Source Validity precedes feature-level v1 `UnsupportedFeature` rejection. Profile/grammar support itself is checked earlier because LuckyToken cannot truthfully validate grammar it does not implement.**

> **Model Resolution failure belongs to the Router / Model Resolution contract and is not reclassified by the conversion layer.**

`sourceProfile` remains an explicit input through static support/representability and deterministic conversion; it is never recovered from ambient state.

#### Final Orchestration


Conceptually：

```ts
const piStream =
  models.streamSimple(
    model,
    context,
    effectiveOptions,
  );

// Core Execution owns this operation.
const committed =
  await execution.consumeForAtomicCommit(
    piStream,
    effectiveOptions.signal,
  );

// From here:
// - Pi execution semantically succeeded.
// - Anthropic renderer receives only committed state.

assertOutboundResponseFidelity(
  committed,
);

const target =
  convertAssistantMessageToAnthropic(
    committed,
    renderState,
  );

// Target identity is created once.

const body =
  renderState.stream
    ? serializeAnthropicAtomicSse(
        target,
      )
    : serializeAnthropicJson(
        target,
      );

// No response bytes were written before this point.

writeFinalHttpResponse({
  contentType:
    renderState.stream
      ? "text/event-stream"
      : "application/json",

  body,
});
```

`execution.consumeForAtomicCommit` is conceptual Core Execution behavior, not an Anthropic module function.

---

### 10.5. No New Managers / Wrappers / Generic IR

#### No Models Wrapper Required


v0.4.9 does not require a wrapper that hides：

```text
refresh
login
logout
```

The natural type boundary remains useful：

```text
composition
→ MutableModels

serving
→ Models
```

because it removes Provider-registration mutation methods from normal serving ownership.

The remaining `Models` operations are governed by `Serving-Time Models Operations and Certification-Bound Facts` and `In-Flight Request Isolation From Serving-Time Mutations` only when they can change certification-bound facts.

#### No New Managers


Do not add：

```text
ResponseManager
StreamManager
OutputManager
ResponseRegistry
CertificationManager
RoundTripManager
```

Ordinary request-local control flow is sufficient.

---

### 10.6. Implementation Sequence

#### Implementation Sequence and Response-Side Readiness


Recommended order：

```text
1.
Implement/verify Core terminal consistency
and abort-aware consumption

2.
Freeze schema-complete AssistantMessage
→ Anthropic Message mapping

3.
Implement ToolInput JSON-tree validation

4.
Implement pure Anthropic Message conversion

5.
Implement JSON serializer

6.
Implement Atomic SSE serializer
with complete v0.4 frame shapes

7.
Implement protocol reference accumulator

8.
Establish SSE usage trajectory
through conformance

9.
Implement JSON ↔ SSE semantic equality tests

10.
Implement stop-reason reachability tests

11.
Patch reachable Pi termination semantic loss

12.
Run full Runtime Certification
including Outbound Response Fidelity
```

Known current Pi request-path fidelity work：

```text
Simple option processing
└── maxTokens context-window clamping
    └── MUST be identity for every accepted request
        or certification fails
```

```text
Shared historical replay normalization
└── transformMessages(...) may perform
    ├── unsupported-image downgrade
    ├── cross-model thinking transformation
    ├── tool-call ID normalization
    └── synthetic orphan ToolResult insertion

For an accepted generic-v1 request,
the selected path MUST prove these transformations
do not change the frozen Anthropic semantics.
```

```text
Anthropic message serialization
└── empty / whitespace text filtering

Accepted text/content semantics
MUST survive without trimming, dropping,
joining, placeholder injection,
or other unclassified rewriting.
```

```text
Anthropic tool serialization
└── non-strict legacy input_schema projection

Every schema keyword accepted by v1
MUST survive to the actual upstream/model-visible tool schema.
A path that keeps only
type / properties / required
while dropping accepted semantic keywords
cannot be certified for those requests.
```

```text
Auth / endpoint adaptation
└── generic-v1 route MUST exclude
    auth paths that inject/rewrite
    model-visible system/tool/conversation semantics
```

Known current Pi response-path fidelity work：

```text
Termination
├── refusal
│   ├── successful classification
│   └── stop_details preservation
└── model_context_window_exceeded
    └── distinguishable successful termination
```

Reachability proof：

```text
stop_sequence
pause_turn
```

ToolCall：

```text
final runtime JSON-object-tree validity
```

Opaque/provenance state：

```text
textSignature
thoughtSignature
namespace
api
provider
model
responseModel
responseId
→ replay relevance / reconstructibility
```

Thinking：

```text
must remain unreachable
for the current v1 certification-candidate route
```

Extended output semantics：

```text
citations
server tools
container semantics
non-null service/inference metadata
other future blocks
```

remain outside current baseline unless explicitly supported and certified.

These are **known current source-observed obligations**, not a closed list of all possible future certification failures. Runtime Certification remains authoritative and MUST reject any additional semantic divergence discovered by conformance.

Response-side readiness：

```text
Atomic Response Architecture:
FROZEN

Execution Ownership:
FROZEN

Success Commit Boundary:
FROZEN

Target Protocol:
Anthropic Messages API Protocol Specification v0.4

AssistantMessage
→ Anthropic Message:
TARGET CONTRACT CLOSED

Anthropic JSON Rendering:
STRUCTURALLY CLOSED

Atomic SSE Structural Rendering:
STRUCTURALLY CLOSED

Atomic SSE Usage Trajectory:
PENDING CONFORMANCE

Reachable Pi Semantic-Loss Patches:
PENDING

Runtime Certification:
PENDING
```

Final mental model：

```text
Pi stream
=
Core Execution lifecycle
```

```text
supported consistent done.message
+
AbortSignal live
=
COMMIT
```

```text
committed AssistantMessage
=
Anthropic response conversion input
```

```text
Anthropic Message
=
single schema-complete target semantic representation
```

```text
stream=false
=
JSON serialization
```

```text
stream=true
=
Atomic SSE serialization
```

The key rule remains：

> **Never translate unfinished execution state into client-visible semantic state, and never satisfy a target-required field by inventing a semantic fact that the certified path cannot justify.**

## 11. Conformance Tests

### Explicit Empty Array, Strict Tool, Tool, and Schema Tests


Current ordinary message policy：

```text
user.content: []
assistant.content: []
→ UnsupportedFeature at Source Grammar Coverage
```

Current ToolResult policy：

```text
tool_result.content: []
→ UnsupportedFeature at Source Grammar Coverage
```

Never current-v1：

```text
[] → silently drop turn
[] → guessed InvalidRequest
[] → guessed Pi []
```

Strict request-wide source limits：

```text
21 strict:true tools
→ InvalidRequest

25 optional parameters across strict schemas
→ InvalidRequest

17 union-type parameters across strict schemas
→ InvalidRequest
```

Tool mapping：

```text
name exact
description exact / omitted→""
input_schema→parameters
strict=true→json_schema/require
strict=false/omitted→constrainedSampling absent
unsupported tool controls→UnsupportedFeature
```

Schema subset：

```text
every allowed keyword at root
→ accepted if source-valid

every allowed keyword in nested properties/items/additionalProperties schema
→ accepted if source-valid

nested anyOf/$ref/format/type-array/etc.
→ UnsupportedFeature if source-valid

enum/const/default/examples object values
→ treated as values, not recursive schema nodes

structurally source-invalid schema
→ InvalidRequest
```

Tool-description projection：

```text
description omitted
→ Pi description=""
→ runtime certification must prove upstream/model-visible equivalence
```

### Deterministic Conversion, Model Resolution, and Serving-Time Certification Tests


Deterministic request mapping：

```text
max_tokens > 0
→ options.maxTokens exact

temperature omitted
→ options.temperature absent

temperature present
→ exact value

metadata.user_id omitted
→ protocolOptions.metadata absent

metadata.user_id present
→ protocolOptions.metadata = { user_id: exact }

composeOptions:
user_id absent + projectDir absent
→ effectiveOptions.metadata absent

user_id = U + projectDir absent
→ effectiveOptions.metadata = { user_id: U }

user_id absent + projectDir = P
→ effectiveOptions.metadata = { projectDir: P }

user_id = U + projectDir = P
→ effectiveOptions.metadata = { user_id: U, projectDir: P }

non-owner/default attempts to overwrite user_id/projectDir
→ Runtime / Serving Failure before Models.streamSimple

extra source metadata
→ never copied through generic cast/spread

stream
→ renderState only
```

Model resolution：

```text
unknown/unresolvable external model selector
→ Model Resolution failure
→ Router/API contract renders it
→ conversion layer does not relabel it InvalidRequest/UnsupportedFeature
```

Model-dependent prefill authority：

```text
classifier = forbidden
→ InvalidRequest

classifier = allowed
→ source-validity succeeds
→ current v1 support rejection = UnsupportedFeature

classifier = unknown
→ UnsupportedFeature
→ never guessed InvalidRequest
→ never guessed allowed

unknown/custom model with no bound evidence
→ classifier = unknown
```

Synthetic namespace readiness：

```text
certified target identity collides with reserved synthetic history identity
→ Runtime / Serving Readiness Failure
```

Catalog change：

```text
runtime refreshes model catalog
↓
future request resolves changed model config
↓
certification mismatch
→ Runtime / Serving Failure
```

Auth/runtime fact change：

```text
login / logout / other Models operation
↓
changes a certification-bound auth/endpoint/runtime fact
↓
readiness invalidated
↓
affected future request cannot execute
until certification/readiness matches again
```

Generic-v1 auth semantic integrity：

```text
auth path preserves Context.systemPrompt, message content, and tool identities
→ eligible for remaining certification checks

auth path injects or rewrites model-visible system/tool/conversation semantics
→ generic Anthropic v1 certification fails
```

In-flight isolation：

```text
request passes Gate C
↓
serving-time Models operation changes a relevant global/runtime fact
↓
in-flight request either remains semantically within
its certified contract or fails before dispatch
```

Never：

```text
in-flight request silently executes
under different certification-bound semantics
```

### 11.1. Profile / Header / JSON Syntax Tests

#### Profile, JSON-Ordering, and Semantic Header Tests


Exact v1 baseline：

```text
anthropic-version: 2023-06-01
anthropic-beta: absent
→ implemented profile grammar
```

Profile envelope：

```text
malformed known anthropic-version / beta grammar
→ InvalidRequest
```

```text
known source-valid beta-activated profile
→ UnsupportedFeature
```

```text
syntactically plausible unclassified beta/profile extension
whose validity is not established locally
→ conservative UnsupportedFeature
→ never guessed InvalidRequest
```

Raw syntax ordering：

```text
malformed JSON
+
unsupported/unknown profile grammar
→ InvalidRequest
```

because profile-independent JSON syntax is checked before profile grammar coverage.

Known headers：

```text
anthropic-version
→ profile resolution

anthropic-beta
→ profile resolution
```

```text
anthropic-user-profile-id
without required beta
under implemented baseline profile
→ InvalidRequest
```

```text
user-profiles beta active
→ beta-activated profile not implemented in v1
→ UnsupportedFeature at profile coverage
```

Ingress guard：

```text
X-AnThRoPiC-Future-Control
→ normalized name anthropic-future-control
→ retained unclassified Anthropic-owned marker
→ UnsupportedFeature after known source validity where applicable
```

Unrelated header：

```text
x-request-id / traceparent / ordinary proxy header
→ not automatically Anthropic semantic input
→ no failure merely because unknown
```

### 11.2. Source Grammar / Validation / Model Resolution Tests

#### Protocol Drift and Source-Grammar Coverage Tests


Protocol drift：

```text
authoritative Protocol Spec adds/changes semantic grammar
but implementation classifier/validator lacks it
→ conformance fails
→ implementation must not silently accept/drop it
```

Current unresolved ordinary-message boundary：

```text
user.content: []
assistant.content: []
→ current source authority does not establish exact validity/semantics
→ UnsupportedFeature at Source Grammar Coverage
→ source turn is never silently removed
```

Current ToolResult boundary：

```text
tool_result.content: []
→ local Protocol authority does not establish validity/equivalence
→ UnsupportedFeature at Source Grammar Coverage
```

Protocol dependency synchronization：

```text
current synchronized local Protocol v0.4
SHA-256 `efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918`
includes model-dependent prefill source validity
and documented strict hard limits
→ eligible for binding to the certification manifest

previous Protocol v0.3
SHA-256 `0179347575d9be388d5ca2258f447a2351990c554c67d172e078ab8cd017a992`
→ not eligible for CERTIFIED status
```

A future Protocol revision that changes these boundaries must update conversion conformance before behavior changes.

### 11.3. Message Conversion Tests

#### 11.3.1. ToolResult and Tool Lifecycle

##### ToolResult String Equivalence Tests


For a profile that explicitly authorizes textual shorthand：

```text
content: "A"
```

and：

```text
content: [
  { type:"text", text:"A" }
]
```

must canonicalize to equivalent Pi：

```text
[Text("A")]
```

---

##### ToolResult String and Model-Dependent Final-Prefill Tests


Current Protocol-Spec profile, and any profile where string syntax exists but string→single-text-block semantic equivalence is not established：

```text
tool_result.content: "A"
→ UnsupportedFeature
```

No guessing.

Final assistant prefill：

```text
messages ends with user
→ ordinary conversion path
```

```text
historical assistant followed by user
→ portable historical assistant path
```

```text
final assistant
+
selected source model forbids prefill
(e.g. current Claude 4.6+ / Mythos Preview rule)
→ InvalidRequest
```

```text
final assistant
+
source model/profile permits prefill
→ Source Valid
→ UnsupportedFeature v1
```

```text
final assistant
+
source validity classifier returns unknown
→ UnsupportedFeature at model-dependent source validation
→ never guessed InvalidRequest or allowed
```

Deterministic converter test：

```text
any final assistant reaches convertMessages()
→ internal conversion invariant failure
→ never a new client UnsupportedFeature decision inside converter
```

##### ToolResult Omission and Complete Pi Message Shape Tests


ToolResult omission：

```text
content omitted
→ Pi []
```

```text
content: ""
→ current v1 UnsupportedFeature unless string shorthand authority exists
```

```text
content: " "
→ current v1 UnsupportedFeature unless string shorthand authority exists
```

For a future profile that explicitly authorizes string shorthand：

```text
""  → [Text("")]
" " → [Text(" ")]
```

Omission remains distinguishable from explicit textual values.

`is_error` projection：

```text
omitted → false
false   → false
true    → true
```

Complete message shape：

```text
ordinary UserMessage
→ timestamp = receivedAt
```

```text
ToolResultMessage
→ toolCallId exact
→ toolName from pending call
→ isError exact/required-shape projection
→ timestamp = receivedAt
```

Historical AssistantMessage：

```text
api/provider = frozen synthetic constants
model = clientModel
usage = exact zero Usage
stopReason = toolUse iff any ToolCall else stop
timestamp = receivedAt
```

Readiness separately guarantees synthetic identity disjointness from certified target identities.

Forbidden：

```text
receivedAt - N fabricated history timestamps
resolved-target provenance fabrication
non-zero fabricated usage
```

### 11.4. Execution / Terminal / Abort Tests

#### AbortSignal Live Lifecycle Tests


Case：

```text
Gate C PASS
signal.aborted = false

↓ later

client disconnects
signal.aborted = true
```

Expected：

```text
outcome = Aborted
```

provided cancellation becomes authoritative before success commit.

---

#### AbortSignal Reference Immutability Test


After Gate C：

```text
effectiveOptions.signal = differentSignal
```

→ forbidden invocation mutation.

But：

```text
existingSignal.aborted changes
```

→ valid owner-defined lifecycle.

---

#### No Abort Snapshot Test


Forbidden implementation：

```ts
const wasAbortedAtGateC =
  signal.aborted;

// later execution relies only on wasAbortedAtGateC
```

if that causes post-Gate cancellation to be ignored.

Execution must continue observing the authoritative live signal through commit.

---

#### Execution Terminal Consistency Tests


Required：

```text
done.reason = stop
message.stopReason = stop
→ eligible for commit
```

```text
done.reason != message.stopReason
→ Runtime / Pi Contract Failure
→ no commit
```

Test all supported success reasons.

---

#### Abort-Aware Wait Test


Fixture：

```text
Pi stream starts
↓
no further event arrives
↓
request AbortSignal fires
```

Expected：

```text
Execution exits/cancels
without waiting for another Pi event
```

and：

```text
no committed AssistantMessage
no Anthropic success rendering
```

---

### 11.5. Response Conversion Tests

#### AssistantMessage Field Tests


For every field：

```text
role
content
api
provider
model
responseModel
responseId
diagnostics
usage
stopReason
deferred
errorMessage
rawStopReason
endTurn
timestamp
```

test its frozen disposition.

Future Pi fields must not become silently ignored by default.

---

#### Message Required-Shape Tests


Every ordinary target Message must explicitly contain：

```text
container
stop_details
stop_sequence
```

Baseline expected：

```text
container = null
stop_details = null
stop_sequence = null
```

Omission is test failure.

---

#### 11.5.1. Content

##### Text Tests


Verify exact：

```text
""
" "
"\t"
"\n"
"A "
" A"
"A\nB"
```

Both JSON and SSE preserve exact semantic text.

Also verify every target TextBlock contains：

```text
citations: null
```

on current baseline path.

---

##### ToolCall Tests


Verify：

```text
id exact
name exact
order exact
arguments exact JSON object tree
caller = {type:"direct"}
```

Reject：

```text
null root
array root
undefined nested
BigInt
NaN
Infinity
function
symbol
cycle
non-semantic toJSON coercion
```

before HTTP write.

---

##### Thinking Tests


Verify committed ordinary `ThinkingContent` produces JSON and Atomic SSE with identical `thinking` and opaque `signature`, and verify the resulting historical block maps back to the same Pi semantics on the next request.

Verify absent Pi signature projects to `signature:""` and replays to absent signature state.

Reject malformed fields, `redacted:true`, and ordinary thinking on a model without `reasoning:true`; do not textify or omit them.

---

#### 11.5.2. Usage

##### Usage Shape Tests


Final target `Usage` must explicitly contain：

```text
cache_creation
cache_creation_input_tokens
cache_read_input_tokens
inference_geo
input_tokens
output_tokens
output_tokens_details
server_tool_use
service_tier
```

Test：

```text
input exact
output exact
cacheRead exact
cacheWrite exact
reasoning subset not double-counted
cacheWrite1h subset not double-counted
required-nullable fields present
```

Malformed values fail before HTTP write.

---

#### 11.5.3. Termination

##### Stop Tests


```text
stop
→ end_turn

length
→ max_tokens

toolUse
→ tool_use
```

Also test certified reachability：

```text
stop_sequence unreachable
pause_turn unreachable
```

and blockers：

```text
refusal
requires successful classification
+
stop_details preservation

model_context_window_exceeded
must remain distinguishable
or path fails certification
```

---

##### `rawStopReason` / `endTurn` Tests


Verify generic renderer never derives target semantics from：

```text
rawStopReason string
endTurn alone
errorMessage
```

Certification fixtures may assert consistency, but renderer logic remains provider-neutral.

---

### 11.6. Response Rendering and Delivery Tests

#### 11.6.1. Atomic SSE Tests

##### Atomic SSE Frame-Shape Tests


Validate every emitted frame independently.

`message_start.message` must include：

```text
container
stop_details
stop_reason
stop_sequence
complete Usage shape
```

Text `content_block_start` must include：

```text
citations
```

ToolUse `content_block_start` must include：

```text
caller
```

`message_delta.delta` must include：

```text
container
stop_details
stop_reason
stop_sequence
```

`message_delta.usage` must include every current `MessageDeltaUsage` field.

---

##### Atomic SSE Empty Text Test


Input：

```text
Text("")
```

Expected lifecycle：

```text
content_block_start
text_delta("")
content_block_stop
```

with：

```text
citations:null
```

on the start block.

---

##### Atomic SSE Tool Test


Input：

```text
ToolCall(
  id,
  name,
  {a:1}
)
```

Expected：

```text
content_block_start(
  tool_use,
  caller={type:"direct"},
  input={}
)

input_json_delta('{"a":1}')

content_block_stop
```

Reference accumulator final input deep-equals：

```json
{
  "a": 1
}
```

---

##### JSON / SSE Identity Test


Construct target Message once.

Then：

```text
JSON target
```

and：

```text
SSE accumulated target
```

must have identical：

```text
id
container
model
role
content
stop_details
stop_reason
stop_sequence
usage
type
```

for fields represented by the streaming accumulation contract.

---

##### SSE Usage Conformance Tests


Do not assert one synthetic initial usage algorithm until validated.

Instead：

```text
target final Message usage
↓
serializer
↓
message_start + message_delta usage
↓
protocol reference accumulator
```

must reconstruct exact final usage.

Also run the emitted events through supported official Anthropic SDK consumers.

---

#### 11.6.2. HTTP Atomicity and Delivery Tests

##### Renderer Atomicity Test


Force：

```text
later target block serialization failure
```

Expected：

```text
zero HTTP bytes written
```

---

##### Post-Commit Disconnect Test


```text
COMMIT
↓
disconnect
```

Expected：

```text
semantic result remains success
HTTP delivery stops
no semantic rollback
```

---

### 11.7. Round-Trip / Provenance Tests

#### Opaque / Provenance Round-Trip Test


For Pi fields omitted from target response：

```text
textSignature
thoughtSignature
namespace
api
provider
model
responseModel
responseId
```

conformance must prove：

```text
their omission does not affect
next supported Anthropic request
→ Pi continuation semantics
```

or：

```text
state can be deterministically
reconstructed by request conversion
without fabricating target provenance
```

Otherwise the route cannot be certified.

---

### 11.8. Runtime Certification / Serving Tests

#### Provider Composition Tests


Serving type boundary：

```text
composition owns MutableModels
serving receives Models
```

Verify normal serving code cannot use Provider-registration methods through its intended contract.

---

#### Models Public API Precision Test


Spec/test documentation must not claim：

```text
Models is mutation-free
```

because normal Pi operations can include runtime/auth/catalog operations.

The protected invariant is：

```text
no Provider-registration mutation
under an active certification
```

---

## Appendix A — Appendices

### A.1. Support Matrices

#### Top-Level Support Matrix


| Source                               | Pi / LuckyToken    | v1                                                           |
| ------------------------------------ | ------------------ | ------------------------------------------------------------ |
| `model`                              | Model Resolver     | Supported / resolution-dependent                             |
| `messages`                           | `Context.messages` | Conditional                                                  |
| `system` simple form                 | `systemPrompt`     | Conditional                                                  |
| `tools`                              | `Context.tools`    | Conditional                                                  |
| positive `max_tokens`                | `maxTokens`        | Conditional                                                  |
| `max_tokens=0`                       | —                  | Unsupported                                                  |
| `temperature`                        | `temperature`      | Conditional                                                  |
| `metadata.user_id`                   | metadata           | Conditional                                                  |
| `stream`                             | renderState        | Supported                                                    |
| `cache_control`                      | —                  | Unsupported                                                  |
| `container`                          | —                  | Unsupported                                                  |
| `inference_geo`                      | —                  | Unsupported                                                  |
| `service_tier`                       | —                  | Unsupported                                                  |
| explicit thinking controls           | —                  | Unsupported after source validity                            |
| `output_config.effort`               | —                  | Unsupported after source validity                            |
| `output_config.format`               | —                  | Unsupported after source validity / grammar coverage as applicable |
| `tool_choice`                        | —                  | Unsupported                                                  |
| `stop_sequences`                     | —                  | Unsupported                                                  |
| `top_p`                              | —                  | Unsupported                                                  |
| `top_k`                              | —                  | Unsupported                                                  |
| server tools                         | —                  | Unsupported                                                  |
| semantic `anthropic-user-profile-id` | —                  | Unsupported / beta-profile-dependent                         |
| future semantic header/field         | —                  | Unsupported                                                  |

### A.2. Invariant Index

#### Revised Frozen Invariants



#### I-1 — No Parallel Universal IR


No LuckyToken generic LLM IR.

#### I-2 — Client Authorization Is Not Source Validity


Independent authority.

#### I-3 — Exact v1 Source Profile Is Frozen


`anthropic-version=2023-06-01` with no beta is the only implemented v1 source grammar.

#### I-4 — Profile Envelope Validity and Profile Support Are Distinct


Known source-invalid profile → `InvalidRequest`; valid/unclassified-but-unimplemented profile grammar → `UnsupportedFeature`.

#### I-5 — Profile-Independent JSON Syntax Has Independent Failure Authority


Malformed JSON → `InvalidRequest` before profile-support rejection.

#### I-6 — Full Source Validity Is Profile-Relative


Only claimed for source grammar LuckyToken implements.

#### I-7 — Within a Supported Profile, Source Validity Precedes Feature-Level Capability Rejection


`UnsupportedFeature` must not mask a source-invalid request once the grammar is understood.

#### I-8 — Model Resolution Failure Is Not Reclassified by Conversion


Router / Model Resolution contract owns that failure.

#### I-9 — Source Closed World Covers Body and Protocol-Defined Semantic Headers


No silent semantic loss.

#### I-10 — Unclassified Anthropic-Owned Headers Fail Closed


Retain `anthropic-*` extension markers; reject conservatively.

#### I-11 — Arbitrary Unknown HTTP Headers Are Not Automatically Anthropic Semantics


Generic transport/proxy headers remain outside Client Protocol semantics.

#### I-12 — Protocol Spec Is Semantic Authority and Certification Dependency


Protocol drift is repaired through Protocol Spec/classifier/conformance synchronization; certification binds an immutable synchronized Protocol revision.

#### I-13 — Normal Message String Shorthand Dies at Canonicalization


Source-authorized equivalence only.

#### I-14 — Explicit Ordinary Message `content:[]` Is Current Unsupported Grammar Coverage


Until source authority resolves its validity/semantics, user/assistant `[]` → `UnsupportedFeature`; never silently drop the turn.

#### I-15 — Same-Role Merge Is User/User and Assistant/Assistant Only


No generic system merge; no invented separators.

#### I-16 — Accepted Text Preserves Exact Parsed Value


No trim or whitespace normalization.

#### I-17 — Message Conversion May Expand 1:N


Especially ToolResult.

#### I-18 — Final Assistant Prefill Has Model-Dependent Source Validity


Evidence-bound `forbidden` → `InvalidRequest`; evidence-bound `allowed` → source-valid then `UnsupportedFeature` in v1; `unknown` → `UnsupportedFeature` without guessing.

#### I-19 — Deterministic Converter Owns No Normative Client Failure Authority


Source/client failures occur before conversion; impossible post-gate states are internal integrity failures.

#### I-20 — Every Pi Message Required Field Has a Frozen Construction Rule


User/ToolResult timestamps use `receivedAt`; historical Assistant required-shape fields use the frozen synthetic policy.

#### I-21 — Historical Target Provenance Is Never Fabricated


Synthetic Client-owned provenance only.

#### I-22 — Synthetic Historical Identity Is Certification-Reserved


Certified target identity must be disjoint from the frozen synthetic namespace.

#### I-23 — Historical Required-Shape Projections Are Deterministic and Replay-Inert


Zero Usage; structural stop/toolUse; `receivedAt` timestamp.

#### I-24 — Opaque Historical Continuation Is Unsupported


No trusted continuation branch in v1.

#### I-25 — Tool Identity Is ID-Based


`tool_use.id = tool_result.tool_use_id`.

#### I-26 — Pending Tool State Is Turn-Scoped


No whole-history registry; no guessing.

#### I-27 — Provider Tool-ID Adaptation Is Collision-Safe


Certification-bound.

#### I-28 — Unsupported Semantics Are Never Dropped or Textified


Exact map or fail.

#### I-29 — Converter Performs No External I/O


No URL-image fetch.

#### I-30 — ToolResult String Equivalence Is Source-Owned


Converter cannot invent string↔single-text-block equivalence.

#### I-31 — Source-Authorized ToolResult Shorthand Has an Explicit Death Point


Equivalent encodings may share one Pi representation only there.

#### I-32 — ToolResult Omission and Semantically Distinct Explicit Values Must Not Collapse


Omitted != explicit empty text.

#### I-33 — Current v1 Explicit ToolResult `[]` Is Unsupported Grammar Coverage


Until Protocol authority establishes validity/equivalence: `[] → UnsupportedFeature`, never guessed `InvalidRequest` or Pi `[]`.

#### I-34 — Tool Mapping Is Complete and Allowlisted


`name`, `description`, `input_schema`, `strict` have exact mappings; unsupported tool controls fail.

#### I-35 — Tool Conversion Is Target-Capability-Free


Truthful Pi semantics first; runtime capability belongs to Gate C/certification.

#### I-36 — Source Schema Validity Belongs to Source Profile


Frozen subset exclusion alone is never `InvalidRequest`.

#### I-37 — Documented Strict Request-Wide Hard Limits Are Source Validity


20 strict tools / 24 optional params / 16 union params; documented violations → `InvalidRequest`.

#### I-38 — Frozen Schema Subset Is Exact and Recursive


Same allowlist at every schema-valued position.

#### I-39 — Non-Schema JSON Values Are Not Recursively Reinterpreted as Schemas


`enum/const/default/examples` remain value data.

#### I-40 — Tool Schema Semantics and Enforcement Are Separate


`parameters != constrainedSampling`.

#### I-41 — Deterministic Request Conversion Preserves Presence/Omission


No arbitrary metadata/options copying or materialized omitted controls.

#### I-42 — Runtime Readiness Failure Is Not UnsupportedFeature


Server/serving failure.

#### I-43 — Invocation Integrity Failure Is Not UnsupportedFeature


Server failure.

#### I-44 — Correctly Constructed Request Capability Failure Is UnsupportedFeature


Client capability rejection.

#### I-45 — Authentication Must Not Mutate Model-Visible Semantics


Credential is not semantic mode.

#### I-46 — Effective Pi Invocation Is Closed-World


Unclassified fields remain absent.

#### I-47 — Ambient Semantic Configuration Is Certification-Owned


Not converter input.

#### I-48 — Certification Binds Concrete Execution Composition and Protocol Dependency


Not API identity or mutable documentation alone.

#### I-49 — Provider Registration Composition Is Immutable During Serving


No `setProvider/deleteProvider/clearProviders` on certified serving composition.

#### I-50 — Models-Facing Invocation Structure Is Immutable After Gate C


Model, Context, ordinary option values and capability identities transfer to Execution.

#### I-51 — Live Lifecycle Capability Identity Is Immutable, Lifecycle State Is Not Frozen


Explicitly applies to AbortSignal.

#### I-52 — AbortSignal Remains HTTP-Owned and Authoritative Until Success Commit


Later abort must still be observed.

#### I-53 — Serving-Time Models Operations Cannot Silently Change Certified Semantics


Preserve certification or invalidate readiness.

#### I-54 — Catalog/Runtime Mutation Does Not Mutate In-Flight Request State


Future requests re-resolve/re-certify.

#### I-55 — Pi Fidelity Defects Are Fixed in Pi First


No converter workaround by default.

#### I-56 — Model-Dependent Source Validity Has Explicit Authority

A model-dependent `InvalidRequest` decision requires an evidence-bound Anthropic Client Protocol authority whose immutable policy revision is certification-bound; unknown validity is `UnsupportedFeature`, never guessed invalid/valid`.

#### I-57 — Metadata Reserved Keys Merge Per Owner

`metadata.user_id` is Client Protocol-owned, `metadata.projectDir` is Client Authorization-owned, and `composeOptions` merges them per key without last-write-wins overwrite.

#### I-58 — Pi Evidence Basis Is Distinct From Certified Runtime Revision

The Method records the Pi contract snapshot used for specification review; each Runtime Certification separately binds the concrete immutable Pi revision being executed.

#### I-59 — Generic v1 Auth Must Be Semantically Inert

An auth/endpoint path that injects or rewrites model-visible system/tool/conversation semantics cannot be certified for the generic Anthropic v1 route.

#### Frozen Architectural Invariants



#### R-1 — Pi Event Stream Is Execution State


Not Client rendering input.

#### R-2 — Core Execution Owns Pi Stream Consumption


Anthropic response conversion starts from committed `AssistantMessage`.

#### R-3 — Successful Response Conversion Starts at Committed `AssistantMessage`


No partial Pi semantic state crosses the boundary.

#### R-4 — `stream` Changes Wire Representation Only


JSON and Atomic SSE represent the same target semantic Message.

#### R-5 — No Generic Response IR


Pi semantic input → Anthropic target representation.

#### R-6 — One Runtime Certification System


Outbound response fidelity is a dimension of existing certification.

#### R-7 — Every `AssistantMessage` Field Has Explicit Disposition


No silent future-field loss.

#### R-8 — `done.reason` and `done.message.stopReason` Must Agree


Mismatch fails before COMMIT.

#### R-9 — Every Pi Progress Wait Is Abort-Aware Until COMMIT


Cancellation cannot depend on another Pi event arriving.

#### R-10 — Client-Visible Model Identity Is Explicit Policy


It is not inferred accidentally from Pi routing identity.

#### R-11 — Required-Nullable Anthropic Fields Are Explicitly Emitted


Omission is not `null`.

#### R-12 — Required-Shape Projection Requires Semantic Authority


A synthetic target value is allowed only when deterministic and truthful under the supported/certified surface.

#### R-13 — Content Ordering Is Exact


No type-based reordering.

#### R-14 — Text Is Exact


No trim/filter/normalization.

#### R-15 — Tool Identity Is Exact


No ID/name normalization.

#### R-16 — Tool Input Must Be a JSON Object Tree


Serialization is not validation.

#### R-17 — Direct Tool `caller` Is a Required-Shape Projection


Only valid while non-direct caller semantics are unreachable.

#### R-18 — Opaque State Is Certification-Dependent


Presence alone does not prove failure; semantic relevance decides.

#### R-19 — Ordinary Thinking Is an Exact v2 Round-Trip Semantic


Certified execution preserves ordinary thinking and opaque signatures through JSON、Atomic SSE and next-turn replay. Redacted thinking remains fail-closed.

#### R-20 — Usage Is Schema-Complete and Mapped, Not Recomputed


Subsets are never double-counted.

#### R-21 — Termination Fidelity Is Reachability-Aware


Only reachable target semantics must remain representable.

#### R-22 — Reachable Successful Target Termination Includes Companion State


For example refusal requires both `stop_reason` and `stop_details`.

#### R-23 — `rawStopReason`, `errorMessage`, and `endTurn` Are Not Generic Guessing Authorities


Certification may inspect them; generic renderer does not infer from them.

#### R-24 — Atomic SSE Requires Per-Frame Validity


Final accumulation equality alone is insufficient.

#### R-25 — Atomic SSE Usage Trajectory Requires Conformance Evidence


Do not freeze invented progress/count semantics without target validation.

#### R-26 — Target Message Is Constructed Once


JSON/SSE serializers consume the same target object.

#### R-27 — Target Serialization Completes Before HTTP Write


Atomicity extends through rendering.

#### R-28 — AbortSignal Is Authoritative Until Semantic COMMIT


After commit, disconnect is delivery-only.

#### R-29 — EOF Is Not Success


Explicit Pi terminal required.

#### R-30 — Failure Does Not Become a Successful Anthropic Message


Failure rendering is parallel.

#### R-31 — Supported Proxy Semantics Must Be Round-Trip Faithful


Display-only one-way conversion is insufficient when response becomes next-turn history.

#### R-32 — Pi Provenance Must Be Replay-Inert or Reconstructible


Do not expose Provider metadata merely to preserve internal state.

#### R-33 — Pi Semantic-Loss Defects Are Fixed in Pi or Fail Certification


The Anthropic renderer does not guess missing state.

---

### A.3. Certification Manifest Example

#### Runtime Certification Manifest


Manifest MUST identify：

```text
Specification Version
Anthropic Protocol Spec Revision
Pi Revision
Provider Construction
API Implementation
Relevant Model Configuration
Anthropic Model-Validity Policy Revision
Supported Anthropic Source Profile
Auth / Endpoint Policy
Tool-ID Adaptation Policy
transformHeaders Policy
fetch Policy
onPayload Policy
Auxiliary Option Policy
Ambient Semantic Configuration Policy
Conformance Revision
Certification Result
```

`Anthropic Protocol Spec Revision` MUST be immutable and synchronized with the source-validity facts required by this specification. A mutable filename/version label alone is insufficient.

`Semantic Header Policy` is not a separate required identity field because it remains specification/Protocol-owned. A derived diagnostic summary is allowed but non-authoritative.

#### Example Manifest


```text
Specification:
Anthropic ↔ Pi AI IR Conversion Method v1.2

Capability Baseline:
v2

Anthropic Protocol Spec:
Anthropic Messages API Protocol Specification v0.4

Reviewed Protocol Document SHA-256:
efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918

Pi Contract Evidence Basis:
Pi AI IR Protocol v0.9.2
Reference Commit = eb3c46d6ce28cb87147bb0d05645ebae28524713
Reference Package = @earendil-works/pi-ai 0.84.1
Protocol Blob SHA = a3dc09b846f2e49f73480d5e33c63aa009ff9a51

Certification Result:
<PENDING | FAILED | CERTIFIED>

Pi Revision:
<immutable revision>

Provider Construction:
<immutable identity>

API Path:
<immutable identity>

Anthropic Source Profile:
version = 2023-06-01
betas = []

Anthropic Model-Validity Policy Revision:
<immutable revision>

Tool-ID Adaptation:
<certified collision-safe policy>

transformHeaders:
absent

fetch:
default

onPayload:
absent

Ambient Semantic Configuration:
<fixed policy>

Conformance Revision:
<immutable revision>
```

The synchronized Protocol v0.4 SHA above is eligible for certification binding because it includes the request-side source-validity facts required by v1. The previous Protocol v0.3 SHA-256 `0179347575d9be388d5ca2258f447a2351990c554c67d172e078ab8cd017a992` MUST NOT be used for `CERTIFIED`.

Optional non-authoritative diagnostics may derive the semantic-header/source-grammar support matrix from the bound Specification + Protocol revision; they do not redefine it.

#### Runtime Certification Checklist


```text
[ ] Specification Version matches converter conformance revision

[ ] immutable Anthropic Protocol Spec revision is synchronized and bound

[ ] Method review provenance binds Pi AI IR Protocol v0.9.2
    / eb3c46d6ce28cb87147bb0d05645ebae28524713
    / a3dc09b846f2e49f73480d5e33c63aa009ff9a51

[ ] concrete Runtime Certification Pi Revision is immutable

[ ] if runtime Pi Revision differs from the Method evidence basis,
    affected Pi contracts/behavior were re-reviewed or proven equivalent

[ ] bound Protocol revision includes model-dependent prefill source validity

[ ] bound Protocol revision includes documented strict request-wide hard limits

[ ] supported source profile is exactly version=2023-06-01, betas=[]

[ ] profile envelope validity and profile-support failure authority are distinct

[ ] malformed JSON precedes profile-support capability rejection

[ ] ordinary user/assistant content:[] follows current grammar-coverage policy

[ ] current source-grammar coverage policy includes explicit ToolResult []

[ ] Client Auth remains independent from source validity

[ ] model-resolution failure follows Router / Model Resolution contract

[ ] final assistant prefill uses model-dependent source validity before v1 support rejection

[ ] final-assistant prefill source validity comes from the
    Anthropic Client Protocol evidence-bound classifier

[ ] classifier result unknown → UnsupportedFeature,
    never guessed InvalidRequest and never guessed allowed

[ ] Anthropic Model-Validity Policy Revision is immutable and bound

[ ] deterministic converter emits no normative client InvalidRequest/UnsupportedFeature decisions

[ ] sourceProfile reaches deterministic conversion explicitly

[ ] every UserMessage / ToolResultMessage timestamp is receivedAt

[ ] historical AssistantMessage uses frozen synthetic provenance

[ ] certified target identities are disjoint from synthetic history identity

[ ] historical zero Usage / structural stopReason / receivedAt are exact

[ ] current ToolResult string form is UnsupportedFeature unless equivalence authority is added

[ ] any future source-authorized string shorthand maps to exactly one TextContent

[ ] omitted ToolResult content remains distinct from explicit textual values

[ ] current explicit ToolResult [] is UnsupportedFeature, not guessed

[ ] ToolResult is_error omitted→false projection is exact

[ ] complete Tool field matrix is enforced

[ ] omitted tool description→"" projection is certified equivalent

[ ] strict=true remains json_schema/require

[ ] documented strict request limits 20/24/16 are validated as InvalidRequest

[ ] exact recursive schema allowlist is enforced at every SchemaNode

[ ] enum/const/default/examples remain value data

[ ] maxTokens exact

[ ] temperature presence/omission exact

[ ] metadata.user_id exact and no generic metadata spread

[ ] composeOptions merges metadata per key:
    user_id from Client Protocol + projectDir from Client Authorization

[ ] no non-owner/default silently overrides metadata.user_id or metadata.projectDir

[ ] reasoning omission faithful

[ ] image fidelity exact

[ ] ToolResult blocks remain structurally faithful

[ ] whitespace/system content preserved

[ ] cache/tool defaults do not materialize unauthorized semantics

[ ] tool-ID adaptation correlation-preserving + collision-safe

[ ] auth behavior semantically invariant

[ ] generic Anthropic v1 certification excludes auth paths
    that inject/rewrite model-visible system/tool/conversation semantics

[ ] onPayload absent

[ ] transformHeaders matches manifest

[ ] fetch matches manifest

[ ] ambient semantic configuration matches manifest

[ ] Provider registration composition immutable while serving

[ ] serving-time Models operations cannot silently invalidate certification

[ ] in-flight requests are isolated from certification-bound serving mutations

[ ] in-flight Model + Context + option structure immutable after Gate C

[ ] AbortSignal reference immutable after Gate C

[ ] AbortSignal cancellation lifecycle remains live through commit

[ ] conformance revision includes profile/header/failure-order/message/tool/schema tests

[ ] conformance revision matches manifest
```

Semantic-header and source-grammar support rows are specification/conformance facts and are not duplicated as independent runtime-manifest authority.

### A.4. Revision Notes and Evidence Boundaries

### v1.2 Ordinary Thinking Round-Trip Extension

v1.2 introduces capability baseline v2 while preserving every inherited v1 rule. The only capability expansion is ordinary, non-redacted thinking：

```text
Anthropic historical thinking ↔ Pi ThinkingContent ↔ Anthropic JSON / Atomic SSE thinking
```

The extension freezes opaque non-empty signature preservation, the empty-signature projection for absent Pi state, model-aware reasoning representability, and fail-closed redacted handling. Explicit source thinking controls remain unsupported. No Provider wire type or Provider policy enters the Client Protocol contract.

### v1.1 Final Contract Completeness Closure

v1.1 preserves the v1 capability baseline and closes five source-evidenced contract-completeness gaps：

```text
1. explicit authority for model-dependent source validity;
2. exact metadata.user_id + projectDir composition;
3. Pi contract evidence identity distinct from runtime Pi certification revision;
4. complete known current Pi request/response fidelity-work inventory;
5. generic-v1 exclusion of auth paths that mutate model-visible semantics.
```

No H3/H4/H5/H6 ownership redesign、request capability expansion、response capability expansion、failure-authority redesign、or generic IR is introduced.

### v1 Combined Hierarchical Contract Closure — Lineage

v1 consolidates the previously separate request v0.4.9 and response v0.3 conversion methods into one human-reviewed hierarchical contract.

This closure performs targeted publication / identity repair only：

```text
combined Method identity → v1
current reviewed Protocol dependency → v0.4
Protocol document SHA-256 → efe2fd39c66a089137c983c1d1f8a6a32a032ccc775fc634b2a7ca90a412e918
Runtime Certification → PENDING
legacy numeric cross-references → named references
historical flat/nested heading numbers → removed
reader-facing hierarchy numbering → contiguous
duplicate carried headings → suppressed where semantically identical
```

No request/response capability、failure authority、Core COMMIT semantics、Pi representation、tool mapping、runtime certification requirement、or provider behavior is changed by this v1 closure.

#### v0.4.9 Final Source Validity & Failure Authority Closure


Relative to v0.4.8, this version performs only targeted contract closure. It does not redesign conversion architecture, Pi representation, Gate C, cancellation, Models ownership, Tool mapping, or the frozen v1 schema subset.

Targeted changes only：

```text
1. freeze the exact v1 implemented source-profile policy:
   anthropic-version = 2023-06-01
   anthropic-beta = absent / empty;

2. make profile-independent JSON syntax parsing
   precede source-profile grammar coverage;

3. add an explicit Model Resolution failure branch
   owned by the Router / Model Resolution contract;

4. classify ordinary message.content: []
   as unresolved Source Grammar Coverage in current v1
   instead of allowing a source turn to disappear;

5. make final-assistant prefill failure authority
   model-dependent:
   source-invalid model → InvalidRequest;
   otherwise source-valid prefill → UnsupportedFeature v1;

6. remove normative client failure authority
   from deterministic message conversion;
   impossible post-gate states become internal invariants;

7. add documented strict:true request-wide
   source-validity hard limits;

8. bind Runtime Certification to an immutable
   synchronized Anthropic Protocol Spec revision;

9. complete acceptance formula, current top-level matrix,
   readiness/integrity placement, tests, manifest,
   failure tree, and final status wording.
```

No new：

```text
Universal IR
Envelope IR
Profile Manager
Beta Registry
Compatibility Manager
Header Manager
Cancellation Manager
Schema Manager
Provider Generation Manager
Models wrapper
```

The governing rule remains：

> **Fix source/failure authority at the existing boundaries; do not introduce new architecture.**
