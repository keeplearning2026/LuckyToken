# Part I — Introduction and Conversion Principles

## 1. Purpose

本文定义 LuckyToken 在 Anthropic Messages protocol 与 Pi AI IR 之间的双向 semantic conversion method。

两个方向分别为：

```text
Anthropic Request
        ↓
Pi / LuckyToken Invocation
```

以及：

```text
committed Pi AssistantMessage
        ↓
Anthropic Response
```

本文关注：

```text
semantic representation
information ownership
conversion rules
defaults
conversion failures
response rendering semantics
```

本文不负责：

```text
authentication
credential acquisition
model catalog management
provider selection internals
provider-native request construction
HTTP retry policy
stream consumption
cancellation
execution commit
runtime certification
```

这些属于 LuckyToken 的其他 architecture/runtime contracts。

---

## 2. Conversion Boundaries

### 2.1. Request Direction

Request conversion 的 destination 是：

```text
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

即：

```text
Anthropic Request
        ↓
construct
        ↓
Pi / LuckyToken invocation state
```

Conversion 不把整个 Anthropic Request 转换成另一个完整 Anthropic-shaped intermediate representation。

它只构造 destination contract 所需要的信息。

---

### 2.2. Response Direction

Response conversion 的 source 是：

```text
committed AssistantMessage
```

destination 是：

```text
Anthropic Message
```

即：

```text
committed Pi AssistantMessage
        ↓
construct
        ↓
Anthropic Message M
        ↓
        ├── JSON
        └── Atomic SSE
```

Part III 不接收 unfinished Pi stream state。

以下状态在进入 response conversion 前已经由 execution/runtime boundary 处理：

```text
pending
error
aborted
deferred
malformed terminal state
unexpected EOF
cancellation
```

---

## 3. Governing Principle — Conversion Is Always Target-Driven

> **Conversion is always target-driven.**

Destination contract 是 conversion 的 authority。

Conversion 首先确定 target 需要构造什么 semantic state，然后才去 source 中提取构造这些 target semantics 所需要的信息。

```text
Target
        ↓
determine required target semantics
        ↓
find corresponding source information
        ↓
construct Target
```

因此 conversion 的方向不是：

```text
Source
        ↓
enumerate source semantics
        ↓
classify each source field
        ↓
decide convert / ignore / reject
        ↓
Target
```

而是：

```text
Target
        ↓
what information does this target need?
        ↓
read only that information from Source
        ↓
construct Target
```

所有后续 conversion rules，包括 source extraction、defaults、validation、failure 和 information lifetime，均由该原则推导。

---

## 3.1. Request Construction Rule

对于每个 Pi / LuckyToken target semantic，conversion 从 target 向 source 查找所需信息：

```text
Target semantic
        ↓
find corresponding source information
        ↓
├── source supplied
│      ├── faithfully convertible
│      │      → convert
│      └── cannot be faithfully represented
│             → fail
│
└── source absent
       → use target-defined default
```

例如：

```text
options.maxTokens
← request.max_tokens

options.reasoning
← request.output_config.effort

options.temperature
← request.temperature
```

如果：

```text
request.temperature
```

不存在，则：

```text
options.temperature
→ absent
→ Pi/provider default behavior
```

Source absence 不是 conversion failure。

只有 source 明确提供了 target 所需要尊重的 semantic，而该 semantic 无法忠实构造 target 时，conversion 才失败。

---

## 3.2. Response Construction Rule

Response conversion 同样以 Anthropic target 为 authority：

```text
Anthropic Message target
        ↓
determine required target semantics
        ↓
read corresponding Pi source information
        ↓
construct Anthropic Message
```

如果 Pi source 中存在 destination 不需要的信息：

```text
→ it does not enter the Anthropic target
```

如果构造 required Anthropic semantic 所需的信息无法忠实表达：

```text
→ OutboundResponseFidelityFailure
```

Response conversion 不通过猜测来修复 committed result。

---

## 4. Destination Defaults

当 optional source information 不存在时，conversion 使用 destination 自己定义的 default behavior。

Converter 不发明 provider defaults。

例如：

```text
Anthropic temperature absent
→ Pi options.temperature absent
```

```text
Anthropic output_config.effort absent
→ Pi options.reasoning absent
```

```text
Anthropic tools absent
→ Context.tools absent
```

```text
Anthropic system absent
→ Context.systemPrompt absent
```

```text
Anthropic stream absent
→ AnthropicRenderState.stream = false
```

如果 destination 没有可用 default，而 target 又无法在缺少该信息时构造：

```text
→ conversion failure
```

例如 model selector 不能凭空生成。

---

## 5. Consequence — Unneeded Source Information Never Enters Conversion State

这是 target-driven conversion 的直接结果。

如果 destination target 不需要某项 source information，则 conversion 不需要对该信息采取任何动作：

```text
Target does not require information
        ↓
conversion does not read it
        ↓
conversion does not validate it
        ↓
conversion does not copy or retain it
        ↓
it never enters conversion state
```

因此 conversion 不存在独立的：

```text
ignore phase
ignore handler
ignored-field registry
known-ignored-feature list
unknown-field classification
exhaustive source grammar coverage
```

所谓“ignore”只是一个结果：

> **Target 没有要求这项信息，所以 conversion 从未读取它。**

例如 Anthropic Request 未来新增一个 optional field：

```text
future_option
```

如果当前 Pi / LuckyToken target 不需要它：

```text
future_option
→ never read
→ no validation
→ no conversion state
→ no failure
```

这使 conversion 可以自然容忍 source protocol 中与当前 target 无关的扩展，而不需要持续维护 source-wide feature inventory。

---

## 6. Faithful Representation

Conversion 的目标不是最大程度复制 source syntax，而是忠实构造 destination semantic。

因此：

```text
different syntax
may map to
the same destination semantic
```

只要该 mapping 是明确且不会改变 request/response meaning。

例如：

```text
Anthropic output_config.effort
→ Pi SimpleStreamOptions.reasoning
```

以及：

```text
Anthropic base64 image
→ Pi ImageContent
```

都属于 semantic conversion，而不是语法复制。

---

## 6.1. No Unnecessary Canonicalization

如果 destination 已经能够直接表达 source semantic，converter 不额外改变它。

因此默认不执行：

```text
message merging
message reordering
text trimming
newline normalization
tool-call renaming
unnecessary wrapper construction
synthetic placeholders
```

除非 destination contract 本身要求这种 transformation。

---

## 6.2. Preserve Natural Hierarchy

Conversion 应保持信息本来的层级：

```text
Request
└── Messages
    └── Content
