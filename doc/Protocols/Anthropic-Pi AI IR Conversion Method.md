# Part I — Anthropic Request → Pi AI IR Conversion Method

## 1. Purpose and Boundary

本 Part 定义 LuckyToken 将：

```text
Anthropic Request
```

转换为：

```text
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

时使用的 request conversion method。

整体方向：

```text
Anthropic Request
        ↓
semantic conversion
        ↓
Pi / LuckyToken invocation state
```

本 Part 只定义 request-side conversion method。

具体 Anthropic fields 和 content blocks 的 conversion rules 在 Part II 定义。

本 Part 不负责：

```text
authentication
credential acquisition
model catalog management
model execution
provider-native request construction
HTTP transport
retry
stream consumption
cancellation
response conversion
response rendering
```

这些属于其他 protocol、conversion 或 runtime contracts。

------

## 2. Source and Target

### 2.1 Source

Request conversion 的 Source 是：

```text
Anthropic Request
```

Conversion 按 Anthropic Request 的自然 semantic hierarchy 处理 Source：

```text
Anthropic Request
├── top-level fields
├── messages[]
│   └── content[]
└── tools[]
```

Source 的：

```text
ordering
containment
identity
correlation
```

本身都可能属于 request semantic。

因此 conversion 不首先把 Anthropic Request flatten 成另一份 normalized or shadow representation。

------

### 2.2 Target

Request conversion 构造的 Target 是：

```text
Pi / LuckyToken Invocation State
├── selector
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   └── tools?
│
├── SimpleStreamOptions
└── AnthropicRenderState
```

这些是 conversion 完成后继续进入 model resolution、Pi execution 和 later Anthropic response rendering 的 authoritative state。

Conversion 不构造第二份 Anthropic-shaped intermediate representation。

------

## 3. Source → Target → Construction

Request conversion 的基本表达顺序为：

```text
Source
↓
Target
↓
Construction
```

对于一个 Anthropic Source semantic：

```text
Source semantic
│
├── Pi / LuckyToken 有 faithful Target representation
│   ↓
│   construct Target
│
├── Source semantic 有效且有意义
│   但当前 Target 没有 faithful representation
│   且丢弃它会改变 request meaning
│   ↓
│   UnsupportedFeature
│
└── information 不参与当前 Pi / LuckyToken
    invocation semantic
    ↓
    does not enter conversion state
```

因此：

> Anthropic Request 中只有能够形成当前 Pi / LuckyToken Target semantic 的信息才被转换进入 Target。

Pi AI IR 不因为 Anthropic Source 存在额外 semantic 而扩张。

如果当前 Pi / LuckyToken Target 无法忠实表达某项 client-required Anthropic semantic，conversion 不通过近似 mapping、silent degradation 或 invented representation 将其强行塞入 Target。

------

### 3.1 Exact Source and Target

Part II 中每个 concrete conversion rule 必须明确：

```text
Source
→ exact Anthropic semantic location

Target
→ exact Pi / LuckyToken semantic location

Construction
→ exact value / structure construction
```

例如结构上应能够回答：

```text
Source field 是什么？
Target field 是什么？
Target value 如何由 Source 构造？
```

不能只用：

```text
Anthropic concept
→ Pi concept
```

代替 field-level conversion contract。

------

### 3.2 Preserve Source Hierarchy

Conversion 按 Source hierarchy读取：

```text
Request
└── Messages
    └── Content
```

并保持 Source 中有意义的：

```text
message order
content order
tool identity
tool result correlation
```

除非 Target representation 本身要求结构转换。

如果 Source hierarchy 与 Target hierarchy 不同，例如一个 Source structure需要产生多个 Target messages，则 Part II 必须显式定义该 construction。

Conversion 不通过：

```text
unnecessary reordering
message merging
text trimming
newline normalization
tool identity rewriting
```

改变 Source semantic，除非对应 Target contract明确要求。

------

## 4. Target Completion

Pi / LuckyToken Target 可能要求 Anthropic Source 本身没有提供的 structural fields。

因此 complete Target 由两部分组成：

```text
Source-derived Target state
        +
Target-required completion
        ↓
complete Pi / LuckyToken Target
```

Target value 的 information source可以是：

```text
Target value
├── Source-derived
├── Target-fixed
├── Request-local
├── Derived
└── Temporary-correlation-derived
```

### Source-derived

Target value 直接来自 Anthropic Source semantic。

### Target-fixed

Target contract 本身要求固定 value，且不需要 Anthropic Source。

### Request-local

Target construction 所需的信息由当前 request conversion invocation 提供，而不是来自 Anthropic protocol semantic。

### Derived

Target value 根据已经读取或已经构造的 semantic state推导。

### Temporary-correlation-derived

Target construction 需要 earlier Source node 提供的信息时，可以通过最小 request-local correlation state 暂时保存该信息。

Target-required completion 不宣称恢复 Anthropic Source 中不存在的事实。

Synthetic or derived Target fields 也不能被反向解释为原 Anthropic/provider provenance。

------

## 5. Information Ownership and Lifetime

Information 应尽量只存在于真正需要它的阶段。

```text
Anthropic Request
└── owns Source protocol representation

