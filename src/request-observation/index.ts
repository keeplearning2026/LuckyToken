import type { RequestIdentityFact, RequestIdentityRecord } from "@luckytoken/application-control-plane/control-plane";

export {
  projectRequestIdentity,
  type RequestIdentityFact,
  type RequestIdentityProjection,
  type RequestIdentityRecord,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Request identity observation (Ticket 17 identity seam; Ticket 18 handoff).
 *
 * Ticket 18 will build the permanent Request Lifecycle Ledger on top of
 * this public contract. The seam fixes the identity semantics now:
 *
 * - `RequestIdentityFact` carries ONLY the optional client-provided session
 *   identity (`clientSessionId`) and the canonical project context. The
 *   internal `effectiveSessionId` (the always-present Pi invocation
 *   identity) is not a field of this contract, so no ledger, wire decoder,
 *   or renderer projection can ever substitute it for the client's ID.
 * - `projectRequestIdentity` (shared with the renderer through the Control
 *   Plane package) renders a missing client identity as `-`.
 * - The observer keeps a bounded ring of the most recent identities and
 *   freezes every record.
 */

export interface RequestIdentityObserver {
  /** Records one authorized request identity; never called for denied
   *  requests. Returns the observer for chaining. */
  observe(
    protocolId: string,
    fact: RequestIdentityFact,
  ): RequestIdentityObserver;
  /** Newest-first bounded projection input, oldest retained entries last. */
  list(): readonly RequestIdentityRecord[];
}

export interface RequestIdentityObserverOptions {
  readonly capacity?: number;
  readonly now?: () => number;
}

export function createRequestIdentityObserver(
  options: RequestIdentityObserverOptions = {},
): RequestIdentityObserver {
  const capacity = options.capacity ?? 50;
  const now = options.now ?? Date.now;
  let nextId = 1;
  const records: RequestIdentityRecord[] = [];
  const live: RequestIdentityObserver = Object.freeze({
    observe(
      protocolId: string,
      fact: RequestIdentityFact,
    ): RequestIdentityObserver {
      if (typeof protocolId !== "string" || protocolId.length === 0) {
        throw new Error("protocolId must be a non-empty string");
      }
      if (records.length >= capacity) records.shift();
      records.push(
        Object.freeze({
          id: nextId,
          time: now(),
          protocolId,
          ...(fact.clientSessionId === undefined
            ? {}
            : { clientSessionId: fact.clientSessionId }),
          ...(fact.projectDir === undefined
            ? {}
            : { projectDir: fact.projectDir }),
        }),
      );
      nextId += 1;
      return live;
    },
    list(): readonly RequestIdentityRecord[] {
      return Object.freeze([...records].reverse());
    },
  });
  return live;
}
