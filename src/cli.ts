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

import { LUCKYTOKEN_RELEASE_VERSION } from "./version.js";
import { startLuckyTokenApplication } from "./application.js";
import { createFirstRunConfig as writeFirstRunConfig } from "./first-run-config.js";
import { loadLuckyTokenCliConfig } from "./cli-config.js";
import {
  ControlPlaneDescriptorOwnedError,
  publishControlPlaneDescriptor,
  readControlPlaneDescriptor,
  resolveControlPlaneDescriptorPath,
} from "./control-plane-discovery.js";
import {
  buildServeAutoStartCommand,
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
import { runCredentialCli } from "./credentials/cli.js";
import { runAuthCli } from "./credentials/auth-cli.js";
import { createCredentialControlPlaneHandler } from "./credentials/control-plane.js";
import { createAuthLoginControlPlaneHandler } from "./credentials/login-control-plane.js";
import type { LiveCredentialAuthority } from "./credentials/authority.js";
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
  type BackupCommandHandler,
  type CompatibilityIssue,
  type ControlPlaneClient,
  type ControlPlaneEndpoint,
  type HistoryRange,
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
import {
  bindRequestLedgerConfiguration,
  createRequestLedgerStoreFactory,
} from "./request-ledger/index.js";
import type { RequestLedgerStore } from "./request-ledger/index.js";
import {
  bindDeepDiagnosticsConfiguration,
  createDeepCaptureStoreFactory,
} from "./deep-diagnostics/index.js";
import type { DeepCaptureStore } from "./deep-diagnostics/index.js";
import { createHistoryAuthority } from "./history/index.js";
import {
  createConfiguredBackupAuthority,
  recoveryBackupSnapshots,
} from "./backup/index.js";
import {
  configCompatibilityIssue,
  inspectOwnedCompatibility,
  recoveryProjection,
} from "./owned-storage/index.js";
import {
  createPersistenceDegradationAuthority,
  createUnavailableDeepCaptureStore,
  createUnavailableDiagnosticsStore,
  createUnavailableRequestLedgerStore,
  observeDiagnosticsStore,
} from "./persistence-degradation/index.js";
import { createSettingsRegistry } from "./settings/catalog.js";
import { createSettingsControlPlaneHandler } from "./settings/control-plane.js";
import { createFileSettingsStore } from "./settings/file-store.js";
import { resolveEffectiveSettings } from "./settings/data-plane.js";
import { createModelsJsonAuthority } from "./models-config/authority.js";
import { createModelsControlPlaneHandler } from "./models-config/control-plane.js";
import { createCatalogCacheStore } from "./providers/catalog-cache.js";
import { createCatalogRefreshController } from "./providers/catalog-refresh.js";
import { composeEffectiveCatalog } from "./providers/effective-composition.js";
import { stripJsonComments } from "./providers/models-json-schema.js";
import { createAliasRegistryAuthority } from "./aliases/authority.js";
import { createAliasControlPlaneHandler } from "./aliases/control-plane.js";
import { createOperationalAttentionAuthority } from "./operational-attention/index.js";
import { resolveCodexHome } from "./integrations/codex/home.js";
import { createCodexLocalCredentialAuthority } from "./integrations/codex/local-auth.js";
import { createCodexNativeModelSource } from "./integrations/codex/native-models.js";
import { readCodexNativeCatalogEntries } from "./integrations/codex/native-catalog-source.js";
import { buildCodexCatalog } from "./integrations/codex/catalog.js";
import { createCodexIntegrationAuthority } from "./integrations/codex/integration.js";

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
  client-token  Manage client tokens: live global tokens through the Control Plane, or token files offline
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
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to attach to the active LuckyToken instance");
}

/**
 * Ticket 24 recovery-only owner. The descriptor and local Control Plane are
 * published even when a LuckyToken-owned file is incompatible. It exposes
 * exact sanitized file/version facts, attach/quit, and auto-start; no model
 * listener or unsafe store is opened.
 */
