import type {
  CatalogSnapshotProjection,
  CredentialProfilesProjectionV1,
} from "@luckytoken/application-control-plane/control-plane";

import type { PublicModelRuntimeFacts } from "./authority.js";

/** Project the minimum runtime facts PublicModelAuthority needs. Credential
 * Profile management owns whether one Provider has an active managed
 * credential or a locally confirmed configured ambient source;
 * Catalog owns the current Provider/model target set. Public Model owns the
 * user's Provider/model publication switches and never interprets auth or
 * Catalog lifecycle states itself. */
export function publicModelRuntimeFacts(
  catalog: CatalogSnapshotProjection,
  credentials: CredentialProfilesProjectionV1 | undefined,
): PublicModelRuntimeFacts {
  const authByProvider = new Map(
    (credentials?.providers ?? []).map((status) => [status.providerId, status] as const),
  );
  return Object.freeze({
    version: catalog.version,
    providers: Object.freeze(
      catalog.providers.map((provider) => {
        const auth = authByProvider.get(provider.providerId);
        const active = auth?.profiles.find(
          (profile) => profile.credentialId === auth.activeCredentialId,
        );
        return Object.freeze({
          providerId: provider.providerId,
          usable: auth?.implementationAvailable === true &&
            ((active?.enabled === true &&
              active.health !== "reconnect_required" &&
              active.health !== "disabled") ||
              auth.ambient?.status === "configured"),
          models: Object.freeze(provider.models.map((model) => model.id)),
        });
      }),
    ),
  });
}
