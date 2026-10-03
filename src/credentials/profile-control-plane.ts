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
import {
  LocalAcquisitionError,
  type AcquisitionIcon,
} from "./acquisition.js";
import {
  CredentialManagementBusyError,
  CredentialManagementCancelledError,
  type CredentialManagementGuard,
  type CredentialManagementOperationKind,
} from "./management.js";
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

export interface LocalAcquisitionMethod {
  readonly providerId: string;
  readonly label: string | undefined;
  readonly icon: AcquisitionIcon;
}

function projectOptions(
  providers: readonly Provider[],
  providerSource: (providerId: string) => ProviderSource,
  localMethods: readonly LocalAcquisitionMethod[],
  state: CredentialProfilesProjection,
): CredentialProfileOptionsProjection {
  const alreadyConnected = new Set<string>();
  for (const provider of state.providers) {
    if (
      provider.profiles.some(
        (profile) => profile.acquisitionKind === "local_oauth",
      )
    ) {
      alreadyConnected.add(provider.providerId);
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
              : [
                  Object.freeze({
                    kind: "api_key" as const,
                    label: provider.auth.apiKey.name,
                    icon: "key" as const,
                    authType: "api_key" as const,
                    interactive: provider.auth.apiKey.login !== undefined,
                    state: "available" as const,
                  }),
                ]),
            ...(provider.auth.oauth === undefined
              ? []
              : [
                  Object.freeze({
                    kind: "oauth" as const,
                    label: provider.auth.oauth.name,
                    icon: "account" as const,
                    authType: "oauth" as const,
                    interactive: true,
                    state: "available" as const,
                  }),
                ]),
            ...localMethods
              .filter((method) => method.providerId === provider.id)
              .map((method) =>
                Object.freeze({
                  kind: "local_oauth" as const,
                  label:
                    method.label ??
                    provider.auth.oauth?.name ??
                    "Local login",
                  icon: method.icon,
                  authType: "oauth" as const,
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

function fixedMutationError(
  outcome: ProfileMutationResult["outcome"],
): string | undefined {
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

function errorOutcome(
  error: unknown,
): ProviderProfileAuthCommandOutcome | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    if ("outcome" in current && typeof current.outcome === "string") {
      const outcome = current.outcome;
      if (
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
    case "invalid":
      return "Credential Profile input is invalid";
    case "duplicate":
      return "A matching Credential Profile already exists";
    case "unknown_provider":
      return "Provider is unknown";
    case "unknown_profile":
      return "Credential Profile is unknown";
    case "management_operation_in_progress":
      return "Another credential management operation is still in progress";
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

function managementKind(
  command: Exclude<
    Parameters<CredentialProfilesCommandHandler>[0],
    { readonly command: "query" | "cancel_management" }
  >,
): CredentialManagementOperationKind {
  switch (command.command) {
    case "update_metadata":
      return "update_metadata";
    case "activate":
      return "activate";
    case "set_enabled":
      return "set_enabled";
    case "reorder_profiles":
      return "reorder";
    case "remove":
      return "remove";
    case "set_switch_policy":
      return "set_switch_policy";
  }
}

export function createCredentialProfilesControlPlaneHandlers(options: {
  readonly models: Pick<Models, "getProviders" | "login">;
  readonly management: CredentialProfileManagement;
  readonly binding: ProviderAuthBindingAuthority;
  readonly managementGuard: CredentialManagementGuard;
  readonly localAcquisitionMethods?: () => readonly LocalAcquisitionMethod[];
  readonly providerSource?: (providerId: string) => ProviderSource;
  readonly postLoginProvider?: (
    providerId: string,
    capture: ProviderAuthBindingCapture,
  ) => void;
}): CredentialProfilesControlPlaneHandlers {
  const source = options.providerSource ?? (() => "user" as const);
  const localMethods = () => options.localAcquisitionMethods?.() ?? [];
  const query = () => options.management.query();
  const optionsFor = (state: CredentialProfilesProjection) =>
    projectOptions(
      options.models.getProviders(),
      source,
      localMethods(),
      state,
    );

  const busyCredentialResult = async (
    error: CredentialManagementBusyError,
  ): Promise<CredentialProfilesCommandResult> => {
    const state = await query();
    return Object.freeze({
      outcome: "management_operation_in_progress" as const,
      state,
      options: optionsFor(state),
      activeOperation: error.activeOperation,
      error: "Another credential management operation is still in progress",
    });
  };

  const busyAuthResult = async (
    error: CredentialManagementBusyError,
  ): Promise<ProviderProfileAuthCommandResult> => {
    const state = await query();
    return Object.freeze({
      outcome: "management_operation_in_progress" as const,
      state,
      options: optionsFor(state),
      activeOperation: error.activeOperation,
      error: authErrorMessage("management_operation_in_progress"),
    });
  };

  const credentials: CredentialProfilesCommandHandler = async (
    command,
  ): Promise<CredentialProfilesCommandResult> => {
    if (command.command === "query") {
      const state = await options.management.query(command.providerIds);
      return Object.freeze({
        outcome: "ok" as const,
        state,
        options: optionsFor(state),
      });
    }

    if (command.command === "cancel_management") {
      const cancelled = options.managementGuard.cancel(command.operationId);
      const state = await query();
      return Object.freeze({
        outcome: cancelled ? ("ok" as const) : ("unknown_operation" as const),
        state,
        options: optionsFor(state),
        ...(cancelled
          ? {}
          : { error: "Credential management operation is unknown" }),
      });
    }

    try {
      return await options.managementGuard.run(
        {
          kind: managementKind(command),
          providerId: command.providerId,
        },
        async () => {
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
          const error =
            mutation.outcome === "ok"
              ? undefined
              : mutation.error ??
                fixedMutationError(mutation.outcome) ??
                "Credential Profile operation failed";
          return Object.freeze({
            outcome: mutation.outcome,
            state,
            options: optionsFor(state),
            ...(error === undefined ? {} : { error }),
          });
        },
      );
    } catch (error) {
      if (error instanceof CredentialManagementBusyError) {
        return busyCredentialResult(error);
      }
      const state = await query();
      return Object.freeze({
        outcome: "storage_failure" as const,
        state,
        options: optionsFor(state),
        error: "Credential Profile operation failed",
      });
    }
  };

  const auth: ProviderProfileAuthCommandHandler = async (
    command,
    interaction: AuthInteractionChannel,
  ): Promise<ProviderProfileAuthCommandResult> => {
    if (command.command === "query") {
      const state = await query();
      return Object.freeze({
        outcome: "ok" as const,
        state,
        options: optionsFor(state),
      });
    }

    const operationKind: CredentialManagementOperationKind =
      command.acquisitionKind === "local_oauth"
        ? "acquire_local_oauth"
        : command.acquisitionKind === "api_key"
          ? "acquire_api_key"
          : "acquire_oauth";

    let operationSignal: AbortSignal | undefined;
    try {
      return await options.managementGuard.run(
        {
          kind: operationKind,
          providerId: command.providerId,
          signal: interaction.signal,
        },
        async (signal) => {
          operationSignal = signal;
          let credentialId: string;

          if (command.acquisitionKind === "local_oauth") {
            const method = localMethods().find(
              (candidate) =>
                candidate.providerId === command.providerId,
            );
            if (method === undefined) {
              throw new CredentialProfileOperationError(
                "unavailable",
                "Local OAuth acquisition is unavailable",
              );
            }
            const result = await options.management.acquireLocal({
              providerId: command.providerId,
              displayName: command.displayName,
              ...(command.note === undefined ? {} : { note: command.note }),
              signal,
            });
            if (result.outcome !== "ok") {
              throw new CredentialProfileOperationError(
                result.outcome,
                result.error ??
                  fixedMutationError(result.outcome) ??
                  "Local OAuth acquisition failed",
              );
            }
            const provider = result.provider;
            const created = provider?.profiles.find(
              (profile) =>
                profile.acquisitionKind === "local_oauth" &&
                profile.displayName === command.displayName,
            );
            if (created === undefined) {
              throw new CredentialProfileOperationError(
                "storage_failure",
                "Local OAuth Profile publication could not be verified",
              );
            }
            credentialId = created.credentialId;
          } else {
            const acquisition = await options.binding.createAcquisitionBinding({
              providerId: command.providerId,
              acquisitionKind: command.acquisitionKind,
              displayName: command.displayName,
              ...(command.note === undefined ? {} : { note: command.note }),
            });
            credentialId = acquisition.credentialId;
            const authType =
              command.acquisitionKind === "api_key" ? "api_key" : "oauth";
            await options.binding.runBound(acquisition, () =>
              options.models.login(
                command.providerId,
                authType,
                createPiAuthInteraction({
                  ...interaction,
                  signal,
                }),
              ),
            );
          }

          if (options.postLoginProvider !== undefined) {
            try {
              const state = await options.management.query([
                command.providerId,
              ]);
              const provider = state.providers[0];
              if (provider?.activeCredentialId === credentialId) {
                const capture = await options.binding.capture(
                  command.providerId,
                );
                if (
                  capture.facts.kind === "profile" &&
                  capture.facts.credentialId === credentialId
                ) {
                  options.postLoginProvider(
                    command.providerId,
                    capture,
                  );
                }
              }
            } catch {
              // Optional background catalog scheduling never changes the
              // authoritative Profile publication outcome.
            }
          }

          const state = await query();
          return Object.freeze({
            outcome: "ok" as const,
            state,
            options: optionsFor(state),
          });
        },
      );
    } catch (error) {
      if (error instanceof CredentialManagementBusyError) {
        return busyAuthResult(error);
      }
      const cancelled =
        interaction.signal.aborted ||
        operationSignal?.reason instanceof CredentialManagementCancelledError;
      const outcome: ProviderProfileAuthCommandOutcome =
        cancelled ? "cancelled" : errorOutcome(error) ?? "failed";
      const state = await query();
      return Object.freeze({
        outcome,
        state,
        options: optionsFor(state),
        error: errorDetail(error) ?? authErrorMessage(outcome),
      });
    }
  };

  return Object.freeze({ credentials, auth });
}