Request conversion
├── reads Source semantics required for construction
├── constructs Pi / LuckyToken Target
└── may own minimal request-local temporary state

Conversion result
├── selector
├── Context
├── SimpleStreamOptions
└── AnthropicRenderState
```

Temporary state 只在 Target construction 确实需要跨 Source node correlation 时存在。

它必须：

```text
solve one demonstrated construction need
use the smallest sufficient representation
remain request-local
disappear after request conversion
```

Conversion 不建立额外的：

```text
normalized Anthropic request
source shadow model
generic conversion registry
feature registry
parallel semantic IR
```

除非未来存在已经证明的必要性。

------

## 6. Failure Semantics

Request semantic conversion 使用两个核心 failure categories：

### InvalidRequest

当一个 Source semantic 理论上可以构造 Target，但 conversion 所需要的 Source information：

```text
malformed
incomplete
or internally contradictory
```

导致 required Target 无法构造时：

```text
→ InvalidRequest
```

Conversion 不猜测缺失的 identity、arguments 或 correlation information。

------

### UnsupportedFeature

当：

```text
Anthropic Source semantic
```

本身有效且有意义，但当前：

```text
Pi / LuckyToken Target
```

没有 faithful representation，并且不保留该 semantic 会改变 client request meaning 时：

```text
→ UnsupportedFeature
```

Conversion 不通过：

```text
silent dropping
approximate mapping
semantic coercion
invented Pi fields
```

把 unsupported Source semantic转换成不同 request。

具体哪些 Anthropic semantics 属于这一类别，由 Part II 在对应 Source hierarchy中定义。

------

## 7. Request Conversion Invariants

整个 Anthropic Request → Pi AI IR conversion 保持：

```text
1. Conversion follows the Anthropic Source hierarchy.

2. Every Source semantic that enters Target
   has an explicit Source → Target → Construction rule.

3. Pi / LuckyToken Target is not expanded merely
   to mirror Anthropic-specific protocol features.

4. A meaningful supplied Anthropic semantic
   is not silently contradicted.

5. Source ordering, containment, identity,
   and correlation are preserved unless
   Target representation requires transformation.

6. Target-required fields that do not come from
   Anthropic Source are identified explicitly
   as fixed, request-local, derived,
   synthetic, or correlation-derived state.

7. Temporary state is minimal,
   request-local, and short-lived.

8. Malformed information required for a supported
   conversion produces InvalidRequest.

9. Valid client-required semantics without a faithful
   Pi / LuckyToken representation produce
   UnsupportedFeature.

10. Conversion completes with one authoritative:

    selector
    +
    Context
    +
    SimpleStreamOptions
    +
    AnthropicRenderState
```

The governing request structure is:

```text
Anthropic Source
↓
identify supplied semantic
↓
find faithful Pi / LuckyToken Target
↓
construct Target
        +
complete Target-required structure
↓
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

# Part II — Anthropic Request → Pi AI IR

## 1. Conversion Boundary

本 Part 将：

```text
Anthropic Request
```

转换为：

```text
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

整体 information flow：

```text
Anthropic Request
        ↓
Source-driven semantic conversion
        ↓
Pi / LuckyToken invocation state
```

本 Part 按：

```text
Source
↓
Target
↓
Construction
```

描述具体 conversion rule。

------

### 1.1 Source

Request conversion 的 Source root 是：

```text
Anthropic Request
```

后续章节按照 Anthropic Source 的自然 hierarchy 组织。

当前 Conversion Method 涉及的主要 Source branches 为：

```text
Anthropic Request
├── model
│
├── system?
│
├── messages[]
│   ├── user
│   │   └── content
│   │
│   └── assistant
│       └── content
│
├── tools?
│
├── max_tokens
├── temperature?
│
├── output_config?
│   ├── effort?
│   └── format?
│
├── metadata?
│
├── stream?
│
├── tool_choice?
└── stop_sequences?
```

这棵树描述的是：

```text
本 Method 当前需要讨论的
Anthropic Source semantic hierarchy
```

不是完整 Anthropic protocol grammar inventory。

Conversion 不因为 Anthropic protocol 存在其他与当前 Pi / LuckyToken invocation semantic 无关的信息，就建立：

```text
source field registry
ignored-field registry
normalized Anthropic request
shadow source model
```

------

### 1.2 Target

Conversion 最终构造：

```text
Pi / LuckyToken Invocation State
│
├── selector
│
├── Context
│   ├── systemPrompt?
│   ├── messages[]
│   └── tools?
│
├── SimpleStreamOptions
│
└── AnthropicRenderState
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

