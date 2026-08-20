#!/usr/bin/env node

import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { startLuckyTokenApplication } from "./application.js";
import { loadLuckyTokenCliConfig } from "./cli-config.js";
import { readControlPlaneDescriptor } from "./control-plane-discovery.js";
import { runCredentialCli } from "./credentials/cli.js";
import { runAuthCli } from "./credentials/auth-cli.js";
import { createConfiguredPiModels } from "./composition.js";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  type ControlPlaneClient,
  type HistoryRange,
  type ModelsCommand,
  type RuntimeCommand,
  type SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";
import { stripJsonComments } from "./providers/models-json-schema.js";

const HELP = `LuckyToken

Usage:
  luckytoken --config <path>
  luckytoken login [provider] --config <path>
  luckytoken logout [provider] --config <path>
  luckytoken control status --descriptor <path>
  luckytoken control <start|stop|restart> --descriptor <path>
  luckytoken control auto-start <status|enable|disable> --descriptor <path>
  luckytoken control settings <query|set|confirm> [<key> <value>] --descriptor <path>
  luckytoken control models <query|write-raw|write-structured> [<revision> <file>] --descriptor <path>
  luckytoken control credentials <query|login|logout|import> ... --descriptor <path>
  luckytoken control auth <query|login> ... --descriptor <path>
  luckytoken control catalog <query|refresh-background|refresh-manual> --descriptor <path>
  luckytoken control aliases <query|write> [<revision> <file>] --descriptor <path>
  luckytoken control history <query|export|export-confirm|delete|delete-confirm|acknowledge> ... --descriptor <path>
  luckytoken control backup <ordinary|full|confirm> ... --descriptor <path>
  luckytoken --help

Commands:
  serve    Start the local Client Protocol service (default)
  login    Authenticate a Provider through Pi Models
  logout   Remove a Provider credential through Pi Models
  control status  Read the local Control Plane status snapshot
  control start|stop|restart  Manage the model gateway through the Control Plane
  control auto-start status|enable|disable  Query or change Windows login auto-start
  control settings query|set|confirm  Read or change registered Settings through the Control Plane
  control models query|write-raw|write-structured  Read or write the canonical models.json through the Control Plane
  control credentials query|login|logout|import  Manage API-key credentials and effective auth status through the Control Plane
  control auth query|login  Run Provider-owned account/subscription or API-key login
  control catalog query|refresh-background|refresh-manual  Read the active catalog snapshot or trigger a refresh
  control aliases query|write  Read the authoritative alias registry or replace the user mapping record
  control history query|export|export-confirm|delete|delete-confirm|acknowledge  Export, delete, or acknowledge permanent history state
  control backup ordinary|full|confirm  Create a redacted or explicitly confirmed full-sensitive backup

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --owner <kind>   Ownership identity for serve: cli (default) or desktop
  --descriptor <path>  Current-user Control Plane discovery descriptor
  --help           Show this help

control models commands:
  query                     Print the authoritative models.json state
  write-raw <rev> <file>    Validate and atomically replace models.json with the
                            file's raw content (compare-and-swap on <rev>)
  write-structured <rev> <file>  Replace models.json with the providers record in
                            <file> (compare-and-swap on <rev>, formatted)

control credentials commands:
  query                     Print the sanitized auth.json projection and per-Provider
                            effective authentication status
  login <provider> <value>  Store an API-key credential (literal, $ENV or !command
                            source); replacing an occupied slot requires --overwrite
  logout <provider>         Remove only the stored auth.json value
  import <file>             Import a Pi-compatible auth.json Provider by Provider
                            with overwrite confirmation

control auth commands:
  query                     Print the per-Provider login options and effective
                            authentication status
  login <provider> <account|api-key>  Run the Provider-owned interactive login flow
                            through the typed interaction contract (browser,
                            device code, prompts); secret input is masked on a TTY

control catalog commands:
  query                     Print the active catalog snapshot
  refresh-background        Schedule a non-blocking background refresh
  refresh-manual            Run a forced refresh with per-Provider results

control aliases commands:
  query                     Print the authoritative model-aliases.json state
                            (revision, file facts, effective registry)
  write <rev> <file>        Validate and atomically replace the user mapping
                            record with the file's content (compare-and-swap
                             on <rev>; the file must be { "aliases": {...} })

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

type ParsedCliArguments =
  | {
      readonly command: "serve";
      readonly configPath: string;
      readonly descriptorPath?: string;
      readonly ownerKind: "cli" | "desktop";
      readonly desktopExe?: string;
      readonly createFirstRunConfig: boolean;
    }
  | {
      readonly command: "login" | "logout";
      readonly configPath: string;
      readonly providerId?: string;
    };

interface LoginChoice {
  readonly provider: Provider;
  readonly type: AuthType;
  readonly label: string;
}

function parseArguments(
  args: readonly string[],
): ParsedCliArguments | undefined {
  if (args.includes("--help")) return undefined;
  let configPath: string | undefined;
  let descriptorPath: string | undefined;
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
  const command: "serve" | "login" | "logout" =
    first === undefined || first === "serve"
      ? "serve"
      : first === "login" || first === "logout"
        ? first
        : (() => {
            throw new Error(`Unknown command: ${first}`);
          })();
  const providerId = command === "serve" ? undefined : positional[1];
  if (command !== "serve" && descriptorPath !== undefined) {
    throw new Error("--descriptor is only valid for serve or control status");
  }
  const expectedPositionals =
    command === "serve" && first === "serve" ? 1 : command === "serve" ? 0 : 2;
  if (positional.length > expectedPositionals) {
    throw new Error(`Too many arguments for ${command}`);
  }
  if (command === "serve") {
    return {
      command,
      configPath,
      ownerKind,
      createFirstRunConfig,
      ...(descriptorPath === undefined ? {} : { descriptorPath }),
      ...(desktopExe === undefined ? {} : { desktopExe }),
    };
  }
  return {
    command,
    configPath,
    ...(providerId === undefined ? {} : { providerId }),
  };
}

class PromptOutput extends Writable {
  muted = false;

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) stdout.write(chunk, encoding);
    callback();
  }
}

function printAuthEvent(event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      stdout.write(`Open this URL in a browser:\n${event.url}\n`);
      if (event.instructions) stdout.write(`${event.instructions}\n`);
      return;
    case "device_code":
      stdout.write(
        `Open ${event.verificationUri} and enter code ${event.userCode}\n`,
      );
      return;
    case "info":
    case "progress":
      stdout.write(`${event.message}\n`);
  }
}

function createTerminalInteraction(): {
  readonly interaction: AuthInteraction;
  close(): void;
} {
  const promptOutput = new PromptOutput();
  const terminal = stdin.isTTY === true && stdout.isTTY === true;
  const readline = createInterface({
    input: stdin,
    output: promptOutput,
    terminal,
  });
  const question = (text: string, signal: AbortSignal | undefined) =>
    signal === undefined
      ? readline.question(text)
      : readline.question(text, { signal });
  const ask = async (prompt: AuthPrompt): Promise<string> => {
    prompt.signal?.throwIfAborted();
    if (prompt.type === "select") {
      stdout.write(`${prompt.message}\n`);
      prompt.options.forEach((option, index) => {
        stdout.write(
          `  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`,
        );
      });
      const answer = await question(
        `Select 1-${prompt.options.length}: `,
        prompt.signal,
      );
      const selection = Number.parseInt(answer.trim(), 10) - 1;
      const option = prompt.options[selection];
      if (option === undefined) throw new Error("Invalid selection");
      return option.id;
    }
    const description = `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `;
    if (prompt.type !== "secret") {
      return question(description, prompt.signal);
    }
    stdout.write(description);
    promptOutput.muted = terminal;
    try {
      return await question("", prompt.signal);
    } finally {
      promptOutput.muted = false;
      if (terminal) stdout.write("\n");
    }
  };
  return {
    interaction: {
      prompt: ask,
      notify: printAuthEvent,
    },
    close: () => readline.close(),
  };
}

function loginChoices(models: Models, providerId?: string): LoginChoice[] {
  const choices: LoginChoice[] = [];
  for (const provider of models.getProviders()) {
    if (providerId !== undefined && provider.id !== providerId) continue;
    if (provider.auth.oauth !== undefined) {
      const oauth = provider.auth.oauth;
      choices.push({
        provider,
        type: "oauth",
        label:
          oauth.loginLabel ??
          (oauth.isSubscription === true
            ? "Use a subscription"
            : "Use an account"),
      });
    }
    if (provider.auth.apiKey?.login !== undefined) {
      choices.push({ provider, type: "api_key", label: "Use an API key" });
    }
  }
  return choices;
}

async function chooseLogin(
  models: Models,
  interaction: AuthInteraction,
  providerId?: string,
): Promise<LoginChoice> {
  const choices = loginChoices(models, providerId);
  if (choices.length === 0) {
    throw new Error(
      providerId === undefined
        ? "No Provider exposes an interactive Pi login method"
        : `Provider ${providerId} does not expose an interactive Pi login method`,
    );
  }
  if (choices.length === 1) return choices[0] as LoginChoice;
  const selection = await interaction.prompt({
    type: "select",
    message:
      providerId === undefined
        ? "Select a Provider login"
        : "Select a login method",
    options: choices.map((choice, index) => ({
      id: String(index),
      label:
        providerId === undefined
          ? `${choice.provider.name} — ${choice.label}`
          : choice.label,
    })),
  });
  const choice = choices[Number.parseInt(selection, 10)];
  if (choice === undefined) throw new Error("Invalid login selection");
  return choice;
}

async function runLogin(
  models: Models,
  providerId: string | undefined,
): Promise<void> {
  const terminalInteraction = createTerminalInteraction();
  try {
    const choice = await chooseLogin(
      models,
      terminalInteraction.interaction,
      providerId,
    );
    await models.login(
      choice.provider.id,
      choice.type,
      terminalInteraction.interaction,
    );
    stdout.write(
      `Authenticated ${choice.provider.name} using ${choice.label}.\n`,
    );
  } finally {
    terminalInteraction.close();
  }
}

async function runLogout(
  models: Models,
  providerId: string | undefined,
): Promise<void> {
  const providers = models
    .getProviders()
    .filter(
      (provider) => providerId === undefined || provider.id === providerId,
    );
  if (providers.length === 0) {
    throw new Error(
      providerId === undefined
        ? "No Provider is configured"
        : `Unknown Provider: ${providerId}`,
    );
  }
  let provider = providers[0] as Provider;
  if (providers.length > 1) {
    const terminalInteraction = createTerminalInteraction();
    try {
      const selection = await terminalInteraction.interaction.prompt({
        type: "select",
        message: "Select a Provider credential to remove",
        options: providers.map((entry, index) => ({
          id: String(index),
          label: entry.name,
        })),
      });
      provider = providers[Number.parseInt(selection, 10)] as Provider;
    } finally {
      terminalInteraction.close();
    }
  }
  await models.logout(provider.id);
  stdout.write(`Stored credential removed for ${provider.name}.\n`);
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
  descriptorOverride?: string,
  ownerKind: "cli" | "desktop" = "cli",
  desktopExe?: string,
  createFirstRunConfig = false,
  buildId?: string,
): Promise<void> {
  const started = await startLuckyTokenApplication({
    configPath,
    ...(descriptorOverride === undefined
      ? {}
      : { descriptorOverride }),
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
  if (action === "confirm") {
    const actionId = positional[1];
    if (actionId === undefined || positional.length > 2) {
      throw new Error("settings confirm requires the pending action id");
    }
    return { descriptorPath, command: { command: "confirm", actionId } };
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

function parseAliasesCommand(args: readonly string[]): {
  readonly descriptorPath: string;
  readonly action: "query" | "write";
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
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) {
    throw new Error("--descriptor <path> is required");
  }
  const action = positional[0];
  if (action === "query") {
    if (positional.length > 1) {
      throw new Error("aliases query takes no arguments");
    }
    return { descriptorPath, action: "query" };
  }
  const revision = positional[1];
  const file = positional[2];
  if (
    action !== "write" ||
    !/^[0-9]+$/u.test(revision ?? "") ||
    file === undefined ||
    positional.length > 3
  ) {
    throw new Error("aliases write requires <revision> <file>");
  }
  return {
    descriptorPath,
    action: "write",
    revision: Number.parseInt(revision as string, 10),
    file,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read and validate the transparent alias proposal file before any write:
 *  the same JSON-with-comments flavor the authority parses, a root object
 *  with a required non-null non-array `aliases` record. A malformed
 *  proposal is rejected value-safely with a clear error — an empty mapping
 *  is never guessed, so a bad file can never wipe the registry. */
async function readAliasProposalFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`Cannot read the aliases proposal file: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(
      `The aliases proposal file is not a valid proposal: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("aliases proposal must be a JSON object");
  }
  if (!isRecord(parsed.aliases)) {
    throw new Error("aliases proposal must contain an aliases object");
  }
  return parsed.aliases;
}

async function runControlAliasesCommand(args: readonly string[]): Promise<void> {
  const parsed = parseAliasesCommand(args);
  const command =
    parsed.action === "query"
      ? ({ command: "query" } as const)
      : ({
          command: "write",
          revision: parsed.revision as number,
          // The proposal file is validated before the write: the transparent
          // { "aliases": {...} } shape is required as-is and never guessed.
          aliases: await readAliasProposalFile(parsed.file as string),
        } as const);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    await assertCompatibleControlPlane(client);
    const result = await client.executeAliasCommand(command);
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
    if (command === "credentials") {
      await runCredentialCli(args.slice(2));
      return;
    }
    if (command === "auth") {
      await runAuthCli(args.slice(2));
      return;
    }
    if (command === "catalog") {
      await runControlCatalogCommand(args.slice(2));
      return;
    }
    if (command === "aliases") {
      await runControlAliasesCommand(args.slice(2));
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
  if (parsed.command === "serve") {
    await runServe(
      parsed.configPath,
      parsed.descriptorPath,
      parsed.ownerKind,
      parsed.desktopExe,
      parsed.createFirstRunConfig,
      backendBuildIdFromEnvironment(),
    );
    return;
  }
  const config = await loadLuckyTokenCliConfig(parsed.configPath);
  const configured = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
    ...(config.pi.modelsJson === undefined
      ? {}
      : { modelsJsonPath: config.pi.modelsJson }),
    providerPackages: config.providerPackages,
    fetch: globalThis.fetch,
  });
  if (parsed.command === "login") {
    await runLogin(configured.models, parsed.providerId);
  } else {
    await runLogout(configured.models, parsed.providerId);
  }
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
