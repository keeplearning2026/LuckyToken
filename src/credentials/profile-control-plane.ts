import type { Models, Provider } from "@earendil-works/pi-ai";
import type {
  AuthInteractionChannel,
  CredentialProfileOptionsProjection,
  CredentialProfilesCommandHandler,
  CredentialProfilesCommandResult,
  ProviderProfileAuthCommandHandler,
  ProviderProfileAuthCommandOutcome,
  ProviderProfileAuthCommandResult,
  ProviderSource,
} from "@token/application-control-plane/control-plane";

import { createPiAuthInteraction } from "./auth-interaction.js";
import { LocalAcquisitionError, type AcquisitionIcon } from "./acquisition.js";
import {
  CredentialProfileOperationError,
  type CredentialProfileManagement,
  type CredentialProfilesProjection,
  type ProfileMutationResult,
  type ProviderAuthBindingAuthority,
  type ProviderAuthBindingCapture,
} from "./profile-contract.js";

export interface CredentialProfilesControlPlaneHandlers {
  readonly credentials: CredentialProfilesCommandHandler;
  readonly auth: ProviderProfileAuthCommandHandler;
}

/** One Provider-registered local acquisition method. `enabled` reflects the
 * visibility setting only; it never creates, removes or refreshes Profiles. */
export interface LocalAcquisitionMethod {
  readonly providerId: string;
  readonly label: string | undefined;
  readonly icon: AcquisitionIcon;
  readonly authType: "api_key" | "oauth";
  readonly enabled: boolean;
}

function projectOptions(
  providers: readonly Provider[],
  providerSource: (providerId: string) => ProviderSource,
  localMethods: readonly LocalAcquisitionMethod[],
  state: CredentialProfilesProjection,
): CredentialProfileOptionsProjection {
  const alreadyConnected = new Set<string>();
  for (const provider of state.providers) {
    for (const profile of provider.profiles) {
      if (profile.acquisitionKind === "local_oauth") {
        alreadyConnected.add(provider.providerId);
      }
    }
  }
  return Object.freeze({
    providers: Object.freeze(
      providers.map((provider) =>
        Object.freeze({
          providerId: provider.id,
          name: provider.name,
          source: providerSource(provider.id),
          acquisitionOptions: Object.freeze([
            ...(provider.auth.apiKey === undefined
              ? []
              : [Object.freeze({
                  kind: "api_key" as const,
                  label: provider.auth.apiKey.name,
                  icon: "key" as const,
                  authType: "api_key" as const,
                  interactive: provider.auth.apiKey.login !== undefined,
                  state: "available" as const,
                })]),
            ...(provider.auth.oauth === undefined
              ? []
              : [Object.freeze({
                  kind: "oauth" as const,
                  label: provider.auth.oauth.name,
                  icon: "account" as const,
                  authType: "oauth" as const,
                  interactive: true,
                  state: "available" as const,
                })]),
            ...localMethods
              .filter(
                (method) =>
                  method.providerId === provider.id && method.enabled,
              )
              .map((method) =>
                Object.freeze({
                  kind: "local_oauth" as const,
                  label:
                    method.label ??
                    provider.auth.oauth?.name ??
                    "Local login",
                  icon: method.icon,
                  authType: method.authType,
                  interactive: true,
                  state: alreadyConnected.has(provider.id)
                    ? ("already_connected" as const)
                    : ("available" as const),
                }),
              ),
          ]),
        }),
      ),
    ),
  });
}

function fixedMutationError(outcome: ProfileMutationResult["outcome"]): string | undefined {
  switch (outcome) {
    case "conflict":
      return "Credential Profiles changed; re-query and retry";
    case "invalid":
      return "Credential Profile input is invalid";
    case "duplicate":
      return "A matching Credential Profile already exists";
    case "unknown_provider":
      return "Provider is unknown";
    case "unknown_profile":
      return "Credential Profile is unknown";
    case "storage_failure":
      return "Credential Profile storage is unavailable";
    case "unavailable":
      return "Provider credential operation is unavailable";
    case "ok":
      return undefined;
  }
}

/** Prefer the operation's own bounded message (for example the local-login
 * singleton reminder) over the generic outcome text. */
function errorDetail(error: unknown): string | undefined {
  if (
    error instanceof LocalAcquisitionError ||
    error instanceof CredentialProfileOperationError
  ) {
    const message = error.message.trim();
    return message.length === 0 ? undefined : message.slice(0, 256);
  }
  return undefined;
}