```

以及：

```text
Context
├── systemPrompt
├── messages
└── tools
```

不把 block-level semantic 提升成 unrelated top-level state，也不把 target ownership 拆散到无关模块。

---

## 7. Supplied Semantics That Cannot Be Represented

有些 Anthropic source semantics 是 LuckyToken 明确理解的，而且如果直接不处理会改变 request meaning。

当当前 Pi / LuckyToken target 没有 faithful representation 时：

```text
→ UnsupportedFeature
```

例如当前包括：

```text
URL image
document
search_result
known server-tool semantics
final assistant prefill
tool_choice
output_config.format
stop_sequences
```

Failure 的原因不是：

```text
"field is unknown"
```

而是：

```text
the client supplied a meaningful semantic
that LuckyToken cannot currently preserve
```

因此不能静默继续执行另一个 request。

---

## 8. Consumed Source Validity

Conversion 只验证它真正需要读取的信息。

如果 target construction 需要某个 source value，而该 value 无法形成 required target semantic：

```text
→ InvalidRequest
```

例如：

```text
model cannot form selector

tool_use cannot provide required identity

tool_use.input cannot form required arguments state

tool_result cannot correlate to required tool identity
```

Conversion 不负责验证未进入 conversion state 的 source information。

---

## 9. Request Failure Categories

Request-side conversion 只需要区分两个核心 semantic failure：

### InvalidRequest

```text
required source information
is malformed, incomplete,
or internally ambiguous
```

导致 target 无法构造。

### UnsupportedFeature

```text
source semantic is understood
and meaningful,
but current Pi / LuckyToken target
cannot faithfully represent it
```

两者都不应通过 silent degradation 变成不同 request。

---

## 10. Response Failure Category

Response conversion 已经位于 execution 成功之后。

如果 committed Pi result 无法忠实构造 required Anthropic target：

```text
→ OutboundResponseFidelityFailure
```

例如：

```text
Anthropic content would be invalid

ToolCall arguments cannot form
required Anthropic JSON object

usage relationships are inconsistent

termination and content disagree

unexpected successful stop state
reaches response conversion
```

Part III 不使用：

```text
InvalidRequest
UnsupportedFeature
```

描述 committed outbound state。

---

## 11. Information Ownership

每个 lifecycle stage 只拥有当前阶段需要的信息。

### Request source

```text
Anthropic Request
```

拥有 client protocol representation。

### Request conversion result

```text
selector
Context
SimpleStreamOptions
AnthropicRenderState
```

拥有 Pi invocation 与 later Anthropic rendering 所需要的信息。

### Pi execution

```text
Model
Context
SimpleStreamOptions
```

拥有 execution input。

### Response conversion

```text
committed AssistantMessage
+
AnthropicRenderState
```

构造唯一 authoritative：

```text
Anthropic Message
```

### Rendering

```text
Anthropic Message
```

再选择：

```text
JSON
or
Atomic SSE
```

信息不应在 unrelated layers 中重复保存。

---

## 12. Protocol, Conversion, and Runtime Separation

本文保持三个问题彼此独立。

### Protocol

描述：

```text
what Anthropic structures mean
what Pi structures mean
their legal shapes and semantics
```

### Conversion

描述：

```text
how destination semantics
are constructed from source information
```

### Runtime / Architecture

描述：

```text
who invokes conversion
how model resolution works
how execution consumes Pi streams
how cancellation works
how successful commit is established
how HTTP failures are rendered
```

Conversion Method 不应吸收 runtime implementation policy。

---

## 13. No Provider-Specific Semantic Recovery

Pi may normalize provider-native semantics before Part III。

一旦 source semantic 已经被 Pi normalization 合并或丢失：

```text
Part III does not reconstruct it
from provider provenance
```

因此 response conversion 不依赖：

```text
provider
api
rawStopReason
responseModel
provider-specific metadata
```

恢复已经不存在于 authoritative Pi semantic state 中的信息。

这避免 generic Anthropic response conversion 重新耦合到具体 provider adapter。

---

## 14. Stable Information Paths

Conversion 应保持信息路径短且确定。

Request：

```text
Pi / LuckyToken Target
        ↓
find required Anthropic source information
        ↓
direct semantic mapping
        ↓
constructed Pi / LuckyToken Target
```

Response：

```text
Anthropic Message Target
        ↓
find required committed Pi information
        ↓
direct semantic mapping
        ↓
constructed Anthropic Message
```

不引入：

```text
generic conversion registry
feature classification layer
second semantic IR
source shadow model
normalization manager
```

除非未来存在已经证明的必要性。

---

## 15. Conversion Invariants

整个 Method 应保持以下 invariants。

### Request

```text
1. Every constructed Pi/LuckyToken target value
   has a defined source or target default.

2. Missing optional source information
   does not cause converter-generated semantic defaults
   when the target can own the default itself.

3. Supplied semantics required for faithful execution
   are never silently contradicted.

4. Source information not needed for target construction
   does not enter conversion state.

5. Message and content ordering remain stable
   unless the target requires transformation.

6. Constructed selector + Context +
   SimpleStreamOptions + RenderState
   must form a valid invocation state.
```

### Response

```text
1. Part III receives only a committed AssistantMessage.

2. Anthropic Message is constructed once.

3. JSON and Atomic SSE render that same Message.

4. Unneeded Pi provenance does not leak into
   Anthropic semantic state.

5. Missing target semantics are not fabricated.

6. An unrepresentable committed result fails
   rather than producing a misleading successful Message.
```

---

## 16. Conversion Summary

Request direction：

```text
Pi / LuckyToken Target
        ↓
determine required target semantics
        ↓
find corresponding Anthropic source
        ↓
├── source supplied
│      ├── faithfully convertible
│      │      → convert
│      └── cannot be faithfully represented
│             → failure
│
└── source absent
       → target-defined default
        ↓
selector + Context
+ SimpleStreamOptions
+ AnthropicRenderState
```

Response direction：

```text
Anthropic Message Target
        ↓
determine required target semantics
        ↓
find corresponding committed Pi source
        ↓
construct Anthropic Message
        ↓
├── JSON
└── Atomic SSE
```

The governing principle is:

> **Conversion is always target-driven. The destination contract determines what source information is required, how that information is converted, what destination-defined defaults apply when source information is absent, and when faithful construction must fail.**

Its information consequence is:

> **Source information not required by the destination never enters conversion state.**

# Part II — Anthropic Request → Pi AI IR

## 1. Conversion Boundary

Anthropic request conversion 的目标是构造：

```text
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

Conceptually：

```ts
interface AnthropicRequestConversion {
  selector: string;
  context: Context;
  options: SimpleStreamOptions;
  renderState: AnthropicRenderState;
}

interface AnthropicRenderState {
  clientModel: string;
  stream: boolean;
}
```

