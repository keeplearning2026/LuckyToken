import { randomUUID } from "node:crypto";

import type {
  ConversionNotice,
  ExecutionFactsSink,
  InvocationAttempt,
} from "@luckytoken/provider-contract/diagnostics";
import type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
export interface CredentialActivityCapture {
  readonly credentialId: string;
  readonly displayName: string;
  readonly authType: "api_key" | "oauth";
  readonly authMethodLabel: string;
  readonly lane: "provider_native" | "semantic_conversion";
  readonly selectionReason: "active" | "http_429_switch";
}

export interface CredentialActivityAttempt extends CredentialActivityCapture {
  readonly attempt: number;
  readonly outcome: "success" | "http_429" | "failed" | "aborted";
}

export interface CredentialActivitySink {
  credentialCaptured(capture: CredentialActivityCapture): void;
  credentialAttempt(attempt: CredentialActivityAttempt): void;
}

/** Stable, secret-free request attribution used only for observation. */
export interface LedgerProfileAttribution {
  readonly profileId: string;
  readonly displayName: string;
}

// The public execution contract remains the neutral ExecutionFactsSink.
// Composition records the associated credential-observation capability in
// this consumer-owned registry instead of relying on undeclared properties.
const credentialActivityByExecutionFacts = new WeakMap<
  ExecutionFactsSink,
  CredentialActivitySink
>();

export function bindCredentialActivityToExecutionFacts(
  facts: ExecutionFactsSink,
  activity: CredentialActivitySink,
): void {
  credentialActivityByExecutionFacts.set(facts, activity);
}

export function credentialActivityForExecutionFacts(
  facts: ExecutionFactsSink | undefined,
): CredentialActivitySink | undefined {
  return facts === undefined
    ? undefined
    : credentialActivityByExecutionFacts.get(facts);
}

/** Handler-local lifecycle facts. Persistence and public query DTOs remain
 * outside this consumer-owned seam. */
export interface RequestLedgerEntry extends CredentialActivitySink {
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
  profileAttributed(attribution: LedgerProfileAttribution): void;
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
      profileAttributed: () => undefined,
      executing: () => undefined,
      rendering: () => undefined,
      terminal: () => undefined,
      terminalUsage: () => undefined,
      notice: () => undefined,
      attempt: () => undefined,
      credentialCaptured: () => undefined,
      credentialAttempt: () => undefined,
      fail: () => undefined,
      completed: () => undefined,
    });
  return Object.freeze({ begin });
}

export type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
