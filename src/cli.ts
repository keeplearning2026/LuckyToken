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
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadLuckyTokenCliConfig } from "./cli-config.js";
import {
  ControlPlaneDescriptorOwnedError,
  publishControlPlaneDescriptor,
  readControlPlaneDescriptor,
  resolveControlPlaneDescriptorPath,
} from "./control-plane-discovery.js";
import {
  buildWindowsAutoStartCommand,
  createUnsupportedAutoStartRegistrar,
  createWindowsAutoStartRegistrar,
  executeAutoStart,
  type AutoStartRegistrar,
} from "./auto-start.js";
import { runClientTokenCli } from "./client-auth/cli.js";
import {
  createClientTokenControlPlaneHandler,
  createProtocolEnablementSettingsHandler,
} from "./client-auth/control-plane.js";
import type { LiveClientTokenAuthority } from "./client-auth/live-authority.js";
import { anthropicMessagesProtocolId } from "./protocols/anthropic/handler.js";
import { openaiResponsesProtocolId } from "./protocols/openai-responses/handler.js";
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
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type ModelsCommand,
  type RuntimeCommand,
  type SettingsCommand,
} from "@luckytoken/application-control-plane/control-plane";
import { startLuckyTokenHttpServer } from "./server.js";
import { createProductionControlPipe } from "./control-pipe-composition.js";
import { createDataPlaneRuntimeSupervisor } from "./runtime-supervisor.js";
import {
  bindRuntimeDiagnosticsConfiguration,
  createRuntimeDiagnosticsStoreFactory,
} from "./runtime-diagnostics/index.js";
import type { RuntimeDiagnosticsStore } from "./runtime-diagnostics/index.js";
import { createSettingsRegistry } from "./settings/catalog.js";
import { createSettingsControlPlaneHandler } from "./settings/control-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { resolveEffectiveSettings } from "./settings/data-plane.js";
import { createModelsJsonAuthority } from "./models-config/authority.js";
import { createModelsControlPlaneHandler } from "./models-config/control-plane.js";
import { composeEffectiveCatalog } from "./providers/effective-composition.js";

