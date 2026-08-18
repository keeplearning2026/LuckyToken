/**
 * Provider readiness (Provider Activation Specification v1.0 §14) — the one
 * pure derivation of the coarse product Provider summary.
 *
 * `ApplicationStatus.provider` means:
 *
 * - `configured` — at least one model in the current authoritative Catalog
 *   snapshot is available for use under current Provider authentication;
 * - `unconfigured` — otherwise.
 *
 * This is deliberately a pure function of the authoritative Catalog
 * snapshot: no second mutable Provider-ready state authority exists, and
 * the coarse flag is never expanded into a duplicate status model. Gateway
 * lifecycle (stopped/failed) is a separate fact and never erases an
 * otherwise connected Provider/model capability.
 */

import type { CatalogSnapshotProjection } from "@luckytoken/application-control-plane/control-plane";

export type ProviderReadiness = "configured" | "unconfigured";

export function providerReadiness(
  snapshot: CatalogSnapshotProjection,
): ProviderReadiness {
  return snapshot.providers.some((catalogProvider) =>
    catalogProvider.models.some(
      (model) => model.availability === "available",
    ),
  )
    ? "configured"
    : "unconfigured";
}
