import type { Model } from "@earendil-works/pi-ai";

import type { AnthropicSemanticInvocation } from "../../invocation.js";
import type { AnthropicEffortPlan } from "../../reasoning/contract.js";
import type {
  AnthropicCandidateId,
  AnthropicCacheCandidate,
  AnthropicContentCandidate,
} from "../../supplement/contract.js";
import type {
  AnthropicProjectionDisposition,
  AnthropicProjectionOutcome,
  AnthropicProjectionOutcomeId,
} from "../contract.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("anthropic-messages payload must be an object");
  }
  return structuredClone(value) as Record<string, unknown>;
}

function add(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  outcome: AnthropicProjectionDisposition,
): void {
  outcomes.push(Object.freeze({ candidateId, outcome: Object.freeze(outcome) }));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exact(
  outcomes: AnthropicProjectionOutcome[],
  candidateId: AnthropicProjectionOutcomeId,
  current: unknown,
  expected: unknown,
  assign: () => void,
): void {
  if (same(current, expected)) {
    add(outcomes, candidateId, { kind: "pi-native" });
    return;
  }
  assign();
  add(outcomes, candidateId, {
    kind: "payload-projected",
    projector: "anthropic-to-anthropic-messages",
    warning: "pi-native-mapping-repaired",
  });
}

function nullableValue<T>(
  intent:
    | { readonly kind: "omitted" }
    | { readonly kind: "explicit-null" }
    | { readonly kind: "specified"; readonly value: T },
): T | null | undefined {
  if (intent.kind === "omitted") return undefined;
  return intent.kind === "explicit-null" ? null : intent.value;
}

function thinkingValue(invocation: AnthropicSemanticInvocation): unknown {
  const activation = invocation.reasoning.activation;
  if (activation.kind === "omitted") return undefined;
  if (activation.kind === "disabled") return { type: "disabled" };
  const display = nullableValue(activation.display);
  return {
    type: activation.kind,
    ...(activation.kind === "enabled"
      ? { budget_tokens: activation.budgetTokens }
      : {}),
    ...(display === undefined ? {} : { display }),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return structuredClone(value) as Record<string, unknown>;
}

function projectedContentQueue(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = payload.messages as unknown[];
  const queue: Record<string, unknown>[] = [];
  for (const [index, candidate] of messages.entries()) {
    const message = asRecord(candidate, `anthropic-messages messages[${index}]`);
    if (typeof message.content === "string") {
      queue.push({ type: "text", text: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new Error(`anthropic-messages messages[${index}].content shape mismatch`);
    }
    for (const block of message.content) {
      queue.push(asRecord(block, `anthropic-messages messages[${index}].content`));
    }
  }
  return queue;
}

function projectedBlock(
  value: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  if (value === undefined) throw new Error(`${label} Pi association did not resolve`);
  return structuredClone(value) as Record<string, unknown>;
}

function piToolResultContent(
  invocation: AnthropicSemanticInvocation,
  callId: string,
): Record<string, unknown>[] {
  const result = invocation.pi.context.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === callId,
  );
  if (result?.role !== "toolResult") {
    throw new Error("anthropic-messages rich ToolResult Pi association did not resolve");
  }
  return result.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType,
            data: block.data,
          },
        }
  );
}

