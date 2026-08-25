import type { ConversionNotice } from "@token/provider-contract/diagnostics";
import type { ResponsesReasoningSource } from "./contract.js";

export const RESPONSES_CONTINUITY_FIELD = "token_continuity";

export type ResponsesItemLocation =
  | { readonly type: "reasoning" }
  | { readonly type: "message"; readonly contentPartCount: number }
  | { readonly type: "toolCall"; readonly callId: string };

export type WireContinuityAttachment =
  | {
      readonly source: ResponsesReasoningSource;
      readonly target: "thinking";
      readonly kind: "opaque-signature" | "reasoning-field-selector";
      readonly value: string;
      readonly representation?: "redacted";
    }
  | {
      readonly source: ResponsesReasoningSource;
      readonly target: "text";
      readonly partIndex: number;
      readonly kind: "opaque-signature";
      readonly value: string;
    }
  | {
      readonly source: ResponsesReasoningSource;
      readonly target: "toolCall";
      readonly callId: string;
      readonly kind: "opaque-signature";
      readonly value: string;
    };

export interface TokenContinuityEnvelopeV1 {
  readonly version: 1;
  readonly source: ResponsesReasoningSource;
  readonly attachments: readonly (
    | {
        readonly target: "thinking";
        readonly kind: "opaque-signature" | "reasoning-field-selector";
        readonly value: string;
        readonly representation?: "redacted";
      }
    | {
        readonly target: "text";
        readonly partIndex: number;
        readonly kind: "opaque-signature";
        readonly value: string;
      }
    | {
        readonly target: "toolCall";
        readonly callId: string;
        readonly kind: "opaque-signature";
        readonly value: string;
      }
  )[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isResponsesReasoningSource(value: unknown): value is ResponsesReasoningSource {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["provider", "api", "model"]) &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.api === "string" &&
    value.api.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

function copySource(source: ResponsesReasoningSource): ResponsesReasoningSource {
  return Object.freeze({
    provider: source.provider,
    api: source.api,
    model: source.model,
  });
}

function sameSource(left: ResponsesReasoningSource, right: ResponsesReasoningSource): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model
  );
}

function continuityNotice(
  code: string,
  jsonPath: string,
): ConversionNotice {
  return Object.freeze({
    adapter: "openai-responses",
    direction: "request",
    code,
    jsonPath,
    action: "ignore",
  });
}

function attachmentIdentity(attachment: WireContinuityAttachment): string {
  switch (attachment.target) {
    case "thinking":
      return "thinking";
    case "text":
      return `text:${attachment.partIndex}`;
    case "toolCall":
      return `toolCall:${attachment.callId}`;
  }
}