这些 Target structures 的字段可能来自：

```text
Anthropic Source
```

也可能是完成 Pi / LuckyToken Target contract 所需要的：

```text
fixed value
request-local value
derived value
synthetic value
temporary-correlation-derived value
```

具体 ownership 在对应 Source conversion section 中说明。

------

### 1.3 Construction Direction

Part II 不从 Target fields 反向枚举 Anthropic Request。

它按照 Anthropic Source hierarchy处理 client 已提供的 semantic：

```text
Anthropic Source semantic
│
├── Pi / LuckyToken 有 faithful representation
│   ↓
│   construct corresponding Target
│
├── valid meaningful semantic
│   but no faithful Pi / LuckyToken representation
│   and dropping it changes request meaning
│   ↓
│   UnsupportedFeature
│
└── information does not participate
    in current Pi / LuckyToken invocation semantic
    ↓
    does not enter conversion state
```

Pi AI IR 不因为 Anthropic protocol 存在额外 feature 而增加 provider-specific parallel representation。

------

### 1.4 Local Conversion Structure

后续每个 concrete Source semantic 使用相同结构描述：

```text
Source
↓
Target
↓
Construction
```

#### Source

明确 Anthropic field 或 structure 的 exact semantic location。

例如：

```text
request.messages[i]
└── content[j]
    └── ...
```

#### Target

明确该 Source semantic 构造的 Pi / LuckyToken location。

例如：

```text
Context.messages[k]
└── ...
```

#### Construction

明确 Target value 或 structure 如何由 Source 构造。

例如形式上：

```text
Target.field
←
Source.field
```

或者：

```text
Source subtree
↓
structural transformation
↓
Target subtree
```

必要时再说明：

```text
Absence
Failure
Temporary State
Target Completion
```

------

### 1.5 Source Hierarchy and Target Hierarchy May Differ

Conversion 保持 Anthropic Source 的自然：

```text
Request
└── messages[]
    └── content[]
```

hierarchy 和 ordering。

但 Source 与 Target 不要求拥有完全相同的结构。

因此可能存在：

```text
one Source field
→ one Target field
```

也可能存在：

```text
one Source subtree
→ one Target structure
```

甚至：

```text
one Source message
→ multiple Pi messages
```

如果 Source hierarchy 与 Target hierarchy 不同，后续章节必须显式定义 transformation。

Conversion 不通过隐式 flattening、reordering 或 regrouping 隐藏这种结构变化。

------

### 1.6 Conversion Result

Part II 完成后只产生一份 authoritative request-conversion result：

```text
Anthropic Request
        ↓
conversion
        ↓
selector
+
Context
+
SimpleStreamOptions
+
AnthropicRenderState
```

其中：

```text
selector
Context
SimpleStreamOptions
```

进入后续 model resolution / Pi invocation。

```text
AnthropicRenderState
```

保存后续 Anthropic response rendering 所需、但不属于 Pi model invocation semantic 的 request-local state。

Anthropic Request 本身不被复制成第二份 intermediate semantic model。

后续具体 conversion 从：

```text
request.model
```

开始，沿 Anthropic Source hierarchy逐项定义。

## 2. `request.model`

### Source

Anthropic Request：

```text
request.model
```

Source value 表示 client 指定的 model selector。

------

### Target

LuckyToken：

```text
selector
```

Target contract：

```text
selector: string
```

------

### Construction

直接保留 Source value：

```text
selector
← request.model
```

即：

```ts
const selector = request.model;
```

Conversion 不：

```text
split provider / model
normalize model id
rewrite selector
construct Model
choose fallback model
```

完整 `Model` 的查找和解析属于后续 Model Resolution，不属于本 conversion。

如果 `request.model` 无法提供 required selector：

```text
→ InvalidRequest
```

最终：

```text
Anthropic request.model
        ↓
     selector
```

## 3. `request.system`

### Source

Anthropic Request：

```text
request.system?
```

当前 Source representation：

```text
string
|
TextBlock[]
|
absent
```

------

### Target

Pi：

```text
Context.systemPrompt?
```

Target contract：

```text
systemPrompt?: string
```

------

### Construction

#### Source is `string`

```text
request.system: string
        ↓
Context.systemPrompt
```

Construction：

```text
Context.systemPrompt
=
request.system
```

Source string 原样保留。

Conversion 不执行：

```text
trim
rewriting
newline normalization
```