async function runRecoveryControlPlane(
  configPath: string,
  issues: readonly CompatibilityIssue[],
  descriptorOverride?: string,
  backupCommandHandler?: BackupCommandHandler,
  ownerKind: "cli" | "desktop" = "cli",
  desktopExe?: string,
): Promise<void> {
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(descriptorOverride === undefined
      ? {}
      : { overridePath: descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const endpoint: ControlPlaneEndpoint = Object.freeze({
    address: `\\\\.\\pipe\\luckytoken-${(process.env.USERNAME ?? "current-user").replace(/[^A-Za-z0-9_.-]/gu, "_")}-${randomBytes(24).toString("hex")}`,
    capability: randomBytes(32).toString("base64url"),
  });
  let descriptor:
    | Awaited<ReturnType<typeof publishControlPlaneDescriptor>>
    | undefined;
  let controlPlane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  try {
    try {
      descriptor = await publishControlPlaneDescriptor({
        path: descriptorPath,
        endpoint,
        createTemporaryId: randomUUID,
      });
    } catch (error) {
      if (error instanceof ControlPlaneDescriptorOwnedError) {
        await attachToActiveInstance(descriptorPath);
        return;
      }
      throw error;
    }
    const controlPipe = await createProductionControlPipe();
    const autoStartRegistrar: AutoStartRegistrar =
      process.platform === "win32"
        ? createWindowsAutoStartRegistrar({
            name: "LuckyToken",
            command: buildServeAutoStartCommand({
              ownerKind,
              nodeExecutable: process.execPath,
              cliScript: fileURLToPath(import.meta.url),
              configPath: resolve(configPath),
              ...(desktopExe === undefined ? {} : { desktopExe }),
            }),
          })
        : createUnsupportedAutoStartRegistrar();
    let requestQuit: (() => void) | undefined;
    const quit = new Promise<void>((resolveQuit) => {
      requestQuit = resolveQuit;
    });
    const signal = new Promise<void>((resolveSignal) => {
      const finish = () => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        resolveSignal();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });
    controlPlane = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: LUCKYTOKEN_RELEASE_VERSION },
      initialStatus: {
        modelDataPlane: "stopped",
        provider: "unconfigured",
      },
      ownership: {
        owner: {
          kind: ownerKind,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
      },
      recoveryProjection: () => recoveryProjection(issues),
      ...(backupCommandHandler === undefined ? {} : { backupCommandHandler }),
      applicationCommandHandler: async (command) => {
        if (command.command === "attach") return { outcome: "attached" };
        if (command.command === "quit") return { outcome: "drained" };
        const execution = await executeAutoStart(
          autoStartRegistrar,
          command.action,
        );
        return {
          outcome: execution.outcome,
          ...(execution.error === undefined ? {} : { error: execution.error }),
          ...(execution.enabled === undefined
            ? {}
            : { autoStart: { enabled: execution.enabled } }),
        };
      },
      onApplicationCommandResultDelivered: (command) => {
        if (command.command === "quit") requestQuit?.();
      },
      pipeServerFactory: controlPipe.pipeServerFactory,
      access: controlPipe.access,
    });
    await Promise.race([signal, quit]);
  } finally {
    const results = await Promise.allSettled([
      descriptor?.close() ?? Promise.resolve(),
      controlPlane?.close() ?? Promise.resolve(),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("LuckyToken recovery Control Plane cleanup failed");
    }
  }
}

async function legacyRunServe(
  configPath: string,
  descriptorOverride?: string,
  ownerKind: "cli" | "desktop" = "cli",
  desktopExe?: string,
  createFirstRunConfig = false,
): Promise<void> {
  if (createFirstRunConfig) {
    await writeFirstRunConfig(resolve(configPath));
  }
  let config: Awaited<ReturnType<typeof loadLuckyTokenCliConfig>>;
  try {
    config = await loadLuckyTokenCliConfig(configPath);
  } catch (error) {
    await runRecoveryControlPlane(
      configPath,
      [configCompatibilityIssue(configPath, error)],
      descriptorOverride,
      undefined,
      ownerKind,
      desktopExe,
    );
    return;
  }
  const compatibilityIssues = await inspectOwnedCompatibility(config);
  if (compatibilityIssues.length > 0) {
    const recoveryBackupAuthority = createConfiguredBackupAuthority({
      configPath,
      config,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      snapshots: recoveryBackupSnapshots(config),
    });
    await runRecoveryControlPlane(
      configPath,
      compatibilityIssues,
      descriptorOverride,
      (command, signal) => recoveryBackupAuthority.handle(command, signal),
      ownerKind,
      desktopExe,
    );
    return;
  }
  const descriptorPath = resolveControlPlaneDescriptorPath({
    homeDirectory: homedir(),
    ...(descriptorOverride === undefined
      ? {}
      : { overridePath: descriptorOverride }),
  });
  await mkdir(dirname(descriptorPath), { recursive: true });
  const endpoint: ControlPlaneEndpoint = Object.freeze({
    address: `\\\\.\\pipe\\luckytoken-${(process.env.USERNAME ?? "current-user").replace(/[^A-Za-z0-9_.-]/gu, "_")}-${randomBytes(24).toString("hex")}`,
    capability: randomBytes(32).toString("base64url"),
  });
  let descriptor:
    Awaited<ReturnType<typeof publishControlPlaneDescriptor>> | undefined;
  let supervisor:
    Awaited<ReturnType<typeof createDataPlaneRuntimeSupervisor>> | undefined;
  let controlPlane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let diagnosticsStore: RuntimeDiagnosticsStore | undefined;
  let requestLedgerStore: RequestLedgerStore | undefined;
  let deepCaptureStore: DeepCaptureStore | undefined;
  let attentionLedgerSubscription: { readonly unsubscribe: () => void } | undefined;
  let attentionRefreshTimer: ReturnType<typeof setInterval> | undefined;
  // Ticket 23: the last published base status, published again on any
  // persistence transition so the audit-unavailable projection rides on a
  // fresh snapshot. Hoisted above the stores (a boot-time failure may fire
  // the transition before the Data Plane's own status exists).
  let lastPublishedStatus: ApplicationStatus = Object.freeze({
    modelDataPlane: "stopped",
    provider: "unconfigured",
  });
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
    // Ticket 23: the persistence degradation authority observes the three
    // persistent authorities. A store that cannot open at serve startup is
    // replaced by its fail-open fallback and reported degraded from boot;
    // serve continues, and the audit-unavailable state rides on every
    // published snapshot until acknowledged or demonstrated recovery.
    let diagnosticsOpenFailed = false;
    try {
      diagnosticsStore = await createRuntimeDiagnosticsStoreFactory({
        configuration: bindRuntimeDiagnosticsConfiguration(
          config.runtimeDiagnostics,
        ),
      }).open();
    } catch {
      diagnosticsStore = undefined;
      diagnosticsOpenFailed = true;
    }
    const persistenceAuthority = createPersistenceDegradationAuthority({
      // The real diagnostics store (when open): Critical copies for
      // ledger/capture failures land there; a diagnostics failure is never
      // appended to itself (no recursive re-entry into a failed store).
      ...(diagnosticsStore === undefined ? {} : { diagnosticsStore }),
      onStateChange: () => {
        // Republish the full latest base status so the fresh persistence
        // projection reaches every status subscriber.
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      },
    });
    if (diagnosticsOpenFailed) {
      persistenceAuthority.reportFailure("diagnostics");
      diagnosticsStore = createUnavailableDiagnosticsStore(persistenceAuthority);
    } else {
      diagnosticsStore = observeDiagnosticsStore(
        diagnosticsStore as RuntimeDiagnosticsStore,
        persistenceAuthority,
      );
    }
    const ownedDiagnosticsStore = diagnosticsStore;
    // Ticket 18: the permanent Request Ledger opens once at serve level and
    // survives Data Plane restarts (recovery on this open is idempotent).
    // The composition attaches the credential-owner scrubber when the Data
    // Plane runs; pattern redaction is the baseline until then. Persistence
    // faults flow through the degradation authority: one fixed-text
    // Critical (stderr + bounded memory + the persistent diagnostics copy)
    // per request, with the message hash only — never fault text or
    // credentials — and recovery is demonstrated by the first successful
    // commit after a fault.
    try {
      requestLedgerStore = await createRequestLedgerStoreFactory({
        configuration: bindRequestLedgerConfiguration(config.requestLedger),
        onPersistenceFailure: (failure) => {
          persistenceAuthority.reportFailure("requestLedger", {
            ...(failure.requestId.length === 0
              ? {}
              : { requestId: failure.requestId }),
            messageHash: failure.messageHash,
          });
        },
        onPersistenceRecovery: (fact) => {
          void fact;
          persistenceAuthority.reportRecovery("requestLedger");
        },
      }).open();
    } catch {
      requestLedgerStore = createUnavailableRequestLedgerStore();
      persistenceAuthority.reportFailure("requestLedger");
    }
    const ownedLedgerStore = requestLedgerStore;
    // Ticket 22: the bounded capture store opens once at serve level and
    // survives Data Plane restarts; it stays fail-closed (no appends)
    // until the running Data Plane composition attaches the credential-
    // owner scrubber, so raw bodies never reach disk pattern-only.
    try {
      deepCaptureStore = await createDeepCaptureStoreFactory({
        configuration: bindDeepDiagnosticsConfiguration(
          config.deepDiagnostics,
        ),
      }).open();
    } catch {
      deepCaptureStore = createUnavailableDeepCaptureStore();
      persistenceAuthority.reportFailure("capture");
    }
    const ownedCaptureStore = deepCaptureStore;
    const controlPipe = await createProductionControlPipe();
    // The canonical LuckyToken-owned models.json: defaults to `models.json`
    // next to the config file (the desktop layout's `~/.luckytoken/models.json`)
    // unless the config overrides it. The Pi Agent default data directory is
    // never read or written implicitly.
    const modelsAuthority = createModelsJsonAuthority({
      path: config.pi.modelsJson,
      compose: (providers) => composeEffectiveCatalog(providers),
    });
    // Ticket 11: the validated dynamic catalog cache lives under the
    // configured application directory as a transparent LuckyToken-owned
    // file; it is never a second editable authority.
    const catalogCacheStore = createCatalogCacheStore({
      path: join(config.pi.directory, "models-catalog-cache.json"),
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
          "diagnostics.deepCapture.enabled": config.deepDiagnostics.enabled,
        },
      },
    );
    await settingsRegistry.load();
    // Ticket 16: the live per-protocol Client Token authorities belong to the
    // running Data Plane composition; the Control Plane adapters read them
    // through this slot so commands and enable transitions always target the
    // current authorities (boot-time enabling is ensured by the composition).
    let tokenAuthorities:
      Readonly<Record<string, LiveClientTokenAuthority>> | undefined;
    let credentialAuthority: LiveCredentialAuthority | undefined;
    /** Ticket 13: the served Pi Models backing Provider-owned login flows
     *  (set when the Data Plane composition runs). */
    let authModels: Models | undefined;
    // Ticket 17 identity seam: the Control Plane serves the bounded public
    // request identity ledger from the running Data Plane composition.
    let requestIdentities:
      | Awaited<
          ReturnType<typeof createConfiguredLuckyTokenComposition>
        >["requestIdentities"]
      | undefined;
    const protocolNames = Object.freeze({
      [anthropicMessagesProtocolId]: "Anthropic Messages",
      [openaiResponsesProtocolId]: "OpenAI Responses",
    });
    const operationalAttention = createOperationalAttentionAuthority({
      now: Date.now,
      credentials: () => credentialAuthority?.snapshot(),
      persistence: () => persistenceAuthority.projection(),
      requestFailureCount: (from, to) => {
        const result = ownedLedgerStore.analyze({
          version: 1,
          command: "summary",
          from,
          to,
        });
        return result.command === "summary"
          ? result.totals.failed + result.totals.other
          : 0;
      },
    });
    const clientTokenCommandHandler = createClientTokenControlPlaneHandler({
      authorities: () => tokenAuthorities ?? Object.freeze({}),
      protocolNames,
      diagnostics: diagnosticsStore,
    });
    const credentialCommandHandler = createCredentialControlPlaneHandler({
      authority: () => credentialAuthority,
    });
    // Ticket 13: Provider-owned auth login through the same Control Plane
    // contract as the UI/CLI credential commands. The served Models own
    // every authentication step; a successful login persists through the
    // Credential Authority's store and schedules the Ticket 11 catalog
    // refresh through the composition's login seam.
    const authCommandHandler = createAuthLoginControlPlaneHandler({
      models: () => authModels,
      authority: () => credentialAuthority,
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
    // Ticket 11: the refresh controller owns the one authoritative active
    // catalog snapshot; the Control Plane adapter serves catalog queries
    // and refresh commands against it, and the sanitized status projection
    // rides on every published snapshot.
    const catalogController = createCatalogRefreshController({
      store: catalogCacheStore,
      authority: modelsAuthority,
      diagnostics: diagnosticsStore,
      now: Date.now,
      onSnapshot: () => {
        // Ticket 14: a catalog swap changes the facts aliases validate
        // against; recompute and hot-apply for new request snapshots.
        aliasAuthority.onCatalogSnapshot();
        // Republish the full latest ApplicationStatus (modelDataPlane,
        // provider AND dataPlane origin/port/failure facts) so the fresh
        // catalog projection rides on a complete status snapshot.
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      },
    });
    // Ticket 14: the transparent LuckyToken-owned model-aliases.json sits
    // next to models.json. The authority owns locking, revisions, atomic
    // persistence, validation against the authoritative catalog snapshot
    // and the captured resolver snapshots (new requests hot-apply;
    // in-flight snapshots never remap).
    const aliasAuthority = createAliasRegistryAuthority({
      path: join(dirname(config.pi.modelsJson), "model-aliases.json"),
      catalogFacts: () => {
        const snapshot = catalogController.snapshot();
        const knownTargets = new Set<string>();
        for (const provider of snapshot.providers) {
          for (const model of provider.models) {
            knownTargets.add(`${provider.providerId}\u0000${model.id}`);
          }
        }
        return {
          catalogVersion: snapshot.version,
          knownTargets,
        };
      },
    });
    const codexLocalAuth = createCodexLocalCredentialAuthority({
      codexHome: resolveCodexHome(),
    });
    const codexNativeModels = createCodexNativeModelSource();
    const codexDialHost = (host: string): string => {
      const normalized = host.trim().toLowerCase();
      if (
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "[::]" ||
        normalized === "localhost"
      ) {
        return "127.0.0.1";
      }
      if (normalized === "::1" || normalized === "[::1]") return "[::1]";
      return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    };
    const codexIntegrationAuthority = createCodexIntegrationAuthority({
      codexHome: resolveCodexHome(),
      stateDirectory: join(dirname(configPath), "integrations", "codex"),
      endpoint: () => {
        if (lastPublishedStatus.modelDataPlane !== "running") return undefined;
        const address = resolveEffectiveSettings(settingsRegistry.query([]));
        return `http://${codexDialHost(address.host)}:${address.port}/v1`;
      },
      localAuthAvailable: () => codexLocalAuth.isAvailable(),
      buildCatalog: async () => {
        if (authModels === undefined) {
          throw new Error("LuckyToken model catalog is unavailable until the Data Plane has started");
        }
        await aliasAuthority.query();
        return buildCodexCatalog({
          nativeModels: codexNativeModels.models(),
          nativeCatalogEntries: await readCodexNativeCatalogEntries(resolveCodexHome()),
          models: authModels,
          aliases: aliasAuthority.resolver().entries(),
        });
      },
    });
    // Ticket 23: the one versioned export/delete/acknowledge authority over
    // the three persistent stores. Owned roots are the LuckyToken-owned
    // directory trees an export must never write into (config dir, Pi data
    // dir, models dir, and the three store directories).
    const historyAuthority = createHistoryAuthority({
      sources: {
        ledger: requestLedgerStore as RequestLedgerStore,
        diagnostics: diagnosticsStore as RuntimeDiagnosticsStore,
        capture: deepCaptureStore as DeepCaptureStore,
      },
      persistence: persistenceAuthority,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      ownedRoots: [
        resolve(dirname(configPath)),
        resolve(config.pi.directory),
        resolve(dirname(config.pi.modelsJson)),
        resolve(
          bindRuntimeDiagnosticsConfiguration(config.runtimeDiagnostics)
            .directory,
        ),
        resolve(bindRequestLedgerConfiguration(config.requestLedger).directory),
        resolve(
          bindDeepDiagnosticsConfiguration(config.deepDiagnostics).directory,
        ),
      ],
      // A failing source during export/delete becomes visible as degraded
      // (fixed Critical + projection), never as raw fault text.
      onSourceFailure: (authority, fact) => {
        persistenceAuthority.reportFailure(authority, fact);
      },
    });
    // Ticket 24: one backup authority over an explicit LuckyToken-owned
    // allowlist. Ordinary mode reads only transparent configuration and
    // recursively redacts it. Full-sensitive mode additionally includes
    // auth/client-token bytes and store-owned consistent SQLite snapshots
    // after a single-use confirmation. No external tool default directory
    // is ever discovered.
    const backupAuthority = createConfiguredBackupAuthority({
      configPath,
      config,
      applicationVersion: LUCKYTOKEN_RELEASE_VERSION,
      snapshots: [
        {
          id: "request-ledger",
          contract: "luckytoken-request-ledger-sqlite",
          version: ownedLedgerStore.schemaVersion,
          category: "history",
          sourcePath: join(
            bindRequestLedgerConfiguration(config.requestLedger).directory,
            "ledger.sqlite3",
          ),
          snapshot: (signal) => ownedLedgerStore.createBackupSnapshot(signal),
        },
        {
          id: "runtime-diagnostics",
          contract: "luckytoken-runtime-diagnostics-sqlite",
          version: ownedDiagnosticsStore.schemaVersion,
          category: "history",
          sourcePath: join(
            bindRuntimeDiagnosticsConfiguration(config.runtimeDiagnostics)
              .directory,
            "diagnostics.sqlite3",
          ),
          snapshot: (signal) => ownedDiagnosticsStore.createBackupSnapshot(signal),
        },
        {
          id: "deep-capture",
          contract: "luckytoken-deep-capture-sqlite",
          version: ownedCaptureStore.schemaVersion,
          category: "capture",
          sourcePath: join(
            bindDeepDiagnosticsConfiguration(config.deepDiagnostics).directory,
            "capture.sqlite3",
          ),
          snapshot: (signal) => ownedCaptureStore.createBackupSnapshot(signal),
        },
      ],
    });
    lastPublishedStatus = Object.freeze({
      modelDataPlane: "stopped",
      provider,
    });
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
            requestLedgerStore: ownedLedgerStore,
            deepCaptureStore: ownedCaptureStore,
            settingsRegistry,
            modelsStore: catalogCacheStore,
            // Ticket 14/15: the one alias registry owns the data plane
            // resolver snapshots; new requests hot-apply, in-flight
            // requests keep the snapshot they captured at acceptance.
            aliasAuthority,
            codexLocalAuth,
            codexNativeModels,
            // A successful Provider login schedules a background refresh
            // for the provider that just logged in (Ticket 11).
            onProviderLogin: (providerId) =>
              catalogController.onProviderLogin(providerId),
            // Ticket 23: capture write faults flow through the degradation
            // authority (fixed Critical fallback + state machine); recovery
            // is demonstrated by the first successful capture commit after
            // a reported double-write failure.
            onCapturePersistenceFailure: (failure) => {
              persistenceAuthority.reportFailure("capture", {
                ...(failure.requestId.length === 0
                  ? {}
                  : { requestId: failure.requestId }),
                code: failure.code,
              });
            },
            onCapturePersistenceRecovery: (fact) => {
              void fact;
              persistenceAuthority.reportRecovery("capture");
            },
          });
          tokenAuthorities = composition.clientTokenAuthorities;
          credentialAuthority = composition.credentialAuthority;
          authModels = composition.catalog.models;
          requestIdentities = composition.requestIdentities;
          // Startup restore: the cached dynamic catalog is served before
          // any network refresh completes, then the non-blocking startup
          // background refresh is scheduled.
          await catalogController.bind(
            composition.catalog,
            shutdownController.signal,
          );
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
            command: buildServeAutoStartCommand({
              ownerKind,
              nodeExecutable: process.execPath,
              cliScript: fileURLToPath(import.meta.url),
              configPath: resolve(configPath),
              ...(desktopExe === undefined ? {} : { desktopExe }),
            }),
          })
        : createUnsupportedAutoStartRegistrar();
    const publish = (status: ApplicationStatus): Promise<void> => {
      lastPublishedStatus = status;
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
      ((outcome: "drained" | "timed_out") => void) | undefined;
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
      if (attentionRefreshTimer !== undefined) {
        clearInterval(attentionRefreshTimer);
        attentionRefreshTimer = undefined;
      }
      attentionLedgerSubscription?.unsubscribe();
      attentionLedgerSubscription = undefined;
      if (supervisor !== undefined) {
        await supervisor
          .execute(
            "stop",
            (status) =>
              controlPlane?.publishStatus(status) ?? Promise.resolve(),
          )
          .catch(() => undefined);
      }
      const results = await Promise.allSettled([
        descriptor?.close() ?? Promise.resolve(),
        controlPlane?.close() ?? Promise.resolve(),
        diagnosticsStore?.close() ?? Promise.resolve(),
        requestLedgerStore?.close() ?? Promise.resolve(),
        deepCaptureStore?.close() ?? Promise.resolve(),
      ]);
      catalogController.dispose();
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("LuckyToken application resource cleanup failed");
      }
    };
    controlPlane = await startControlPlane({
      endpoint,
      application: { id: "luckytoken", version: LUCKYTOKEN_RELEASE_VERSION },
      initialStatus: supervisor.initialStatus,
      ownership: {
        owner: {
          kind: ownerKind,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
      },
      runtimeCommandHandler: supervisor.execute,
      settingsCommandHandler,
      settingsProjection: () => settingsRegistry.snapshot(),
      clientTokenCommandHandler,
      // Ticket 18: the Control Plane serves the permanent Request Ledger
      // (bounded query + opt-in typed events) from the serve-level store,
      // even while the Data Plane is stopped.
      requestLedger: requestLedgerStore,
      // Ticket 21: query-time analytics aggregation over the same ledger
      // store — the host computes nothing itself.
      analyticsHandler: (query) => ownedLedgerStore.analyze(query),
      // Ticket 22: the Control Plane serves bounded capture queries and
      // opt-in typed capture-state events from the serve-level store.
      capture: deepCaptureStore,
      // Ticket 23: versioned history export/delete/acknowledge commands
      // against the one history authority; the audit-unavailable projection
      // rides on every published snapshot until acknowledged or recovered.
      historyCommandHandler: (command, signal) =>
        historyAuthority.handle(command, signal),
      backupCommandHandler: (command, signal) =>
        backupAuthority.handle(command, signal),
      persistenceProjection: () => persistenceAuthority.projection(),
      attentionProjection: (status) => operationalAttention.project(status),
      requestIdentitiesHandler: () =>
        Promise.resolve({
          records: requestIdentities?.list() ?? Object.freeze([]),
        }),
      modelsCommandHandler: createModelsControlPlaneHandler(modelsAuthority),
      modelsProjection: () => modelsAuthority.snapshot(),
      credentialCommandHandler,
      credentialProjection: () => credentialAuthority?.snapshot(),
      // Ticket 13: versioned Provider-auth commands (query/login) with the
      // typed interaction channel for in-flight login flows.
      authCommandHandler,
      // Ticket 11: versioned catalog queries and refresh commands against
      // the one authoritative active catalog snapshot.
      catalogCommandHandler: async (command) => {
        if (command.command === "query") {
          return { outcome: "ok", snapshot: catalogController.snapshot() };
        }
        if (command.mode === "background") {
          // Before the gateway (and the controller binding) is up, a
          // background refresh is a no-op — report unavailable instead of
          // claiming something was scheduled.
          if (!catalogController.isBound()) {
            return {
              outcome: "unavailable",
              snapshot: catalogController.snapshot(),
            };
          }
          catalogController.scheduleBackground("page_open");
          return {
            outcome: "scheduled",
            snapshot: catalogController.snapshot(),
          };
        }
        const refresh = await catalogController.refreshManual();
        return {
          outcome: "ok",
          snapshot: catalogController.snapshot(),
          refresh,
        };
      },
      catalogProjection: () => {
        const snapshot = catalogController.snapshot();
        return Object.freeze({
          version: snapshot.version,
          refreshing: snapshot.providers.some(
            (provider) => provider.state === "refreshing",
          ),
          ...(snapshot.refreshedAt === undefined
            ? {}
            : { refreshedAt: snapshot.refreshedAt }),
          failedProviderIds: Object.freeze(
            snapshot.providers
              .filter((provider) => provider.state === "failed")
              .map((provider) => provider.providerId),
          ),
        });
      },
      // Ticket 14: versioned alias registry commands against the one
      // authoritative model-aliases.json authority; the sanitized
      // projection rides on every published snapshot.
      aliasCommandHandler: createAliasControlPlaneHandler(aliasAuthority),
      aliasesProjection: () => aliasAuthority.snapshot(),
      codexIntegrationCommandHandler: async (command) => {
        const state =
          command.command === "query"
            ? await codexIntegrationAuthority.query()
            : command.command === "sync_catalog"
              ? await codexIntegrationAuthority.syncCatalog()
              : await codexIntegrationAuthority.setEnabled(command.enabled);
        return { state };
      },
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
    // Request failures update only the aggregate tray count; they can never
    // activate an actionable condition. Completed non-success records cause
    // one fresh snapshot so the count is visible promptly.
    attentionLedgerSubscription = ownedLedgerStore.subscribe((event) => {
      if (
        event.record.completedAt !== undefined &&
        event.record.outcome !== "success" &&
        event.record.outcome !== "running" &&
        event.record.outcome !== "aborted"
      ) {
        controlPlane?.publishStatus(lastPublishedStatus).catch(() => undefined);
      }
    });
    // Expiration and the one-hour aggregate can change without another
    // command. A bounded owner-side refresh republishes the current base
    // status; no request path or renderer owns this policy.
    let attentionRefreshInFlight = false;
    attentionRefreshTimer = setInterval(() => {
      if (attentionRefreshInFlight) return;
      attentionRefreshInFlight = true;
      void (async () => {
        try {
          await credentialAuthority?.query();
          await controlPlane?.publishStatus(lastPublishedStatus);
        } catch {
          // Refresh faults remain on their existing diagnostics surfaces.
        } finally {
          attentionRefreshInFlight = false;
        }
      })();
    }, 60_000);
    attentionRefreshTimer.unref();
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
    if (attentionRefreshTimer !== undefined) {
      clearInterval(attentionRefreshTimer);
      attentionRefreshTimer = undefined;
    }
    attentionLedgerSubscription?.unsubscribe();
    attentionLedgerSubscription = undefined;
    if (supervisor !== undefined) {
      await supervisor
        .execute(
          "stop",
          (status) => controlPlane?.publishStatus(status) ?? Promise.resolve(),
        )
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

async function runServe(
  configPath: string,
  descriptorOverride?: string,
  ownerKind: "cli" | "desktop" = "cli",
  desktopExe?: string,
  createFirstRunConfig = false,
): Promise<void> {
  const started = await startLuckyTokenApplication({
    configPath,
    ...(descriptorOverride === undefined
      ? {}
      : { descriptorOverride }),
    ownerKind,
    ...(desktopExe === undefined ? {} : { desktopExe }),
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
    await runServe(
      parsed.configPath,
      parsed.descriptorPath,
      parsed.ownerKind,
      parsed.desktopExe,
      parsed.createFirstRunConfig,
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
