#!/usr/bin/env node

import { stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startLuckyTokenApplication } from "./application.js";
import { createControlPlaneDiscovery } from "./control-plane-discovery.js";
import { runProfileCli } from "./credentials/profile-cli.js";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ControlPlaneClient,
  type HistoryRange,
  type ModelsCommand,
  type PublicModelsCommand,
  type RuntimeCommand,
  type SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";

async function readControlPlaneDescriptor(path: string) {
  const endpoint = await createControlPlaneDiscovery({ path }).read();
  if (endpoint === undefined) {
    throw new Error("Failed to read Control Plane descriptor");
  }
  return endpoint;
}

const HELP = `LuckyToken

Usage:
  luckytoken --config <path>
  luckytoken control status --descriptor <path>
  luckytoken control <start|stop|restart> --descriptor <path>
  luckytoken control auto-start <status|enable|disable> --descriptor <path>
  luckytoken control settings <query|set> [<key> <value>] --descriptor <path>
  luckytoken control models <query|write-raw|write-structured> [<revision> <file>] --descriptor <path>
  luckytoken control profiles <query|add|reconnect|rename|activate|enable|disable|priority|remove|recheck|settings> ... --descriptor <path>
  luckytoken control catalog <query|refresh-background|refresh-manual> --descriptor <path>
  luckytoken control public-models <query|set-port|set-provider|set-model|rename|restore> ... --descriptor <path>
  luckytoken control history <query|export|export-confirm|delete|delete-confirm|acknowledge> ... --descriptor <path>
  luckytoken control backup <ordinary|full|confirm> ... --descriptor <path>
  luckytoken --help

Commands:
  serve    Start the local Client Protocol service (default)
  control status  Read the local Control Plane status snapshot
  control start|stop|restart  Manage the model gateway through the Control Plane
  control auto-start status|enable|disable  Query or change Windows login auto-start
  control settings query|set  Read or change registered Settings through the Control Plane
  control models query|write-raw|write-structured  Read or write the canonical models.json through the Control Plane
  control profiles ...  Manage Provider credential Profiles through the Control Plane
  control catalog query|refresh-background|refresh-manual  Read the active catalog snapshot or trigger a refresh
  control public-models ...  Read or change the live Public Model authority
  control history query|export|export-confirm|delete|delete-confirm|acknowledge  Export, delete, or acknowledge permanent history state
  control backup ordinary|full|confirm  Create a redacted or explicitly confirmed full-sensitive backup

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --owner <kind>   Ownership identity for serve: cli (default) or desktop
  --descriptor <path>  Control-command discovery descriptor
  --help           Show this help

control models commands:
  query                     Print the authoritative models.json state
  write-raw <rev> <file>    Validate and atomically replace models.json with the
                            file's raw content (compare-and-swap on <rev>)
  write-structured <rev> <file>  Replace models.json with the providers record in
                            <file> (compare-and-swap on <rev>, formatted)

control profiles commands:
  query                     Print sanitized Provider/Profile state
  add|reconnect             Run a Provider-owned auth flow for one Profile
  rename|activate|enable|disable|priority|remove|recheck|settings
                            Mutate one Provider record with optimistic concurrency

control catalog commands:
  query                     Print the active catalog snapshot
  refresh-background        Schedule a non-blocking background refresh
  refresh-manual            Run a forced refresh with per-Provider results

control public-models commands:
  query                     Print the live Public Model state
  set-port <rev> <port>     Change the Public endpoint port
  set-provider <rev> <provider> <on|off>
  set-model <rev> <provider> <model> <on|off>
  rename <rev> <provider> <model> <name>
  restore <rev> <provider> <model>

control history commands:
  query [--all|--from <ms>|--to <ms>]
                            Count eligible request, diagnostic, and capture records
  export <file> (--all|--from <ms>|--to <ms>) [--include-capture] [--overwrite]
                            Write one versioned export; capture is excluded by default
  export-confirm <actionId> Confirm a pending sensitive-capture export
  delete (--all|--from <ms>|--to <ms>)
                            Preview an irreversible history deletion
  delete-confirm <actionId> Confirm a pending irreversible deletion
  acknowledge               Silence persistence urgency without claiming recovery
`;

interface ParsedCliArguments {
  readonly command: "serve";
  readonly configPath: string;
  readonly ownerKind: "cli" | "desktop";
  readonly desktopExe?: string;
  readonly createFirstRunConfig: boolean;
}

