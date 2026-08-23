import type { ConversionNotice } from "@luckytoken/provider-contract/diagnostics";

export interface AnthropicContinuitySource {
  readonly provider: string;
  readonly api: string;
  readonly model: string;
}

export type AnthropicContinuityAttachment =
  | {
      readonly target: "thinking";
      readonly kind: "native-field-provenance";
      readonly representation?: "redacted";
    }
  | {
      readonly target: "thinking";
      readonly kind: "opaque-signature" | "opaque-reasoning-state";
      readonly value: string;
      readonly representation?: "redacted";
    }
  | {
      readonly target: "text";
      readonly kind: "opaque-signature";
      readonly value: string;
    }
  | {
      readonly target: "toolCall";
      readonly callId: string;
      readonly kind: "opaque-signature" | "opaque-reasoning-state";
      readonly value: string;
    };

export interface LuckyTokenAnthropicContinuityEnvelopeV1 {
  readonly version: 1;
  readonly source: AnthropicContinuitySource;
  readonly attachments: readonly AnthropicContinuityAttachment[];
}

export type AnthropicContinuityOwner =
  | {
      readonly target: "thinking";
      readonly representation: "thinking" | "redacted";
      readonly hasNativeValue: boolean;
    }
  | { readonly target: "text" }
  | { readonly target: "toolCall"; readonly callId: string };

export interface DecodedAnthropicContinuity {
  readonly source?: AnthropicContinuitySource;
  readonly attachments: readonly AnthropicContinuityAttachment[];
  readonly notices: readonly ConversionNotice[];
}

const MAX_ENVELOPE_BYTES = 256 * 1_024;
const MAX_OPAQUE_VALUE_BYTES = 128 * 1_024;
const MAX_ID_BYTES = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function boundedString(value: unknown, maximumBytes = MAX_ID_BYTES): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumBytes
  );
}

function notice(
  direction: "request" | "response",
  jsonPath: string,
): ConversionNotice {
  return Object.freeze({
    adapter: "anthropic-messages",
    direction,
    code: "anthropic_continuity_attachment_ignored",
    jsonPath,
    action: "degrade",
  });
}

function parseSource(value: unknown): AnthropicContinuitySource | undefined {
  if (!isRecord(value) || !exactKeys(value, ["provider", "api", "model"])) {
    return undefined;
  }
  if (
    !boundedString(value.provider) ||
    !boundedString(value.api) ||
    !boundedString(value.model)
  ) {
    return undefined;
  }
  return Object.freeze({
    provider: value.provider,
    api: value.api,
    model: value.model,
  });
}

function parseAttachment(
  value: unknown,
  owner: AnthropicContinuityOwner,
): AnthropicContinuityAttachment | undefined {
  if (!isRecord(value) || typeof value.target !== "string" || typeof value.kind !== "string") {
    return undefined;
  }
  if (value.target !== owner.target) return undefined;
  if (value.target === "thinking") {
    if (owner.target !== "thinking") return undefined;
    const representation = value.representation;
    if (representation !== undefined && representation !== "redacted") return undefined;
    if (
      representation === "redacted" &&
      owner.representation !== "redacted"
    ) {
      return undefined;
    }
    if (value.kind === "native-field-provenance") {
      if (
        !owner.hasNativeValue ||
        !exactKeys(value, ["target", "kind", "representation"])
      ) {
        return undefined;
      }
      return Object.freeze({
        target: "thinking",
        kind: "native-field-provenance",
        ...(representation === undefined ? {} : { representation }),
      });
    }
    if (value.kind === "opaque-signature" || value.kind === "opaque-reasoning-state") {
      if (
        !exactKeys(value, ["target", "kind", "value", "representation"]) ||
        !boundedString(value.value, MAX_OPAQUE_VALUE_BYTES)
      ) {
        return undefined;
      }
      return Object.freeze({
        target: "thinking",
        kind: value.kind,
        value: value.value,
        ...(representation === undefined ? {} : { representation }),
      });
    }
    return undefined;
  }
  if (value.target === "text") {
    if (
      owner.target !== "text" ||
      value.kind !== "opaque-signature" ||
      !exactKeys(value, ["target", "kind", "value"]) ||
      !boundedString(value.value, MAX_OPAQUE_VALUE_BYTES)
    ) {
      return undefined;
    }
    return Object.freeze({
      target: "text",
      kind: "opaque-signature",
      value: value.value,
    });
  }
  if (
    value.target !== "toolCall" ||
    owner.target !== "toolCall" ||
    (value.kind !== "opaque-signature" && value.kind !== "opaque-reasoning-state") ||
    !exactKeys(value, ["target", "kind", "value", "callId"]) ||
    !boundedString(value.callId) ||
    value.callId !== owner.callId ||
    !boundedString(value.value, MAX_OPAQUE_VALUE_BYTES)
  ) {
    return undefined;
  }
  return Object.freeze({
    target: "toolCall",
    callId: value.callId,
    kind: value.kind,
    value: value.value,
  });
}

