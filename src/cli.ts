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
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { loadLuckyTokenCliConfig } from "./cli-config.js";
import { runClientTokenCli } from "./client-auth/cli.js";
import {
  createConfiguredLuckyTokenComposition,
  createConfiguredPiModels,
} from "./composition.js";
import { startLuckyTokenHttpServer } from "./server.js";

const HELP = `LuckyToken

Usage:
  luckytoken --config <path>
  luckytoken login [provider] --config <path>
  luckytoken logout [provider] --config <path>
  luckytoken client-token <create|rotate|remove|list> <protocol> [scope] --config <path>
  luckytoken --help

Commands:
  serve    Start the local Client Protocol service (default)
  login    Authenticate a Provider through Pi Models
  logout   Remove a Provider credential through Pi Models
  client-token  Manage one Client Protocol's local token file

Options:
  --config <path>  Strict LuckyToken JSON configuration
  --global         Select the protocol-global client token
  --project <path> Select a project-bound client token
  --token <value>  Use an explicit token for create/rotate
  --help           Show this help
`;

type ParsedCliArguments =
  | { readonly command: "serve"; readonly configPath: string }
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
  const expectedPositionals = command === "serve" && first === "serve" ? 1 : command === "serve" ? 0 : 2;
  if (positional.length > expectedPositionals) {
    throw new Error(`Too many arguments for ${command}`);
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
): Promise<void> {
  const config = await loadLuckyTokenCliConfig(configPath);
  const shutdownController = new AbortController();
  const composition = await createConfiguredLuckyTokenComposition({
    config,
    fetch: globalThis.fetch,
    shutdownSignal: shutdownController.signal,
  });
  const server = await startLuckyTokenHttpServer({
    runtime: composition.runtime,
    host: config.server.host,
    port: config.server.port,
  });
  for (const route of composition.runtime.routes) {
    stdout.write(
      `LuckyToken ${route.method} ${server.origin}${route.pathname}\n`,
    );
  }

  await new Promise<void>((resolvePromise) => {
    let closing: Promise<void> | undefined;
    const close = (signalName: "SIGINT" | "SIGTERM") => {
      closing ??= (async () => {
        shutdownController.abort(new Error(`LuckyToken received ${signalName}`));
        await server.close();
        process.off("SIGINT", onInterrupt);
        process.off("SIGTERM", onTerminate);
        resolvePromise();
      })();
      void closing.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`LuckyToken shutdown failed: ${message}\n`);
        process.exitCode = 1;
        resolvePromise();
      });
    };
    const onInterrupt = () => close("SIGINT");
    const onTerminate = () => close("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

export async function runLuckyTokenCli(
  args: readonly string[],
): Promise<void> {
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
    await runServe(parsed.configPath);
    return;
  }
  const config = await loadLuckyTokenCliConfig(parsed.configPath);
  const configured = await createConfiguredPiModels({
    piDirectory: config.pi.directory,
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