function parseArguments(
  args: readonly string[],
): ParsedCliArguments | undefined {
  if (args.includes("--help")) return undefined;
  let configPath: string | undefined;
  let ownerKind: "cli" | "desktop" = "cli";
  let desktopExe: string | undefined;
  let createFirstRunConfig = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--config") {
      if (configPath !== undefined)
        throw new Error("--config may be provided once");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--config requires a path");
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (argument === "--owner") {
      const value = args[index + 1];
      if (value !== "cli" && value !== "desktop") {
        throw new Error("--owner requires 'cli' or 'desktop'");
      }
      ownerKind = value;
      index += 1;
      continue;
    }
    if (argument === "--desktop-exe") {
      if (desktopExe !== undefined) {
        throw new Error("--desktop-exe may be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--desktop-exe requires a path");
      }
      desktopExe = value;
      index += 1;
      continue;
    }
    if (argument === "--create-first-run-config") {
      createFirstRunConfig = true;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (configPath === undefined) throw new Error("--config <path> is required");
  const first = positional[0];
  if (first !== undefined && first !== "serve") {
    throw new Error(`Unknown command: ${first}`);
  }
  const expectedPositionals = first === "serve" ? 1 : 0;
  if (positional.length > expectedPositionals) {
    throw new Error("Too many arguments for serve");
  }
  return {
    command: "serve",
    configPath,
    ownerKind,
    createFirstRunConfig,
    ...(desktopExe === undefined ? {} : { desktopExe }),
  };
}

function backendBuildIdFromEnvironment(): string | undefined {
  const value = process.env.LUCKYTOKEN_BACKEND_BUILD_ID;
  if (value === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("LUCKYTOKEN_BACKEND_BUILD_ID is invalid");
  }
  return value;
}

async function runServe(
  configPath: string,
  ownerKind: "cli" | "desktop" = "cli",
  desktopExe?: string,
  createFirstRunConfig = false,
  buildId?: string,
): Promise<void> {
  const started = await startLuckyTokenApplication({
    configPath,
    ownerKind,
    ...(desktopExe === undefined ? {} : { desktopExe }),
    ...(buildId === undefined ? {} : { buildId }),
    createFirstRunConfig,
    events: {
      onRoute: (route) => {
        stdout.write(
          `LuckyToken ${route.method} ${route.origin}${route.pathname}\n`,
        );
      },
      onAttached: (ownership) => {
        const owner = ownership?.owner;
        stdout.write(
          `LuckyToken is already running: attached to the active instance${
            owner === undefined
              ? ""
              : ` owned by PID ${owner.pid} (${owner.kind})`
          }. No second Data Plane was started.\n`,
        );
      },
    },
  });
  if (started.kind === "attached") return;

  const application = started.application;
  let finishSignal: (() => void) | undefined;
  const signal = new Promise<void>((resolveSignal) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      finishSignal = undefined;
      resolveSignal();
    };
    finishSignal = finish;
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });

  const first = await Promise.race([
    signal.then(() => "signal" as const),
    application.exited.then(() => "application" as const),
  ]);
  const exit =
    first === "signal"
      ? await application.requestShutdown()
      : await application.exited;
  if (first !== "signal" && finishSignal !== undefined) {
    process.off("SIGINT", finishSignal);
    process.off("SIGTERM", finishSignal);
  }
  if (exit.reason === "drained" || exit.reason === "timed_out") {
    stdout.write(
      `LuckyToken: application quit — ${
        exit.reason === "drained"
          ? "active requests drained"
          : "drain timed out; remaining requests aborted"
      }\n`,
    );
  }
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?[0-9]+$/u.test(value)) return Number.parseInt(value, 10);
  return value;
}

function parseSettingsCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly command: SettingsCommand;
} {
  let descriptorPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      if (descriptorPath !== undefined) {
        throw new Error("--descriptor may be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--descriptor requires a path");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined)
    throw new Error("--descriptor <path> is required");
  const action = positional[0];
  if (action === "query") {
    if (positional.length > 1)
      throw new Error("settings query takes no key arguments");
    return { descriptorPath, command: { command: "query" } };
  }
  if (action === "set") {
    const key = positional[1];
    const value = positional[2];
    if (key === undefined || value === undefined || positional.length > 3) {
      throw new Error("settings set requires <key> <value>");
    }
    return {
      descriptorPath,
      command: { command: "set", key, value: parseValue(value) },
    };
  }
  throw new Error(`Unknown settings command: ${action ?? ""}`);
}

async function runControlSettingsCommand(
  args: readonly string[],
): Promise<void> {
  const parsed = parseSettingsCommand(args);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(
        `Control Plane contract v${controlPlaneVersion} is unsupported`,
      );
    }
    const result = await client.executeSettingsCommand(parsed.command);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

