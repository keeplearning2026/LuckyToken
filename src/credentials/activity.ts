import type { ExecutionFactsSink } from "@token/provider-contract/diagnostics";

/** Secret-free credential lifecycle facts owned by the credential boundary. */
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

const activityByExecutionFacts = new WeakMap<
  ExecutionFactsSink,
  CredentialActivitySink
>();

export function bindCredentialActivityToExecutionFacts(
  facts: ExecutionFactsSink,
  activity: CredentialActivitySink,
): void {
  activityByExecutionFacts.set(facts, activity);
}

export function credentialActivityForExecutionFacts(
  facts: ExecutionFactsSink | undefined,
): CredentialActivitySink | undefined {
  return facts === undefined ? undefined : activityByExecutionFacts.get(facts);
}
