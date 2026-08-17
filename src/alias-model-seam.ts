import type { Model, Models } from "@earendil-works/pi-ai";

import type { AliasResolverSnapshot } from "./aliases/authority.js";
import { resolveModel } from "./model-resolution.js";

/**
 * Ticket 15 alias-only data plane seam — the one shared resolution step of
 * the two Client Protocol handlers and the shared model discovery surface.
 *
 * The composition root wires the narrow source over the Ticket 14 alias
 * authority; the handlers never see the authority itself. At request
 * acceptance the handler captures one immutable resolver snapshot
 * (`requestSnapshot` refreshes and hot-applies observed alias/catalog
 * changes first), then resolves the selector against that captured
 * snapshot plus the current served catalog. New requests see current
 * state; in-flight requests keep the snapshot, the alias, and the captured
 * canonical Model they resolved at acceptance.
 *
 * Semantics:
 *
 * - only configured aliases are valid selectors: a selector that the
 *   captured snapshot does not resolve is `unknown`. Alias text is opaque
 *   and may itself look like `provider/model_id`; such a value is callable
 *   only when it is explicitly configured as an alias. Bare or canonical-
 *   looking strings are never resolved implicitly against the Pi catalog;
 * - a configured alias whose canonical target is not in the current served
 *   catalog snapshot is `unavailable` (the Ticket 11 snapshot is the one
 *   callable-catalog authority; the alias registry never invents targets);
 * - a resolved alias yields the canonical Pi Model from the served catalog,
 *   so the invocation continues through the standard Pi Provider path.
 */
export interface AliasModelSource {
  /** Refresh and hot-apply observed alias/catalog changes, then return the
   *  captured resolver snapshot for this request. */
  requestSnapshot(): Promise<AliasResolverSnapshot>;
}

export type AliasModelResolution =
  | {
      readonly kind: "model";
      /** The accepted external alias (never a Provider/model identity). */
      readonly alias: string;
      readonly model: Model<string>;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable" };

/**
 * Resolve one selector for one request. Without a wired alias source the
 * legacy selector contract applies (handler-level test seam); with one, the
 * request is alias-only.
 */
export async function resolveDataPlaneModel(
  models: Models,
  aliasSource: AliasModelSource | undefined,
  selector: string,
): Promise<AliasModelResolution> {
  if (aliasSource === undefined) {
    // Legacy handler-level seam: the selector is the canonical
    // provider/model selector; ModelResolutionFailure surfaces as before.
    return {
      kind: "model",
      alias: selector,
      model: resolveModel(models, selector),
    };
  }
  const snapshot = await aliasSource.requestSnapshot();
  return resolveAliasModel(models, snapshot, selector);
}

/** Resolve one alias against one captured snapshot and the current served
 *  catalog. Pure and synchronous: the caller owns both inputs. */
export function resolveAliasModel(
  models: Pick<Models, "getModels">,
  snapshot: AliasResolverSnapshot,
  selector: string,
): AliasModelResolution {
  const target = snapshot.resolve(selector);
  if (target === undefined) return { kind: "unknown" };
  const model = models
    .getModels()
    .find(
      (candidate) =>
        candidate.provider === target.providerId &&
        candidate.id === target.modelId,
    );
  if (model === undefined) return { kind: "unavailable" };
  return { kind: "model", alias: selector, model };
}
