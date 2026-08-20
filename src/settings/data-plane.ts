import type { RegisteredSetting } from "./catalog.js";

export const DATA_PLANE_LOOPBACK_HOST = "127.0.0.1";

export interface EffectiveDataPlaneAddress {
  readonly host: string;
  readonly port: number;
}

/**
 * Resolve the effective Data Plane address from the registered settings.
 * Only the declared effective values are used; the fixed configured port is
 * authoritative and there is no random or default fallback.
 */
export function resolveEffectiveSettings(
  settings: Readonly<Record<string, RegisteredSetting>>,
): EffectiveDataPlaneAddress {
  const portSetting = settings["server.port"];
  const port =
    portSetting === undefined
      ? 3000
      : Number(portSetting.effective ?? portSetting.value);
  return Object.freeze({ host: DATA_PLANE_LOOPBACK_HOST, port });
}

export function protocolEnabled(
  settings: Readonly<Record<string, RegisteredSetting>>,
  key: `protocols.${string}.enabled`,
): boolean {
  const setting = settings[key];
  return setting === undefined ? true : Boolean(setting.value);
}