async function runControlCommand(
  command: "status" | RuntimeCommand | "auto-start",
  args: readonly string[],
): Promise<void> {
  let descriptorPath: string | undefined;
  let autoStartAction: "status" | "enable" | "disable" | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--descriptor") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--descriptor requires a path");
      }
      if (descriptorPath !== undefined) {
        throw new Error("--descriptor may be provided once");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (command === "auto-start") {
      const action = args[index];
      if (action === "status" || action === "enable" || action === "disable") {
        if (autoStartAction !== undefined) {
          throw new Error("auto-start action may be provided once");
        }
        autoStartAction = action;
        continue;
      }
    }
    throw new Error(`Unknown control option: ${args[index]}`);
  }
  if (descriptorPath === undefined)
    throw new Error("--descriptor <path> is required");
  if (command === "auto-start" && autoStartAction === undefined) {
    throw new Error("auto-start requires status, enable, or disable");
  }
  const endpoint = await readControlPlaneDescriptor(descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(
        `Control Plane contract v${controlPlaneVersion} is unsupported`,
      );
    }
    const result =
      command === "status"
        ? await client.getStatus()
        : command === "auto-start"
          ? await client.executeApplicationCommand({
              command: "auto_start",
              action: autoStartAction as "status" | "enable" | "disable",
            })
          : await client.executeRuntimeCommand(command);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

function parseModelsCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly action: "query" | "write_raw" | "write_structured";
  readonly revision?: number;
  readonly file?: string;
} {
  let descriptorPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      if (descriptorPath !== undefined) {
        throw new Error("--descriptor may be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--descriptor requires a path");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) {
    throw new Error("--descriptor <path> is required");
  }
  const action = positional[0];
  if (action === "query") {
    if (positional.length > 1) {
      throw new Error("models query takes no arguments");
    }
    return { descriptorPath, action: "query" };
  }
  const revision = positional[1];
  const file = positional[2];
  if (
    (action !== "write-raw" && action !== "write-structured") ||
    !/^[0-9]+$/u.test(revision ?? "") ||
    file === undefined ||
    positional.length > 3
  ) {
    throw new Error(
      "models write-raw|write-structured requires <revision> <file>",
    );
  }
  return {
    descriptorPath,
    action: action === "write-raw" ? "write_raw" : "write_structured",
    revision: Number.parseInt(revision as string, 10),
    file,
  };
}

async function assertCompatibleControlPlane(
  client: ControlPlaneClient,
): Promise<void> {
  const hello = await client.hello(controlPlaneVersion);
  if (hello.type === "incompatible") {
    throw new Error(
      `Control Plane contract v${controlPlaneVersion} is unsupported`,
    );
  }
}

