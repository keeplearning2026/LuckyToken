export interface DeepCaptureBeginInput {
  readonly requestId: string;
  readonly protocolId: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
}

export interface DeepCaptureEntry {
  readonly requestId: string;
  readonly decision: Readonly<{ enabled: boolean; acceptedAt: number }>;
  requestBody(body: string): void;
  response(
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): void;
  fail(classification: string): void;
  finalize(): void;
}

export interface DeepCaptureAuthority {
  begin(input: DeepCaptureBeginInput): DeepCaptureEntry;
}

export function createNoopCaptureEntry(requestId: string): DeepCaptureEntry {
  return Object.freeze({
    requestId,
    decision: Object.freeze({ enabled: false, acceptedAt: 0 }),
    requestBody: () => undefined,
    response: () => undefined,
    fail: () => undefined,
    finalize: () => undefined,
  });
}

export function createNoopDeepCaptureAuthority(): DeepCaptureAuthority {
  return Object.freeze({
    begin: (input: DeepCaptureBeginInput) =>
      createNoopCaptureEntry(input.requestId),
  });
}
