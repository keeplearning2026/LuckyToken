import type {
  ApplicationStatus,
  DataPlaneFailure,
  DataPlaneStatus,
  RuntimeCommand,
  RuntimeCommandExecution,
  RuntimeCommandHandler,
  RuntimeStatusPublisher,
} from "@luckytoken/application-control-plane/control-plane";

export interface RunningDataPlaneListener {
  close(): Promise<void>;
}

export interface DataPlaneRuntimeSupervisor {
  readonly initialStatus: ApplicationStatus;
  readonly execute: RuntimeCommandHandler;
}

export interface DataPlaneAddress {
  readonly host: string;
  readonly port: number;
}

export interface DataPlaneRuntimeSupervisorOptions {
  readonly host: string;
  readonly port: number;
  readonly provider: ApplicationStatus["provider"];
  /** Resolves the effective bind address at each start/restart. When omitted,
   *  the fixed configured host and port are used (Ticket 03 semantics). The
   *  resolution is authoritative: there is no random or default fallback. */
  readonly resolveAddress?: () => DataPlaneAddress;
  readonly startListener: (
    address: DataPlaneAddress,
  ) => Promise<RunningDataPlaneListener>;
}

const failureMessages: Readonly<Record<DataPlaneFailure["code"], string>> = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
};

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

export function createDataPlaneRuntimeSupervisor(
  options: DataPlaneRuntimeSupervisorOptions,
): DataPlaneRuntimeSupervisor {
  const configuredAddress = (): DataPlaneAddress =>
    options.resolveAddress === undefined
      ? Object.freeze({ host: options.host, port: options.port })
      : options.resolveAddress();
  const displayHost = (host: string): string =>
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const configured = (address: DataPlaneAddress): ApplicationStatus["dataPlane"] =>
    Object.freeze({
      configuredOrigin: `http://${displayHost(address.host)}:${address.port}`,
      configuredPort: address.port,
    });
  const status = (
    modelDataPlane: ApplicationStatus["modelDataPlane"],
    failure?: DataPlaneFailure,
  ): ApplicationStatus =>
    Object.freeze({
      modelDataPlane,
      provider: options.provider,
      dataPlane: {
        ...configured(configuredAddress()),
        ...(failure === undefined
          ? {}
          : { failure: Object.freeze(failure) }),
      } as DataPlaneStatus,
    });
  const initialStatus = status("stopped");
  let current = initialStatus;
  let listener: RunningDataPlaneListener | undefined;
  let operationQueue = Promise.resolve();

  const transition = async (
    next: ApplicationStatus,
    publishStatus: RuntimeStatusPublisher,
  ): Promise<void> => {
    current = next;
    await publishStatus(next);
  };

  const failStart = async (
    error: unknown,
    publishStatus: RuntimeStatusPublisher,
  ): Promise<RuntimeCommandExecution> => {
    const code =
      errorCode(error) === "EADDRINUSE" ? "port_in_use" : "start_failed";
    await transition(
      status("failed", { code, message: failureMessages[code] }),
      publishStatus,
    );
    return { outcome: "failed" };
  };

  const start = async (
    publishStatus: RuntimeStatusPublisher,
  ): Promise<RuntimeCommandExecution> => {
    if (current.modelDataPlane === "running") return { outcome: "unchanged" };
    if (current.dataPlane?.failure?.code === "stop_failed") {
      return {
        outcome: "conflict",
        conflict: {
          code: "application_restart_required",
          message: "Restart LuckyToken before starting the model gateway again.",
        },
      };
    }
    await transition(status("starting"), publishStatus);
    try {
      listener = await options.startListener(configuredAddress());
    } catch (error) {
      listener = undefined;
      return failStart(error, publishStatus);
    }
    await transition(status("running"), publishStatus);
    return { outcome: "completed" };
  };

  const stop = async (
    publishStatus: RuntimeStatusPublisher,
  ): Promise<RuntimeCommandExecution> => {
    if (current.modelDataPlane === "stopped") return { outcome: "unchanged" };
    if (current.modelDataPlane === "failed") {
      if (current.dataPlane?.failure?.code === "stop_failed") {
        return { outcome: "unchanged" };
      }
      await transition(status("stopped"), publishStatus);
      return { outcome: "completed" };
    }
    await transition(status("stopping"), publishStatus);
    const active = listener;
    listener = undefined;
    try {
      await active?.close();
    } catch {
      await transition(
        status("failed", {
          code: "stop_failed",
          message: failureMessages.stop_failed,
        }),
        publishStatus,
      );
      return { outcome: "failed" };
    }
    await transition(status("stopped"), publishStatus);
    return { outcome: "completed" };
  };

  const restart = async (
    publishStatus: RuntimeStatusPublisher,
  ): Promise<RuntimeCommandExecution> => {
    if (current.modelDataPlane !== "running") {
      return {
        outcome: "conflict",
        conflict: {
          code: "restart_requires_running",
          message: "Start the model gateway before restarting it.",
        },
      };
    }
    await transition(status("stopping"), publishStatus);
    const active = listener;
    listener = undefined;
    try {
      await active?.close();
    } catch {
      await transition(
        status("failed", {
          code: "stop_failed",
          message: failureMessages.stop_failed,
        }),
        publishStatus,
      );
      return { outcome: "failed" };
    }
    await transition(status("starting"), publishStatus);
    try {
      listener = await options.startListener(configuredAddress());
    } catch (error) {
      return failStart(error, publishStatus);
    }
    await transition(status("running"), publishStatus);
    return { outcome: "completed" };
  };

  const perform = (
    command: RuntimeCommand,
    publishStatus: RuntimeStatusPublisher,
  ): Promise<RuntimeCommandExecution> => {
    switch (command) {
      case "start":
        return start(publishStatus);
      case "stop":
        return stop(publishStatus);
      case "restart":
        return restart(publishStatus);
    }
  };

  const execute: RuntimeCommandHandler = (command, publishStatus) => {
    const operation = operationQueue.then(() => perform(command, publishStatus));
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({ initialStatus, execute });
}
