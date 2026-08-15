import {
  controlPlaneVersion,
  type ApplicationIdentity,
  type ApplicationStatus,
  type HelloResult,
  type StatusEvent,
  type StatusSnapshot,
} from "./contracts.js";

export type RecordValue = Record<string, unknown>;

export type ClientRequest =
  | {
      readonly type: "hello";
      readonly requestId: string;
      readonly contractVersion: number;
      readonly capability: string;
    }
  | { readonly type: "get_status"; readonly requestId: string }
  | { readonly type: "subscribe"; readonly requestId: string }
  | { readonly type: "unsubscribe"; readonly requestId: string };

export type ControlPlaneErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "hello_required"
  | "unknown_command";

export type ServerMessage =
  | {
      readonly type: "hello_result";
      readonly requestId: string;
      readonly result: HelloResult;
    }
  | {
      readonly type: "status_result";
      readonly requestId: string;
      readonly snapshot: StatusSnapshot;
    }
  | { readonly type: "subscribed"; readonly requestId: string }
  | { readonly type: "unsubscribed"; readonly requestId: string }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly code: ControlPlaneErrorCode;
    }
  | { readonly type: "event"; readonly event: StatusEvent };

export type DecodedClientRequest =
  | { readonly type: "valid"; readonly request: ClientRequest }
  | {
      readonly type: "invalid";
      readonly requestId: string;
      readonly code: "invalid_request" | "unknown_command";
    };

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeRequestId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

export function decodeApplicationStatus(
  value: unknown,
): ApplicationStatus | undefined {
  if (
    !isRecord(value) ||
    (value.provider !== "configured" && value.provider !== "unconfigured") ||
    (value.modelDataPlane !== "stopped" &&
      value.modelDataPlane !== "running" &&
      value.modelDataPlane !== "stopping")
  ) {
    return undefined;
  }
  return {
    modelDataPlane: value.modelDataPlane,
    provider: value.provider,
  };
}

export function decodeClientRequest(value: unknown): DecodedClientRequest {
  if (!isRecord(value)) {
    return { type: "invalid", requestId: "", code: "invalid_request" };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined || typeof value.type !== "string") {
    return {
      type: "invalid",
      requestId: requestId ?? "",
      code: "invalid_request",
    };
  }
  if (value.type === "hello") {
    if (
      !Number.isSafeInteger(value.contractVersion) ||
      typeof value.capability !== "string"
    ) {
      return { type: "invalid", requestId, code: "invalid_request" };
    }
    return {
      type: "valid",
      request: {
        type: "hello",
        requestId,
        contractVersion: value.contractVersion as number,
        capability: value.capability,
      },
    };
  }
  if (
    value.type === "get_status" ||
    value.type === "subscribe" ||
    value.type === "unsubscribe"
  ) {
    return { type: "valid", request: { type: value.type, requestId } };
  }
  return { type: "invalid", requestId, code: "unknown_command" };
}

export function compatibleHello(
  application: ApplicationIdentity,
): HelloResult {
  return {
    type: "compatible",
    application,
    contractVersion: controlPlaneVersion,
  };
}

export function incompatibleHello(requestedVersion: number): HelloResult {
  return {
    type: "incompatible",
    requestedVersion,
    supportedVersions: [controlPlaneVersion],
  };
}

export function decodeHello(value: unknown): HelloResult | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.type === "incompatible" &&
    typeof value.requestedVersion === "number" &&
    Number.isSafeInteger(value.requestedVersion) &&
    Array.isArray(value.supportedVersions) &&
    value.supportedVersions.length === 1 &&
    value.supportedVersions[0] === controlPlaneVersion
  ) {
    return {
      type: "incompatible",
      requestedVersion: value.requestedVersion,
      supportedVersions: [controlPlaneVersion],
    };
  }
  if (
    value.type === "compatible" &&
    value.contractVersion === controlPlaneVersion &&
    isRecord(value.application) &&
    value.application.id === "luckytoken" &&
    typeof value.application.version === "string"
  ) {
    return {
      type: "compatible",
      application: {
        id: "luckytoken",
        version: value.application.version,
      },
      contractVersion: controlPlaneVersion,
    };
  }
  return undefined;
}

export function decodeSnapshot(value: unknown): StatusSnapshot | undefined {
  const safeStatus = decodeApplicationStatus(value);
  const sequence = isRecord(value) ? value.sequence : undefined;
  return safeStatus !== undefined &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? { ...safeStatus, sequence }
    : undefined;
}

export function decodeEvent(value: unknown): StatusEvent | undefined {
  if (
    !isRecord(value) ||
    value.type !== "status_changed" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence)
  ) {
    return undefined;
  }
  const snapshot = decodeSnapshot(value.snapshot);
  return snapshot !== undefined && snapshot.sequence === value.sequence
    ? {
        type: "status_changed",
        sequence: value.sequence,
        snapshot,
      }
    : undefined;
}

export function decodeServerMessage(value: unknown): ServerMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "event") {
    const event = decodeEvent(value.event);
    return event === undefined ? undefined : { type: "event", event };
  }
  const requestId = decodeRequestId(value.requestId);
  if (requestId === undefined) return undefined;
  if (value.type === "hello_result") {
    const result = decodeHello(value.result);
    return result === undefined
      ? undefined
      : { type: "hello_result", requestId, result };
  }
  if (value.type === "status_result") {
    const snapshot = decodeSnapshot(value.snapshot);
    return snapshot === undefined
      ? undefined
      : { type: "status_result", requestId, snapshot };
  }
  if (value.type === "subscribed" || value.type === "unsubscribed") {
    return { type: value.type, requestId };
  }
  if (
    value.type === "error" &&
    (value.code === "invalid_request" ||
      value.code === "unauthorized" ||
      value.code === "hello_required" ||
      value.code === "unknown_command")
  ) {
    return { type: "error", requestId, code: value.code };
  }
  return undefined;
}