Conversion 不复制 Anthropic Request，也不建立通用 intermediate representation。

其信息流为：

```text
Pi / LuckyToken Target
        ↓
determine required information
        ↓
read corresponding Anthropic source
        ↓
├── source present and convertible
│      → convert
│
├── source absent
│      → use target-defined default
│
└── supplied semantic cannot be
    faithfully represented
       → conversion failure
```

因此：

> **Start from the Pi/LuckyToken target, extract only the Anthropic source information required to construct it, use target-defined defaults when source information is absent, and fail when supplied source semantics cannot be faithfully represented.**

Anthropic Request 中未参与 target construction 的信息不进入 conversion state。

---

## 2. Model Selector

LuckyToken model identity contract 为：

```text
request.model
=
selector
=
<provider>/<model-id>
```

因此：

```text
Anthropic request.model
→ selector
```

值保持原样。

例如：

```text
commandcode-private/deepseek/deepseek-v4-flash
```

仍然是完整 selector。

Model resolution 使用：

```ts
models.getModels().filter(
  model => `${model.provider}/${model.id}` === selector
);
```

Conversion 不：

```text
split selector into provider/model
construct Model
modify model id
normalize selector
```

完整 `Model` 由 Pi model catalog / model resolution 拥有。

`selector` 没有 converter-local 默认值。

如果无法从 request 构造有效 selector：

```text
→ InvalidRequest
```

Model lookup failure 属于 Model Resolution contract，不由 conversion 重新分类。

---

## 3. Context Construction

目标：

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

因此 request conversion 分别构造：

```text
systemPrompt
messages
tools
```

---

## 3.1. System Prompt

### String

```text
request.system: string
→ Context.systemPrompt
```

字符串保持原值。

不执行：

```text
trim
rewriting
normalization
```

### TextBlock Array

```text
request.system: TextBlock[]
→ blocks.map(block => block.text).join("\n")
```

只有可以转换为 system text 的 block 参与构造。

因此：

```text
[]
→ ""
```

如果 `system` 不存在：

```text
Context.systemPrompt
→ absent
```

使用 Pi 默认行为。

---

## 3.2. Message Ordering

Anthropic：

```text
request.messages[]
```

按原顺序逐条转换为：

```text
Context.messages[]
```

Conversion 不主动：

```text
merge adjacent same-role messages
reorder messages
delete an otherwise convertible message
```

每个 source message 独立构造对应 Pi message。

转换后的：

```text
content: []
```

是合法结果，保持为空即可。

---

## 3.3. User Message

Anthropic：

```text
role = "user"
```

转换为：

```ts
{
  role: "user",
  content,
  timestamp: receivedAt,
}
```

### String Content

```text
content: string
→ [{ type: "text", text: content }]
```

### Array Content

从 source content 中提取可以构造 Pi：

```text
TextContent | ImageContent
```

的信息。

#### Text

```text
Anthropic text
→ Pi TextContent
```

```ts
{
  type: "text",
  text,
}
```

#### Base64 Image

```text
Anthropic base64 image
→ Pi ImageContent
```

```ts
{
  type: "image",
  data,
  mimeType,
}
```

如果 resolved model 不接受 image input：

```text
→ UnsupportedFeature
```

#### URL Image

Pi `ImageContent` 没有 URL representation。

因此：

```text
URL image
→ UnsupportedFeature
```

#### Non-projectable Primary Content

已知 source semantic 如果要求保留主要 client-visible information，而当前 Pi message model 没有对应 representation，例如：

```text
document
search_result
known server-tool content/result
```

则：

```text
→ UnsupportedFeature
```

其他未用于构造 Pi content 的 source information不进入 target state。

最终 content 即使为空：

```ts
content: []
```

也照常构造 UserMessage。

---

## 3.4. `messages[].role = "system"`

Pi Message union 没有 `SystemMessage`。

因此历史 message 中：

```text
role = "system"
```

降级为：

```text
role = "user"
```

同时保持：

```text
message position
convertible content
```

即：

```text
Anthropic historical system message
→ Pi UserMessage
```

Top-level：

```text
request.system
```

仍然单独映射到：

```text
Context.systemPrompt
```

两者不是同一个 conversion rule。

---

## 3.5. Historical Assistant Message

Anthropic：

```text
role = "assistant"
```

转换为 Pi：

```ts
AssistantMessage
```

Content 依次转换。

### Text

```text
text
→ TextContent
```

### Ordinary Thinking

```text
thinking
→ ThinkingContent
```

```ts
{
  type: "thinking",
  thinking,
  thinkingSignature: signature,
}
```

如果 source signature 不存在，则不需要发明 signature。

### Redacted Thinking

当前 request conversion 不从：

```text
redacted_thinking
```

构造 Pi historical semantic state。

它不进入 converted content。

### Tool Use

```text
Anthropic tool_use
→ Pi ToolCall
```

Mapping：

```text
id
→ id

name
→ name

input
→ arguments
```

Conceptually：

```ts
{
  type: "toolCall",
  id,
  name,
  arguments: input,
}
```

Source `input` 必须足以构造 Pi：

```ts
Record<string, any>
```

否则：

```text
→ InvalidRequest
```

---

## 3.6. Historical Assistant Required Fields

Pi `AssistantMessage` 需要一些 Anthropic historical message 本身没有提供的 structural fields。

这些字段只用于满足 Pi message shape，不宣称恢复 provider history。

使用 deterministic client-history values：

```text
api
→ LuckyToken synthetic client-history API identity

provider
→ LuckyToken synthetic client-history provider identity

model
→ request selector

usage
→ zero usage

timestamp
→ receivedAt
```

Termination：

```text
contains ToolCall
→ stopReason = "toolUse"

otherwise
→ stopReason = "stop"
```

这些 synthetic values 不属于 recovered Anthropic facts，也不应被用于反推原 provider state。

---

## 3.7. Final Assistant Prefill

最终 input assistant turn 在 Anthropic 中具有 prefill semantic。

当前 generic Pi invocation不能忠实表达该 request behavior。

因此：

```text
final assistant prefill
→ UnsupportedFeature
```

---

## 3.8. Tool Result

Anthropic：

```text
tool_result
```

转换为：

```ts
ToolResultMessage
```

Pi target 需要：

```text
toolCallId
toolName
content
isError
timestamp
```

Mapping：

```text
tool_use_id
→ toolCallId

is_error ?? false
→ isError

receivedAt
→ timestamp
```

### Content

```text
content omitted
→ []

content string
→ [
     {
       type: "text",
       text: content
     }
   ]

content = []
→ []

content array
→ convert supported text / base64 image blocks
```

最终 content 可以为空。

---

## 3.9. Tool Identity Correlation

Anthropic `tool_result` 提供：