------

#### Source is `TextBlock[]`

Source：

```text
request.system[]
└── TextBlock
    └── text
```

Target：

```text
Context.systemPrompt
```

Construction：

```text
request.system
↓
read block.text in Source order
↓
join with "\n"
↓
Context.systemPrompt
```

即：

```ts
context.systemPrompt =
  request.system
    .map(block => block.text)
    .join("\n");
```

保持 Source block order。

Conversion 不：

```text
reorder blocks
trim block text
merge text by other rules
normalize newlines
```

如果：

```text
request.system = []
```

则：

```text
Context.systemPrompt = ""
```

------

### Absence

如果：

```text
request.system
→ absent
```

则：

```text
Context.systemPrompt
→ absent
```

Conversion 不生成 synthetic system prompt。

最终：

```text
Anthropic request.system
        │
        ├── string
        │   → preserve
        │
        ├── TextBlock[]
        │   → text values
        │   → join("\n")
        │
        └── absent
            → Context.systemPrompt absent
```

## 4. Messages

### 4.1. Message Ordering

```text
request.messages[]
→ Context.messages[]
```

按 Source message order 依次转换。

Conversion 不主动：

```text
merge adjacent messages
reorder messages
move content across message boundaries
delete an otherwise convertible message
```

一个 Anthropic message 可以根据其 role 和 content 构造一个或多个 Pi messages。

如果一个 Source message 构造多个 Pi messages，则保持其 Source content order。

因此：

```text
request.messages[0]
request.messages[1]
request.messages[2]
...
```

构造出的 Pi messages 按对应 Source semantic 的原始顺序追加到：

```text
Context.messages[]
```

具体 `user`、`assistant`、`system` message 及其 content 的 construction rules 在后续章节定义。

### 4.2. User Message

Anthropic：

```text
message.role = "user"
```

普通 user content 转换为 Pi：

```ts
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

其中：

```text
role
→ "user"

timestamp
→ receivedAt
```

`content` 按 Source representation 转换。

#### String

Anthropic：

```text
message.content: string
```

Pi `UserMessage.content` 原生支持 string，因此直接保留：

```text
message.content
→ UserMessage.content
```

即：

```ts
{
  role: "user",
  content: message.content,
  timestamp: receivedAt,
}
```

不需要先构造成单元素 `TextContent[]`。

------

#### Text

Anthropic `TextBlock`：

```text
TextBlock
├── type = "text"
├── text
├── citations?
└── cache_control?
```

转换为 Pi：

```text
TextContent
├── type = "text"
└── text
```

字段转换：

```text
TextBlock.type
→ TextContent.type = "text"

TextBlock.text
→ TextContent.text
```

即：

```ts
{
  type: "text",
  text: block.text,
}
```

Pi `TextContent.textSignature` 没有对应 Anthropic Source，因此不构造。

`citations` 和 `cache_control` 不属于 Pi `TextContent`，不复制进入该 Target content。

------

#### Image

Anthropic `ImageBlock`：

```text
ImageBlock
├── type = "image"
├── source
│   ├── Base64ImageSource
│   │   ├── type = "base64"
│   │   ├── media_type
│   │   └── data
│   │
│   └── URLImageSource
└── cache_control?
```

Pi image representation：

```text
ImageContent
├── type = "image"
├── data
└── mimeType
```

对于：

```text
source.type = "base64"
```

转换：

```text
ImageBlock.type
→ ImageContent.type = "image"

ImageBlock.source.data
→ ImageContent.data

ImageBlock.source.media_type
→ ImageContent.mimeType
```

即：

```ts
{
  type: "image",
  data: block.source.data,
  mimeType: block.source.media_type,
}
```

`cache_control` 不属于 Pi `ImageContent`，不复制进入 Target content。

对于：

```text
source.type = "url"
```

Pi `ImageContent` 没有 URL representation，因此：

```text
→ UnsupportedFeature
```

Message conversion 这里只负责构造 Pi `ImageContent`。Selected model 是否接受 image input 属于后续 model capability / invocation validation，不改变 `ImageBlock → ImageContent` 的结构转换。

------

#### Tool Result

Anthropic `tool_result` 位于：

```text
User Message
└── content[]
    └── ToolResultBlock
```

Source structure：

```text
ToolResultBlock
├── type = "tool_result"
├── tool_use_id
├── content?
├── is_error?
└── cache_control?
```

Pi 不把 tool result 放在 `UserMessage.content` 中。

对应 Target 是顶层：

```text
Context.messages[]
└── ToolResultMessage
    ├── role = "toolResult"
    ├── toolCallId
    ├── toolName
    ├── content
    ├── isError
    └── timestamp