function errorOutcome(error: unknown): ProviderProfileAuthCommandOutcome | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("outcome" in current && typeof current.outcome === "string") {
      const outcome = current.outcome;
      if (
        outcome === "conflict" ||
        outcome === "invalid" ||
        outcome === "duplicate" ||
        outcome === "unknown_provider" ||
        outcome === "unknown_profile" ||
        outcome === "storage_failure" ||
        outcome === "unavailable"
      ) {
        return outcome;
      }
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function authErrorMessage(outcome: ProviderProfileAuthCommandOutcome): string {
  switch (outcome) {
    case "cancelled":
      return "Sign-in was cancelled";
    case "conflict":
      return "Credential Profiles changed; re-query and retry";
    case "invalid":
      return "Credential Profile input is invalid";
    case "duplicate":
      return "A matching Credential Profile already exists";
    case "unknown_provider":
      return "Provider is unknown";
    case "unknown_profile":
      return "Credential Profile is unknown";
    case "storage_failure":
      return "Credential Profile storage is unavailable";
    case "unavailable":
      return "Provider credential operation is unavailable";
    case "failed":
      return "Provider sign-in did not complete";
    case "ok":
      return "";
  }
}

export function createCredentialProfilesControlPlaneHandlers(options: {
  readonly models: Pick<Models, "getProviders" | "login">;
  readonly management: CredentialProfileManagement;
  readonly binding: ProviderAuthBindingAuthority;
  /** Local acquisition methods registered by composition, with their current
   * visibility. Absent means no Provider exposes a local login. */
  readonly localAcquisitionMethods?: () => readonly LocalAcquisitionMethod[];
  readonly providerSource?: (providerId: string) => ProviderSource;
  /** Explicit user-driven, non-interactive Provider auth/model recheck. */
  readonly recheckProvider?: (
    providerId: string,
    capture: ProviderAuthBindingCapture,
  ) => Promise<"succeeded" | "failed" | "skipped">;
  /** Non-blocking post-login Catalog trigger. The capture is the exact
   * newly published Profile and is supplied only while it is active. */
  readonly postLoginProvider?: (
    providerId: string,
    capture: ProviderAuthBindingCapture,
  ) => void;
}): CredentialProfilesControlPlaneHandlers {
  const source = options.providerSource ?? (() => "user" as const);
  const localMethods = () => options.localAcquisitionMethods?.() ?? [];
  const query = () => options.management.query();
  const optionsFor = (state: CredentialProfilesProjection) =>
    projectOptions(options.models.getProviders(), source, localMethods(), state);
  const inFlight = new Set<string>();

  const recheck = async (
    command: Extract<
      Parameters<CredentialProfilesCommandHandler>[0],
      { readonly command: "recheck" }
    >,
  ): Promise<CredentialProfilesCommandResult> => {
    const before = (await options.management.query([command.providerId]))
      .providers[0];
    let outcome: CredentialProfilesCommandResult["outcome"] | undefined;
    if (before === undefined) {
      outcome = "unknown_provider";
    } else if (before.recordError !== undefined) {
      outcome = "storage_failure";
    } else if (!before.implementationAvailable || options.recheckProvider === undefined) {
      outcome = "unavailable";
    } else if (before.revision !== command.expectedRevision) {
      outcome = "conflict";
    } else {
      const profile = before.profiles.find(
        (candidate) => candidate.credentialId === command.credentialId,
      );
      if (profile === undefined) {
        outcome = "unknown_profile";
      } else if (
        before.activeCredentialId !== profile.credentialId ||
        !profile.enabled
      ) {
        outcome = "invalid";
      } else if (profile.health === "reconnect_required") {
        // There is no usable credential to check. The binding authority would
        // reject this Profile before running the Provider check, so report the
        // actionable state directly instead of misclassifying it as conflict.
        outcome = "reconnect_required";
      }
    }

    if (outcome !== undefined) {
      const state = await query();
      return Object.freeze({
        outcome,
        state,
        options: optionsFor(state),
        error:
          outcome === "storage_failure"
            ? "Credential Profile storage is unavailable"
            : outcome === "unavailable"
              ? "Provider credential recheck is unavailable"
              : outcome === "reconnect_required"
                ? "Provider authentication must be reconnected"
                : outcome === "conflict"
                  ? "Credential Profiles changed; re-query and retry"
                  : outcome === "unknown_profile"
                    ? "Credential Profile is unknown"
                    : outcome === "unknown_provider"
                      ? "Provider is unknown"
                      : "Only the enabled active Profile can be rechecked",
      });
    }

    let capture: ProviderAuthBindingCapture;
    try {
      capture = await options.binding.captureForRecheck({
        providerId: command.providerId,
        credentialId: command.credentialId,
        expectedRevision: command.expectedRevision,
      });
    } catch (error) {
      const state = await query();
      const bindingOutcome = errorOutcome(error);
      return Object.freeze({
        outcome: bindingOutcome === "storage_failure" ? "storage_failure" : "conflict",
        state,
        options: optionsFor(state),
        error: bindingOutcome === "storage_failure"
          ? "Credential Profile storage is unavailable"
          : "Credential Profiles changed; re-query and retry",
      });
    }

    let failed = false;
    try {
      failed =
        (await options.recheckProvider!(command.providerId, capture)) !==
        "succeeded";
    } catch {
      failed = true;
    }
    const state = await query();
    const after = state.providers
      .find((provider) => provider.providerId === command.providerId)
      ?.profiles.find(
        (profile) => profile.credentialId === command.credentialId,
      );
    if (after?.health === "reconnect_required") {
      return Object.freeze({
        outcome: "reconnect_required",
        state,
        options: optionsFor(state),
        error: "Provider authentication must be reconnected",
      });
    }
    return Object.freeze({
      outcome: failed ? "unavailable" : "ok",
      state,
      options: optionsFor(state),
      ...(failed ? { error: "Provider credential recheck did not complete" } : {}),
    });
  };

  const credentials: CredentialProfilesCommandHandler = async (
    command,
  ): Promise<CredentialProfilesCommandResult> => {
    if (command.command === "query") {
      const state = await options.management.query(command.providerIds);
      return Object.freeze({
        outcome: "ok",
        state,
        options: optionsFor(state),
      });
    }
    if (command.command === "recheck") {
      return recheck(command);
    }

    let mutation: ProfileMutationResult;
    switch (command.command) {
      case "update_metadata":
        mutation = await options.management.updateMetadata(command);
        break;
      case "activate":
        mutation = await options.management.activate(command);
        break;
      case "set_enabled":
        mutation = await options.management.setEnabled(command);
        break;
      case "set_priority":
        mutation = await options.management.setPriority(command);
        break;
      case "reorder_profiles":
        mutation = await options.management.reorderProfiles(command);
        break;
      case "remove":
        mutation = await options.management.remove(command);
        break;
      case "set_switch_policy":
        mutation = await options.management.setSwitchPolicy(command);
        break;
    }
    const state = await query();
    const error = mutation.outcome === "ok"
      ? undefined
      : mutation.error ?? fixedMutationError(mutation.outcome) ??
        "Credential Profile operation failed";
    return Object.freeze({
      outcome: mutation.outcome,
      state,
      options: optionsFor(state),
      ...(error === undefined ? {} : { error }),
    });
  };

  const auth: ProviderProfileAuthCommandHandler = async (
    command,
    interaction: AuthInteractionChannel,
  ): Promise<ProviderProfileAuthCommandResult> => {
    if (command.command === "query") {
      const state = await query();
      return Object.freeze({
        outcome: "ok",
        state,
        options: optionsFor(state),
      });
    }
    if (inFlight.has(command.providerId)) {
      const state = await query();
      return Object.freeze({
        outcome: "conflict",
        state,
        options: optionsFor(state),
        error: authErrorMessage("conflict"),
      });
    }

    inFlight.add(command.providerId);
    try {
      const binding = command.command === "login"
        ? await options.binding.createLoginBinding({
            providerId: command.providerId,
            acquisitionKind: command.acquisitionKind,
            displayName: command.displayName,
            ...(command.note === undefined ? {} : { note: command.note }),
            useNow: command.useNow,
            expectedRevision: command.expectedRevision,
          })
        : await options.binding.createReconnectBinding({
            providerId: command.providerId,
            credentialId: command.credentialId,
            useNow: command.useNow,
            expectedRevision: command.expectedRevision,
          });
      let published = {
        credentialId: binding.credentialId,
        credentialGeneration: binding.credentialGeneration,
      };
      if (binding.acquisitionKind === "local_oauth") {
        interaction.signal.throwIfAborted();
        published = await options.binding.acquireLocal(
          binding,
          interaction.signal,
        );
      } else {
        await options.binding.runBound(binding, () =>
          options.models.login(
            command.providerId,
            binding.authType,
            createPiAuthInteraction(interaction),
          ),
        );
      }
      if (options.postLoginProvider !== undefined) {
        try {
          const capture = await options.binding.capture(command.providerId);
          if (
            capture.facts.kind === "managed" &&
            capture.facts.credentialId === published.credentialId &&
            capture.facts.credentialGeneration === published.credentialGeneration
          ) {
            options.postLoginProvider(command.providerId, capture);
          }
        } catch {
          // Login publication is authoritative. A concurrent selection or
          // scheduling race suppresses only the optional background refresh.
        }
      }
      const state = await query();
      const profile = state.providers.find((item) => item.providerId === command.providerId)
        ?.profiles.find((item) => item.credentialId === published.credentialId);
      return Object.freeze({
        outcome: profile?.health === "reconnect_required" ? "unavailable" : "ok",
        state,
        options: optionsFor(state),
        ...(profile?.health === "reconnect_required" ? { error: authErrorMessage("unavailable") } : {}),
      });
    } catch (error) {
      const outcome = interaction.signal.aborted
        ? "cancelled"
        : (errorOutcome(error) ?? "failed");
      const state = await query();
      return Object.freeze({
        outcome,
        state,
        options: optionsFor(state),
        error: errorDetail(error) ?? authErrorMessage(outcome),
      });
    } finally {
      inFlight.delete(command.providerId);
    }
  };

  return Object.freeze({ credentials, auth });
}
