import type { Model, Models } from "@earendil-works/pi-ai";

import type { PublicModelSnapshot } from "./public-models/authority.js";
import { resolveModel } from "./model-resolution.js";

/** Narrow immutable Public Model source captured once per request. */
export interface PublicModelSource {
  requestSnapshot(): Promise<PublicModelSnapshot>;
}

export type PublicModelResolution =
  | {
      readonly kind: "model";
      readonly alias: string;
      readonly model: Model<string>;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "unavailable" };

/** Resolve one selector for one request. Without a Public Model source the
 * direct provider/model selector contract remains available as a test seam. */
export async function resolveDataPlanePublicModel(
  models: Models,
  publicModels: PublicModelSource | undefined,
  selector: string,
): Promise<PublicModelResolution> {
  if (publicModels === undefined) {
    return {
      kind: "model",
      alias: selector,
      model: resolveModel(models, selector),
    };
  }
  return resolvePublicModel(models, await publicModels.requestSnapshot(), selector);
}

/** Publication state intentionally does not participate in request
 * resolution: an OFF alias remains directly callable while its target still
 * exists in the served Pi catalog. */
export function resolvePublicModel(
  models: Pick<Models, "getModels">,
  snapshot: PublicModelSnapshot,
  selector: string,
): PublicModelResolution {
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