```

字段转换：

```text
type = "tool_result"
→ role = "toolResult"

tool_use_id
→ toolCallId

is_error ?? false
→ isError

receivedAt
→ timestamp
```

`toolName` 不能从当前 `ToolResultBlock` 单独获得，由 §4.5 Tool Identity Correlation 构造：

```text
tool_use.id
+
tool_use.name
+
tool_result.tool_use_id
→ ToolResultMessage.toolName
```

##### Tool Result Content

Pi：

```text
ToolResultMessage.content
→ (TextContent | ImageContent)[]
```

Anthropic `tool_result.content` 可以是：

```text
absent
string
content block array
```

当前 conversion：

```text
content absent
→ []

content string
→ [
     {
       type: "text",
       text: content
     }
   ]
```

这里的：

```text
string
→ TextContent
```

是 Anthropic → Pi 的 conversion rule。

它不宣称 Anthropic Source protocol 自身定义了：

```text
string
≡
[TextBlock]
```

对于 `ToolResultBlock.content[]`，按 Source block order 转换 Pi 能表示的 result content。

Text：

```text
TextBlock.text
→ TextContent.text
```

构造：

```ts
{
  type: "text",
  text: block.text,
}
```

Base64 image：

```text
ImageBlock.source.data
→ ImageContent.data

ImageBlock.source.media_type
→ ImageContent.mimeType
```

构造：

```ts
{
  type: "image",
  data: block.source.data,
  mimeType: block.source.media_type,
}
```

Pi `ToolResultMessage.content` 只支持：

```text
TextContent
ImageContent
```

因此无法形成这两个 Target content types 的 structured tool-result content 不强行转换为其他 Pi representation。

`cache_control` 不进入 `ToolResultMessage`。

------

当一个 Anthropic user message 的 `content[]` 同时包含 ordinary user content 与 `tool_result` 时，保持 Source content order，并按 Target hierarchy 构造 Pi messages。

例如：

```text
Anthropic User Message
└── content[]
    ├── text A
    ├── tool_result X
    └── text B
```

构造：

```text
Context.messages[]
├── UserMessage
│   └── TextContent A
│
├── ToolResultMessage X
│
└── UserMessage
    └── TextContent B
```

相邻的普通 `text` / supported `image` blocks 可以保留在同一个 Pi `UserMessage.content[]` 中。

每个 `tool_result` 构造独立的 Pi `ToolResultMessage`。

整个 construction 保持 Anthropic `content[]` 的 Source order。

### 4.3. Assistant Message

Anthropic：

```text
message.role = "assistant"
```

转换为 Pi：

```text
AssistantMessage
├── role
├── content[]
├── api
├── provider
├── model
├── usage
├── stopReason
└── timestamp
```

`content` 按 Source order 转换。

------

#### Text

Anthropic ordinary assistant text 可以使用：

```text
content: string
```

或者：

```text
TextBlock
├── type = "text"
├── text
├── citations?
└── cache_control?
```

普通 message 中：

```text
string S
≡
[TextBlock { type: "text", text: S }]
```

因此两种 Source representation 都构造 Pi：

```text
TextContent
├── type = "text"
└── text
```

字段转换：

```text
TextBlock.type
→ TextContent.type = "text"

TextBlock.text
→ TextContent.text
```

即：

```ts
{
  type: "text",
  text: block.text,
}
```

如果 Source 使用 string shorthand，则该 string 作为 `TextContent.text`。

`citations` 和 `cache_control` 不属于 Pi `TextContent`，不复制进入 Target。

Pi `TextContent.textSignature` 没有对应 Anthropic Source，因此不构造。

------

#### Thinking

Anthropic：

```text
ThinkingBlock
├── type = "thinking"
├── thinking
└── signature
```

其中：

```text
thinking
```

是可见 reasoning text；

```text
signature
```

是 opaque continuity data，不解析、不生成。

转换为 Pi：

```text
ThinkingContent
├── type = "thinking"
├── thinking
└── thinkingSignature?
```

字段转换：

```text
ThinkingBlock.type
→ ThinkingContent.type = "thinking"

ThinkingBlock.thinking
→ ThinkingContent.thinking

ThinkingBlock.signature
→ ThinkingContent.thinkingSignature
```

即：

```ts
{
  type: "thinking",
  thinking: block.thinking,
  thinkingSignature: block.signature,
}
```

如果 Source 没有 signature：

```text
ThinkingContent.thinkingSignature
→ absent
```

Conversion 不生成 synthetic signature。

Anthropic 允许：

```text
thinking = ""
signature = <opaque>
```

表示 visible thinking omitted。

这种状态仍然构造 `ThinkingContent`，不能因为 `thinking` 为空而丢失 signature。

------

#### Redacted Thinking

Anthropic：

```text
RedactedThinkingBlock
├── type = "redacted_thinking"
└── data
```

`data` 是 opaque redacted-thinking payload。

Pi 已有对应 representation：

```text
ThinkingContent
├── type = "thinking"
├── thinking
├── thinkingSignature
└── redacted
```

转换：

```text
RedactedThinkingBlock.type
→ ThinkingContent.type = "thinking"