function attachmentIdentity(value: AnthropicContinuityAttachment): string {
  return value.target === "toolCall"
    ? `${value.target}:${value.callId}:${value.kind}`
    : `${value.target}:${value.kind}`;
}

export function decodeAnthropicContinuity(input: {
  readonly value: unknown;
  readonly owner: AnthropicContinuityOwner;
  readonly jsonPath: string;
}): DecodedAnthropicContinuity {
  const notices: ConversionNotice[] = [];
  const value = input.value;
  if (value === undefined) {
    return Object.freeze({ attachments: Object.freeze([]), notices: Object.freeze([]) });
  }
  let encodedBytes = MAX_ENVELOPE_BYTES + 1;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    // Handled as a malformed envelope below.
  }
  if (
    encodedBytes > MAX_ENVELOPE_BYTES ||
    !isRecord(value) ||
    !exactKeys(value, ["version", "source", "attachments"]) ||
    value.version !== 1 ||
    !Array.isArray(value.attachments)
  ) {
    notices.push(notice("request", input.jsonPath));
    return Object.freeze({ attachments: Object.freeze([]), notices: Object.freeze(notices) });
  }
  const source = parseSource(value.source);
  if (source === undefined) {
    notices.push(notice("request", `${input.jsonPath}.source`));
    return Object.freeze({ attachments: Object.freeze([]), notices: Object.freeze(notices) });
  }
  const attachments: AnthropicContinuityAttachment[] = [];
  const identities = new Set<string>();
  for (const [index, candidate] of value.attachments.entries()) {
    const parsed = parseAttachment(candidate, input.owner);
    if (parsed === undefined) {
      notices.push(notice("request", `${input.jsonPath}.attachments[${index}]`));
      continue;
    }
    const identity = attachmentIdentity(parsed);
    if (identities.has(identity)) {
      notices.push(notice("request", `${input.jsonPath}.attachments[${index}]`));
      continue;
    }
    identities.add(identity);
    attachments.push(parsed);
  }
  return Object.freeze({
    source,
    attachments: Object.freeze(attachments),
    notices: Object.freeze(notices),
  });
}

export function encodeAnthropicContinuity(input: {
  readonly source: AnthropicContinuitySource;
  readonly attachments: readonly AnthropicContinuityAttachment[];
}): LuckyTokenAnthropicContinuityEnvelopeV1 | undefined {
  if (input.attachments.length === 0) return undefined;
  const source = parseSource(input.source);
  if (source === undefined) return undefined;
  const envelope: LuckyTokenAnthropicContinuityEnvelopeV1 = Object.freeze({
    version: 1,
    source,
    attachments: Object.freeze(input.attachments.map((attachment) => Object.freeze({ ...attachment }))),
  });
  const decoded = decodeAnthropicContinuity({
    value: envelope,
    owner:
      envelope.attachments[0]?.target === "toolCall"
        ? { target: "toolCall", callId: envelope.attachments[0].callId }
        : envelope.attachments[0]?.target === "text"
          ? { target: "text" }
          : {
              target: "thinking",
              representation:
                envelope.attachments[0]?.representation === "redacted"
                  ? "redacted"
                  : "thinking",
              hasNativeValue: true,
            },
    jsonPath: "$.luckytoken_continuity",
  });
  return decoded.attachments.length === input.attachments.length ? envelope : undefined;
}