const HELP = `LuckyToken

Usage:
  luckytoken --config <path>
  luckytoken login [provider] --config <path>
  luckytoken logout [provider] --config <path>
  luckytoken client-token <list|reveal|rotate|remove> <protocol> --descriptor <path>
  luckytoken client-token <create|rotate|remove|list> <protocol> --config <path> [--global|--project <path>]
  luckytoken control status --descriptor <path>
  luckytoken control <start|stop|restart> --descriptor <path>
  luckytoken control auto-start <status|enable|disable> --descriptor <path>
  luckytoken control settings <query|set|confirm> [<key> <value>] --descriptor <path>
  luckytoken control models <query|write-raw|write-structured> [<revision> <file>] --descriptor <path>
  luckytoken --help

Commands:
  serve    Start the local Client Protocol service (default)
  login    Authenticate a Provider through Pi Models
  logout   Remove a Provider credential through Pi Models
  client-token  Manage client tokens: live global tokens through the Control Plane, or token files offline
  control status  Read the local Control Plane status snapshot
  control start|stop|restart  Manage the model gateway through the Control Plane
  control auto-start status|enable|disable  Query or change Windows login auto-start
  control settings query|set|confirm  Read or change registered Settings through the Control Plane
  control models query|write-raw|write-structured  Read or write the canonical models.json through the Control Plane

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --global         Select the protocol-global client token
  --project <path> Select a project-bound client token
  --token <value>  Use an explicit token for create/rotate
  --descriptor <path>  Current-user Control Plane discovery descriptor
  --help           Show this help

control models commands:
  query                     Print the authoritative models.json state
  write-raw <rev> <file>    Validate and atomically replace models.json with the
                            file's raw content (compare-and-swap on <rev>)
  write-structured <rev> <file>  Replace models.json with the providers record in
                            <file> (compare-and-swap on <rev>, formatted)
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

async function attachToActiveInstance(descriptorPath: string): Promise<void> {
  // The winning launch publishes its descriptor immediately after taking
  // the lease; a bounded retry absorbs that small publish window.
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const endpoint = await readControlPlaneDescriptor(descriptorPath);
      const client = await connectControlPlane(endpoint, {
        createRequestId: randomUUID,
        pipeConnector: createNodePipeTransport(),
      });
      try {
        const hello = await client.hello(controlPlaneVersion);
        if (hello.type === "incompatible") {
          throw new Error(
            "the active instance speaks an incompatible Control Plane contract",
          );
        }
        const result = await client.executeApplicationCommand({
          command: "attach",
        });
        const owner = result.snapshot.ownership?.owner;
        stdout.write(
          `LuckyToken is already running: attached to the active instance${
            owner === undefined
              ? ""
              : ` owned by PID ${owner.pid} (${owner.kind})`
          }. No second Data Plane was started.\n`,
        );
        return;
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw (
    lastError instanceof Error
      ? lastError
      : new Error("Failed to attach to the active LuckyToken instance")
  );
}

async function runServe(
  configPath: string,
  descriptorOverride?: string,
): Promise<void> {
  const config = await loadLuckyTokenCliConfig(configPath);
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(descriptorOverride === undefined
      ? {}
      : { overridePath: descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const endpoint: ControlPlaneEndpoint = Object.freeze({
    pipeName: `\\\\.\\pipe\\luckytoken-${(process.env.USERNAME ?? "current-user").replace(/[^A-Za-z0-9_.-]/gu, "_")}-${randomBytes(24).toString("hex")}`,
    capability: randomBytes(32).toString("base64url"),
  });
  let descriptor:
    | Awaited<ReturnType<typeof publishControlPlaneDescriptor>>
    | undefined;
  let supervisor:
    | Awaited<ReturnType<typeof createDataPlaneRuntimeSupervisor>>
    | undefined;
  let controlPlane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let diagnosticsStore: RuntimeDiagnosticsStore | undefined;
  try {
    try {
      descriptor = await publishControlPlaneDescriptor({
        path: descriptorPath,
        endpoint,
        createTemporaryId: randomUUID,
      });
    } catch (error) {
      if (error instanceof ControlPlaneDescriptorOwnedError) {
        // One active instance already owns the application: attach to it
        // instead of binding a second Data Plane.
        await attachToActiveInstance(descriptorPath);
        return;
      }
      throw error;
    }
    diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
      configuration: bindRuntimeDiagnosticsConfiguration(
        config.runtimeDiagnostics,
      ),
    }).open();
    const ownedDiagnosticsStore = diagnosticsStore;
    const controlPipe = await createProductionControlPipe();
    // The canonical LuckyToken-owned models.json: defaults to `models.json`
    // next to the config file (the desktop layout's `~/.luckytoken/models.json`)
    // unless the config overrides it. The Pi Agent default data directory is
    // never read or written implicitly.
    const modelsAuthority = createModelsJsonAuthority({
      path: config.pi.modelsJson,
      compose: (providers) => composeEffectiveCatalog(providers),
    });
    const modelsState = await modelsAuthority.query();
    const provider: ApplicationStatus["provider"] =
      Object.keys(config.providerPackages).length > 0 ||
      (modelsState.present &&
        modelsState.valid &&
        Object.keys(modelsState.providers ?? {}).length > 0)
        ? "configured"
        : "unconfigured";
    const settingsRegistry = createSettingsRegistry(
      createFileSettingsStore(join(dirname(configPath), "settings.json")),
      {
        initial: {
          "server.port": config.server.port,
          "server.bindHost": config.server.host,
        },
      },
    );
    await settingsRegistry.load();
    // Ticket 16: the live per-protocol Client Token authorities belong to the
    // running Data Plane composition; the Control Plane adapters read them
    // through this slot so commands and enable transitions always target the
    // current authorities (boot-time enabling is ensured by the composition).
    let tokenAuthorities:
      | Readonly<Record<string, LiveClientTokenAuthority>>
      | undefined;
    // Ticket 17 identity seam: the Control Plane serves the bounded public
    // request identity ledger from the running Data Plane composition.
    let requestIdentities:
      | Awaited<ReturnType<typeof createConfiguredLuckyTokenComposition>>["requestIdentities"]
      | undefined;
    const protocolNames = Object.freeze({
      [anthropicMessagesProtocolId]: "Anthropic Messages",
      [openaiResponsesProtocolId]: "OpenAI Responses",
    });
    const clientTokenCommandHandler = createClientTokenControlPlaneHandler({
      authorities: () => tokenAuthorities ?? Object.freeze({}),
      protocolNames,
      diagnostics: diagnosticsStore,
    });
    const settingsCommandHandler = createProtocolEnablementSettingsHandler({
      settingsHandler: createSettingsControlPlaneHandler(settingsRegistry),
      authorities: () => tokenAuthorities ?? Object.freeze({}),
      protocolNames,
      diagnostics: diagnosticsStore,
    });
    const drainTimeoutMs = (): number => {
      const setting = settingsRegistry.query([
        "application.quitDrainTimeoutMs",
      ])["application.quitDrainTimeoutMs"];
      if (setting === undefined) return 5000;
      const value = Number(setting.value);
      return Number.isSafeInteger(value) && value >= 0 ? value : 5000;
    };
    supervisor = createDataPlaneRuntimeSupervisor({
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
            diagnosticsStore: ownedDiagnosticsStore,
            settingsRegistry,
          });
          tokenAuthorities = composition.clientTokenAuthorities;
          requestIdentities = composition.requestIdentities;
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
            async drain(timeoutMs) {
              // A graceful quit drain lets in-flight requests complete; the
              // composition shutdown signal is only aborted on Stop/close.
              return server.drain(timeoutMs);
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
    const autoStartRegistrar: AutoStartRegistrar =
      process.platform === "win32"
        ? createWindowsAutoStartRegistrar({
            name: "LuckyToken",
            command: buildWindowsAutoStartCommand(process.execPath, [
              fileURLToPath(import.meta.url),
              "serve",
              "--config",
              resolve(configPath),
              ...(descriptorOverride === undefined
                ? []
                : ["--descriptor", resolve(descriptorOverride)]),
            ]),
          })
        : createUnsupportedAutoStartRegistrar();
    const publish = (status: ApplicationStatus): Promise<void> => {
      const plane = controlPlane;
      return plane === undefined
        ? Promise.reject(new Error("Control Plane is not ready"))
        : plane.publishStatus(status);
    };
    const signalQuit = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
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
    let resolveCommandQuit:
      | ((outcome: "drained" | "timed_out") => void)
      | undefined;
    let resolveCommandQuitExited: (() => void) | undefined;
    const commandQuit = new Promise<"drained" | "timed_out">((resolve) => {
      resolveCommandQuit = resolve;
    });
    const commandQuitExited = new Promise<void>((resolve) => {
      resolveCommandQuitExited = resolve;
    });
    const quitRequested = Promise.race([
      signalQuit.then((signal) => ({ kind: "signal" as const, signal })),
      commandQuit.then((outcome) => ({ kind: "command" as const, outcome })),
    ]);
    const cleanup = async (): Promise<void> => {
      if (supervisor !== undefined) {
        await supervisor
          .execute("stop", (status) => controlPlane?.publishStatus(status) ?? Promise.resolve())
          .catch(() => undefined);
      }
      const results = await Promise.allSettled([
        descriptor?.close() ?? Promise.resolve(),
        controlPlane?.close() ?? Promise.resolve(),
        diagnosticsStore?.close() ?? Promise.resolve(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("LuckyToken application resource cleanup failed");
      }
    };
    controlPlane = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: "0.0.0" },
      initialStatus: supervisor.initialStatus,
      ownership: {
        owner: {
          kind: "cli",
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
      },
      runtimeCommandHandler: supervisor.execute,
      settingsCommandHandler,
      settingsProjection: () => settingsRegistry.snapshot(),
      clientTokenCommandHandler,
      requestIdentitiesHandler: () =>
        Promise.resolve({
          records: requestIdentities?.list() ?? Object.freeze([]),
        }),
      modelsCommandHandler: createModelsControlPlaneHandler(modelsAuthority),
      modelsProjection: () => modelsAuthority.snapshot(),
      applicationCommandHandler: async (command, publishStatus) => {
        switch (command.command) {
          case "attach":
            return { outcome: "attached" };
          case "auto_start": {
            const execution = await executeAutoStart(
              autoStartRegistrar,
              command.action,
            );
            return {
              outcome: execution.outcome,
              ...(execution.error === undefined
                ? {}
                : { error: execution.error }),
              ...(execution.enabled === undefined
                ? {}
                : { autoStart: { enabled: execution.enabled } }),
            };
          }
          case "quit": {
            const outcome = await supervisor?.quit({
              timeoutMs: drainTimeoutMs(),
              publishStatus,
            });
            const settled = outcome ?? "timed_out";
            resolveCommandQuit?.(settled);
            return { outcome: settled };
          }
        }
      },
      onApplicationCommandResultDelivered: async (command, result) => {
        if (
          command.command !== "quit" ||
          (result.outcome !== "drained" && result.outcome !== "timed_out")
        ) {
          return;
        }
        stdout.write(
          `LuckyToken: application quit — ${
            result.outcome === "drained"
              ? "active requests drained"
              : "drain timed out; remaining requests aborted"
          }\n`,
        );
        // Tear down only after the quit result frame is visible to the
        // requester, and never from inside the host's request loop.
        setImmediate(() => {
          void cleanup().then(
            () => resolveCommandQuitExited?.(),
            (error: unknown) => {
              process.stderr.write(
                `LuckyToken: ${
                  error instanceof Error ? error.message : String(error)
                }\n`,
              );
              process.exitCode = 1;
              resolveCommandQuitExited?.();
            },
          );
        });
      },
      pipeServerFactory: controlPipe.pipeServerFactory,
      access: controlPipe.access,
      diagnostics: ownedDiagnosticsStore,
    });
    await supervisor.execute("start", publish);
    const quit = await quitRequested;
    if (quit.kind === "signal") {
      const outcome = await supervisor.quit({
        timeoutMs: drainTimeoutMs(),
        publishStatus: publish,
      });
      stdout.write(
        `LuckyToken: application quit — ${
          outcome === "drained"
            ? "active requests drained"
            : "drain timed out; remaining requests aborted"
        }\n`,
      );
    } else {
      // The quit result was delivered by the Control Plane; the delivery
      // hook performs the teardown above. Wait for it so this cleanup path
      // never runs concurrently with the hook's.
      await commandQuitExited;
    }
  } finally {
    if (supervisor !== undefined) {
      await supervisor
        .execute("stop", (status) => controlPlane?.publishStatus(status) ?? Promise.resolve())
        .catch(() => undefined);
    }
    const results = await Promise.allSettled([
      descriptor?.close() ?? Promise.resolve(),
      controlPlane?.close() ?? Promise.resolve(),
      diagnosticsStore?.close() ?? Promise.resolve(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
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
      if (
        action === "status" ||
        action === "enable" ||
        action === "disable"
      ) {
        if (autoStartAction !== undefined) {
          throw new Error("auto-start action may be provided once");
        }
        autoStartAction = action;
        continue;
      }
    }
    throw new Error(`Unknown control option: ${args[index]}`);
  }
  if (descriptorPath === undefined) throw new Error("--descriptor <path> is required");
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
      throw new Error(`Control Plane contract v${controlPlaneVersion} is unsupported`);
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
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
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
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw)
    ) {
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

export async function runLuckyTokenCli(
  args: readonly string[],
): Promise<void> {
  if (args[0] === "control") {
    const command = args[1];
    if (command === "settings") {
      await runControlSettingsCommand(args.slice(2));
      return;
    }
    if (command === "models") {
      await runControlModelsCommand(args.slice(2));
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