RedactedThinkingBlock.data
→ ThinkingContent.thinkingSignature

fixed ""
→ ThinkingContent.thinking

fixed true
→ ThinkingContent.redacted
```

即：

```ts
{
  type: "thinking",
  thinking: "",
  thinkingSignature: block.data,
  redacted: true,
}
```

Conversion 不解析或修改 `data`。

`redacted_thinking` 与：

```text
thinking = ""
+
signature
```

不是同一个 Anthropic semantic，两者保持不同的 Pi state：

```text
ordinary omitted thinking
→ redacted absent

redacted_thinking
→ redacted = true
```

------

#### Tool Use

Anthropic client tool call：

```text
ToolUseBlock
├── type = "tool_use"
├── id
├── name
├── input
└── optional caller / provenance fields
```

转换为 Pi：

```text
ToolCall
├── type = "toolCall"
├── id
├── name
└── arguments
```

字段转换：

```text
ToolUseBlock.type
→ ToolCall.type = "toolCall"

ToolUseBlock.id
→ ToolCall.id

ToolUseBlock.name
→ ToolCall.name

ToolUseBlock.input
→ ToolCall.arguments
```

即：

```ts
{
  type: "toolCall",
  id: block.id,
  name: block.name,
  arguments: block.input,
}
```

`input` 必须能够构造 Pi：

```ts
Record<string, any>
```

否则：

```text
→ InvalidRequest
```

Pi `ToolCall` 的：

```text
thoughtSignature
namespace
```

没有对应 Anthropic client `ToolUseBlock` Source，因此不构造。

Anthropic optional caller / provenance information没有对应 Pi `ToolCall` representation时，不复制进入 `ToolCall`。

每个成功构造的：

```text
ToolUseBlock.id
+
ToolUseBlock.name
```

同时提供给 §4.5 Tool Identity Correlation，用于后续：

```text
tool_result.tool_use_id
→ ToolResultMessage.toolName
```

------

#### Required Pi Fields

Anthropic historical assistant message提供的是：

```text
role
+
content
```

Pi `AssistantMessage` 还要求：

```text
api
provider
model
usage
stopReason
timestamp
```

这些字段不是从 Anthropic historical assistant message 中恢复出来的 provider facts。

当前 construction：

```text
role
→ "assistant"

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

`stopReason` 根据已经构造完成的 Pi content 得到：

```text
content contains ToolCall
→ stopReason = "toolUse"

otherwise
→ stopReason = "stop"
```

因此完整 historical Pi assistant message 为：

```text
AssistantMessage
├── role = "assistant"
├── content
│   ├── TextContent
│   ├── ThinkingContent
│   └── ToolCall
├── api = synthetic client-history API identity
├── provider = synthetic client-history provider identity
├── model = selector
├── usage = zero usage
├── stopReason
└── timestamp = receivedAt
```

这些 required Pi fields只用于形成合法的 historical `AssistantMessage`。

它们不表示 Anthropic Source 曾经提供：

```text
original provider
original API
original usage
original stop reason
original generation timestamp
```

------

#### Final Assistant Prefill

Anthropic 对最终 input message：

```text
request.messages[last]
└── role = "assistant"
```

定义了不同于普通 historical assistant message 的 semantic：

```text
assistant prefill
```

即下一次 generation 从 client 提供的 assistant prefix 继续。

当前 generic Pi invocation没有对应的 prefill request semantic。

因此 source-valid final assistant prefill：

```text
→ UnsupportedFeature
```

Conversion 不把 final assistant prefill 当作普通 historical `AssistantMessage` 后继续 generation，因为这会改变 request meaning。

最终 assistant prefill 的 Anthropic source validity 是独立的 protocol/model-profile 问题；conversion 不通过 model-name guessing 判断其 Source validity。

### 4.4. System Message

Anthropic 支持 model-dependent mid-conversation system messages。

它与 top-level：

```text
request.system
```

不同。

Top-level `request.system` 已由 §3 转换为：

```text
Context.systemPrompt
```

Mid-conversation system message 则位于：

```text
request.messages[]
└── message
    ├── role = "system"
    └── content
```

并保留它在 conversation 中的原始位置。

Pi `Message` union没有：

```text
SystemMessage
```

因此当前 conversion 将 mid-conversation system message 构造为：

