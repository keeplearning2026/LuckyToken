import type {
  ProviderUsageCommandHandler,
  ProviderUsageProviderProjection,
} from "@token/application-control-plane/control-plane";

import type {
  ProviderUsageAuthority,
  ProviderUsageState,
} from "./contract.js";

function projectState(state: ProviderUsageState): ProviderUsageProviderProjection {
  if (state.state === "observed") {
    return Object.freeze({
      providerId: state.observation.providerId,
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
      state: "unobserved",
    });
  }
  if (state.state === "unsupported") {
    return Object.freeze({
      providerId: state.providerId,
      state: "unsupported",
      reason: state.reason,
    });
  }
  return Object.freeze({
    providerId: state.providerId,
    state: "unavailable",
    reason: state.reason,
  });
}

export function createProviderUsageControlPlaneHandler(
  authority: ProviderUsageAuthority,
): ProviderUsageCommandHandler {
  return async (command) => {
    if (command.command === "query") {
      const snapshot = await authority.query();
      return Object.freeze({
        outcome: "ok" as const,
        snapshot: Object.freeze({
          providers: Object.freeze(snapshot.providers.map(projectState)),
        }),
      });
    }
    const result = await authority.refresh(command.providerId);
    return Object.freeze({
      outcome: "ok" as const,
      snapshot: Object.freeze({
        providers: Object.freeze(result.snapshot.providers.map(projectState)),
      }),
      refresh: result.refresh,
    });
  };
}