async function runControlModelsCommand(args: readonly string[]): Promise<void> {
  const parsed = parseModelsCommand(args);
  let command: ModelsCommand;
  if (parsed.action === "query") {
    command = { command: "query" };
  } else if (parsed.action === "write_raw") {
    command = {
      command: "write_raw",
      revision: parsed.revision as number,
      content: await readFile(parsed.file as string, "utf8"),
    };
  } else {
    const raw = JSON.parse(await readFile(parsed.file as string, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("write-structured requires a providers object file");
    }
    command = {
      command: "write_structured",
      revision: parsed.revision as number,
      providers: raw as Record<string, unknown>,
    };
  }
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    const result = await client.executeModelsCommand(command);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

async function runControlCatalogCommand(
  args: readonly string[],
): Promise<void> {
  const action = args[0];
  if (
    action !== "query" &&
    action !== "refresh-background" &&
    action !== "refresh-manual"
  ) {
    throw new Error(
      "control catalog requires query, refresh-background or refresh-manual",
    );
  }
  const descriptorIndex = args.indexOf("--descriptor");
  if (descriptorIndex < 0 || descriptorIndex + 1 >= args.length) {
    throw new Error("control catalog requires --descriptor <path>");
  }
  const descriptorPath = args[descriptorIndex + 1] as string;
  const endpoint = await readControlPlaneDescriptor(descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    const command =
      action === "query"
        ? ({ command: "query" } as const)
        : ({
            command: "refresh",
            mode:
              action === "refresh-background"
                ? ("background" as const)
                : ("manual" as const),
          } as const);
    const result = await client.executeCatalogCommand(command);
    stdout.write(`${JSON.stringify(result)}
`);
  } finally {
    await client.close();
  }
}

function parsePublicModelsCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly command: PublicModelsCommand;
} {
  let descriptorPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      if (descriptorPath !== undefined) throw new Error("--descriptor may be provided once");
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("--descriptor requires a path");
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
  const action = positional[0];
  if (action === "query" && positional.length === 1) {
    return { descriptorPath, command: { command: "query" } };
  }
  const revisionText = positional[1] ?? "";
  if (!/^[0-9]+$/u.test(revisionText)) throw new Error("public-models mutation requires <revision>");
  const revision = Number.parseInt(revisionText, 10);
  if (action === "set-port" && positional.length === 3 && /^[0-9]+$/u.test(positional[2] ?? "")) {
    return { descriptorPath, command: { command: "set_port", revision, port: Number.parseInt(positional[2] as string, 10) } };
  }
  if (action === "set-provider" && positional.length === 4) {
    const on = positional[3];
    if (on !== "on" && on !== "off") throw new Error("set-provider requires <on|off>");
    return { descriptorPath, command: { command: "set_provider", revision, providerId: positional[2] as string, on: on === "on" } };
  }
  if (action === "set-model" && positional.length === 5) {
    const on = positional[4];
    if (on !== "on" && on !== "off") throw new Error("set-model requires <on|off>");
    return { descriptorPath, command: { command: "set_model", revision, providerId: positional[2] as string, modelId: positional[3] as string, on: on === "on" } };
  }
  if (action === "rename" && positional.length === 5) {
    return { descriptorPath, command: { command: "rename_model", revision, providerId: positional[2] as string, modelId: positional[3] as string, modelName: positional[4] as string } };
  }
  if (action === "restore" && positional.length === 4) {
    return { descriptorPath, command: { command: "restore_model_name", revision, providerId: positional[2] as string, modelId: positional[3] as string } };
  }
  throw new Error("Invalid public-models command");
}

async function runControlPublicModelsCommand(args: readonly string[]): Promise<void> {
  const parsed = parsePublicModelsCommand(args);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    const result = await client.executePublicModelsCommand(parsed.command);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

function parseHistoryCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly action: "query" | "export" | "export-confirm" | "delete" | "delete-confirm" | "acknowledge";
  readonly range?: HistoryRange;
  readonly destinationPath?: string;
  readonly includeCapture?: boolean;
  readonly overwrite?: boolean;
  readonly actionId?: string;
} {
  let descriptorPath: string | undefined;
  let rangeFrom: number | undefined;
  let rangeTo: number | undefined;
  let all = false;
  let includeCapture = false;
  let overwrite = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      if (descriptorPath !== undefined) {
        throw new Error("--descriptor may be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--descriptor requires a path");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument === "--from" || argument === "--to") {
      const value = args[index + 1];
      if (
        value === undefined ||
        value.startsWith("-") ||
        !/^[0-9]+$/u.test(value)
      ) {
        throw new Error(`${argument} requires a non-negative epoch-ms integer`);
      }
      const parsed = Number.parseInt(value, 10);
      if (argument === "--from") rangeFrom = parsed;
      else rangeTo = parsed;
      index += 1;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--include-capture") {
      includeCapture = true;
      continue;
    }
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined)
    throw new Error("--descriptor <path> is required");
  if (rangeFrom !== undefined && rangeTo !== undefined && rangeFrom > rangeTo) {
    throw new Error("--from must not exceed --to");
  }
  const range: HistoryRange =
    all || (rangeFrom === undefined && rangeTo === undefined)
      ? "all"
      : Object.freeze({
          ...(rangeFrom === undefined ? {} : { fromMs: rangeFrom }),
          ...(rangeTo === undefined ? {} : { toMs: rangeTo }),
        });
  const action = positional[0];
  if (action === "query") {
    if (positional.length > 1) throw new Error("history query takes no arguments");
    return { descriptorPath, action: "query", range };
  }
  if (action === "export") {
    const destinationPath = positional[1];
    if (
      destinationPath === undefined ||
      positional.length > 2 ||
      !all && rangeFrom === undefined && rangeTo === undefined
    ) {
      throw new Error(
        "history export requires a destination path and an explicit range (--all or --from/--to)",
      );
    }
    return {
      descriptorPath,
      action: "export",
      range,
      destinationPath: resolve(destinationPath),
      includeCapture,
      overwrite,
    };
  }
  if (action === "export-confirm") {
    const actionId = positional[1];
    if (actionId === undefined || positional.length > 2) {
      throw new Error("history export-confirm requires the pending action id");
    }
    return { descriptorPath, action: "export-confirm", actionId };
  }
  if (action === "delete") {
    if (positional.length > 1 || (!all && rangeFrom === undefined && rangeTo === undefined)) {
      throw new Error(
        "history delete requires an explicit range (--all or --from/--to)",
      );
    }
    return { descriptorPath, action: "delete", range };
  }
  if (action === "delete-confirm") {
    const actionId = positional[1];
    if (actionId === undefined || positional.length > 2) {
      throw new Error("history delete-confirm requires the pending action id");
    }
    return { descriptorPath, action: "delete-confirm", actionId };
  }
  if (action === "acknowledge") {
    if (positional.length > 1) {
      throw new Error("history acknowledge takes no arguments");
    }
    return { descriptorPath, action: "acknowledge" };
  }
  throw new Error(`Unknown history command: ${action ?? ""}`);
}

