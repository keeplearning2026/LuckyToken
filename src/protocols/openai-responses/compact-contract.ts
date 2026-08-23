import type { RequestJourneyObserver } from "../../diagnostics/contract.js";

export interface LocalResponsesCompactLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: string;
    readonly selector: string;
    readonly journey?: RequestJourneyObserver;
  }): Promise<Response>;
}
