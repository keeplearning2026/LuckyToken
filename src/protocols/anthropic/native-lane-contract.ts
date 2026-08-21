import type { Model } from "@earendil-works/pi-ai";

export interface AnthropicNativeDiagnostic {
  readonly upstreamStatus?: number;
  readonly safeRequestId?: string;
  /** Diagnostics-only cause; an adapter response must never render it. */
  readonly error?: unknown;
}

export type AnthropicNativeExecutionResult =
  | {
      readonly outcome: "success";
      readonly response: Response;
    }
  | {
      readonly outcome: "failed";
      readonly response: Response;
      readonly diagnostic?: AnthropicNativeDiagnostic;
    };

/** Consumer-owned port for the Anthropic Provider Native preservation lane. */
export interface AnthropicProviderNativeLane {
  claims(model: Model<string>): boolean;
  execute(input: {
    readonly model: Model<string>;
    readonly rawBody: string;
    readonly request: Request;
    readonly alias?: string;
    readonly requestId: string;
    readonly onExecutionStart: () => void;
  }): Promise<AnthropicNativeExecutionResult>;
}