```text
tool_use_id
```

但 Pi `ToolResultMessage` 还要求：

```text
toolName
```

因此 conversion 在 request lifetime 内维护最小相关状态：

```text
toolUseId → toolName
```

遇到：

```text
tool_use(id, name)
```

记录：

```text
id → name
```

随后：

```text
tool_result(tool_use_id)
```

使用该 mapping 构造：

```text
ToolResultMessage.toolName
```

该 mapping 不在第一次 lookup 后删除；它只在当前 request conversion 生命周期内存在。

如果：

```text
tool_result references unknown id
```

则无法忠实构造 Pi ToolResultMessage：

```text
→ InvalidRequest
```

如果同一 tool-use ID 对应冲突的 tool names：

```text
→ InvalidRequest
```

Conversion 不猜测 tool identity。

---

## 4. Tools Construction

目标：

```text
Context.tools?: Tool[]
```

Anthropic tool definition 映射为 Pi：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

Mapping：

```text
name
→ Tool.name

description
→ Tool.description

input_schema
→ Tool.parameters
```

如果 source `description` 不存在：

```text
Tool.description = ""
```

Conversion 不重新实现 JSON Schema keyword validator。

`input_schema` 作为 target schema 直接传递给 Pi。

### Strict Tool

如果：

```text
strict = true
```

则：

```ts
constrainedSampling = {
  type: "json_schema",
  strict: "require",
};
```

如果：

```text
strict = false
```

或 absent：

```text
constrainedSampling
→ absent
```

### Server Tools

已知 Anthropic server-side tool definition 无法忠实构造为 LuckyToken 当前 client-executed Pi Tool contract：

```text
→ UnsupportedFeature
```

如果 `tools` 不存在：

```text
Context.tools
→ absent
```

---

## 5. SimpleStreamOptions Construction

目标：

```text
SimpleStreamOptions
```

当前 Anthropic request 中有明确 target 的 controls 为：

```text
max_tokens
temperature
output_config.effort
metadata.user_id
```

---

## 5.1. `max_tokens`

```text
request.max_tokens
→ options.maxTokens
```

值直接传递：

```ts
options.maxTokens = request.max_tokens;
```

Conversion 不执行：

```text
clamp
provider adjustment
context-window adjustment
thinking-budget adjustment
```

这些属于 Pi / provider execution。

如果 source 不存在：

```text
options.maxTokens
→ absent
```

使用 Pi target default behavior。

---

## 5.2. `temperature`

```text
request.temperature
→ options.temperature
```

值直接传递。

如果 absent：

```text
options.temperature
→ absent
```

由 Pi/provider 使用默认行为。

---

## 5.3. `output_config.effort`

Anthropic current effort levels：

```text
low
medium
high
xhigh
max
```

Pi：

```ts
type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
```

因此：

```text
low
→ low

medium
→ medium

high
→ high

xhigh
→ xhigh

max
→ max
```

即：

```text
request.output_config.effort
→ options.reasoning
```

如果 source 提供未来 effort string，而当前 Pi 没有同名 level：

```text
→ options.reasoning = "max"
```

`max` 是当前 Pi `SimpleStreamOptions.reasoning` 的最高档 fallback。

如果 `effort` 不存在：

```text
options.reasoning
→ absent
```

使用 Pi reasoning default behavior。

---

## 5.4. Metadata

如果：

```text
request.metadata.user_id
```

存在：

```text
→ options.metadata.user_id
```

Conceptually：

```ts
options.metadata = {
  user_id: request.metadata.user_id,
};
```

如果 source 不存在：

```text
options.metadata
→ absent
```

Conversion 不把其他 request state 塞入 Pi metadata。

---

## 6. Render State

Anthropic：

```text
request.stream
```

不属于 Pi provider transport preference。

它控制 LuckyToken 返回给 Anthropic client 的 wire representation。

因此：

```text
request.stream
→ renderState.stream
```

如果 absent：

```text
renderState.stream = false
```

同时：

```text
renderState.clientModel
=
selector
```

即保存原始 client-facing model selector，供 Part III 构造：

```text
Anthropic Message.model
```

不得：

```text
request.stream
→ options.transport
```

Pi/provider upstream streaming 与 Anthropic client response rendering 是不同语义。

---

## 7. Required Client Semantics Without Pi Target

如果 Anthropic Request 明确提供一个 LuckyToken 必须尊重的 client behavior，而当前 Pi/LuckyToken target 无法忠实表达，则 conversion 失败。

当前包括：

```text
tool_choice
→ UnsupportedFeature

output_config.format
→ UnsupportedFeature

stop_sequences
→ UnsupportedFeature
```

原因不是 converter “不认识这些字段”，而是忽略它们会执行与客户端明确要求不同的 request。

同样，已知无法形成 Pi primary semantic representation 的：

```text
URL image
document
search_result
known server-tool semantics
final assistant prefill
```

也进入：

```text
UnsupportedFeature
```

---

## 8. Invalid Required Source Information

如果 conversion 正在读取某项 source information 来构造 Pi target，而该信息本身不足以形成 target，则：

```text
→ InvalidRequest
```

典型情况：

```text
model cannot form selector

text block lacks usable text value

tool_use lacks required id or name

tool_use.input cannot form required arguments object

tool_result cannot correlate to tool identity

conflicting tool-use identity
```

Conversion 只要求它实际使用的信息足以构造 target。

---

## 9. Final Request Conversion

最终输出：

```text
Anthropic Request
        ↓

selector
│
└── request.model

Context
├── systemPrompt
│    └── request.system
│
├── messages
│    └── request.messages
│
└── tools
     └── request.tools

SimpleStreamOptions
├── maxTokens
│    └── request.max_tokens
│
├── temperature
│    └── request.temperature
│
├── reasoning
│    └── request.output_config.effort
│
└── metadata.user_id
     └── request.metadata.user_id

AnthropicRenderState
├── clientModel
│    └── selector
│
└── stream
     └── request.stream ?? false
```

Conceptually：

```ts
return {
  selector,

  context: {
    ...(systemPrompt === undefined
      ? {}
      : { systemPrompt }),

    messages,

    ...(tools === undefined
      ? {}
      : { tools }),
  },

  options: {
    ...(maxTokens === undefined
      ? {}
      : { maxTokens }),

    ...(temperature === undefined
      ? {}
      : { temperature }),

    ...(reasoning === undefined
      ? {}
      : { reasoning }),

    ...(metadata === undefined
      ? {}
      : { metadata }),
  },

  renderState: {
    clientModel: selector,
    stream: request.stream ?? false,
  },
};
```

---

## 10. Request Conversion Summary

Request conversion follows the target hierarchy directly：