function reconstructRichToolResult(
  projected: Record<string, unknown> | undefined,
  candidates: readonly AnthropicContentCandidate[],
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> {
  const block = projectedBlock(projected, "anthropic-messages ToolResult");
  if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
    throw new Error("anthropic-messages rich ToolResult payload shape mismatch");
  }
  const rich = candidates.filter(
    (candidate) => candidate.kind === "rich-client-tool-result",
  );
  const references = candidates.filter(
    (candidate) => candidate.kind === "tool-reference",
  );
  const lengths = new Set<number>([
    ...rich.map((candidate) => candidate.value.contentLength),
    ...references.map((candidate) => candidate.value.contentLength),
  ]);
  if (lengths.size !== 1) {
    throw new Error("anthropic-messages rich ToolResult content length is ambiguous");
  }
  const contentLength = [...lengths][0]!;
  const inserted = new Map<
    number,
    {
      readonly piContentCount: 0 | 1;
      readonly value: Record<string, unknown>;
    }
  >();
  for (const candidate of rich) {
    for (const entry of candidate.value.blocks) {
      if (inserted.has(entry.contentIndex)) {
        throw new Error("anthropic-messages rich ToolResult content ownership is duplicated");
      }
      inserted.set(
        entry.contentIndex,
        {
          piContentCount: entry.piContentCount,
          value: structuredClone(entry.value) as Record<string, unknown>,
        },
      );
    }
  }
  for (const candidate of references) {
    if (inserted.has(candidate.value.contentIndex)) {
      throw new Error("anthropic-messages ToolReference content ownership is duplicated");
    }
    inserted.set(candidate.value.contentIndex, {
      piContentCount: 0,
      value: {
        type: "tool_reference",
        tool_name: candidate.value.toolName,
      },
    });
  }
  const visible = piToolResultContent(invocation, block.tool_use_id);
  let visibleIndex = 0;
  const content: Record<string, unknown>[] = [];
  for (let index = 0; index < contentLength; index += 1) {
    const insertion = inserted.get(index);
    if (insertion !== undefined) {
      if (
        insertion.piContentCount === 1 &&
        visible[visibleIndex++] === undefined
      ) {
        throw new Error(
          "anthropic-messages rich ToolResult Pi association did not resolve",
        );
      }
      content.push(insertion.value);
      continue;
    }
    const retained = visible[visibleIndex++];
    if (retained === undefined) {
      throw new Error("anthropic-messages rich ToolResult content association did not resolve");
    }
    content.push(retained);
  }
  if (visibleIndex !== visible.length) {
    throw new Error("anthropic-messages rich ToolResult contains unassociated Pi content");
  }
  block.content = content;
  return block;
}

function reconstructContentBlock(
  projected: Record<string, unknown> | undefined,
  candidates: readonly AnthropicContentCandidate[],
  invocation: AnthropicSemanticInvocation,
): Record<string, unknown> | undefined {
  if (candidates.length === 0) return projected;
  const byKind = new Map(candidates.map((candidate) => [candidate.kind, candidate]));
  const textCitations = byKind.get("text-citations");
  if (textCitations?.kind === "text-citations") {
    const block = projectedBlock(projected, "anthropic-messages text citations");
    block.citations = structuredClone(textCitations.value);
    return block;
  }
  const urlImage = byKind.get("url-image-source");
  if (urlImage?.kind === "url-image-source") {
    return { type: "image", source: structuredClone(urlImage.value) };
  }
  const documentSource = byKind.get("document-source");
  if (documentSource?.kind === "document-source") {
    const block: Record<string, unknown> = {
      type: "document",
      source: structuredClone(documentSource.value),
    };
    const metadata = byKind.get("document-metadata");
    if (metadata?.kind === "document-metadata") {
      Object.assign(block, structuredClone(metadata.value));
    }
    return block;
  }
  const search = byKind.get("search-result");
  if (search?.kind === "search-result") {
    return structuredClone(search.value) as Record<string, unknown>;
  }
  const caller = byKind.get("client-tool-use-caller");
  if (caller?.kind === "client-tool-use-caller") {
    const block = projectedBlock(projected, "anthropic-messages ToolUse caller");
    block.caller = structuredClone(caller.value);
    return block;
  }
  if (
    byKind.has("rich-client-tool-result") ||
    byKind.has("tool-reference")
  ) {
    return reconstructRichToolResult(projected, candidates, invocation);
  }
  const serverUse = byKind.get("server-tool-use");
  if (serverUse?.kind === "server-tool-use") {
    return structuredClone(serverUse.value) as Record<string, unknown>;
  }
  const serverResult = byKind.get("server-tool-result");
  if (serverResult?.kind === "server-tool-result") {
    return structuredClone(serverResult.value) as Record<string, unknown>;
  }
  const upload = byKind.get("container-upload");
  if (upload?.kind === "container-upload") {
    return { type: "container_upload", file_id: upload.value.fileId };
  }
  throw new Error("anthropic-messages content candidate kind is not reconstructable");
}