async function runControlHistoryCommand(args: readonly string[]): Promise<void> {
  const parsed = parseHistoryCommand(args);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    let result: unknown;
    if (parsed.action === "query") {
      result = await client.queryHistory(parsed.range);
    } else if (parsed.action === "export") {
      result = await client.executeHistoryExport({
        range: parsed.range as HistoryRange,
        capture: parsed.includeCapture === true ? "included" : "excluded",
        destinationPath: parsed.destinationPath as string,
        overwrite: parsed.overwrite === true,
      });
    } else if (parsed.action === "export-confirm") {
      result = await client.confirmHistoryExport(parsed.actionId as string);
    } else if (parsed.action === "delete") {
      result = await client.executeHistoryDelete({
        range: parsed.range as HistoryRange,
      });
    } else if (parsed.action === "delete-confirm") {
      result = await client.confirmHistoryDelete(parsed.actionId as string);
    } else {
      result = await client.acknowledgePersistence();
    }
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

function parseBackupCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly action: "ordinary" | "full" | "confirm";
  readonly value: string;
  readonly overwrite: boolean;
} {
  let descriptorPath: string | undefined;
  let overwrite = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--descriptor") {
      const value = args[index + 1];
      if (descriptorPath !== undefined || value === undefined || value.startsWith("-")) {
        throw new Error("--descriptor requires one path");
      }
      descriptorPath = value;
      index += 1;
      continue;
    }
    if (argument === "--overwrite") {
      overwrite = true;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
  const action = positional[0];
  const value = positional[1];
  if (
    (action !== "ordinary" && action !== "full" && action !== "confirm") ||
    value === undefined ||
    positional.length !== 2 ||
    (action === "confirm" && overwrite)
  ) {
    throw new Error(
      "backup requires ordinary|full <destination> or confirm <actionId>",
    );
  }
  return { descriptorPath, action, value, overwrite };
}

async function runControlBackupCommand(args: readonly string[]): Promise<void> {
  const parsed = parseBackupCommand(args);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    const result =
      parsed.action === "confirm"
        ? await client.confirmBackup(parsed.value)
        : await client.executeBackup({
            mode:
              parsed.action === "ordinary" ? "ordinary" : "full_sensitive",
            destinationPath: resolve(parsed.value),
            overwrite: parsed.overwrite,
          });
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

export async function runLuckyTokenCli(
  args: readonly string[],
): Promise<void> {
  if (args[0] === "control") {
    const command = args[1];
    if (command === "settings") {
      await runControlSettingsCommand(args.slice(2));
      return;
    }
    if (command === "history") {
      await runControlHistoryCommand(args.slice(2));
      return;
    }
    if (command === "backup") {
      await runControlBackupCommand(args.slice(2));
      return;
    }
    if (command === "models") {
      await runControlModelsCommand(args.slice(2));
      return;
    }
    if (command === "profiles") {
      await runProfileCli(args.slice(2));
      return;
    }
    if (command === "catalog") {
      await runControlCatalogCommand(args.slice(2));
      return;
    }
    if (command === "public-models") {
      await runControlPublicModelsCommand(args.slice(2));
      return;
    }
    if (
      command !== "status" &&
      command !== "start" &&
      command !== "stop" &&
      command !== "restart" &&
      command !== "auto-start"
    ) {
      throw new Error(`Unknown control command: ${command ?? ""}`);
    }
    await runControlCommand(command, args.slice(2));
    return;
  }
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    stdout.write(HELP);
    return;
  }
  await runServe(
    parsed.configPath,
    parsed.ownerKind,
    parsed.desktopExe,
    parsed.createFirstRunConfig,
    backendBuildIdFromEnvironment(),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runLuckyTokenCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`LuckyToken: ${message}\n`);
    process.exitCode = 1;
  });
}
