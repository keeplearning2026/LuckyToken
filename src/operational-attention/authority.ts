import type {
  ApplicationStatus,
  AttentionCondition,
  AttentionProjection,
  CredentialProfilesProjectionV1,
  PersistenceProjection,
} from "@luckytoken/application-control-plane/control-plane";
import { RECENT_REQUEST_FAILURE_WINDOW_MS } from "@luckytoken/application-control-plane/control-plane";

export interface OperationalAttentionAuthorityOptions {
  readonly now?: () => number;
  readonly credentials: () => CredentialProfilesProjectionV1 | undefined;
  readonly persistence: () => PersistenceProjection | undefined;
  readonly requestFailureCount: (from: number, to: number) => number;
}

export interface OperationalAttentionAuthority {
  project(status: ApplicationStatus): AttentionProjection | undefined;
}

interface Candidate {
  readonly id: string;
  readonly category: AttentionCondition["category"];
  readonly page: AttentionCondition["page"];
  readonly providerId?: string;
}

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

/** Owns the process-lifetime actionable fault episodes. */
export function createOperationalAttentionAuthority(
  options: OperationalAttentionAuthorityOptions,
): OperationalAttentionAuthority {
  const now = options.now ?? Date.now;
  const episodeStarts = new Map<string, number>();
  const providerWasEffective = new Map<string, boolean>();
  const providerInvalidEpisodes = new Set<string>();

  return Object.freeze({
    project(status: ApplicationStatus): AttentionProjection | undefined {
      const currentTime = safeNow(now);
      const candidates: Candidate[] = [];
      const failureCode = status.dataPlane?.failure?.code;
      if (status.modelDataPlane === "failed" && failureCode === "start_failed") {
        candidates.push({
          id: "gateway-start-failed",
          category: "gateway-start-failed",
          page: "dashboard",
        });
      } else if (
        status.modelDataPlane === "failed" &&
        failureCode === "port_in_use"
      ) {
        candidates.push({
          id: "port-conflict",
          category: "port-conflict",
          page: "dashboard",
        });
      }

      let persistence: PersistenceProjection | undefined;
      try {
        persistence = options.persistence();
      } catch {
        persistence = undefined;
      }
      if (persistence?.auditUnavailable === true) {
        candidates.push({
          id: "persistence-critical",
          category: "persistence-critical",
          page: "diagnostics",
        });
      }

      let credentialProjection: CredentialProfilesProjectionV1 | undefined;
      try {
        credentialProjection = options.credentials();
      } catch {
        credentialProjection = undefined;
      }
      const visibleProviders = new Set<string>();
      for (const provider of credentialProjection?.providers ?? []) {
        if (!PROVIDER_ID.test(provider.providerId)) continue;
        visibleProviders.add(provider.providerId);
        if (provider.profiles.length === 0) {
          providerWasEffective.delete(provider.providerId);
          providerInvalidEpisodes.delete(provider.providerId);
          continue;
        }
        const active = provider.profiles.find(
          (profile) => profile.credentialId === provider.activeCredentialId,
        );
        const effective = provider.implementationAvailable &&
          active?.enabled === true &&
          active.health !== "reconnect_required" &&
          active.health !== "disabled";
        const previous = providerWasEffective.get(provider.providerId);
        if (effective) {
          providerWasEffective.set(provider.providerId, true);
          providerInvalidEpisodes.delete(provider.providerId);
        } else {
          if (previous === true) providerInvalidEpisodes.add(provider.providerId);
          if (previous === undefined) providerWasEffective.set(provider.providerId, false);
        }
        if (providerInvalidEpisodes.has(provider.providerId)) {
          candidates.push({
            id: `provider-login-invalid:${provider.providerId}`,
            category: "provider-login-invalid",
            page: "providers",
            providerId: provider.providerId,
          });
        }
      }
      for (const providerId of [...providerWasEffective.keys()]) {
        if (!visibleProviders.has(providerId)) {
          providerWasEffective.delete(providerId);
          providerInvalidEpisodes.delete(providerId);
        }
      }

      const activeIds = new Set(candidates.map((candidate) => candidate.id));
      for (const id of [...episodeStarts.keys()]) {
        if (!activeIds.has(id)) episodeStarts.delete(id);
      }
      const conditions = candidates.map((candidate) => {
        const since = episodeStarts.get(candidate.id) ?? currentTime;
        episodeStarts.set(candidate.id, since);
        return Object.freeze({ ...candidate, since }) satisfies AttentionCondition;
      });

      let failureCount: number | undefined;
      try {
        const candidate = options.requestFailureCount(
          Math.max(0, currentTime - RECENT_REQUEST_FAILURE_WINDOW_MS),
          Math.min(Number.MAX_SAFE_INTEGER, currentTime + 1),
        );
        if (Number.isSafeInteger(candidate) && candidate >= 0) {
          failureCount = candidate;
        }
      } catch {
        failureCount = undefined;
      }
      if (conditions.length === 0 && (failureCount ?? 0) === 0) return undefined;
      return Object.freeze({
        conditions: Object.freeze(conditions),
        ...(failureCount === undefined || failureCount === 0
          ? {}
          : {
              requestFailures: Object.freeze({
                count: failureCount,
                windowMs: RECENT_REQUEST_FAILURE_WINDOW_MS,
              }),
            }),
      });
    },
  });
}