```text
Pi / LuckyToken Target
│
├── selector
│     ← request.model
│
├── Context
│   ├── systemPrompt
│   │     ← request.system
│   │
│   ├── messages[]
│   │     ← request.messages[]
│   │
│   └── tools[]
│         ← request.tools[]
│
├── SimpleStreamOptions
│   ├── maxTokens
│   │     ← request.max_tokens
│   │
│   ├── temperature
│   │     ← request.temperature
│   │
│   ├── reasoning
│   │     ← request.output_config.effort
│   │
│   └── metadata.user_id
│         ← request.metadata.user_id
│
└── AnthropicRenderState
    ├── clientModel
    │     ← selector
    │
    └── stream
          ← request.stream ?? false
```

For each target semantic：

```text
needed source exists
        ↓
convert it

needed source is absent
        ↓
use target-defined default

supplied source semantic
cannot be faithfully represented
        ↓
fail
```

The governing request rule is:

> **Construct the Pi/LuckyToken target from the Anthropic Request. Read only the source information required for that construction. Use target-defined defaults when source information is absent, and fail when supplied semantics required by the request cannot be faithfully represented.**

# Part III — Pi AI IR → Anthropic Response

## 1. Response Conversion Boundary

Response conversion 接收一个已经成功完成并提交的 Pi：

```text
AssistantMessage
```

以及 request conversion 保留下来的：

```text
AnthropicRenderState
```

Conceptually：

```ts
interface AnthropicRenderState {
  clientModel: string;
  stream: boolean;
}
```

Part III 的输入不是：

```text
AssistantMessageEventStream
```

也不是：

```text
provider-native stream events
```

而是：

```text
committed AssistantMessage
```

因此以下 lifecycle：

```text
Pi stream consumption
terminal validation
abort handling
execution failure
deferred execution
semantic commit
```

均属于 execution/runtime contract，不属于本 Conversion Method。

Response conversion 的整体信息流是：

```text
committed Pi AssistantMessage
        +
AnthropicRenderState
        ↓
construct one Anthropic Message
        ↓
        M
       / \
      /   \
   JSON   Atomic SSE
```

JSON 和 SSE 不执行两套独立 semantic conversion。

唯一 authoritative Anthropic response semantic representation 是：

```text
Anthropic Message
```

---

## 2. Response Conversion Principles

### 2.1. Target-Driven Projection

Response conversion 以 Anthropic output contract 为 target authority。

Pi `AssistantMessage` 包含的 source information 多于 Anthropic response 所需要的信息。

因此：

```text
Pi source information
        │
        ├── has defined Anthropic target
        │       → convert
        │
        ├── internal / provenance /
        │   unconsumed information
        │       → ignore
        │
        └── required client-visible semantic
            cannot form truthful target
                → OutboundResponseFidelityFailure
```

Response conversion 不试图暴露 Pi 的完整 runtime state。

---

### 2.2. Source Projection Is Tolerant

Pi source object 中未被 conversion 消费的额外信息：

```text
→ ignore
```

例如未来新增一个与 Anthropic response 无关的 optional Pi field，不应仅因为 converter 不认识它而导致失败。

因此：

```text
unknown extra Pi field
≠
response conversion failure
```

---

### 2.3. Target Construction Is Strict

LuckyToken 自己构造的 Anthropic target 必须符合目标协议。

因此：

```text
Pi source
→ tolerant projection

Anthropic target
→ strict construction
```

不能通过：

```text
guessing
placeholder insertion
silent coercion
field omission
semantic repair
```

制造一个表面合法但语义错误的 Anthropic response。

---

### 2.4. No Semantic Reconstruction from Provenance

Response conversion 不使用：

```text
provider
api
responseModel
responseId
rawStopReason
endTurn
diagnostics
```

反推已经在 Pi normalization 中丢失的 provider-specific semantic。

特别地：

```text
Pi normalized state
```

是 Part III 的 source authority。

Part III 不尝试恢复原始 provider wire response。

---

## 3. Anthropic Message Construction

Successful non-streaming Anthropic response 的 target hierarchy 为：

```text
Message
│
├── Identity
│   ├── id
│   ├── type
│   ├── role
│   └── model
│
├── Runtime
│   └── container
│
├── Content
│   └── content[]
│
├── Termination
│   ├── stop_reason
│   ├── stop_sequence
│   └── stop_details
│
└── Usage
    └── usage
```

Response conversion 先完整构造该 `Message`，之后才决定 JSON 或 SSE rendering。

---

## 3.1. Message Identity and Envelope

### 3.1.1. `id`

LuckyToken 为每个成功 Anthropic response 生成一个新的 opaque message ID：

```text
generatedMessageId
→ Message.id
```

Pi：

```text
responseId
```

不自动成为 Anthropic：

```text
Message.id
```

因为 Pi `responseId` 属于 upstream/provider provenance，而 Anthropic response ID 属于当前 LuckyToken client protocol response。

一个成功 response 只生成一次 message ID。

JSON 与 Atomic SSE 必须共享同一个 ID。

---

### 3.1.2. `type`

```text
Message.type
→ "message"
```

---

### 3.1.3. `role`

```text
Message.role
→ "assistant"
```

---

### 3.1.4. `model`

Anthropic：

```text
Message.model
```

使用 request conversion 保存的：

```text
renderState.clientModel
```

即：

```text
original request.model selector
```

Mapping：

```text
renderState.clientModel
→ Message.model
```

不得替换为：

```text
AssistantMessage.model
AssistantMessage.responseModel
AssistantMessage.provider
AssistantMessage.api
```

这些字段属于 Pi runtime/provider identity，不属于当前 Anthropic client-visible model identity。

---

### 3.1.5. `container`

当前 generic Pi committed response 不提供可转换的 Anthropic container state。

因此：

```text
Message.container
→ null
```

这是 target required-shape projection。

---

## 4. Content Projection

Pi source：

```text
AssistantMessage.content[]
├── TextContent
├── ThinkingContent
└── ToolCall
```

转换为 Anthropic：

```text
Message.content[]
```

Conversion 遍历 Pi content，并对每个 block 应用对应 mapping。

被明确丢弃的 block 不进入 target content。

Surviving blocks：

```text
preserve relative order
```

但 target index 根据转换后的 Anthropic content 重新连续编号。

例如：

```text
Pi content
0 Text
1 Redacted Thinking
2 ToolCall
```

转换为：

```text
Anthropic content
0 TextBlock
1 ToolUseBlock
```

不得保留 source index gap。

---

## 4.1. TextContent → TextBlock

Pi：

```ts
{
  type: "text",
  text: sourceText,
  textSignature?: ...
}
```

转换为：

```ts
{
  type: "text",
  text: sourceText,
  citations: null,
}
```

