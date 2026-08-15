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
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { loadLuckyTokenCliConfig } from "./cli-config.js";
import {
  publishControlPlaneDescriptor,
  readControlPlaneDescriptor,
  resolveControlPlaneDescriptorPath,
} from "./control-plane-discovery.js";
import { runClientTokenCli } from "./client-auth/cli.js";
import {
  createConfiguredLuckyTokenComposition,
  createConfiguredPiModels,
} from "./composition.js";
import {
  connectControlPlane,
  controlPlaneVersion,
  createNodePipeTransport,
  startControlPlane,
  type ApplicationStatus,
  type ControlPlaneEndpoint,
  type RuntimeCommand,
  type SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";
import { startLuckyTokenHttpServer } from "./server.js";
import { createProductionControlPipe } from "./control-pipe-composition.js";
import { createDataPlaneRuntimeSupervisor } from "./runtime-supervisor.js";
import { createSettingsRegistry } from "./settings/catalog.js";
import { createSettingsControlPlaneHandler } from "./settings/control-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { resolveEffectiveSettings } from "./settings/data-plane.js";

const HELP = `LuckyToken

Usage:
  luckytoken --config <path>
  luckytoken login [provider] --config <path>
  luckytoken logout [provider] --config <path>
  luckytoken client-token <create|rotate|remove|list> <protocol> [scope] --config <path>
  luckytoken control status --descriptor <path>
  luckytoken control <start|stop|restart> --descriptor <path>
  luckytoken control settings <query|set|confirm> [<key> <value>] --descriptor <path>
  luckytoken --help

Commands:
  serve    Start the local Client Protocol service (default)
  login    Authenticate a Provider through Pi Models
  logout   Remove a Provider credential through Pi Models
  client-token  Manage one Client Protocol's local token file
  control status  Read the local Control Plane status snapshot
  control start|stop|restart  Manage the model gateway through the Control Plane
  control settings query|set|confirm  Read or change registered Settings through the Control Plane

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --global         Select the protocol-global client token
  --project <path> Select a project-bound client token
  --token <value>  Use an explicit token for create/rotate
  --descriptor <path>  Current-user Control Plane discovery descriptor
  --help           Show this help
`;

type ParsedCliArguments =
  | {
      readonly command: "serve";
      readonly configPath: string;
      readonly descriptorPath?: string;
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

function parseArguments(args: readonly string[]): ParsedCliArguments | undefined {
  if (args.includes("--help")) return undefined;
  let configPath: string | undefined;
  let descriptorPath: string | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--config") {
      if (configPath !== undefined) throw new Error("--config may be provided once");
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
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
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
  const expectedPositionals = command === "serve" && first === "serve" ? 1 : command === "serve" ? 0 : 2;
  if (positional.length > expectedPositionals) {
    throw new Error(`Too many arguments for ${command}`);
  }
  return {
    command,
    configPath,
    ...(command === "serve" && descriptorPath !== undefined
      ? { descriptorPath }
      : {}),
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
  const readline = createInterface({ input: stdin, output: promptOutput, terminal });
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
          (oauth.isSubscription === true ? "Use a subscription" : "Use an account"),
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
    message: providerId === undefined ? "Select a Provider login" : "Select a login method",
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
    const choice = await chooseLogin(models, terminalInteraction.interaction, providerId);
    await models.login(
      choice.provider.id,
      choice.type,
      terminalInteraction.interaction,
    );
    stdout.write(`Authenticated ${choice.provider.name} using ${choice.label}.\n`);
  } finally {
    terminalInteraction.close();
  }
}

async function runLogout(models: Models, providerId: string | undefined): Promise<void> {
  const providers = models
    .getProviders()
    .filter((provider) => providerId === undefined || provider.id === providerId);
  if (providers.length === 0) {
    throw new Error(
      providerId === undefined ? "No Provider is configured" : `Unknown Provider: ${providerId}`,
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
  stdout.write(`Removed the stored credential for ${provider.name}.\n`);
}

async function runServe(
  configPath: string,
  descriptorOverride?: string,
): Promise<void> {
  const config = await loadLuckyTokenCliConfig(configPath);
  const controlPipe = await createProductionControlPipe();
  const provider: ApplicationStatus["provider"] =
    Object.keys(config.providerPackages).length === 0 &&
    config.pi.modelsJson === undefined
      ? "unconfigured"
      : "configured";
  const settingsRegistry = createSettingsRegistry(
    createFileSettingsStore(
      join(dirname(configPath), ".luckytoken", "settings.json"),
    ),
    {
      initial: {
        "server.port": config.server.port,
        "server.bindHost": config.server.host,
      },
    },
  );
  await settingsRegistry.load();
  const supervisor = createDataPlaneRuntimeSupervisor({
    host: config.server.host,
    port: config.server.port,
    provider,
    resolveAddress: () =>
      resolveEffectiveSettings(settingsRegistry.query([])),
    startListener: async (address) => {
      const shutdownController = new AbortController();
      try {
        const composition = await createConfiguredLuckyTokenComposition({
          config,
          fetch: globalThis.fetch,
          shutdownSignal: shutdownController.signal,
          settingsRegistry,
        });
        const server = await startLuckyTokenHttpServer({
          runtime: composition.runtime,
          host: address.host,
          port: address.port,
        });
        for (const route of composition.runtime.routes) {
          stdout.write(
            `LuckyToken ${route.method} ${server.origin}${route.pathname}\n`,
          );
        }
        return {
          async close() {
            shutdownController.abort(
              new Error("LuckyToken model gateway is stopping"),
            );
            await server.close();
          },
        };
      } catch (error) {
        shutdownController.abort(
          new Error("LuckyToken model gateway startup failed"),
        );
        throw error;
      }
    },
  });
  const endpoint: ControlPlaneEndpoint = Object.freeze({
    pipeName: `\\\\.\\pipe\\luckytoken-${(process.env.USERNAME ?? "current-user").replace(/[^A-Za-z0-9_.-]/gu, "_")}-${randomBytes(24).toString("hex")}`,
    capability: randomBytes(32).toString("base64url"),
  });
  const controlPlane = await startControlPlane({
    endpoint,
    application: { id: "luckytoken", version: "0.0.0" },
    initialStatus: supervisor.initialStatus,
    runtimeCommandHandler: supervisor.execute,
    settingsCommandHandler: createSettingsControlPlaneHandler(settingsRegistry),
    settingsProjection: () => settingsRegistry.snapshot(),
    pipeServerFactory: controlPipe.pipeServerFactory,
    access: controlPipe.access,
  });
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(descriptorOverride === undefined
      ? {}
      : { overridePath: descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  let descriptor:
    | Awaited<ReturnType<typeof publishControlPlaneDescriptor>>
    | undefined;
  try {
    descriptor = await publishControlPlaneDescriptor({
      path: descriptorPath,
      endpoint,
      createTemporaryId: randomUUID,
    });
    await supervisor.execute("start", (status) =>
      controlPlane.publishStatus(status),
    );

    await new Promise<"SIGINT" | "SIGTERM">((resolve) => {
      const finish = (signal: "SIGINT" | "SIGTERM") => {
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        resolve(signal);
      };
      const onInterrupt = () => finish("SIGINT");
      const onTerminate = () => finish("SIGTERM");
      process.once("SIGINT", onInterrupt);
      process.once("SIGTERM", onTerminate);
    });
    await supervisor.execute("stop", (status) =>
      controlPlane.publishStatus(status),
    );
  } finally {
    await supervisor
      .execute("stop", (status) => controlPlane.publishStatus(status))
      .catch(() => undefined);
    const cleanup = await Promise.allSettled([
      descriptor?.close() ?? Promise.resolve(),
      controlPlane.close(),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      throw new Error("LuckyToken application resource cleanup failed");
    }
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
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positional.push(argument);
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
  const action = positional[0];
  if (action === "query") {
    if (positional.length > 1) throw new Error("settings query takes no key arguments");
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

async function runControlSettingsCommand(args: readonly string[]): Promise<void> {
  const parsed = parseSettingsCommand(args);
  const endpoint = await readControlPlaneDescriptor(parsed.descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(`Control Plane contract v${controlPlaneVersion} is unsupported`);
    }
    const result = await client.executeSettingsCommand(parsed.command);
    stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

async function runControlCommand(
  command: "status" | RuntimeCommand,
  args: readonly string[],
): Promise<void> {
  let descriptorPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--descriptor") throw new Error(`Unknown control option: ${args[index]}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) throw new Error("--descriptor requires a path");
    descriptorPath = value;
    index += 1;
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
  const endpoint = await readControlPlaneDescriptor(descriptorPath);
  const client = await connectControlPlane(endpoint, {
    createRequestId: randomUUID,
    pipeConnector: createNodePipeTransport(),
  });
  try {
    const hello = await client.hello(controlPlaneVersion);
    if (hello.type === "incompatible") {
      throw new Error(`Control Plane contract v${controlPlaneVersion} is unsupported`);
    }
    const result =
      command === "status"
        ? await client.getStatus()
        : await client.executeRuntimeCommand(command);
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
    if (
      command !== "status" &&
      command !== "start" &&
      command !== "stop" &&
      command !== "restart"
    ) {
      throw new Error(`Unknown control command: ${command ?? ""}`);
    }
    await runControlCommand(command, args.slice(2));
    return;
  }
  if (args[0] === "client-token") {
    await runClientTokenCli(args.slice(1), {
      resolveAuthFile: async (configPath, protocolId) => {
        const config = await loadLuckyTokenCliConfig(configPath);
        return Object.hasOwn(config.clientProtocols, protocolId)
          ? config.clientProtocols[protocolId]?.authFile
          : undefined;
      },
    });
    return;
  }
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    stdout.write(HELP);
    return;
  }
  if (parsed.command === "serve") {
    await runServe(parsed.configPath, parsed.descriptorPath);
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
