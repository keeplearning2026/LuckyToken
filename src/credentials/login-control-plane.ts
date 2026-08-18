import type {
  AuthCommand,
  AuthCommandHandler,
  AuthCommandResult,
  AuthInteractionChannel,
  AuthInteractionEvent,
  CredentialProjection,
  ProviderSource,
} from "@luckytoken/application-control-plane/control-plane";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Models,
} from "@earendil-works/pi-ai";

import type { LiveCredentialAuthority } from "./authority.js";
import { projectAuthOptions } from "./auth-options.js";

/**
 * Ticket 13 — Provider-owned auth login through the Control Plane.
 *
 * The Provider owns every authentication step: this handler only adapts
 * the typed interaction channel to Pi's `AuthInteraction` contract, runs
 * `Models.login` (which persists through the same store the Ticket 12
 * Credential Authority wraps — no second credential authority), refreshes
 * the authority's effective status, and maps every outcome to a value-safe
 * closed result. Failure messages are fixed templates; raw Provider errors
 * (which can embed upstream response bodies) never cross the wire. Only
 * the targeted Provider's slot can change; cancellation and failure never
 * delete anything.
 */
export function createAuthLoginControlPlaneHandler(options: {
  /** The served Pi Models; its `login` persists through the authority's
   *  store and its Ticket 11 login seam schedules the catalog refresh. */
  readonly models: () => Models | undefined;
  /** The single serialized Credential Authority (Ticket 12). */
  readonly authority: () => LiveCredentialAuthority | undefined;
  /** Provider product source classification (Spec v1.0 §9). */
  readonly providerSource?: (providerId: string) => ProviderSource;
}): AuthCommandHandler {
  // Per-Provider in-flight guard: a second login for the same Provider is
  // refused instead of racing the Provider-owned flow.
  const inFlight = new Set<string>();

  return async (
    command: AuthCommand,
    interaction: AuthInteractionChannel,
  ): Promise<AuthCommandResult> => {
    const authority = options.authority();
    if (authority === undefined) {
      return unavailableResult();
    }
    if (command.command === "query") {
      const models = options.models();
      if (models === undefined) return unavailableResult();
      const state = (await authority.query()).state;
      return Object.freeze({
        outcome: "ok",
        state,
        options: projectAuthOptions(
          models.getProviders(),
          state.providers,
          options.providerSource ?? (() => "user" as ProviderSource),
        ),
      });
    }
    // login
    const models = options.models();
    if (models === undefined) return unavailableResult();
    const provider = models
      .getProviders()
      .find((entry) => entry.id === command.providerId);
    if (provider === undefined) {
      return Object.freeze({
        outcome: "unknown_provider",
        state: authority.snapshot(),
        error: `Unknown Provider: ${command.providerId}`,
      });
    }
    const method =
      command.authType === "oauth"
        ? provider.auth.oauth
        : provider.auth.apiKey;
    if (method?.login === undefined) {
      return Object.freeze({
        outcome: "unsupported",
        state: authority.snapshot(),
        error: `${provider.name} does not support ${command.authType} login`,
      });
    }
    if (inFlight.has(command.providerId)) {
      return Object.freeze({
        outcome: "conflict",
        state: authority.snapshot(),
        error: "A sign-in is already in progress for this Provider",
      });
    }
    inFlight.add(command.providerId);
    try {
      const piInteraction = createPiAuthInteraction(interaction);
      await models.login(command.providerId, command.authType, piInteraction);
      // The login replaced the Provider's slot through the same store the
      // authority wraps: refresh the authoritative projection so the
      // published status and subsequent queries observe the new credential.
      const state = (await authority.query()).state;
      return Object.freeze({ outcome: "ok", state });
    } catch {
      // Value-safe outcomes only: a user cancellation, a lost connection,
      // or a Provider failure never leak raw error text or any code value.
      const state = authority.snapshot();
      if (interaction.signal.aborted) {
        return Object.freeze({
          outcome: "cancelled",
          state,
          error: "Sign-in was cancelled",
        });
      }
      return Object.freeze({
        outcome: "failed",
        state,
        error:
          "Sign-in did not complete. Check the Provider's requirements and try again.",
      });
    } finally {
      inFlight.delete(command.providerId);
    }
  };
}

function unavailableResult(): AuthCommandResult {
  const state: CredentialProjection = Object.freeze({
    revision: 0,
    path: "",
    present: false,
    valid: false,
    providers: Object.freeze([]),
  });
  return Object.freeze({
    outcome: "unavailable",
    state,
    error: "Provider sign-in is unavailable",
  });
}

/** Maps the typed channel onto Pi's `AuthInteraction` contract. `notify`
 *  is fire-and-forget (Pi never awaits it); a lost connection aborts the
 *  flow through the channel's signal instead. */
function createPiAuthInteraction(
  channel: AuthInteractionChannel,
): AuthInteraction {
  return Object.freeze({
    signal: channel.signal,
    prompt: (prompt: AuthPrompt) =>
      channel.prompt({
        kind: prompt.type,
        message: prompt.message,
        ...(prompt.type === "select"
          ? {
              options: prompt.options.map((option) =>
                Object.freeze({
                  id: option.id,
                  label: option.label,
                  ...(option.description === undefined
                    ? {}
                    : { description: option.description }),
                }),
              ),
            }
          : prompt.placeholder === undefined
            ? {}
            : { placeholder: prompt.placeholder }),
      }),
    notify: (event: AuthEvent) => {
      void channel.notify(projectAuthEvent(event));
    },
  });
}

function projectAuthEvent(event: AuthEvent): AuthInteractionEvent {
  switch (event.type) {
    case "info":
      return Object.freeze({
        type: "info",
        message: event.message,
        ...(event.links === undefined
          ? {}
          : {
              links: Object.freeze(
                event.links.map((link) =>
                  Object.freeze({
                    url: link.url,
                    ...(link.label === undefined ? {} : { label: link.label }),
                  }),
                ),
              ),
            }),
      });
    case "auth_url":
      return Object.freeze({
        type: "auth_url",
        url: event.url,
        ...(event.instructions === undefined
          ? {}
          : { instructions: event.instructions }),
      });
    case "device_code":
      return Object.freeze({
        type: "device_code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        ...(event.intervalSeconds === undefined
          ? {}
          : { intervalSeconds: event.intervalSeconds }),
        ...(event.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: event.expiresInSeconds }),
      });
    case "progress":
      return Object.freeze({ type: "progress", message: event.message });
  }
}
