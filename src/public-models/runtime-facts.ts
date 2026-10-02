import type {
  CatalogSnapshotProjection,
  CredentialProfilesProjection,
} from "@token/application-control-plane/control-plane";
import type { PublicModelRuntimeFacts } from "./authority.js";

/** Project the minimum runtime facts PublicModelAuthority needs. Credential
 * Profile management owns the active credential selection and source health;
 * Catalog owns the current Provider/model target set. Public Model owns the
 * user's Provider/model publication switches and never interprets auth or
 * Catalog lifecycle states itself. */
export function publicModelRuntimeFacts(
  catalog: CatalogSnapshotProjection,
  credentials: CredentialProfilesProjection | undefined,
): PublicModelRuntimeFacts {
  const authByProvider = new Map(
    (credentials?.providers ?? []).map((status) => [status.providerId, status] as const),
  );
  return Object.freeze({
    version: catalog.version,
    providers: Object.freeze(
      catalog.providers.map((provider) => {
        const auth = authByProvider.get(provider.providerId);
        const selected = auth?.profiles.find(
          (profile) => profile.credentialId === auth.activeCredentialId,
        );
        const profileUsable = selected?.enabled === true;
        const ambientUsable =
          auth?.profiles.length === 0 &&
          auth.ambient?.status === "configured";
        return Object.freeze({
          providerId: provider.providerId,
          usable:
            auth?.implementationAvailable === true &&
            (profileUsable || ambientUsable),
          models: Object.freeze(provider.models.map((model) => model.id)),
        });
      }),
    ),
  });
}
