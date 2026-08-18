import type { Provider } from "@earendil-works/pi-ai";

import type {
  AuthOptionsProjection,
  AuthProviderOption,
  ProviderAuthStatus,
  ProviderSource,
} from "@luckytoken/application-control-plane/control-plane";

/**
 * Ticket 13 — per-Provider login option projection.
 *
 * Pure metadata projection: `account` exists exactly when the Provider
 * declares an OAuth login, `subscription` is true exactly when Provider
 * metadata (`oauth.isSubscription`) marks it as a true subscription, and
 * the labels are the Provider's own declarations. No renderer label, and
 * no OAuth/account flow, can ever be mislabeled as a subscription here.
 * The effective status facts are the Ticket 12 authority rows (which the
 * caller has already refreshed); nothing secret is projected.
 */
export function projectAuthProviderOption(
  provider: Provider,
  status: ProviderAuthStatus,
  source: ProviderSource,
): AuthProviderOption {
  const oauth = provider.auth.oauth;
  const apiKey = provider.auth.apiKey;
  return Object.freeze({
    providerId: provider.id,
    name: provider.name,
    source,
    account: oauth !== undefined,
    subscription: oauth?.isSubscription === true,
    ...(oauth === undefined || (oauth.loginLabel === undefined && oauth.name === undefined)
      ? {}
      : { accountLabel: oauth.loginLabel ?? oauth.name }),
    apiKey: apiKey !== undefined,
    ...(apiKey === undefined ? {} : { apiKeyLabel: apiKey.name }),
    status,
  });
}

/** Projects one provider catalog against refreshed authority status rows. */
export function projectAuthOptions(
  providers: readonly Provider[],
  statuses: readonly ProviderAuthStatus[],
  sourceFor: (providerId: string) => ProviderSource,
): AuthOptionsProjection {
  const byId = new Map(statuses.map((row) => [row.providerId, row]));
  return Object.freeze({
    providers: Object.freeze(
      providers.map((provider) => {
        const status =
          byId.get(provider.id) ??
          Object.freeze({
            providerId: provider.id,
            stored: false,
            environment: false,
            modelsJson: false,
            commandDerived: false,
            expired: false,
            unavailable: true,
            effectiveSource: "none",
          } as ProviderAuthStatus);
        return projectAuthProviderOption(provider, status, sourceFor(provider.id));
      }),
    ),
  });
}
