import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from "@earendil-works/pi-ai";
import type {
  AuthInteractionChannel,
  AuthInteractionEvent,
} from "@token/application-control-plane/control-plane";

/** Adapts the write-only Control Plane interaction channel to Pi. */
export function createPiAuthInteraction(
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
