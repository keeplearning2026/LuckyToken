import {
  assertControlPlaneEndpoint,
  type ControlPlaneEndpoint,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseControlPlaneDescriptor(value: unknown): ControlPlaneEndpoint {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "address,capability" ||
    typeof value.address !== "string" ||
    typeof value.capability !== "string"
  ) {
    throw new Error("Invalid Control Plane descriptor");
  }
  const endpoint = Object.freeze({
    address: value.address,
    capability: value.capability,
  });
  try {
    assertControlPlaneEndpoint(endpoint);
  } catch {
    throw new Error("Invalid Control Plane descriptor");
  }
  return endpoint;
}
