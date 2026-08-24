import type { RequestJourneyObserver } from "../../diagnostics/contract.js";

export interface DirectResponsesCompactLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: Uint8Array<ArrayBuffer>;
    readonly selector: string;
    readonly journey?: RequestJourneyObserver;
  }): Promise<Response>;
}
