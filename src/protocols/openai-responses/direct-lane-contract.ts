import type { RequestJourneyObserver } from "../../diagnostics/contract.js";

/** The narrow Direct Mode lane contract the Responses protocol claims
 *  through. It carries no conversion, Pi, credential, or transport import, so
 *  the lane can implement it without reaching the composed protocol module. */
export interface DirectResponsesLane {
  claims(selector: string): boolean;
  execute(input: {
    readonly request: Request;
    readonly rawBody: Uint8Array<ArrayBuffer>;
    readonly selector: string;
    readonly streamRequested: boolean;
    readonly journey?: RequestJourneyObserver;
  }): Promise<Response>;
}
