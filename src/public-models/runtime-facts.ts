import type {
  CatalogSnapshotProjection,
  CredentialProjection,
} from "@luckytoken/application-control-plane/control-plane";

import type { PublicModelRuntimeFacts } from "./authority.js";

/** Project the minimum runtime facts PublicModelAuthority needs. Credential
 * Authority owns whether one Provider currently has effective authentication;
 * Catalog owns the current Provider/model target set. Public Model owns the
 * user's Provider/model publication switches and never interprets auth or
 * Catalog lifecycle states itself. */
export function publicModelRuntimeFacts(
  catalog: CatalogSnapshotProjection,
  credentials: CredentialProjection | undefined,
): PublicModelRuntimeFacts {
  const authByProvider = new Map(
    (credentials?.providers ?? []).map((status) => [status.providerId, status] as const),
  );
  return Object.freeze({
    version: catalog.version,
    providers: Object.freeze(
      catalog.providers.map((provider) => {
        const auth = authByProvider.get(provider.providerId);
        return Object.freeze({
          providerId: provider.providerId,
          usable: auth !== undefined && !auth.unavailable && !auth.expired,
          models: Object.freeze(provider.models.map((model) => model.id)),
        });
      }),
    ),
  });
}