function reconstructMessages(
  payload: Record<string, unknown>,
  invocation: AnthropicSemanticInvocation,
): {
  readonly messages: unknown[];
  readonly resolvedCandidateIds: ReadonlySet<AnthropicCandidateId>;
} {
  const frames = invocation.supplement.conversation.messages;
  const contentById = new Map(
    invocation.supplement.content.map((candidate) => [candidate.id, candidate]),
  );
  const cacheById = new Map(
    invocation.supplement.cache.map((candidate) => [candidate.id, candidate]),
  );
  const queue = projectedContentQueue(payload);
  const resolvedCandidateIds = new Set<AnthropicCandidateId>();
  const messages = frames.map((frame) => {
    const content = frame.entries.map((entry) => {
      const projected = entry.piAttachment === undefined ? undefined : queue.shift();
      if (entry.piAttachment !== undefined && projected === undefined) {
        throw new Error("anthropic-messages content association did not resolve");
      }
      if (
        entry.kind === "synthetic-tool-result" &&
        (
          projected?.type !== "tool_result" ||
          projected.tool_use_id !== entry.callId
        )
      ) {
        throw new Error("anthropic-messages synthetic ToolResult association did not resolve");
      }
      const contentCandidates = entry.candidateIds
        .map((id) => contentById.get(id))
        .filter((candidate): candidate is AnthropicContentCandidate => candidate !== undefined);
      const cacheCandidates = entry.candidateIds
        .map((id) => cacheById.get(id))
        .filter((candidate): candidate is AnthropicCacheCandidate => candidate !== undefined);
      const block = reconstructContentBlock(projected, contentCandidates, invocation);
      if (block === undefined) {
        throw new Error("anthropic-messages source content association did not resolve");
      }
      for (const contentCandidate of contentCandidates) {
        resolvedCandidateIds.add(contentCandidate.id);
      }
      for (const cacheCandidate of cacheCandidates) {
        attachMessageCacheControl(block, cacheCandidate);
        resolvedCandidateIds.add(cacheCandidate.id);
      }
      return block;
    });
    return { role: frame.effectiveRole, content };
  });
  if (queue.length !== 0) {
    throw new Error("anthropic-messages payload contains unassociated Pi content");
  }
  return Object.freeze({
    messages,
    resolvedCandidateIds,
  });
}

function attachMessageCacheControl(
  block: Record<string, unknown>,
  candidate: AnthropicCacheCandidate,
): void {
  if (candidate.attachment.kind !== "message-content") {
    throw new Error("anthropic-messages message cache association mismatch");
  }
  let owner: unknown = block;
  for (const segment of candidate.attachment.nestedPath ?? []) {
    if (typeof segment === "number") {
      if (!Array.isArray(owner) || owner[segment] === undefined) {
        throw new Error("anthropic-messages nested cache association did not resolve");
      }
      owner = owner[segment];
      continue;
    }
    if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
      throw new Error("anthropic-messages nested cache association did not resolve");
    }
    owner = (owner as Record<string, unknown>)[segment];
  }
  if (typeof owner !== "object" || owner === null || Array.isArray(owner)) {
    throw new Error("anthropic-messages nested cache owner must be an object");
  }
  (owner as Record<string, unknown>).cache_control = wireCacheControl(candidate.value);
}

function wireCacheControl(
  value: AnthropicCacheCandidate["value"],
): unknown {
  return value === null
    ? null
    : { type: "ephemeral", ...(value.ttl === undefined ? {} : { ttl: value.ttl }) };
}