Mapping：

```text
TextContent.text
→ TextBlock.text

TextBlock.type
→ "text"

TextBlock.citations
→ null
```

Pi：

```text
textSignature
```

没有当前 Anthropic target mapping：

```text
→ ignore
```

Text value 不执行：

```text
trim
newline normalization
semantic rewriting
```

---

## 4.2. Ordinary ThinkingContent → ThinkingBlock

当：

```text
ThinkingContent.redacted !== true
```

时，转换为普通 Anthropic `ThinkingBlock`。

Pi：

```ts
{
  type: "thinking",
  thinking: sourceThinking,
  thinkingSignature?: sourceSignature,
}
```

转换为：

```ts
{
  type: "thinking",
  thinking: sourceThinking,
  signature: sourceSignature ?? "",
}
```

Mapping：

```text
thinking
→ thinking

thinkingSignature present
→ signature exact

thinkingSignature absent
→ signature = ""
```

冻结：

```text
missing Pi thinkingSignature
does not convert thinking to text
```

也不删除 thinking block。

---

## 4.3. Redacted ThinkingContent

当：

```text
ThinkingContent.redacted === true
```

当前 LuckyToken response contract 明确：

```text
→ discard
```

不输出：

```text
redacted_thinking
```

也不转换为：

```text
text
ordinary thinking
placeholder
```

例如：

```text
Pi:
[
  Text("A"),
  RedactedThinking(...),
  Text("B")
]
```

转换为：

```text
Anthropic:
[
  Text("A"),
  Text("B")
]
```

redacted block 的 information lifetime 在该 projection point 结束。

---

## 4.4. ToolCall → ToolUseBlock

Pi：

```ts
{
  type: "toolCall",
  id: sourceId,
  name: sourceName,
  arguments: sourceArguments,
  thoughtSignature?: ...,
  namespace?: ...,
}
```

转换为：

```ts
{
  type: "tool_use",
  id: sourceId,
  name: sourceName,
  input: convertedArguments,
  caller: {
    type: "direct",
  },
}
```

Mapping：

```text
ToolCall.id
→ ToolUseBlock.id

ToolCall.name
→ ToolUseBlock.name

ToolCall.arguments
→ ToolUseBlock.input

ToolUseBlock.type
→ "tool_use"

ToolUseBlock.caller
→ { type: "direct" }
```

Pi：

```text
thoughtSignature
namespace
```

没有当前 Anthropic direct client-tool response mapping：

```text
→ ignore
```

---

## 4.5. ToolCall Arguments Contract

Anthropic：

```text
tool_use.input
```

必须是一个 JSON object。

因此：

```text
Pi ToolCall.arguments
        ↓
must losslessly represent
a JSON object tree
        ↓
Anthropic ToolUseBlock.input
```

Root 必须是：

```text
non-null JSON object
```

Nested JSON values 可以为：

```text
null
string
boolean
finite number
array of JSON values
JSON object
```

如果 runtime value 不能忠实表示为 Anthropic JSON object：

```text
→ OutboundResponseFidelityFailure
```

典型 failure 包括：

```text
non-object root
undefined
function
symbol
BigInt
NaN
Infinity
-Infinity
cyclic structure
```

Conversion 不允许：

```text
repair malformed arguments
replace with {}
drop unsupported properties
stringify-and-hope
coerce to another semantic value
```

Part III 也不重新使用 request-side：

```text
Tool.input_schema
```

验证 model-generated arguments。

Response conversion 只判断：

> Can this completed Pi `ToolCall.arguments` be faithfully represented as Anthropic `tool_use.input`?

---

## 4.6. Empty Projected Content

所有 content mappings 完成后：

```text
Anthropic Message.content.length
```

必须大于零。

如果：

```text
content.length === 0
```

则：

```text
→ OutboundResponseFidelityFailure
```

例如：

```text
Pi content
=
[
  RedactedThinking(...)
]
```

在 redacted thinking 被丢弃后：

```text
Anthropic content
=
[]
```

该 response 不能作为成功 Anthropic `Message` 返回。

LuckyToken 不通过以下方式补位：

```text
empty TextBlock
placeholder text
"[Reasoning redacted]"
synthetic tool block
```

---

## 5. Usage Projection

Pi：

```text
Usage
│
├── input
├── output
├── cacheRead
├── cacheWrite
├── cacheWrite1h?
├── reasoning?
├── totalTokens
└── cost
```

转换为 Anthropic final：

```text
Usage
│
├── cache_creation
├── cache_creation_input_tokens
├── cache_read_input_tokens
├── input_tokens
├── output_tokens
├── output_tokens_details
├── server_tool_use
├── inference_geo
└── service_tier
```

---

## 5.1. Direct Token Mapping

```text
Pi usage.input
→ Anthropic input_tokens

Pi usage.output
→ Anthropic output_tokens

Pi usage.cacheRead
→ Anthropic cache_read_input_tokens

Pi usage.cacheWrite
→ Anthropic cache_creation_input_tokens
```

Pi Usage 已经是 normalized numeric state。

因此 numeric：

```text
0
```

保持：

```text
0
```

而不是重新解释为：

```text
null
```

例如：

```text
cacheRead = 0
→ cache_read_input_tokens = 0
```

---

## 5.2. Reasoning Token Breakdown

Pi：

```text
usage.reasoning?
```

表示 output token 中的 reasoning/thinking-token subset。

Mapping 以 presence 为准。

如果：

```text
reasoning === undefined
```

则：

```text
output_tokens_details = null
```

如果：

```text
reasoning !== undefined
```

则：

```ts
output_tokens_details = {
  thinking_tokens: reasoning,
};
```

因此：

```text
reasoning = 0
```

仍然转换为：

```json
{
  "thinking_tokens": 0
}
```

而不是 `null`。

Invariant：

```text
0 <= reasoning <= output
```

如果不满足：

```text
→ OutboundResponseFidelityFailure
```

`reasoning` 已经包含在 authoritative：

```text
output
```

之内。

不得：

```text
output_tokens =
output + reasoning
```

---

## 5.3. Cache-Creation Breakdown

Pi：

```text
usage.cacheWrite1h?
```

表示：

```text
subset of cacheWrite
```

如果：

```text
cacheWrite1h === undefined
```

则：

```text
cache_creation = null
```

如果 present：

```ts
cache_creation = {
  ephemeral_1h_input_tokens:
    cacheWrite1h,

  ephemeral_5m_input_tokens:
    cacheWrite - cacheWrite1h,
};
```

因此：

```text
cacheWrite1h = 0
```

仍然是明确 present 的 breakdown：

```text
ephemeral_1h_input_tokens = 0
ephemeral_5m_input_tokens = cacheWrite
```

