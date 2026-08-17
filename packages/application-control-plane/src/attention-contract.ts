/**
 * Ticket 25 operational-attention projection.
 *
 * This is a value-free, bounded status projection. It deliberately contains
 * no error text, ports, paths, request ids, aliases, model ids, or credential
 * material. Ordinary request failures are represented only by an aggregate
 * count and can never become an actionable notification condition.
 */

export const RECENT_REQUEST_FAILURE_WINDOW_MS = 60 * 60 * 1_000;

export type AttentionCategory =
  | "gateway-start-failed"
  | "port-conflict"
  | "persistence-critical"
  | "provider-login-invalid";

export type AttentionPage =
  | "dashboard"
  | "providers"
  | "requests"
  | "diagnostics";

export interface AttentionCondition {
  readonly id: string;
  readonly category: AttentionCategory;
  readonly since: number;
  readonly page: AttentionPage;
  readonly providerId?: string;
}

export interface RecentRequestFailures {
  readonly count: number;
  readonly windowMs: number;
}

export interface AttentionProjection {
  readonly conditions: readonly AttentionCondition[];
  readonly requestFailures?: RecentRequestFailures;
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const CONDITION_IDS = new Set([
  "gateway-start-failed",
  "port-conflict",
  "persistence-critical",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function decodeCondition(value: unknown): AttentionCondition | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "category", "since", "page", "providerId"]) ||
    typeof value.id !== "string" ||
    typeof value.since !== "number" ||
    !Number.isSafeInteger(value.since) ||
    value.since < 0
  ) {
    return undefined;
  }
  const common = { id: value.id, since: value.since };
  if (
    value.category === "provider-login-invalid" &&
    value.page === "providers" &&
    typeof value.providerId === "string" &&
    PROVIDER_ID.test(value.providerId) &&
    value.id === `provider-login-invalid:${value.providerId}`
  ) {
    return Object.freeze({
      ...common,
      category: value.category,
      page: value.page,
      providerId: value.providerId,
    });
  }
  const expectedPage =
    value.category === "persistence-critical" ? "diagnostics" : "dashboard";
  if (
    (value.category !== "gateway-start-failed" &&
      value.category !== "port-conflict" &&
      value.category !== "persistence-critical") ||
    value.page !== expectedPage ||
    value.providerId !== undefined ||
    !CONDITION_IDS.has(value.id) ||
    value.id !== value.category
  ) {
    return undefined;
  }
  return Object.freeze({
    ...common,
    category: value.category,
    page: expectedPage,
  });
}

export function decodeAttentionProjection(
  value: unknown,
): AttentionProjection | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["conditions", "requestFailures"]) ||
    !Array.isArray(value.conditions) ||
    value.conditions.length > 64
  ) {
    return undefined;
  }
  const conditions: AttentionCondition[] = [];
  const ids = new Set<string>();
  for (const raw of value.conditions) {
    const condition = decodeCondition(raw);
    if (condition === undefined || ids.has(condition.id)) return undefined;
    ids.add(condition.id);
    conditions.push(condition);
  }
  let requestFailures: RecentRequestFailures | undefined;
  if (value.requestFailures !== undefined) {
    const raw = value.requestFailures;
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, ["count", "windowMs"]) ||
      typeof raw.count !== "number" ||
      !Number.isSafeInteger(raw.count) ||
      raw.count < 0 ||
      raw.windowMs !== RECENT_REQUEST_FAILURE_WINDOW_MS
    ) {
      return undefined;
    }
    requestFailures = Object.freeze({ count: raw.count, windowMs: raw.windowMs });
  }
  return Object.freeze({
    conditions: Object.freeze(conditions),
    ...(requestFailures === undefined ? {} : { requestFailures }),
  });
}