```text
UserMessage
├── role = "user"
├── content
└── timestamp
```

字段转换：

```text
role = "system"
→ role = "user"

content
→ UserMessage.content

receivedAt
→ UserMessage.timestamp
```

即：

```text
Anthropic System Message
        ↓
Pi UserMessage
```

保持：

```text
message position
content order
convertible content
```

不把 mid-conversation system message 移到：

```text
Context.systemPrompt
```

因为这会改变其在 conversation 中的位置。

对于 source-valid 的 ordinary string / text / image content，使用 §4.2 对应的 `UserMessage` content conversion。

Mid-conversation system message 的具体 source validity 和允许的 content surface 取决于所选 Anthropic model/profile；conversion 不从普通 `user` message 的 content surface 推断额外 system-message capability。

------

### 4.5. Tool Identity Correlation

Anthropic tool invocation 与后续 tool result 通过：

```text
Assistant Message
└── ToolUseBlock
    ├── id
    └── name

        ↓ later

User Message
└── ToolResultBlock
    └── tool_use_id
```

建立关联。

Anthropic identity invariant：

```text
ToolUseBlock.id
=
ToolResultBlock.tool_use_id
```

`tool_use_id` 标识具体 tool invocation。

关联不依赖：

```text
array position
tool name matching
```

Pi 对应结构为：

```text
AssistantMessage.content[]
└── ToolCall
    ├── id
    └── name

        ↓

ToolResultMessage
├── toolCallId
└── toolName
```

其中：

```text
ToolUseBlock.id
→ ToolCall.id

ToolResultBlock.tool_use_id
→ ToolResultMessage.toolCallId
```

但 Anthropic `ToolResultBlock` 本身只提供：

```text
tool_use_id
```

而 Pi `ToolResultMessage` 还要求：

```text
toolName
```

因此 conversion 在当前 request conversion lifetime 内保存最小 correlation：

```text
toolUseId → toolName
```

遇到：

```text
ToolUseBlock
├── id = X
└── name = N
```

时记录：

```text
X → N
```

并同时构造：

```text
ToolCall
├── id = X
└── name = N
```

后续遇到：

```text
ToolResultBlock
└── tool_use_id = X
```

时：

```text
tool_use_id
→ ToolResultMessage.toolCallId = X

lookup(X)
→ ToolResultMessage.toolName = N
```

因此完整 identity path 为：

```text
ToolUseBlock
├── id = X
└── name = N
        │
        ├──────────────→ ToolCall
        │                ├── id = X
        │                └── name = N
        │
        └── correlation: X → N
                         │
                         ▼
ToolResultBlock          ToolResultMessage
└── tool_use_id = X  →  ├── toolCallId = X
                         └── toolName = N
```

如果：

```text
tool_result.tool_use_id
```

无法找到对应 `tool_use.id`：

```text
→ InvalidRequest
```

因为 conversion 无法构造 Pi required：

```text
ToolResultMessage.toolName
```

如果同一个：

```text
tool_use.id
```

对应冲突的 tool names：

```text
→ InvalidRequest
```

Conversion 不猜测 tool identity。

该 correlation：

```text
request-local
```

只在当前 request conversion期间存在，并在 conversion 完成后丢弃。

它不进入：

```text
Context
SimpleStreamOptions
AnthropicRenderState
```

也不形成新的 persistent semantic representation。



## 5. Tools

Anthropic：

```text
request.tools?
└── Tool[]
```

转换为：

```text
Context.tools?
└── Tool[]
```

如果：

```text
request.tools
→ absent
```

则：

```text
Context.tools
→ absent
```

对于每个 supported Anthropic client tool：

```text
Anthropic Tool
├── name
├── description?
├── input_schema
└── strict?

        ↓

Pi Tool
├── name
├── description
├── parameters
└── constrainedSampling?
```

字段转换：

```text
name
→ Tool.name

description
→ Tool.description

input_schema
→ Tool.parameters
```

即：

```ts
{
  name: source.name,
  description: source.description ?? "",
  parameters: source.input_schema,
}
```

如果：

```text
description
→ absent
```

则：

```text
Tool.description
→ ""
```

因为 Pi `Tool.description` 是 required string。

`input_schema` 直接作为 Pi：

```text
Tool.parameters
```

传递。

Conversion 不：

```text
rewrite schema
normalize schema
reconstruct schema
reimplement JSON Schema keyword validation
```

### Strict Tool

如果 Anthropic tool：

```text
strict = true
```

则构造：

```text
Tool.constrainedSampling
└── type = "json_schema"
    strict = "require"
```

即：

```ts
{
  name: source.name,
  description: source.description ?? "",
  parameters: source.input_schema,
  constrainedSampling: {
    type: "json_schema",
    strict: "require",
  },
}
```

