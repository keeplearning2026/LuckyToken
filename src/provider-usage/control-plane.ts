import type {
  ProviderUsageCommandHandler,
  ProviderUsageProfileProjection,
} from "@token/application-control-plane/control-plane";

import type {
  ProviderUsageAuthority,
  ProviderUsageState,
} from "./contract.js";

function projectState(
  state: ProviderUsageState,
): ProviderUsageProfileProjection {
  if (state.state === "observed") {
    return Object.freeze({
      providerId: state.providerId,
      credentialId: state.credentialId,
      state: "observed",
      observedAt: state.observation.observedAt,
      refreshable: state.refreshable,
      windows: state.observation.windows,
      budgets: state.observation.budgets,
    });
  }
  if (state.state === "unobserved") {
    return Object.freeze({
      providerId: state.providerId,
      credentialId: state.credentialId,
      state: "unobserved",
    });
  }
  if (state.state === "unsupported") {
    return Object.freeze({
      providerId: state.providerId,
      credentialId: state.credentialId,
      state: "unsupported",
      reason: state.reason,
    });
  }
  return Object.freeze({
    providerId: state.providerId,
    credentialId: state.credentialId,
    state: "unavailable",
    reason: state.reason,
  });
}

export function createProviderUsageControlPlaneHandler(
  authority: ProviderUsageAuthority,
): ProviderUsageCommandHandler {
  return async (command, signal) => {
    if (command.command === "query") {
      const snapshot = await authority.query();
      return Object.freeze({
        outcome: "ok" as const,
        snapshot: Object.freeze({
          profiles: Object.freeze(snapshot.profiles.map(projectState)),
        }),
      });
    }
    const result = await authority.refresh(command.providerId, signal);
    return Object.freeze({
      outcome: "ok" as const,
      snapshot: Object.freeze({
        profiles: Object.freeze(result.snapshot.profiles.map(projectState)),
      }),
      refresh: result.refresh,
    });
  };
}