Invariant：

```text
0 <= cacheWrite1h <= cacheWrite
```

否则：

```text
→ OutboundResponseFidelityFailure
```

---

## 5.4. Unavailable Anthropic Usage Fields

当前 generic Pi Usage 没有 corresponding target information：

```text
server_tool_use
inference_geo
service_tier
```

因此：

```text
server_tool_use
→ null

inference_geo
→ null

service_tier
→ null
```

Pi：

```text
totalTokens
cost
```

当前没有 Anthropic response mapping：

```text
→ ignore
```

Conversion 不把内部 accounting 写入 model-visible or protocol-visible metadata。

---

## 6. Termination Projection

Part III 只接收：

```text
successfully committed AssistantMessage
```

其 successful termination invariant 为：

```text
stopReason
∈
{
  "stop",
  "length",
  "toolUse"
}
```

Mapping：

```text
Pi "stop"
→ Anthropic "end_turn"

Pi "length"
→ Anthropic "max_tokens"

Pi "toolUse"
→ Anthropic "tool_use"
```

对于当前所有三个 mapped termination：

```text
stop_sequence = null
stop_details = null
```

---

## 6.1. Other Pi Stop Reasons

Pi `StopReason` 还包括：

```text
pending
error
aborted
deferred
```

它们不是 Part III successful-response input。

Responsibility：

```text
pending
→ incomplete / malformed execution

error
→ execution failure

aborted
→ cancellation / abort

deferred
→ unsupported execution outcome
```

这些状态必须在 successful response conversion 之前处理。

因此：

```text
pending
error
aborted
deferred
```

不得被映射为任何 Anthropic successful：

```text
stop_reason
```

特别禁止：

```text
error
→ refusal

aborted
→ end_turn

deferred
→ pause_turn

pending
→ null successful response
```

如果异常情况下这些状态突破 execution boundary 进入 Part III：

```text
→ OutboundResponseFidelityFailure
```

---

## 6.2. No Recovery from `rawStopReason`

Response conversion 不根据：

```text
rawStopReason
```

恢复：

```text
stop_sequence
pause_turn
refusal
model_context_window_exceeded
future provider stop reasons
```

因为 generic Pi normalization 可能已经把多个 provider states 合并为同一个 Pi stop state。

例如：

```text
provider-specific termination
        ↓
Pi normalization
        ↓
stop
```

Part III 的 source authority 是：

```text
Pi stopReason
```

不是 original provider termination metadata。

---

## 6.3. ToolCall / Termination Consistency

Committed response 必须保持：

```text
contains ToolCall
⇔
stopReason = "toolUse"
```

因此：

```text
stopReason = "toolUse"
+
no surviving ToolCall

→ OutboundResponseFidelityFailure
```

以及：

```text
one or more surviving ToolCalls
+
stopReason = "stop" or "length"

→ OutboundResponseFidelityFailure
```

Conversion 不猜：

```text
content
```

或：

```text
stopReason
```

哪一个更权威。

它们必须共同构成 consistent target state。

---

## 7. Complete Anthropic Message

Conceptually：

```ts
function convertAssistantMessageToAnthropic(
  message: AssistantMessage,
  renderState: AnthropicRenderState,
  generatedMessageId: string,
): AnthropicMessage {
  const content =
    convertContent(message.content);

  if (content.length === 0) {
    throw new OutboundResponseFidelityFailure(
      "Projected Anthropic content is empty",
    );
  }

  assertToolTerminationConsistency(
    content,
    message.stopReason,
  );

  return {
    id:
      generatedMessageId,

    container:
      null,

    content,

    model:
      renderState.clientModel,

    role:
      "assistant",

    stop_details:
      null,

    stop_reason:
      convertStopReason(
        message.stopReason,
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

该 `AnthropicMessage` 是当前 response conversion 的唯一 authoritative semantic representation。

---

## 8. Response Rendering Selection

Request conversion 保存：

```text
renderState.stream
```

Part III 使用它选择 wire representation。

```text
stream = false
→ JSON

stream = true
→ Atomic SSE
```

`stream` 只选择 rendering mode。

它不改变已经构造完成的 Anthropic Message semantic。

---

## 9. Non-Streaming JSON Rendering

当：

```text
renderState.stream = false
```

执行：

```text
Anthropic Message M
        ↓
target validation
        ↓
JSON serialization
        ↓
HTTP JSON response
```

JSON renderer 不重新访问：

```text
Pi AssistantMessage
```

也不重新执行 content / usage / termination mapping。

Conceptually：

```ts
renderAnthropicJsonSuccess(M);
```

---

## 10. Atomic SSE Rendering

当：

```text
renderState.stream = true
```

LuckyToken 不转发原始 Pi/provider stream。

而是从已经构造完成的：

```text
Anthropic Message M
```

生成一个合法的 Anthropic SSE lifecycle：

```text
message_start
        ↓
ContentBlock[index]*
│
├── content_block_start
├── content_block_delta*
└── content_block_stop
        ↓
message_delta
        ↓
message_stop
```

该模式称为：

```text
Atomic SSE
```

Atomic SSE：

```text
does not reproduce provider chunk timing
does not reproduce provider chunk boundaries
does not expose incomplete Pi tool state
```

它只负责：

> Serialize the already committed Anthropic Message through a legal Anthropic streaming lifecycle.

---

## 10.1. `message_start`

`message_start` 携带一个 incomplete partial Message。

它与最终 Message 使用相同：

```text
id
model
role
type
```

Initial message-level state：

```text
content = []

container = null

stop_reason = null
stop_sequence = null
stop_details = null
```

---

## 10.2. Initial Streaming Usage

`message_start.message.usage` 使用 initial snapshot，而不是最终完整 generation state。

从 final Pi Usage 构造：

```text
input_tokens
→ final input

cache_read_input_tokens
→ final cacheRead

cache_creation_input_tokens
→ final cacheWrite

cache_creation
→ final cache breakdown

output_tokens
→ 0

output_tokens_details
→ null

server_tool_use
→ null

inference_geo
→ null

service_tier
→ null
```

该 snapshot 表示：

```text
request/input accounting known at stream start
+
no generated output exposed yet
```

---

## 11. Atomic Content Block Lifecycles

每一个最终：

```text
Message.content[index]
```

产生一个对应 SSE block lifecycle。

SSE：

```text
content_block.index
=
final Anthropic Message.content[index]
```

由于 redacted Pi thinking 已在 Message construction 阶段丢弃，因此 SSE index 使用转换后的 dense target indexing。

---

## 11.1. TextBlock Lifecycle

对于最终：

```ts
{
  type: "text",
  text: finalText,
  citations: null,
}
```

生成：

```text
content_block_start
        ↓
