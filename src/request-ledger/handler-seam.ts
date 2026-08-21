import { randomUUID } from "node:crypto";

import type {
  ConversionNotice,
  InvocationAttempt,
} from "@luckytoken/provider-contract/diagnostics";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";

/** Handler-local lifecycle facts. Persistence and public query DTOs remain
 * outside this consumer-owned seam. */
export interface RequestLedgerEntry {
  readonly requestId: string;
  authorized(facts: {
    readonly effectiveSessionId: string;
    readonly clientSessionId?: string;
  }): void;
  aliasCaptured(fact: { readonly externalAlias: string }): void;
  modelResolved(snapshot: {
    readonly externalAlias: string;
    readonly providerId: string;
    readonly realModelId: string;
  }): void;
  executing(): void;
  rendering(): void;
  terminal(
    outcome:
      | "success"
      | "failed"
      | "aborted"
      | "rejected-auth"
      | "unknown-alias"
      | "unavailable-alias",
    facts?: {
      readonly clientHttpStatus?: number;
      readonly piStopReason?: string;
    },
  ): void;
  terminalUsage(snapshot: NormalizedTerminalUsage): void;
  notice(notice: ConversionNotice): void;
  attempt(attempt: InvocationAttempt): void;
  fail(input: {
    readonly classification: string;
    readonly stage?: string;
    readonly error?: unknown;
  }): void;
  completed(status: number): void;
}

export interface RequestLedger {
  begin(protocolId: string): RequestLedgerEntry;
}

/** Safe handler default: preserves request-id correlation without importing
 * the broad ledger package surface. */
export function createNoopRequestLedger(): RequestLedger {
  const begin = (): RequestLedgerEntry =>
    Object.freeze({
      requestId: randomUUID(),
      authorized: () => undefined,
      aliasCaptured: () => undefined,
      modelResolved: () => undefined,
      executing: () => undefined,
      rendering: () => undefined,
      terminal: () => undefined,
      terminalUsage: () => undefined,
      notice: () => undefined,
      attempt: () => undefined,
      fail: () => undefined,
      completed: () => undefined,
    });
  return Object.freeze({ begin });
}

export type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