function reconstructTools(
  payload: Record<string, unknown>,
  invocation: AnthropicSemanticInvocation,
): unknown[] | undefined {
  const supplements = invocation.supplement.tools;
  const cacheSupplements = invocation.supplement.cache.filter(
    (candidate) => candidate.attachment.kind === "tool-definition",
  );
  if (supplements.length === 0 && cacheSupplements.length === 0) return undefined;
  const projected = Array.isArray(payload.tools)
    ? payload.tools.map((tool) => asRecord(tool, "anthropic-messages tool"))
    : [];
  const byIndex = new Map<number, typeof supplements[number][]>();
  for (const candidate of supplements) {
    const group = byIndex.get(candidate.sourceToolIndex) ?? [];
    group.push(candidate);
    byIndex.set(candidate.sourceToolIndex, group);
  }
  const cacheByIndex = new Map(cacheSupplements.map((candidate) => [
    candidate.attachment.kind === "tool-definition"
      ? candidate.attachment.toolIndex
      : -1,
    candidate,
  ]));
  const serverToolCount = [...byIndex.values()].filter((group) =>
    group.some((candidate) => candidate.kind === "server-tool-definition")
  ).length;
  const total = Math.max(
    projected.length + serverToolCount,
    ...supplements.map((tool) => tool.sourceToolIndex + 1),
    ...cacheSupplements.map((candidate) =>
      candidate.attachment.kind === "tool-definition"
        ? candidate.attachment.toolIndex + 1
        : 0
    ),
  );
  const tools: unknown[] = [];
  for (let index = 0; index < total; index += 1) {
    const candidates = byIndex.get(index) ?? [];
    const server = candidates.find(
      (candidate) => candidate.kind === "server-tool-definition",
    );
    if (server !== undefined && candidates.length !== 1) {
      throw new Error("anthropic-messages server tool candidate ownership mismatch");
    }
    const tool = server === undefined
      ? projected.shift()
      : structuredClone(server.value) as Record<string, unknown>;
    if (tool === undefined) {
      throw new Error("anthropic-messages Pi tool association did not resolve");
    }
    for (const candidate of candidates) {
      switch (candidate.kind) {
        case "custom-tool-caller-policy":
          tool.allowed_callers = [...candidate.value];
          break;
        case "custom-tool-deferred-loading":
          tool.defer_loading = candidate.value;
          break;
        case "custom-tool-input-streaming":
          tool.eager_input_streaming = candidate.value;
          break;
        case "custom-tool-input-examples":
          tool.input_examples = structuredClone(candidate.value);
          break;
        case "server-tool-definition":
          break;
      }
    }
    const cache = cacheByIndex.get(index);
    if (cache !== undefined) tool.cache_control = wireCacheControl(cache.value);
    tools.push(tool);
  }
  if (projected.length !== 0) {
    throw new Error("anthropic-messages payload contains unassociated Pi tools");
  }
  return tools;
}

interface ProjectionInput {
  readonly model: Model<string>;
  readonly invocation: AnthropicSemanticInvocation;
  readonly effortPlan: AnthropicEffortPlan;
  readonly payload: unknown;
}