text_delta
        ↓
content_block_stop
```

Start block：

```ts
{
  type: "text",
  text: "",
  citations: null,
}
```

Delta：

```text
text_delta.text
=
full finalText
```

一个完整 final string 可以作为一个 atomic incremental delta。

无需重新切分 provider chunk。

---

## 11.2. ThinkingBlock Lifecycle

对于最终：

```ts
{
  type: "thinking",
  thinking: finalThinking,
  signature: finalSignature,
}
```

生成：

```text
content_block_start
        ↓
thinking_delta
        ↓
signature_delta
        ↓
content_block_stop
```

Start：

```ts
{
  type: "thinking",
  thinking: "",
  signature: "",
}
```

Thinking delta：

```text
thinking_delta.thinking
=
full finalThinking
```

Signature delta：

```text
signature_delta.signature
=
full finalSignature
```

如果 Pi source 没有 signature：

```text
finalSignature = ""
```

Atomic SSE 仍然使用 target representation 中的 empty signature。

---

## 11.3. Redacted Thinking

Redacted Pi thinking 在构造 Anthropic Message 时已经：

```text
discarded
```

因此 Atomic SSE：

```text
does not generate
redacted_thinking lifecycle
```

不存在第二次 redacted-thinking decision。

---

## 11.4. ToolUseBlock Lifecycle

对于最终：

```ts
{
  type: "tool_use",
  id,
  name,
  input,
  caller: {
    type: "direct",
  },
}
```

生成：

```text
content_block_start
        ↓
input_json_delta
        ↓
content_block_stop
```

Start block：

```text
same id
same name
same caller

input = {}
```

Delta：

```text
input_json_delta.partial_json
=
JSON.stringify(final input)
```

一个完整 serialized JSON object 可以作为一个 atomic partial-json delta。

Conversion 不：

```text
reconstruct original provider fragments
stream incomplete Pi arguments
emit partial ToolCall before target input is complete
```

---

## 12. `message_delta`

完成所有 content block lifecycles 后，Atomic SSE 发送：

```text
message_delta
```

用于更新最终 message-level termination state 与 cumulative streaming usage。

---

## 12.1. Termination Delta

```text
delta.container
→ null

delta.stop_details
→ final Message.stop_details

delta.stop_reason
→ final Message.stop_reason

delta.stop_sequence
→ final Message.stop_sequence
```

当前因此为：

```text
container
→ null

stop_details
→ null

stop_sequence
→ null

stop_reason
→ end_turn | max_tokens | tool_use
```

---

## 12.2. Final Cumulative Streaming Usage

`message_delta.usage` 使用 Anthropic streaming-specific usage shape。

Mapping：

```text
input_tokens
→ final input

cache_read_input_tokens
→ final cacheRead

cache_creation_input_tokens
→ final cacheWrite

output_tokens
→ final output

output_tokens_details
→ final reasoning breakdown

server_tool_use
→ null
```

这些值是 cumulative。

`MessageDeltaUsage` 不包含 final `Usage` 的全部字段。

因此不添加：

```text
cache_creation
inference_geo
service_tier
```

---

## 13. `message_stop`

Atomic SSE 最后发送：

```text
message_stop
```

它是成功 streaming response 的 semantic terminal。

正常 lifecycle：

```text
message_start
        ↓
content block lifecycle*
        ↓
message_delta
        ↓
message_stop
```

LuckyToken 不发送：

```text
data: [DONE]
```

作为 Anthropic success terminal。

---

## 14. JSON / Atomic SSE Semantic Equality

JSON 和 Atomic SSE 必须表达同一个：

```text
Anthropic Message M
```

Invariant：

```text
committed AssistantMessage
        ↓
construct M once
        ↓
        ├── JSON(M)
        └── AtomicSSE(M)
```

Accumulating the Atomic SSE lifecycle must reconstruct the same final semantic Message `M`.

因此 JSON 与 SSE 必须保持：

```text
same message ID

same model

same surviving content

same content order

same text

same thinking

same thinking signatures

same tool-call IDs

same tool names

same tool inputs

same termination

same final usage
```

Transport fragmentation 不属于 semantic equality requirement。

---

## 15. Ignored Pi State

当前以下 Pi fields 没有 Anthropic response mapping，且不影响 target construction：

```text
AssistantMessage.api
AssistantMessage.provider
AssistantMessage.model
AssistantMessage.responseModel
AssistantMessage.responseId
AssistantMessage.diagnostics
AssistantMessage.timestamp
AssistantMessage.rawStopReason
AssistantMessage.endTurn

TextContent.textSignature

ToolCall.thoughtSignature
ToolCall.namespace

Usage.totalTokens
Usage.cost
```

这些信息：

```text
→ ignore
```

不得复制到：

```text
Anthropic content
Anthropic metadata
tool input
response model
debug text
```

Part III 不创建额外 transport metadata 保存它们。

---

## 16. Response Conversion Failure

Part III 不使用 request-side：

```text
InvalidRequest
UnsupportedFeature
```

因为 response conversion 开始时：

```text
request has already executed
+
Pi result has already committed
```

如果 committed Pi result 无法构造 truthful Anthropic response：

```text
→ OutboundResponseFidelityFailure
```

典型 cases：

```text
projected Anthropic content is empty

ToolCall.arguments cannot form
a faithful JSON object

invalid reasoning/output relationship

invalid cacheWrite1h/cacheWrite relationship

ToolCall / stopReason inconsistency

unexpected Pi stopReason reaches Part III

constructed Anthropic target
violates required target contract

JSON/SSE target serialization
cannot preserve Message semantics
```

Conversion 不通过 semantic guessing 将这些状态变成成功 response。

---

## 17. Response Conversion Summary

完整 response semantic flow：

```text
committed Pi AssistantMessage
        │
        ├── content
        │   │
        │   ├── TextContent
        │   │      → TextBlock
        │   │
        │   ├── ordinary ThinkingContent
        │   │      → ThinkingBlock
        │   │
        │   ├── redacted ThinkingContent
        │   │      → discard
        │   │
        │   └── ToolCall
        │          → ToolUseBlock
        │
        ├── usage
        │      → Anthropic Usage
        │
        └── stopReason
               │
               ├── stop
               │     → end_turn
               │
               ├── length
               │     → max_tokens
               │
               └── toolUse
                     → tool_use
        │
        ▼
Anthropic Message M
        │
        ├── stream = false
        │      → JSON(M)
        │
        └── stream = true
               → Atomic SSE(M)
```

The governing response rule is:

> **Construct one truthful Anthropic Message from the committed Pi AssistantMessage, discard only explicitly irrelevant Pi state, fail rather than invent missing target semantics, and render JSON or Atomic SSE from that same Message.**