export function decodeResponsesContinuity(
  item: Readonly<Record<string, unknown>>,
  location: ResponsesItemLocation,
): {
  readonly source?: ResponsesReasoningSource;
  readonly attachments: readonly WireContinuityAttachment[];
  readonly notices: readonly ConversionNotice[];
} {
  const raw = item[RESPONSES_CONTINUITY_FIELD];
  if (raw === undefined) {
    return Object.freeze({
      attachments: Object.freeze([]),
      notices: Object.freeze([]),
    });
  }
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["version", "source", "attachments"]) ||
    raw.version !== 1 ||
    !isResponsesReasoningSource(raw.source) ||
    !Array.isArray(raw.attachments)
  ) {
    return Object.freeze({
      attachments: Object.freeze([]),
      notices: Object.freeze([
        continuityNotice(
          "openai-responses_continuity_envelope_invalid",
          `$.${RESPONSES_CONTINUITY_FIELD}`,
        ),
      ]),
    });
  }
  const attachments: WireContinuityAttachment[] = [];
  const notices: ConversionNotice[] = [];
  for (const [index, candidate] of raw.attachments.entries()) {
    if (!isRecord(candidate)) {
      notices.push(
        continuityNotice(
          "openai-responses_continuity_attachment_invalid",
          `$.${RESPONSES_CONTINUITY_FIELD}.attachments[${index}]`,
        ),
      );
      continue;
    }
    if (
      location.type === "reasoning" &&
      (hasExactKeys(candidate, ["target", "kind", "value"]) ||
        hasExactKeys(candidate, [
          "target",
          "kind",
          "value",
          "representation",
        ])) &&
      candidate.target === "thinking" &&
      (candidate.kind === "opaque-signature" ||
        candidate.kind === "reasoning-field-selector") &&
      typeof candidate.value === "string" &&
      candidate.value.length > 0 &&
      (candidate.representation === undefined ||
        (candidate.kind === "opaque-signature" &&
          candidate.representation === "redacted"))
    ) {
      attachments.push(
        Object.freeze({
          source: copySource(raw.source),
          target: candidate.target,
          kind: candidate.kind,
          value: candidate.value,
          ...(candidate.representation === "redacted"
            ? { representation: "redacted" as const }
            : {}),
        }),
      );
      continue;
    }
    if (
      location.type === "message" &&
      hasExactKeys(candidate, ["target", "partIndex", "kind", "value"]) &&
      candidate.target === "text" &&
      candidate.kind === "opaque-signature" &&
      Number.isSafeInteger(candidate.partIndex) &&
      (candidate.partIndex as number) >= 0 &&
      (candidate.partIndex as number) < location.contentPartCount &&
      typeof candidate.value === "string" &&
      candidate.value.length > 0
    ) {
      attachments.push(
        Object.freeze({
          source: copySource(raw.source),
          target: "text",
          partIndex: candidate.partIndex as number,
          kind: "opaque-signature",
          value: candidate.value,
        }),
      );
      continue;
    }
    if (
      location.type === "toolCall" &&
      hasExactKeys(candidate, ["target", "callId", "kind", "value"]) &&
      candidate.target === "toolCall" &&
      candidate.kind === "opaque-signature" &&
      candidate.callId === location.callId &&
      typeof candidate.value === "string" &&
      candidate.value.length > 0
    ) {
      attachments.push(
        Object.freeze({
          source: copySource(raw.source),
          target: "toolCall",
          callId: location.callId,
          kind: "opaque-signature",
          value: candidate.value,
        }),
      );
      continue;
    }
    notices.push(
      continuityNotice(
        "openai-responses_continuity_attachment_invalid",
        `$.${RESPONSES_CONTINUITY_FIELD}.attachments[${index}]`,
      ),
    );
  }
  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const identity = attachmentIdentity(attachment);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const uniqueAttachments = attachments.filter((attachment) => {
    if ((counts.get(attachmentIdentity(attachment)) ?? 0) === 1) return true;
    notices.push(
      continuityNotice(
        "openai-responses_continuity_attachment_duplicate",
        `$.${RESPONSES_CONTINUITY_FIELD}.attachments`,
      ),
    );
    return false;
  });
  return Object.freeze({
    source: copySource(raw.source),
    attachments: Object.freeze(uniqueAttachments),
    notices: Object.freeze(notices),
  });
}

export function encodeResponsesContinuity(input: {
  readonly source: ResponsesReasoningSource;
  readonly attachments: readonly WireContinuityAttachment[];
}): TokenContinuityEnvelopeV1 | undefined {
  if (!isResponsesReasoningSource(input.source)) return undefined;
  const attachments: Array<
    TokenContinuityEnvelopeV1["attachments"][number]
  > = [];
  for (const attachment of input.attachments) {
    if (
      !sameSource(attachment.source, input.source) ||
      attachment.value.length === 0
    ) {
      continue;
    }
    if (attachment.target === "thinking") {
      if (
        attachment.representation !== undefined &&
        (attachment.kind !== "opaque-signature" ||
          attachment.representation !== "redacted")
      ) {
        continue;
      }
      attachments.push(
        Object.freeze({
          target: attachment.target,
          kind: attachment.kind,
          value: attachment.value,
          ...(attachment.representation === "redacted"
            ? { representation: "redacted" as const }
            : {}),
        }),
      );
      continue;
    }
    if (attachment.target === "text") {
      attachments.push(
        Object.freeze({
          target: attachment.target,
          partIndex: attachment.partIndex,
          kind: attachment.kind,
          value: attachment.value,
        }),
      );
      continue;
    }
    if (attachment.target === "toolCall") {
      attachments.push(
        Object.freeze({
          target: attachment.target,
          callId: attachment.callId,
          kind: attachment.kind,
          value: attachment.value,
        }),
      );
    }
  }
  return Object.freeze({
    version: 1,
    source: copySource(input.source),
    attachments: Object.freeze(attachments),
  });
}