function projectAnthropicToAnthropicMessages(
  input: ProjectionInput,
  phase: "reasoning" | "supplement",
): {
  readonly payload: unknown;
  readonly outcomes: readonly AnthropicProjectionOutcome[];
} {
  const payload = record(input.payload);
  if (
    typeof payload.model !== "string" ||
    !Array.isArray(payload.messages) ||
    payload.stream !== true ||
    typeof payload.max_tokens !== "number"
  ) {
    throw new Error("anthropic-messages payload shape mismatch");
  }
  const outcomes: AnthropicProjectionOutcome[] = [];
  const supplement = input.invocation.supplement;

  const contentCaches = supplement.cache.filter(
    (candidate) => candidate.attachment.kind === "message-content",
  );
  if (
    phase === "supplement" &&
    (supplement.content.length > 0 || contentCaches.length > 0)
  ) {
    const reconstructed = reconstructMessages(payload, input.invocation);
    payload.messages = reconstructed.messages;
    for (const candidateId of reconstructed.resolvedCandidateIds) {
      add(outcomes, candidateId, {
          kind: "payload-projected",
          projector: "anthropic-to-anthropic-messages",
      });
    }
  }
  if (phase === "supplement" && supplement.system.length > 0) {
    const systemCaches = new Map(
      supplement.cache.flatMap((candidate) =>
        candidate.attachment.kind === "system-block"
          ? [[candidate.attachment.blockIndex, candidate] as const]
          : []
      ),
    );
    payload.system = supplement.system.map((candidate) => {
      const block = structuredClone(candidate.value) as Record<string, unknown>;
      const cache = systemCaches.get(candidate.blockIndex);
      if (cache !== undefined) block.cache_control = wireCacheControl(cache.value);
      return block;
    });
    for (const candidate of supplement.system) {
      add(outcomes, candidate.id, {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
    for (const candidate of systemCaches.values()) {
      add(outcomes, candidate.id, {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }
  const tools = phase === "supplement"
    ? reconstructTools(payload, input.invocation)
    : undefined;
  if (tools !== undefined) {
    payload.tools = tools;
    for (const entry of supplement.tools) {
      add(outcomes, entry.id, {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
    for (const entry of supplement.cache.filter(
      (candidate) => candidate.attachment.kind === "tool-definition",
    )) {
      add(outcomes, entry.id, {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }

  if (phase === "supplement") {
    const finalMaxTokens = Math.min(
      payload.max_tokens,
      supplement.controls.outputTokenCeiling.value,
    );
    exact(outcomes, "maxTokens", payload.max_tokens, finalMaxTokens, () => {
      payload.max_tokens = finalMaxTokens;
    });
    for (const [control, field, value] of [
      ["sampling.temperature", "temperature", supplement.controls.temperature?.value],
      ["sampling.topP", "top_p", supplement.controls.topP?.value],
      ["sampling.topK", "top_k", supplement.controls.topK?.value],
    ] as const) {
      if (value === undefined) continue;
      if (control === "sampling.temperature") {
        if (same(payload[field], value)) {
          add(outcomes, control, { kind: "pi-native" });
        }
        continue;
      }
      exact(outcomes, control, payload[field], value, () => {
        payload[field] = value;
      });
    }
    if (supplement.controls.stopSequences !== undefined) {
      exact(
        outcomes,
        "stopSequences",
        payload.stop_sequences,
        supplement.controls.stopSequences.value,
        () => {
          payload.stop_sequences = [...supplement.controls.stopSequences!.value];
        },
      );
    }
  }

  const choice = supplement.controls.toolChoice?.value;
  if (phase === "supplement" && choice !== undefined) {
    const mapped =
      choice.kind === "named"
        ? {
            type: "tool",
            name: choice.name,
            disable_parallel_tool_use: choice.disableParallelToolUse,
          }
        : choice.kind === "none"
          ? { type: "none" }
          : {
              type: choice.kind,
              disable_parallel_tool_use: choice.disableParallelToolUse,
            };
    exact(outcomes, "toolChoice", payload.tool_choice, mapped, () => {
      payload.tool_choice = mapped;
    });
  }

  const thinkingBudgetDoesNotFit = phase === "reasoning" &&
    input.invocation.reasoning.activation.kind === "enabled" &&
    input.invocation.reasoning.activation.budgetTokens >= payload.max_tokens;
  const requestedThinking = input.invocation.reasoning.activation;
  const targetCannotReason =
    !input.model.reasoning &&
    (requestedThinking.kind === "enabled" || requestedThinking.kind === "adaptive");
  const expectedThinking = thinkingBudgetDoesNotFit || targetCannotReason
    ? undefined
    : thinkingValue(input.invocation);
  if (phase === "reasoning" && thinkingBudgetDoesNotFit) {
    delete payload.thinking;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning:
        "Anthropic thinking budget no longer fits below the context-safe final max_tokens ceiling; reasoning was disabled for this request",
    });
  } else if (phase === "reasoning" && targetCannotReason) {
    delete payload.thinking;
    add(outcomes, "reasoning.activation", {
      kind: "degraded",
      warning:
        "target model does not support reasoning; ordinary generation was retained",
    });
  } else if (phase === "reasoning" && expectedThinking === undefined) {
    const changed = Object.hasOwn(payload, "thinking");
    delete payload.thinking;
    if (changed) {
      add(outcomes, "reasoning.activation", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
        warning: "pi-native-mapping-repaired",
      });
    }
  } else if (phase === "reasoning") {
    exact(
      outcomes,
      "reasoning.activation",
      payload.thinking,
      expectedThinking,
      () => {
        payload.thinking = expectedThinking;
      },
    );
  }
  const format = supplement.controls.outputFormat?.value;
  const effortPlan = input.effortPlan;
  const outputConfig: Record<string, unknown> =
    typeof payload.output_config === "object" &&
      payload.output_config !== null &&
      !Array.isArray(payload.output_config)
      ? { ...(payload.output_config as Record<string, unknown>) }
      : {};
  if (phase === "reasoning" && effortPlan.kind === "specified") {
    if (effortPlan.selection.kind !== "selected") {
      delete outputConfig.effort;
      add(outcomes, "reasoning.effort", {
        kind: "degraded",
        warning:
          effortPlan.selection.kind === "non-reasoning"
            ? "target model does not support reasoning; ordinary generation was retained"
            : "target model exposes no selectable reasoning level; Provider default was retained",
      });
    } else {
      const mapped = input.model.thinkingLevelMap?.[effortPlan.selection.level];
      const expected =
        typeof mapped === "string"
          ? mapped
          : effortPlan.selection.level === "minimal"
            ? undefined
            : effortPlan.selection.level;
      if (expected === undefined) {
        delete outputConfig.effort;
        add(outcomes, "reasoning.effort", {
          kind: "degraded",
          warning:
            "target has no certified Anthropic effort value for the selected Pi level; Provider default was retained",
        });
      } else if (outputConfig.effort === expected) {
        add(
          outcomes,
          "reasoning.effort",
          effortPlan.requested === effortPlan.selection.level
            ? { kind: "pi-native" }
            : {
                kind: "degraded",
                warning: `requested reasoning level ${effortPlan.requested} mapped to supported Pi level ${effortPlan.selection.level}`,
              },
        );
      } else {
        outputConfig.effort = expected;
        add(outcomes, "reasoning.effort", {
          kind: "payload-projected",
          projector: "anthropic-to-anthropic-messages",
          warning: "pi-native-mapping-repaired",
        });
      }
    }
  }
  if (phase === "supplement" && format !== undefined) {
    outputConfig.format =
      format === null
        ? null
        : { type: "json_schema", schema: format.schema };
  }
  if (Object.keys(outputConfig).length === 0) {
    delete payload.output_config;
  } else if (!same(payload.output_config, outputConfig)) {
    payload.output_config = outputConfig;
    if (phase === "supplement" && format !== undefined) {
      add(outcomes, "outputFormat", {
        kind: "payload-projected",
        projector: "anthropic-to-anthropic-messages",
      });
    }
  }

  if (phase === "supplement") {
    const userId = supplement.controls.metadataUserId?.value;
    if (userId === undefined) {
      delete payload.metadata;
    } else {
      exact(
        outcomes,
        "metadataUserId",
        payload.metadata,
        { user_id: userId },
        () => {
          payload.metadata = { user_id: userId };
        },
      );
    }
    const tier = supplement.controls.serviceTier?.value;
    if (tier !== undefined) {
      exact(outcomes, "serviceTier", payload.service_tier, tier, () => {
        payload.service_tier = tier;
      });
    }
    const geo = supplement.controls.inferenceGeo?.value;
    if (geo !== undefined) {
      exact(outcomes, "inferenceGeo", payload.inference_geo, geo, () => {
        payload.inference_geo = geo;
      });
    }
    const container = supplement.controls.container?.value;
    if (container !== undefined) {
      exact(outcomes, "container", payload.container, container, () => {
        payload.container = container;
      });
    }
    const cache = supplement.cache.find(
      (candidate) => candidate.attachment.kind === "request",
    );
    if (cache !== undefined) {
      const expected = wireCacheControl(cache.value);
      exact(outcomes, "cacheControl", payload.cache_control, expected, () => {
        payload.cache_control = expected;
      });
    }
  }

  return Object.freeze({
    payload: Object.freeze(payload),
    outcomes: Object.freeze(outcomes),
  });
}

export function projectAnthropicToAnthropicMessagesReasoning(
  input: ProjectionInput,
) {
  return projectAnthropicToAnthropicMessages(input, "reasoning");
}

export function projectAnthropicToAnthropicMessagesSupplement(
  input: ProjectionInput,
) {
  return projectAnthropicToAnthropicMessages(input, "supplement");
}
