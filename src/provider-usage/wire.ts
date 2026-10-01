import type { FetchFunction } from "@earendil-works/pi-ai";

import type { ProviderUsageUnavailableReason } from "./contract.js";

export const PROVIDER_USAGE_RESPONSE_MAX_BYTES = 524_288 as const;

export interface ProviderUsageHttpResult {
  readonly response?: Response;
  readonly body?: unknown;
  readonly reason?: ProviderUsageUnavailableReason;
}

export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizePercent(value: unknown): number | undefined {
  const number = toFiniteNumber(value);
  return number === undefined ? undefined : Math.max(0, Math.min(100, number));
}

export function normalizeResetAt(value: unknown): number | undefined {
  let milliseconds: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value > 10_000_000_000 ? value : value * 1000;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^[+-]?\d+(?:\.\d+)?$/u.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      }
    } else {
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) milliseconds = parsed;
    }
  }
  if (milliseconds === undefined || milliseconds <= 0) return undefined;
  const time = new Date(milliseconds).getTime();
  return Number.isFinite(time) ? time : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function canonicalUrl(
  value: string | undefined,
  expectedOrigin: string,
  acceptedPaths: readonly string[],
): boolean {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    const origin = url.origin.toLowerCase();
    if (origin !== expectedOrigin.toLowerCase()) return false;
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return acceptedPaths.some((candidate) => {
      const normalized = candidate.replace(/\/+$/u, "") || "/";
      return path === normalized;
    });
  } catch {
    return false;
  }
}

export async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > PROVIDER_USAGE_RESPONSE_MAX_BYTES) {
      try {
        await response.body?.cancel();
      } catch {
        // Best-effort only.
      }
      return undefined;
    }
  }

  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelOnAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > PROVIDER_USAGE_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      await reader.cancel(signal.aborted ? signal.reason : error);
    } catch {
      // Best-effort only.
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function fetchProviderUsageJson(
  fetch: FetchFunction,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<ProviderUsageHttpResult> {
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetch(url, { ...init, signal, redirect: "error" });
  } catch {
    return Object.freeze({ reason: "network" });
  }
  if (!response.ok) {
    return Object.freeze({
      response,
      reason: response.status === 401 || response.status === 403 ? "auth" : "upstream",
    });
  }
  let body: unknown | undefined;
  try {
    body = await readBoundedJson(response, signal);
  } catch {
    return Object.freeze({ response, reason: "network" });
  }
  if (body === undefined) {
    return Object.freeze({ response, reason: "schema" });
  }
  return Object.freeze({ response, body });
}