字段关系：

```text
Anthropic strict = true
        ↓
Pi constrainedSampling
├── type = "json_schema"
└── strict = "require"
```

如果：

```text
strict = false
```

或：

```text
strict
→ absent
```

则：

```text
Tool.constrainedSampling
→ absent
```

Known Anthropic server-side tool definitions 不转换为 Pi client-executed `Tool`：

```text
request.tools[]
└── server-side tool definition
        ↓
UnsupportedFeature
```

最终：

```text
request.tools[]
        ↓
supported client tools
        ↓
Context.tools[]
```

保持 tool definition 的 Source order。

## 6. Invocation Options

当前 Anthropic Request 中进入 Pi `SimpleStreamOptions` 的信息为：

```text
Anthropic Request
├── max_tokens
├── temperature?
├── output_config?
│   └── effort?
└── metadata?
    └── user_id?

        ↓

SimpleStreamOptions
├── maxTokens?
├── temperature?
├── reasoning?
└── metadata?
    └── user_id
```

------

### 6.1. `max_tokens`

Anthropic：

```text
request.max_tokens
```

转换为：

```text
SimpleStreamOptions
└── maxTokens
```

字段转换：

```text
request.max_tokens
→ options.maxTokens
```

即：

```ts
options.maxTokens = request.max_tokens;
```

值原样传递，包括：

```text
max_tokens = 0
→ maxTokens = 0
```

Conversion 不执行：

```text
clamp
provider adjustment
context-window adjustment
thinking-budget adjustment
```

这些属于后续 Pi / provider execution。

`max_tokens` 是 Anthropic Request required field，因此 validated Anthropic Request 进入 conversion 时不存在 optional-absence branch。

------

### 6.2. `temperature`

Anthropic：

```text
request.temperature?
```

转换为：

```text
SimpleStreamOptions
└── temperature?
```

字段转换：

```text
request.temperature
→ options.temperature
```

值原样传递：

```ts
options.temperature = request.temperature;
```

Conversion 不：

```text
clamp
normalize
replace with provider default
```

如果：

```text
request.temperature
→ absent
```

则：

```text
options.temperature
→ absent
```

后续使用 Pi / provider 自己的默认行为。

------

### 6.3. `output_config.effort`

Anthropic Source hierarchy：

```text
request
└── output_config?
    └── effort?
```

Target：

```text
SimpleStreamOptions
└── reasoning?
```

Anthropic 当前 effort values：

```text
low
medium
high
xhigh
max
```

Pi `SimpleStreamOptions.reasoning` 使用 `ThinkingLevel`：

```text
minimal
low
medium
high
xhigh
max
```

当前共同 semantic values 直接映射：

```text
request.output_config.effort     options.reasoning

low                         →    low
medium                      →    medium
high                        →    high
xhigh                       →    xhigh
max                         →    max
```

即：

```text
request.output_config.effort
→ options.reasoning
```

Pi-only：

```text
minimal
```

没有对应的当前 Anthropic `effort` value，因此该 conversion 不生成：

```text
reasoning = "minimal"
```

如果：

```text
request.output_config
→ absent
```

或：

```text
request.output_config.effort
→ absent
```

则：

```text
options.reasoning
→ absent
```

使用 Pi reasoning default behavior。

如果未来 Anthropic 提供一个 source-valid `effort` value，而当前 Pi `ThinkingLevel` 没有 faithful corresponding value：

```text
→ UnsupportedFeature
```

Conversion 不把未知 effort 强制转换为：

```text
"max"
```

或其他已知 Pi level。

------

### 6.4. `metadata.user_id`

Anthropic Source hierarchy：

```text
request
└── metadata?
    └── user_id?
```

转换为：

```text
SimpleStreamOptions
└── metadata?
    └── user_id
```

字段转换：

```text
request.metadata.user_id
→ options.metadata.user_id
```

即：

```ts
options.metadata = {
  user_id: request.metadata.user_id,
};
```

`user_id` 值原样保留。

如果：

```text
request.metadata
→ absent
```

或：

```text
request.metadata.user_id
→ absent
```

则：

```text
options.metadata
→ absent
```

Conversion 不为了该 mapping 创建空：

```ts
metadata: {}
```

也不把其他 Anthropic Request state 塞入 Pi `metadata`。

最终：

```text
Anthropic Request
├── max_tokens                 → maxTokens
├── temperature?               → temperature?
├── output_config?.effort?     → reasoning?
└── metadata?.user_id?         → metadata?.user_id

                         ↓

               SimpleStreamOptions
```

## 7. Final Request Conversion

除了1-7章中的说明需要转换的字段，其他anthropic request的字段都忽略。

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
```

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
