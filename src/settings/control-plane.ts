import type {
  LanConfirmation,
  RegisteredSetting,
  SettingsCommand,
  SettingsCommandHandler,
  SettingsCommandOutcome,
} from "@luckytoken/application-control-plane/control-plane";

import type { SettingsRegistry } from "./catalog.js";

/**
 * Adapts the registered settings registry to the Control Plane settings
 * command channel. The registry is the sole authority on keys, validation,
 * sensitivity, and apply modes; this adapter only maps the closed outcomes
 * and projection onto the versioned wire contract.
 */
export function createSettingsControlPlaneHandler(
  registry: SettingsRegistry,
): SettingsCommandHandler {
  return async (
    command: SettingsCommand,
  ): Promise<{
    readonly outcome: SettingsCommandOutcome;
    readonly error?: string;
    readonly confirmation?: LanConfirmation;
    readonly settings: Readonly<Record<string, RegisteredSetting>>;
  }> => {
    if (command.command === "query") {
      return {
        outcome: "ok",
        settings: registry.query(command.keys ?? []),
      };
    }
    if (command.command === "set") {
      const result = await registry.set(command.key, command.value, undefined);
      return {
        outcome: result.outcome,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.confirmation === undefined
          ? {}
          : { confirmation: result.confirmation }),
        settings: result.settings,
      };
    }
    const confirmed = await registry.confirm({
      actionId: command.actionId,
      token: undefined,
    });
    return {
      outcome: confirmed.outcome,
      ...(confirmed.error === undefined ? {} : { error: confirmed.error }),
      settings: confirmed.settings,
    };
  };
}
